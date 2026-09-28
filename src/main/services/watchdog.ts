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
}

let running = false
let inflight = false
let last: HealthSnapshot | null = null

export function start(onChange: (snap: HealthSnapshot) => void): void {
  if (running) return
  running = true

  const tick = async (): Promise<void> => {
    // These run ahead of the guard below, which skips whole ticks while a speech recognition model loads
    // for minutes. None spawns anything while its model is not prepared.
    const settings = getSettings()
    if (aizuchiClassifier.wanted(settings)) void aizuchiClassifier.ensureStarted()
    if (vap.wanted(settings)) void vap.restart()
    if (!embedding.running()) {
      void memory.startEmbeddingIfEnabled().catch((error) => console.error('memory embedding:', error))
    }
    if (inflight) return
    inflight = true
    try {
      let [asrUp, ttsUp] = await Promise.all([asr.available(), tts.available()])
      if (!asrUp) asrUp = await asr.revive()
      if (!ttsUp) {
        // ensureEngine leaves a process it already owns alone while that process is still coming up over
        // HTTP, and retries only after the process has exited or errored.
        void tts.ensureEngine().catch((error) => console.error('TTS engine failed to start:', error))
      }
      const snap: HealthSnapshot = { asr: asrUp, tts: ttsUp }
      if (snap.tts) aizuchi.ttsAnswered(last !== null && !last.tts)
      if (!last || last.asr !== snap.asr || last.tts !== snap.tts) {
        if (last) {
          console.log(
            `watchdog: asr ${last.asr}→${snap.asr}, tts ${last.tts}→${snap.tts}`
          )
        }
        last = snap
        onChange(snap)
      }
    } finally {
      inflight = false
    }
  }

  setInterval(() => void tick(), INTERVAL_MS)
  void tick()
}
