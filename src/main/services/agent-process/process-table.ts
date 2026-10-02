import { execFile, execFileSync } from 'node:child_process'
import { errorText } from '@shared/i18n/error-text'
import { childEnv } from '../child-env'

/** Carried across the exec and inherited by descendants. It identifies this one launch and is not a credential. */
export const AGENT_PROCESS_TOKEN = 'ASIST_AGENT_EXECUTION_ID'

export interface ProcessRow { pid: number; ppid: number; pgid: number; state: string; startedAt: string }

const TABLE_ARGS = ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=']
const TABLE_OPTIONS = { encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true } as const

function parseTable(output: string): ProcessRow[] {
  const lines = output.split('\n').filter((line) => line.trim())
  if (lines.length === 0) throw new Error(errorText('jobs.process.tableUnreadable'))
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) throw new Error(errorText('jobs.process.tableUnparsable'))
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], startedAt: match[5] }
  })
}

/** Every process on the machine, read at once. ps prints the start time in the local time zone. */
export function processTable(): ProcessRow[] {
  return parseTable(execFileSync('/bin/ps', TABLE_ARGS, { ...TABLE_OPTIONS, env: childEnv({ LC_ALL: 'C' }) }))
}

/** The same table read without blocking main's thread, for the reads made while a job runs. */
export function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', TABLE_ARGS, { ...TABLE_OPTIONS, env: childEnv({ LC_ALL: 'C' }) }, (error, stdout) => {
      if (error) reject(error)
      else {
        try {
          resolve(parseTable(stdout))
        } catch (parseError) {
          reject(parseError)
        }
      }
    })
  })
}

/** Whether a process's line of ps holds the token as a variable of the environment. */
function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${AGENT_PROCESS_TOKEN}=${escaped}(?:\\s|$)`)
}

/**
 * Whether a process carries the agent's token: 'unreadable' means its environment could not be read on this
 * pass, so it is neither ours nor foreign yet.
 */
export type TokenState = 'ours' | 'foreign' | 'unreadable'

/**
 * How each process stands to the token, read in one call of ps. A process that has ended since it was found
 * is 'unreadable'.
 */
export function readTokens(pids: number[], token: string): Map<number, TokenState> {
  const states = new Map<number, TokenState>(pids.map((pid) => [pid, 'unreadable']))
  if (pids.length === 0) return states
  // The environment ps prints can contain secrets, so it is only matched against and neither the raw
  // output nor the underlying error leaves this function.
  let output: string
  try {
    output = execFileSync('/bin/ps', ['eww', '-p', pids.join(','), '-o', 'pid=,command='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(), windowsHide: true
    })
  } catch (error) {
    // ps exits with 1 when none of the processes is left.
    if ((error as { status?: number | null }).status === 1) return states
    throw new Error(errorText('jobs.process.tokenUnreadable'))
  }
  // A value in an environment can hold a newline, so a record runs on to the next line that begins with
  // one of the pids asked for.
  const records = new Map<number, string>()
  let current: number | undefined
  for (const line of output.split('\n')) {
    const start = /^\s*(\d+)\s(.*)$/.exec(line)
    if (start && states.has(Number(start[1]))) {
      current = Number(start[1])
      records.set(current, start[2])
    } else if (current !== undefined) {
      records.set(current, `${records.get(current)}\n${line}`)
    }
  }
  const carries = tokenPattern(token)
  for (const [pid, record] of records) {
    // A process that is exiting stays in the table as "Ss", "Rs" or "?Es" for a few milliseconds after the
    // kernel has released its arguments, and ps then prints "(node)" or "<defunct>" with no environment.
    // Measured on macOS 26.2 on 2026-09-22: 22 of 1431 reads of a Node process around its exit. Another
    // user's process prints the same form, so it proves nothing about ownership either way.
    states.set(pid, carries.test(record) ? 'ours' : /^(?:\(.*\)|<defunct>)$/.test(record.trim()) ? 'unreadable' : 'foreign')
  }
  return states
}

/**
 * Every process of the user whose environment carries the agent's token. ps prints each process's environment
 * on its line, and a value can hold a newline, so a line that shows the token is only a lead, confirmed by
 * reading the leads again. The shells and tools Apple ships under System Integrity Protection, /bin/zsh,
 * /bin/sh, /bin/bash and sleep among them, never show their environment (macOS 26.2, 2026-10-02), so the
 * token does not find them.
 */
export function tokenHolders(token: string): number[] {
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-x', '-ww', '-E', '-o', 'pid=,pgid=,command='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(), windowsHide: true
    })
  } catch {
    throw new Error(errorText('jobs.process.tokenUnreadable'))
  }
  const carries = tokenPattern(token)
  const leads = new Set<number>()
  let current: number | undefined
  for (const line of output.split('\n')) {
    const start = /^\s*(\d+)\s+\d+\s/.exec(line)
    if (start) current = Number(start[1])
    if (current !== undefined && carries.test(line)) leads.add(current)
  }
  const tokens = readTokens([...leads], token)
  return [...leads].filter((pid) => tokens.get(pid) === 'ours')
}

/**
 * The processes a CLI started, followed through their parent pids from the table read while the job runs. A
 * command the CLI runs in a session of its own is its child only until the CLI exits, and then belongs to
 * launchd, so a process is recorded while its parent is known. Each is kept with its start time, so that a
 * pid given to another process later is told apart.
 */
export class ProcessTree {
  private readonly known = new Map<number, string>()
  private rootSeen = false

  constructor(private readonly root: number) {}

  /** Records the new children of the CLI and of every process already recorded, and forgets those that ended. */
  update(table: ProcessRow[]): void {
    const running = new Map(table.filter((row) => !row.state.startsWith('Z')).map((row) => [row.pid, row]))
    for (const [pid, startedAt] of this.known) {
      if (running.get(pid)?.startedAt !== startedAt) this.known.delete(pid)
    }
    // Only the first table that shows the CLI records it, so that a pid it leaves behind is never taken for it.
    const root = running.get(this.root)
    if (!this.rootSeen && root) {
      this.known.set(root.pid, root.startedAt)
      this.rootSeen = true
    }
    let added = true
    while (added) {
      added = false
      for (const row of running.values()) {
        if (this.known.has(row.pid) || !this.known.has(row.ppid)) continue
        this.known.set(row.pid, row.startedAt)
        added = true
      }
    }
  }

  /** The recorded processes still running at the last update, the CLI itself left out. */
  descendants(): number[] {
    return [...this.known.keys()].filter((pid) => pid !== this.root)
  }
}
