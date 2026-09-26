import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { Float32StreamReader } from '@shared/pcm-stream'
import type { NativeMicStartResult } from '@shared/ipc'
import { childEnv } from './child-env'

/**
 * The lifecycle of the asist-mic helper, which captures the microphone through macOS voice processing.
 *
 * The helper streams 48 kHz mono float32 to stdout continuously. It follows a change of the device's
 * format itself, but when the default device changes it exits with code 2 and is respawned here, and
 * when the format keeps changing it exits with code 5 and capture is given up. Any other abnormal exit
 * is retried for a short while and then reported through onDown, after which the renderer switches to
 * getUserMedia. Closing stdin is how the helper is told to stop.
 */

const SAMPLE_RATE = 48_000
/**
 * How long the first frame may take after each spawn. Initializing the audio engine costs a few hundred
 * ms, and opening a Bluetooth microphone about 2 s (logged on 2026-09-26), so a helper respawned after a
 * device change gets the whole time again.
 */
const FIRST_FRAME_TIMEOUT_MS = 5_000
/** How long to wait before respawning after a device change, which the helper reports as exit code 2. */
const RECONFIGURE_DELAY_MS = 300
/**
 * How long a whole start may take: the first spawn and one respawn after a device change. Helpers that
 * keep exiting just before their own deadline would otherwise leave the microphone starting for tens of
 * seconds.
 */
const START_TIMEOUT_MS = 2 * FIRST_FRAME_TIMEOUT_MS + RECONFIGURE_DELAY_MS
/** How many unexpected exits are retried within CRASH_WINDOW_MS before giving up. */
const CRASH_RETRY_LIMIT = 2
const CRASH_WINDOW_MS = 10_000
/**
 * More changes than this inside CONFIG_WINDOW_MS mean VPIO itself is unstable, so capture is given up. It
 * counts the respawns after a device change here, and the helper counts the changes of format it follows.
 */
const CONFIG_RESTART_LIMIT = 3
const CONFIG_WINDOW_MS = 30_000
/** How long frames may stop arriving from a helper that is still alive before it is respawned, which is how a degraded VPIO stuck in silence is recovered. */
const FRAME_STALL_MS = 4_000
const WATCHDOG_INTERVAL_MS = 2_000

type FrameHandler = (frame: Float32Array) => void
type DownHandler = (reason: string) => void

let child: ChildProcessWithoutNullStreams | null = null
let generation = 0
let onFrame: FrameHandler | null = null
let onDown: DownHandler | null = null
/** A start() that has not settled. A permanent failure before it settles is reported as ok:false rather than through onDown. */
interface PendingStart {
  settle: (result: NativeMicStartResult) => void
  /** Starts the first-frame deadline over for a helper that has just been spawned. */
  armDeadline: () => void
}
let pendingStart: PendingStart | null = null
let crashTimestamps: number[] = []
let configRestartTimestamps: number[] = []
let lastFrameAt = 0
let watchdogTimer: NodeJS.Timeout | null = null
let quitHookRegistered = false

function binaryPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'asist-mic')
    : path.join(app.getAppPath(), 'resources', 'native', 'asist-mic')
}

export function available(): boolean {
  return process.platform === 'darwin' && fs.existsSync(binaryPath())
}

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => stop())
}

/** Reports a permanent failure: ok:false when capture has not started, onDown once it is running, which makes the renderer switch to getUserMedia. */
function giveUp(reason: string): void {
  console.warn(`native-mic: ${reason}; giving up`)
  const pending = pendingStart
  const notify = onDown
  onFrame = null
  onDown = null
  stopWatchdog()
  if (pending) {
    pending.settle({ ok: false, sampleRate: SAMPLE_RATE, reason })
    return
  }
  notify?.(reason)
}

function stopWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer)
  watchdogTimer = null
}

/** Kills the helper when it is alive but frames have stopped arriving, which is the degraded VPIO state, so that it is respawned. */
function startWatchdog(): void {
  stopWatchdog()
  watchdogTimer = setInterval(() => {
    if (!child || !onFrame) return
    if (Date.now() - lastFrameAt <= FRAME_STALL_MS) return
    console.warn('native-mic: no frames from helper; killing for restart')
    // Pushing the timestamp forward keeps the watchdog from killing again while the respawn is pending.
    lastFrameAt = Date.now()
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }, WATCHDOG_INTERVAL_MS)
  watchdogTimer.unref?.()
}

function spawnHelper(myGeneration: number): void {
  const spawned = spawn(binaryPath(), [String(CONFIG_RESTART_LIMIT), String(CONFIG_WINDOW_MS / 1000)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(),
    windowsHide: true
  })
  child = spawned
  lastFrameAt = Date.now()
  pendingStart?.armDeadline()
  const reader = new Float32StreamReader()

  spawned.stdout.on('data', (chunk: Buffer) => {
    if (generation !== myGeneration || child !== spawned) return
    const frame = reader.push(chunk)
    if (frame && frame.length > 0) {
      lastFrameAt = Date.now()
      onFrame?.(frame)
    }
  })
  readline.createInterface({ input: spawned.stderr }).on('line', (line) => {
    if (line.trim()) console.log(`native-mic: ${line}`)
  })

  const fail = (reason: string): void => {
    if (generation !== myGeneration || child !== spawned) return
    child = null
    const now = Date.now()
    crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS)
    crashTimestamps.push(now)
    if (crashTimestamps.length <= CRASH_RETRY_LIMIT) {
      console.warn(`native-mic: ${reason}; restarting`)
      setTimeout(() => {
        if (generation === myGeneration && onFrame) spawnHelper(myGeneration)
      }, RECONFIGURE_DELAY_MS)
      return
    }
    giveUp(reason)
  }

  spawned.on('error', (error) => fail(`helper error: ${error.message}`))
  spawned.on('exit', (code, signal) => {
    if (generation !== myGeneration || child !== spawned) return
    if (code === 5) {
      child = null
      giveUp('audio configuration keeps changing')
      return
    }
    if (code === 2) {
      // A new default device settles after a single restart. Repeating within a short window means
      // voice processing itself has become unstable and entered its degraded mode, so capture moves to
      // getUserMedia instead.
      child = null
      const now = Date.now()
      configRestartTimestamps = configRestartTimestamps.filter((t) => now - t < CONFIG_WINDOW_MS)
      configRestartTimestamps.push(now)
      if (configRestartTimestamps.length > CONFIG_RESTART_LIMIT) {
        giveUp('audio configuration keeps changing')
        return
      }
      console.log('native-mic: audio device changed; restarting helper')
      setTimeout(() => {
        if (generation === myGeneration && onFrame) spawnHelper(myGeneration)
      }, RECONFIGURE_DELAY_MS)
      return
    }
    fail(`helper exited (${code ?? signal ?? 'unknown'})`)
  })
}

/**
 * Starts capture and resolves ok=true on the first frame that is not all zeros. Without microphone
 * permission macOS keeps delivering exactly zero-filled frames, so seeing nothing but silence until the
 * timeout resolves ok=false; the caller then switches to getUserMedia, where the permission error
 * surfaces properly. An environment that cannot start at all, with the binary missing or voice
 * processing unavailable, also resolves ok=false.
 */
export function start(frameHandler: FrameHandler, downHandler: DownHandler): Promise<NativeMicStartResult> {
  stop()
  registerQuitHook()
  if (!available()) {
    return Promise.resolve({ ok: false, sampleRate: SAMPLE_RATE, reason: 'the asist-mic helper is missing' })
  }
  const myGeneration = ++generation
  crashTimestamps = []
  configRestartTimestamps = []
  onDown = downHandler
  startWatchdog()

  return new Promise((resolve) => {
    let deadline: NodeJS.Timeout | null = null
    let sawSilentFrames = false
    const expire = (): void => {
      if (pendingStart !== pending) return
      pending.settle({
        ok: false,
        sampleRate: SAMPLE_RATE,
        reason: sawSilentFrames
          ? 'only silent frames arrived from the microphone'
          : 'the native microphone capture did not start'
      })
      if (generation === myGeneration) stop()
    }
    const limit = setTimeout(expire, START_TIMEOUT_MS)
    limit.unref?.()
    const pending: PendingStart = {
      settle: (result) => {
        if (pendingStart !== pending) return
        pendingStart = null
        clearTimeout(limit)
        if (deadline) clearTimeout(deadline)
        deadline = null
        resolve(result)
      },
      armDeadline: () => {
        if (deadline) clearTimeout(deadline)
        deadline = setTimeout(expire, FIRST_FRAME_TIMEOUT_MS)
        deadline.unref?.()
      }
    }
    pendingStart = pending

    onFrame = (frame) => {
      if (pendingStart === pending) {
        // Without microphone permission the frames are exactly zero-filled, so the start counts as
        // successful only once real audio arrives; a real microphone always has a non-zero noise floor.
        if (!frame.some((sample) => sample !== 0)) {
          sawSilentFrames = true
          return
        }
        pending.settle({ ok: true, sampleRate: SAMPLE_RATE })
      }
      frameHandler(frame)
    }
    try {
      spawnHelper(myGeneration)
    } catch (error) {
      pending.settle({ ok: false, sampleRate: SAMPLE_RATE, reason: error instanceof Error ? error.message : String(error) })
      if (generation === myGeneration) stop()
    }
  })
}

export function stop(): void {
  generation++
  onFrame = null
  onDown = null
  pendingStart?.settle({ ok: false, sampleRate: SAMPLE_RATE, reason: 'the native microphone start was cancelled' })
  stopWatchdog()
  const stale = child
  child = null
  if (stale && stale.exitCode === null && !stale.killed) {
    // Closing stdin makes the helper exit on EOF by itself; the kill below is the fallback.
    try {
      stale.stdin.end()
    } catch {
      // The stream is already closed.
    }
    const killTimer = setTimeout(() => {
      if (stale.exitCode === null && !stale.killed) stale.kill('SIGTERM')
    }, 1_000)
    killTimer.unref?.()
  }
}
