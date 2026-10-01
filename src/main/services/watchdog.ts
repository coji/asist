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
    let [asrUp, ttsUp] = await Promise.all([asr.available(), tts.available()])
    if (!asrUp) asrUp = await asr.revive()
    if (!ttsUp) {
      // ensureEngine leaves a process it already owns alone while that process is still coming up over
      // HTTP, and retries only after the process has exited or errored.
      void tts.ensureEngine().catch((error) => console.error('TTS engine failed to start:', error))
    }
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
