import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentProcessIdentity } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { STOP_DEADLINE_MS, type AgentEvents, type AgentOwner, type AgentProcess } from './owner'
import { AGENT_PROCESS_TOKEN, ProcessTree, processTable, readProcessTable, readTokens, tokenHolders } from './process-table'

/** A stop sends SIGTERM, and SIGKILL to whatever is left once this long has passed. */
const KILL_AFTER_MS = 2_000
/**
 * How often a stopping agent's processes outside the CLI's group are read. One read took about 45 ms on
 * main's thread: 10 ms for the table, 25 ms for the scan of every environment and 10 ms to read the leads
 * again, with 724 processes, 514 of them the user's, on an Apple M5 (2026-10-02). So it runs far less often
 * than the check of the CLI's own group.
 */
const SCAN_MS = 500
/** How often the CLI's descendants are read while it runs, off main's thread, so that each is known before its parent exits. */
const FOLLOW_MS = 500

export function captureProcessIdentity(pid: number, token: string): AgentProcessIdentity {
  const member = processTable().find((row) => row.pid === pid)
  if (!member || member.pgid !== pid) throw new Error(errorText('jobs.process.groupUnconfirmed'))
  return { pid, startedAt: member.startedAt, token }
}

/** The signal a stop sends at this point: SIGTERM, and SIGKILL to whatever is left from KILL_AFTER_MS on. */
const phaseSignal = (elapsed: number): NodeJS.Signals => (elapsed >= KILL_AFTER_MS ? 'SIGKILL' : 'SIGTERM')

/**
 * Sends each target the signal once, and nothing more once it was sent SIGKILL. A negative target is a
 * process group.
 */
function signalOnce(sent: Map<number, NodeJS.Signals>, targets: number[], signal: NodeJS.Signals): void {
  for (const target of targets) {
    const previous = sent.get(target)
    if (previous === signal || previous === 'SIGKILL') continue
    sent.set(target, signal)
    try {
      process.kill(target, signal)
    } catch (error) {
      // ESRCH is a process that ended after it was read. macOS answers EPERM for a group whose members have
      // all exited but are not reaped yet, and for a process of another user, such as one started through
      // sudo, which cannot be stopped; the stop then reports it by its deadline.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') throw new Error(errorText('jobs.process.exitUnconfirmed'))
    }
  }
}

/** What a later run of ASIST finds of an agent: nothing, processes it cannot judge on this pass, or its processes to stop. */
export type AgentRemains = { state: 'gone' } | { state: 'unreadable' } | { state: 'owned'; pids: number[] }

/**
 * A PID alone never stops another process. Every remaining member of the agent's group is checked, even once
 * the leader is gone, and every process outside the group that carries the agent's token is the agent's too.
 * The processes the CLI started cannot be followed across a restart, since they went to launchd, so the
 * token alone finds those outside the group.
 */
export function inspectProcessIdentity(identity: AgentProcessIdentity): AgentRemains {
  const members = processTable().filter((row) => row.pgid === identity.pid && !row.state.startsWith('Z'))
  const states = readTokens(members.map((member) => member.pid), identity.token)
  const tokens = members.map((member) => states.get(member.pid))
  const leader = members.find((row) => row.pid === identity.pid)
  // macOS, like BSD, never gives a new process a PID that is still the id of a process group, so a leader
  // that started at another time, in a group where no member carries the token, means the agent's group
  // ended and its PID went to another process, which is left alone. ps prints the start time in the local
  // time zone, so the same agent also shows another start time after the Mac changed time zone, and its
  // token tells it apart.
  const reused = leader !== undefined && leader.startedAt !== identity.startedAt && !tokens.includes('ours')
  if (!reused) {
    for (const token of tokens) {
      if (token === 'unreadable') return { state: 'unreadable' }
      if (token === 'foreign') throw new Error(errorText('jobs.process.tokenMismatch'))
    }
  }
  const pids = new Set(tokenHolders(identity.token))
  if (!reused) for (const member of members) pids.add(member.pid)
  return pids.size === 0 ? { state: 'gone' } : { state: 'owned', pids: [...pids] }
}

/** Stops only an agent whose parent link a restart broke, and settles its output once it can no longer write. */
export function recoverAgentProcess(identity: AgentProcessIdentity, onStopped: () => void): AgentProcess {
  let running = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  void completion.catch(() => {})
  const stop = (): Promise<void> => {
    if (running) return completion
    running = true
    const started = Date.now()
    const sent = new Map<number, NodeJS.Signals>()
    const check = (): void => {
      try {
        const remains = inspectProcessIdentity(identity)
        if (remains.state === 'gone') {
          onStopped()
          resolve()
          return
        }
        const elapsed = Date.now() - started
        if (elapsed >= STOP_DEADLINE_MS) {
          throw new Error(errorText(remains.state === 'owned' ? 'jobs.process.staleRunning' : 'jobs.process.tokenUnreadable'))
        }
        // An unconfirmed group receives no signal; the next pass sees an exiting member as a zombie or gone.
        if (remains.state === 'owned') signalOnce(sent, remains.pids, phaseSignal(elapsed))
        setTimeout(check, SCAN_MS)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorText('jobs.process.exitUnconfirmed')))
      }
    }
    // The recovery event fires only after the caller has registered the completion and the process.
    queueMicrotask(check)
    return completion
  }
  return { completion, stop }
}

/** One stop of a running agent, from its SIGTERM to the agent gone or the deadline. */
interface Stop {
  startedAt: number
  /** The signals sent to each process outside the CLI's group, and to the group under its negative id. */
  sent: Map<number, NodeJS.Signals>
  timers: Array<ReturnType<typeof setTimeout>>
  done: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * Owns the agent until stdout has closed, its own process group is confirmed gone, and none of its processes
 * outside that group is left: neither one the CLI was seen starting nor one carrying its token. Either alone
 * misses some: a command in a session of its own whose parent exited before it was read, and a shell or
 * tool Apple ships under System Integrity Protection, whose environment ps does not show.
 */
export function manageAgentProcess(child: ChildProcess, token: string, events: AgentEvents): AgentProcess {
  let streamsClosed = false
  let exitCode: number | null = null
  let finished = false
  let lastScan = -Infinity
  let unreadable = false
  let watch: ReturnType<typeof setInterval> | undefined
  let stopping: Stop | undefined
  const tree = child.pid === undefined ? undefined : new ProcessTree(child.pid)
  /** Counts the tables read, so that a read made off main's thread does not undo a newer one. */
  let readings = 0
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  /** A read that failed is tried again on the next pass; a stop that cannot confirm the end reports it by its deadline. */
  const readFailed = (error: unknown): void => {
    if (!unreadable) console.error('the agent\'s processes could not be read:', error)
    unreadable = true
  }
  const follow = tree && setInterval(() => {
    const reading = ++readings
    readProcessTable().then(
      (table) => {
        if (reading === readings && !finished) tree.update(table)
      },
      readFailed
    )
  }, FOLLOW_MS)
  /** The agent's processes outside the CLI's group: those the CLI was seen starting, and those carrying its token. */
  const outsideGroup = (): number[] => {
    readings++
    const table = processTable()
    tree?.update(table)
    const groupOf = new Map(table.map((row) => [row.pid, row.pgid]))
    const pids = new Set([...(tree?.descendants() ?? []), ...tokenHolders(token)])
    unreadable = false
    return [...pids].filter((pid) => groupOf.get(pid) !== child.pid)
  }
  const groupAlive = (): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      // macOS answers EPERM for a group whose members have all exited but are not reaped yet, which is
      // how a stopped descendant waits for launchd, and for a member running as another user. Either way
      // the group still exists, and the watch goes on until it is gone or the deadline passes.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  /**
   * Sends the signal of the stop's phase to the CLI's group, and to each process of the agent outside it. Those
   * are read first, because a child in a session of its own goes to launchd once the CLI exits, and the group
   * is signalled whether or not they could be read.
   */
  const signalAll = (current: Stop): void => {
    const signal = phaseSignal(Date.now() - current.startedAt)
    let outside: number[] = []
    try {
      outside = outsideGroup()
    } catch (error) {
      readFailed(error)
    }
    try {
      signalOnce(current.sent, child.pid === undefined ? outside : [-child.pid, ...outside], signal)
    } catch (error) {
      readFailed(error)
    }
  }
  const finish = (): void => {
    finished = true
    clearInterval(watch)
    clearInterval(follow)
    for (const timer of stopping?.timers ?? []) clearTimeout(timer)
    try {
      events.onClose(exitCode)
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    stopping?.resolve()
  }
  const checkCompletion = (): void => {
    if (finished || !streamsClosed || groupAlive()) return
    if (Date.now() - lastScan < SCAN_MS) return
    lastScan = Date.now()
    let outside: number[]
    try {
      outside = outsideGroup()
    } catch (error) {
      readFailed(error)
      return
    }
    if (outside.length === 0) {
      finish()
      return
    }
    if (!stopping) return
    try {
      signalOnce(stopping.sent, outside, phaseSignal(Date.now() - stopping.startedAt))
    } catch (error) {
      readFailed(error)
    }
  }
  const stop = (): Promise<void> => {
    if (finished) return completion
    if (stopping) return stopping.done
    let resolveStop!: () => void
    let rejectStop!: (error: Error) => void
    const done = new Promise<void>((settled, failed) => { resolveStop = settled; rejectStop = failed })
    // A caller may leave the stop's outcome to onStopFailed and never wait for it.
    void done.catch(() => {})
    const current: Stop = { startedAt: Date.now(), sent: new Map(), timers: [], done, resolve: resolveStop, reject: rejectStop }
    stopping = current
    signalAll(current)
    // Sending the signal successfully does not make the process finished: settling the output waits until
    // the descendants are gone.
    current.timers.push(setTimeout(() => {
      signalAll(current)
      checkCompletion()
    }, KILL_AFTER_MS))
    // Ownership is not given up after the deadline: a late confirmation still settles the job's state, and
    // the next stop sends the signals again.
    current.timers.push(setTimeout(() => {
      clearTimeout(current.timers[0])
      if (stopping === current) stopping = undefined
      const error = new Error(errorText('jobs.process.stopTimedOut'))
      events.onStopFailed(error)
      current.reject(error)
    }, STOP_DEADLINE_MS))
    return done
  }
  child.once('close', (code: number | null) => {
    streamsClosed = true
    exitCode = code
    checkCompletion()
    if (finished) return
    // Even a CLI that exited on its own can leave processes behind, in its group or outside it.
    if (!stopping) void stop()
    watch = setInterval(checkCompletion, 25)
  })
  return { completion, stop }
}

/**
 * The watcher's script, given the CLI's PID, which is also its group's. A line on its input means the CLI has
 * exited; an end without one means ASIST is gone, and the CLI's group and every process descended from the CLI
 * are sent SIGTERM. The descendants are read while the CLI still links them, since claude's Bash tool and codex
 * run each command in a process group of their own, and codex 0.155.0 left its running command to finish after
 * it got SIGTERM itself (2026-10-02). The depth limit keeps a table read while processes come and go from
 * looping.
 */
const WATCHER = [
  'read -r _ && exit',
  'descendants=$(/bin/ps -axo pid=,ppid= | /usr/bin/awk -v root="$1" \'{ parent[$1] = $2 } END { for (pid in parent) { up = parent[pid]; for (depth = 0; (up in parent) && up != root && depth < 64; depth++) up = parent[up]; if (up == root) print pid } }\')',
  'kill -TERM -"$1" $descendants'
].join('\n')

/**
 * Sends the agent SIGTERM, as a stop begins, if ASIST ends, crashed or killed, while the CLI runs, as the
 * launcher on Windows stops its job. Measured with claude 2.1.276 on 2026-10-02: once the process that started
 * it was killed, it finished the running command, asked the model again and ran another one. The watcher is a
 * shell in a session of its own that reads a pipe only ASIST writes to, and ASIST writes a line there once the
 * CLI has exited, so that no watcher is left to signal the group's PID once another process may have it. Kept
 * out of the agent's group, it never keeps the group alive after the CLI, which would make every end that
 * settles on its own run a stop and cut short what the CLI left in its group.
 *
 * A watcher that cannot be started, as at the limit of processes, fails the job before its CLI is let start:
 * an agent ASIST could not stop if it crashed is what the watcher exists to prevent, and the job's error says
 * why it did not start, where the user can start it again.
 */
function watchForAsistEnd(group: number, env: NodeJS.ProcessEnv, child: ChildProcess): void {
  const watcher = spawn('/bin/sh', ['-c', WATCHER, 'asist-agent-watcher', String(group)], {
    env,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  })
  // A failed spawn is reported here with its reason after the job has already failed, and a watcher killed
  // later by someone else leaves the agent running as it would be without one.
  const lost = (error: Error): void => console.error(`the watcher of agent ${group} is gone:`, error)
  watcher.on('error', lost)
  if (watcher.pid === undefined) {
    // The launcher reads the end of its input instead of "start" and exits without running the CLI.
    child.stdin!.end()
    throw new Error(errorText('jobs.process.watcherUnavailable'))
  }
  watcher.stdin!.on('error', lost)
  child.once('exit', () => watcher.stdin!.end('\n'))
}

/**
 * An agent on macOS is the process group of a shell that waits for permission to start: the CLI must not
 * start writing before the job is persisted, and if ASIST exits first, the EOF on stdin ends the shell
 * before the exec. The prompt follows the permission on the same stdin: the shell's read takes only the
 * first line from a pipe, and the CLI reads the rest (see agent-cli).
 */
export const posixOwner: AgentOwner = {
  start(cli, args, { cwd, env, token }, events) {
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready && [ "$ready" = start ] && exec "$@"', 'asist-agent-launcher', cli, ...args], {
      cwd,
      env: { ...env, [AGENT_PROCESS_TOKEN]: token },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    if (child.pid !== undefined) watchForAsistEnd(child.pid, env, child)
    return { child, identity: () => captureProcessIdentity(child.pid!, token), lifetime: manageAgentProcess(child, token, events) }
  },
  recover: recoverAgentProcess
}
