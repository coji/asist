import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { errorText } from '@shared/i18n/error-text'
import { nativeHelperPath } from '../resource-path'
import { STOP_DEADLINE_MS, type AgentEvents, type AgentOwner, type AgentProcess } from './owner'

/**
 * An agent on Windows runs inside the job object of asist-agent-launcher.exe, named after its token. The
 * launcher creates the CLI inside the job only once it has read "start", stops the job when ASIST ends,
 * and exits only once the job is empty, so its exit means that the CLI and every process it started are
 * gone. Windows has no process group to signal and reuses a PID at once, which is why the job, reached
 * through its name, takes the place of both.
 */

const launcherPath = (): string => nativeHelperPath('windows', 'asist-agent-launcher.exe')

/** Stops the job of a token and resolves once it is empty, or at once when no job has the token. */
function stopJob(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(launcherPath(), ['--stop', token], { windowsHide: true, timeout: 10_000 }, (error) => (error ? reject(error) : resolve()))
  })
}

/** One stop of a running agent, from the first `--stop` to the launcher's exit or the deadline. */
interface Stop {
  done: Promise<void>
  resolve: () => void
  /** Ends this stop, whether it failed or its launcher exited; the next stop starts over. */
  end: () => void
}

/** Owns the agent until the launcher has exited, which it does only once its job is empty. */
function ownLauncher(child: ChildProcess, token: string, events: AgentEvents): AgentProcess {
  let finished = false
  let stopping: Stop | undefined
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  child.once('close', (code: number | null) => {
    finished = true
    const current = stopping
    current?.end()
    try {
      events.onClose(code)
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    current?.resolve()
  })
  const stop = (): Promise<void> => {
    if (finished) return completion
    if (stopping) return stopping.done
    let ended = false
    let resend: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let resolveStop!: () => void
    let rejectStop!: (error: Error) => void
    const done = new Promise<void>((settled, failed) => { resolveStop = settled; rejectStop = failed })
    // A caller may leave the stop's outcome to onStopFailed and never wait for it.
    void done.catch(() => {})
    const current: Stop = {
      done,
      resolve: resolveStop,
      end: () => {
        ended = true
        clearTimeout(resend)
        clearTimeout(deadline)
        if (stopping === current) stopping = undefined
      }
    }
    // Ownership is not given up when a stop fails: a late exit of the launcher still settles the job, and
    // the next stop sends `--stop` again.
    const failed = (error: Error): void => {
      if (ended) return
      current.end()
      events.onStopFailed(error)
      rejectStop(error)
    }
    // A stop that reaches the launcher before it has created its job finds nothing to stop, and the
    // launcher, which has been sent "start", would then run the CLI. So the stop is sent again until the
    // launcher has exited; once the job exists, the launcher keeps the stop even before the CLI does.
    const send = (): void => {
      stopJob(token).then(
        () => {
          if (!ended) resend = setTimeout(send, 100)
        },
        () => failed(new Error(errorText('jobs.process.exitUnconfirmed')))
      )
    }
    deadline = setTimeout(() => failed(new Error(errorText('jobs.process.stopTimedOut'))), STOP_DEADLINE_MS)
    stopping = current
    send()
    return done
  }
  return { completion, stop }
}

export const windowsOwner: AgentOwner = {
  start(cli, args, { cwd, env, token }, events) {
    const child = spawn(launcherPath(), ['--run', token, String(process.pid), cli, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Only the token finds the job again; the PID of the launcher is kept for the record.
    return { child, identity: () => ({ pid: child.pid!, startedAt: new Date().toISOString(), token }), lifetime: ownLauncher(child, token, events) }
  },
  // The launcher of the earlier run stopped its job when that run ended, so this finds it gone unless
  // the launcher was itself still stopping it.
  recover(identity, onStopped) {
    let running = false
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    void completion.catch(() => {})
    const stop = (): Promise<void> => {
      if (running) return completion
      running = true
      stopJob(identity.token).then(
        () => {
          onStopped()
          resolve()
        },
        () => reject(new Error(errorText('jobs.process.staleSignalFailed')))
      )
      return completion
    }
    return { completion, stop }
  }
}
