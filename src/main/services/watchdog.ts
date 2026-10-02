import type { AppSettings } from '@shared/ipc'
import * as asr from './asr'
import * as tts from './tts'
import * as aizuchi from './aizuchi'
import * as aizuchiClassifier from './aizuchi-classifier'
import * as embedding from './embedding'
import * as memory from './memory'
import * as vap from './vap'
import { getSettings } from './settings'

/**
 * Health monitoring for the speech recognition and TTS engine sidecars, which tries to restart one that has
 * died. It also restarts the aizuchi classifier, the memory embedding worker and the VAP worker after a
 * timeout or a crash: nothing else starts the first two again, and the VAP worker would come back only
 * when the microphone is next turned on. onChange runs only when the snapshot differs from the previous
 * one, because the renderer treats every call as a status change to push.
 */

const INTERVAL_MS = 30_000
/** The longest wait between two of the watchdog's starts of a speech engine that does not come up. */
const MAX_RESTART_WAIT_MS = 10 * 60_000
/** A check from the timer can come slightly before a wait has passed by Date.now(), which the timer does not run on. */
const CLOCK_SLACK_MS = 1_000

/**
 * The watchdog's starts of one speech engine that does not come up. Each start of llama-server or of
 * speech.cpp's worker loads 1.5 to 3.4 GB of weights, which one that keeps failing to load would repeat at
 * every check, so the wait between two starts doubles from one check up to MAX_RESTART_WAIT_MS. It is one
 * check again once the engine answers or the settings choose another engine or model. A start the
 * conversation asks for, to transcribe or to read a sentence, does not wait.
 */
class Restarts {
  /** What the settings chose when the waits began, which a new choice starts over from. */
  private chosen: string | null = null
  private count = 0
  private lastAt = 0

  /** Whether the engine the settings now choose, named by `chosen`, is due to be started. */
  due(chosen: string): boolean {
    if (chosen !== this.chosen) {
      this.chosen = chosen
      this.count = 0
    }
    if (this.count === 0) return true
    const wait = Math.min(INTERVAL_MS * 2 ** (this.count - 1), MAX_RESTART_WAIT_MS)
    return Date.now() - this.lastAt >= wait - CLOCK_SLACK_MS
  }

  started(): void {
    this.count++
    this.lastAt = Date.now()
  }

  answered(): void {
    this.count = 0
  }
}

const asrRestarts = new Restarts()
const ttsRestarts = new Restarts()
const chosenTts = (settings: AppSettings): string => (settings.ttsEngine === 'qwen3tts' ? `qwen3tts:${settings.qwenTtsSize}` : settings.ttsEngine)

export interface HealthSnapshot {
  asr: boolean
  tts: boolean
  /** The TTS engine is loading, which the screens tell apart from an engine that is missing. */
  ttsStarting: boolean
}

let running = false
let inflight = false
/** A check asked for while another ran, which runs once that one ends, since the state may have changed after it read it. */
let again = false
/** A check that tells the screens its snapshot even when it has not changed. */
let forced = false
let last: HealthSnapshot | null = null
let notify: (snap: HealthSnapshot) => void = () => {}

/**
 * Reads whether speech recognition and the TTS engine answer, tries to start one that does not, and passes
 * a snapshot that differs from the previous one to onChange, or any snapshot when `force` is set.
 */
export async function checkHealth(force = false): Promise<void> {
  if (!running) return
  forced ||= force
  if (inflight) {
    again = true
    return
  }
  inflight = true
  try {
    const push = forced
    forced = false
    const settings = getSettings()
    let [asrUp, ttsUp] = await Promise.all([asr.available(), tts.available()])
    if (!asrUp && asrRestarts.due(settings.asrModel)) {
      asrRestarts.started()
      // A start that throws, as in a build without llama-server, leaves speech recognition down, which the
      // screens are told like any other outcome.
      asrUp = await asr.revive().catch((error: unknown) => {
        console.error('speech recognition failed to start:', error)
        return false
      })
    }
    if (asrUp) asrRestarts.answered()
    if (!ttsUp && ttsRestarts.due(chosenTts(settings))) {
      ttsRestarts.started()
      // ensureEngine leaves a process it already owns alone while that process is still coming up over
      // HTTP, and retries only after the process has exited or errored.
      void tts.ensureEngine().catch((error) => console.error('TTS engine failed to start:', error))
    }
    if (ttsUp) ttsRestarts.answered()
    const snap: HealthSnapshot = { asr: asrUp, tts: ttsUp, ttsStarting: !ttsUp && tts.engineStarting() }
    if (snap.tts) aizuchi.ttsAnswered(last !== null && !last.tts)
    if (push || !last || last.asr !== snap.asr || last.tts !== snap.tts || last.ttsStarting !== snap.ttsStarting) {
      if (last && (last.asr !== snap.asr || last.tts !== snap.tts)) {
        console.log(
          `watchdog: asr ${last.asr}→${snap.asr}, tts ${last.tts}→${snap.tts}`
        )
      }
      last = snap
      notify(snap)
    }
  } finally {
    inflight = false
    if (again) {
      again = false
      void checkHealth()
    }
  }
}

/**
 * Checks once the start of a speech engine has settled, so that the screens learn the outcome then rather
 * than from the next periodic check up to 30 seconds later. The snapshot goes to them even when it has not
 * changed: a screen reads the status itself after changing a setting, and one that read it while the engine
 * was loading would otherwise keep showing it loading after a start that failed. The caller handles the
 * start's failure.
 */
export function checkAfter(starting: Promise<unknown>): void {
  const settled = (): Promise<void> => checkHealth(true)
  void starting.then(settled, settled)
}

export function start(onChange: (snap: HealthSnapshot) => void): void {
  if (running) return
  running = true
  notify = onChange

  const tick = (): void => {
    // These run ahead of the health check, which skips whole ticks while a speech recognition model loads
    // for minutes. None spawns anything while its model is not prepared.
    const settings = getSettings()
    if (aizuchiClassifier.wanted(settings)) void aizuchiClassifier.ensureStarted()
    if (vap.wanted(settings)) void vap.restart()
    if (!embedding.running()) {
      void memory.startEmbeddingIfEnabled().catch((error) => console.error('memory embedding:', error))
    }
    void checkHealth()
  }

  setInterval(tick, INTERVAL_MS)
  tick()
}
