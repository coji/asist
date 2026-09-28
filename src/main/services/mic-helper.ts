import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { OsFamily } from '@shared/platform'
import { childEnv } from './child-env'
import { nativeHelperPath } from './resource-path'

/**
 * Where the microphone helper of each OS is, and the check that decides at startup whether the Windows
 * helper can be used on this machine.
 */

const HELPERS: Record<OsFamily, string> = {
  macos: 'asist-mic',
  windows: 'asist-mic.exe'
}

/**
 * How long the check may take. It opens the microphone without starting it, and opening a Bluetooth
 * microphone took about 2 s on macOS (logged on 2026-09-26). The check runs before the window is created,
 * so this is also the longest it can delay the start of the app.
 */
const CHECK_TIMEOUT_MS = 5_000

/** The exit codes of `asist-mic.exe --check` that describe the machine rather than a failure of the check. */
const NO_ECHO_CANCELLATION = 3
const NO_DEVICE = 4

export const micHelperPath = (os: OsFamily): string => nativeHelperPath(os, HELPERS[os])

/**
 * What the check found. failed is true when the check itself did not work, which is a defect of the helper
 * or of the machine's audio stack rather than a microphone without echo cancellation.
 */
export type MicCheck = { cancelsEcho: true } | { cancelsEcho: false; failed: boolean; reason: string }

/**
 * Reads the result of `asist-mic.exe --check`. Only a check that exits normally and reports echo
 * cancellation as on counts, so a helper that exits 0 without saying so is taken as broken.
 */
export function readMicCheck(result: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stdout'>): MicCheck {
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return {
      cancelsEcho: false,
      failed: true,
      reason: timedOut ? `the check did not finish within ${CHECK_TIMEOUT_MS} ms` : `the check could not run: ${result.error.message}`
    }
  }
  if (result.status === 0) {
    if (/^echo-cancellation: on\r?$/m.test(result.stdout)) return { cancelsEcho: true }
    return { cancelsEcho: false, failed: true, reason: 'the check exited without reporting echo cancellation as on' }
  }
  if (result.status === NO_ECHO_CANCELLATION) {
    return { cancelsEcho: false, failed: false, reason: 'Windows does not cancel the echo on the default microphone' }
  }
  if (result.status === NO_DEVICE) return { cancelsEcho: false, failed: false, reason: 'no microphone could be opened' }
  return { cancelsEcho: false, failed: true, reason: `the check exited with ${result.status ?? result.signal ?? 'nothing'}` }
}

/**
 * Whether the Windows helper captures this machine's default microphone with the echo of everything the
 * machine plays cancelled. Without it the renderer captures through getUserMedia, whose echo canceller
 * removes only what Chromium plays.
 */
export function windowsMicCancelsEcho(): boolean {
  const result = spawnSync(micHelperPath('windows'), ['--check'], {
    encoding: 'utf8',
    env: childEnv(),
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true
  })
  for (const line of `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/)) {
    if (line.trim()) console.log(`native-mic: check: ${line}`)
  }
  const check = readMicCheck(result)
  if (check.cancelsEcho) return true
  const message = `native-mic: the microphone is captured through getUserMedia: ${check.reason}`
  if (check.failed) console.error(message)
  else console.log(message)
  return false
}
