import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { AgentProcessIdentity } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { childEnv } from '../child-env'
import type { AgentOwner, AgentProcess } from './owner'

/** Carried across the exec and inherited by descendants. It identifies this one launch and is not a credential. */
export const AGENT_PROCESS_TOKEN = 'ASIST_AGENT_EXECUTION_ID'

interface GroupMember { pid: number; pgid: number; state: string; startedAt: string }

function processTable(): GroupMember[] {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024,
    env: childEnv({ LC_ALL: 'C' }), windowsHide: true
  })
  const lines = output.split('\n').filter((line) => line.trim())
  if (lines.length === 0) throw new Error(errorText('jobs.process.tableUnreadable'))
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) throw new Error(errorText('jobs.process.tableUnparsable'))
    return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], startedAt: match[4] }
  })
}

export function captureProcessIdentity(pid: number, token: string): AgentProcessIdentity {
  const member = processTable().find((row) => row.pid === pid)
  if (!member || member.pgid !== pid) throw new Error(errorText('jobs.process.groupUnconfirmed'))
  return { pid, startedAt: member.startedAt, token }
}

/**
 * Whether the member carries the agent's token. 'unreadable' means its environment could not be read on this
 * pass, so it is neither ours nor foreign yet.
 */
function memberToken(pid: number, token: string): 'ours' | 'foreign' | 'unreadable' {
  // The environment ps prints can contain secrets, so it is only matched against and neither the raw
  // output nor the underlying error leaves this function.
  let environment: string
  try {
    environment = execFileSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(), windowsHide: true
    })
  } catch (error) {
    // ps exits with 1 when the member ended after the table was read.
    if ((error as { status?: number | null }).status === 1) return 'unreadable'
    throw new Error(errorText('jobs.process.tokenUnreadable'))
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(?:^|\\s)${AGENT_PROCESS_TOKEN}=${escaped}(?:\\s|$)`).test(environment)) return 'ours'
  // A process that is exiting stays in the table as "Ss", "Rs" or "?Es" for a few milliseconds after the
  // kernel has released its arguments, and ps then prints "(node)" or "<defunct>" with no environment.
  // Measured on macOS 26.2 on 2026-09-22: 22 of 1431 reads of a Node process around its exit. Another
  // user's process prints the same form, so it proves nothing about ownership either way.
  if (/^(?:\(.*\)|<defunct>)$/.test(environment.trim())) return 'unreadable'
  return 'foreign'
}

/**
 * A PID alone never stops another process. Every remaining member is checked, even once the leader is gone.
 * 'unreadable' means a member's environment could not be read on this pass, so it is neither ours nor foreign yet.
 */
export function inspectProcessIdentity(identity: AgentProcessIdentity): 'gone' | 'owned' | 'unreadable' {
  const members = processTable().filter((row) => row.pgid === identity.pid && !row.state.startsWith('Z'))
  if (members.length === 0) return 'gone'
  const tokens = members.map((member) => memberToken(member.pid, identity.token))
  const leader = members.find((row) => row.pid === identity.pid)
  // macOS, like BSD, never gives a new process a PID that is still the id of a process group, so a leader
  // that started at another time, in a group where no member carries the token, means the agent's group
  // ended and its PID went to another process, which is left alone. ps prints the start time in the local
  // time zone, so the same agent also shows another start time after the Mac changed time zone, and its
  // token tells it apart.
  if (leader && leader.startedAt !== identity.startedAt && !tokens.includes('ours')) return 'gone'
  for (const token of tokens) {
    if (token === 'unreadable') return 'unreadable'
    if (token === 'foreign') throw new Error(errorText('jobs.process.tokenMismatch'))
  }
  return 'owned'
}

/** Stops only an agent whose parent link a restart broke, and settles its output once it can no longer write. */
export function recoverAgentProcess(identity: AgentProcessIdentity, onStopped: () => void): AgentProcess {
  let running = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  void completion.catch(() => {})
  const stop = (): void => {
    if (running) return
    running = true
    const started = Date.now()
    let termSent = false
    let killSent = false
    const check = (): void => {
      try {
        const state = inspectProcessIdentity(identity)
        if (state === 'gone') {
          onStopped()
          resolve()
          return
        }
        const elapsed = Date.now() - started
        if (elapsed >= 5_000) {
          throw new Error(errorText(state === 'owned' ? 'jobs.process.staleRunning' : 'jobs.process.tokenUnreadable'))
        }
        // An unconfirmed group receives no signal; the next pass sees an exiting member as a zombie or gone.
        const signal = state !== 'owned' ? null : !termSent ? 'SIGTERM' : elapsed >= 2_000 && !killSent ? 'SIGKILL' : null
        if (signal) {
          try { process.kill(-identity.pid, signal) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(errorText('jobs.process.staleSignalFailed'))
          }
          if (signal === 'SIGTERM') termSent = true
          else killSent = true
        }
        setTimeout(check, 100)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorText('jobs.process.exitUnconfirmed')))
      }
    }
    // The recovery event fires only after the caller has registered the completion and the process.
    queueMicrotask(check)
  }
  return { completion, stop }
}

/** Owns the agent until stdout has closed and its own process group is confirmed gone. */
export function manageAgentProcess(child: ChildProcess, onClose: (code: number | null) => void): AgentProcess {
  let streamsClosed = false
  let exitCode: number | null = null
  let finished = false
  let stopping = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let groupWatch: ReturnType<typeof setInterval> | undefined
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      // macOS answers EPERM for a group whose members have all exited but are not reaped yet, which is
      // how a stopped descendant waits for launchd, and for a member running as another user. Either way
      // the group still exists, and the watch goes on until it is gone or the deadline passes.
      if (code === 'EPERM') return true
      throw error
    }
  }
  const clearTimers = (): void => {
    clearTimeout(forceTimer)
    clearTimeout(deadlineTimer)
    clearInterval(groupWatch)
  }
  const checkCompletion = (): boolean => {
    if (finished) return true
    if (!streamsClosed) return false
    try {
      if (signalGroup(0)) return false
      finished = true
      clearTimers()
      onClose(exitCode)
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    return finished
  }
  const stop = (): void => {
    if (finished || stopping) return
    stopping = true
    try { signalGroup('SIGTERM') } catch (error) { reject(error as Error) }
    // Sending the signal successfully does not make the process finished: settling the output waits until
    // the descendants are gone.
    forceTimer = setTimeout(() => {
      try {
        signalGroup('SIGKILL')
        checkCompletion()
      } catch (error) { reject(error as Error) }
    }, 2_000)
    deadlineTimer = setTimeout(() => reject(new Error(errorText('jobs.process.stopTimedOut'))), 5_000)
  }
  child.once('close', (code: number | null) => {
    streamsClosed = true
    exitCode = code
    if (checkCompletion()) return
    // Even a CLI that exited on its own can leave a child process behind with its stdio detached.
    stop()
    if (!finished) {
      // Ownership is not given up after the deadline: a late confirmation still settles the job's state.
      groupWatch = setInterval(checkCompletion, 25)
    }
  })
  return { completion, stop }
}

/**
 * An agent on macOS is the process group of a shell that waits for permission to start: the CLI must not
 * start writing before the job is persisted, and if ASIST exits first, the EOF on stdin ends the shell
 * before the exec. The prompt follows the permission on the same stdin: the shell's read takes only the
 * first line from a pipe, and the CLI reads the rest (see agent-cli).
 */
export const posixOwner: AgentOwner = {
  start(cli, args, { cwd, env, token }, onClose) {
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready && [ "$ready" = start ] && exec "$@"', 'asist-agent-launcher', cli, ...args], {
      cwd,
      env: { ...env, [AGENT_PROCESS_TOKEN]: token },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    return { child, identity: () => captureProcessIdentity(child.pid!, token), lifetime: manageAgentProcess(child, onClose) }
  },
  recover: recoverAgentProcess
}
