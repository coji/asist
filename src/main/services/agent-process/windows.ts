import { execFile, spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import type { AgentOwner, AgentProcess } from './owner'

/**
 * An agent on Windows runs inside the job object of asist-agent-launcher.exe, named after its token. The
 * launcher creates the CLI inside the job only once it has read "start", stops the job when ASIST ends,
 * and exits only once the job is empty, so its exit means that the CLI and every process it started are
 * gone. Windows has no process group to signal and reuses a PID at once, which is why the job, reached
 * through its name, takes the place of both.
 */

function launcherPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'asist-agent-launcher.exe')
    : path.join(app.getAppPath(), 'resources', 'native', 'windows', 'asist-agent-launcher.exe')
}

/** Stops the job of a token and resolves once it is empty, or at once when no job has the token. */
function stopJob(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(launcherPath(), ['--stop', token], { windowsHide: true, timeout: 10_000 }, (error) => (error ? reject(error) : resolve()))
  })
}

/** Owns the agent until the launcher has exited, which it does only once its job is empty. */
function ownLauncher(child: ChildProcess, token: string, onClose: (code: number | null) => void): AgentProcess {
  let finished = false
  let stopping = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  let resend: ReturnType<typeof setTimeout> | undefined
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  child.once('close', (code: number | null) => {
    finished = true
    clearTimeout(deadline)
    clearTimeout(resend)
    onClose(code)
    resolve()
  })
  const stop = (): void => {
    if (finished || stopping) return
    stopping = true
    let expired = false
    // A stop that reaches the launcher before it has created its job finds nothing to stop, and the
    // launcher, which has been sent "start", would then run the CLI. So the stop is sent again until the
    // launcher has exited; once the job exists, the launcher keeps the stop even before the CLI does.
    const send = (): void => {
      stopJob(token).then(
        () => {
          if (!finished && !expired) resend = setTimeout(send, 100)
        },
        () => reject(new Error(errorText('jobs.process.exitUnconfirmed')))
      )
    }
    send()
    // Ownership is not given up after the deadline: a late exit of the launcher still settles the job.
    deadline = setTimeout(() => {
      expired = true
      reject(new Error(errorText('jobs.process.stopTimedOut')))
    }, 5_000)
  }
  return { completion, stop }
}

export const windowsOwner: AgentOwner = {
  start(cli, args, { cwd, env, token }, onClose) {
    const child = spawn(launcherPath(), ['--run', token, String(process.pid), cli, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Only the token finds the job again; the PID of the launcher is kept for the record.
    return { child, identity: () => ({ pid: child.pid!, startedAt: new Date().toISOString(), token }), lifetime: ownLauncher(child, token, onClose) }
  },
  // The launcher of the earlier run stopped its job when that run ended, so this finds it gone unless
  // the launcher was itself still stopping it.
  recover(identity, onStopped) {
    let running = false
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    void completion.catch(() => {})
    const stop = (): void => {
      if (running) return
      running = true
      stopJob(identity.token).then(
        () => {
          onStopped()
          resolve()
        },
        () => reject(new Error(errorText('jobs.process.staleSignalFailed')))
      )
    }
    return { completion, stop }
  }
}
