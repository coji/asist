import type { ConversationLocale } from '@shared/conversation-locale'
import type { TurnEvent } from '@shared/ipc'
import * as tts from '../tts'
import { errMessage } from '@shared/api-errors'
import { SynthQueue } from './synth-queue'

/**
 * Where the sentences the brain produces are spoken.
 *
 * - tts: the classic setup, which synthesizes each sentence with the chosen speech engine and sends
 *   it to the renderer's playback queue as a segment.
 * - silent: text-to-speech is off, so nothing is produced.
 * - live: the sentences go to the voice model (GPT-Live), which reads them in its own voice. It also
 *   produces the aizuchi and the fillers spoken while work is running, so the brain does not.
 *
 * runTurn knows none of this: it pushes sentences into the SpeechSink returned by open() and waits on
 * drain(). A live engine registers the route with the session, and a route can also be overridden for
 * a single turn, which the engines and the tests rely on.
 */

export interface SpeechSink {
  push(sentence: string): void
  /** Resolves once every pushed sentence has been sent, and returns immediately on abort. */
  drain(): Promise<void>
}

export interface SpeechRouteContext {
  turnId: number
  signal: AbortSignal
  emit: (event: TurnEvent) => void
  /** The language the sentences are written in, which the voice reads them in. */
  locale: ConversationLocale
}

export interface SpeechRoute {
  kind: 'tts' | 'live' | 'silent'
  open(ctx: SpeechRouteContext): SpeechSink
}

/** The classic setup. The synthesis time of the first sentence is reported as ttsMs in the metrics. */
export const ttsRoute: SpeechRoute = {
  kind: 'tts',
  open: ({ turnId, signal, emit, locale }) =>
    new SynthQueue({
      turnId,
      signal,
      synthesize: (text, s) => tts.synthesizeSentence(text, locale, s),
      emitSegment: (segment) => emit({ type: 'segment', turnId, segment }),
      emitAudio: (index, samples, last) => emit({ type: 'segmentAudio', turnId, index, samples, last }),
      onFirstSynth: (ms) => emit({ type: 'metrics', turnId, timings: { ttsMs: ms } }),
      onFailure: (err) => emit({ type: 'error', turnId, message: errMessage(err) })
    })
}

/** With text-to-speech off nothing is synthesized or played, and the reply reaches the user only as text deltas in the feed. */
export const silentRoute: SpeechRoute = {
  kind: 'silent',
  open: () => ({ push: () => {}, drain: () => Promise.resolve() })
}

/**
 * The route that hands sentences to the voice model. `say` sends one sentence and opens the
 * connection first if it is closed. Pushes are chained one after another, because the sentences have
 * to be read in the order they were sent.
 */
export function liveRoute(say: (sentence: string, signal: AbortSignal) => Promise<void>): SpeechRoute {
  return {
    kind: 'live',
    open: ({ signal }) => {
      let tail: Promise<void> = Promise.resolve()
      return {
        push: (sentence) => {
          const text = sentence.trim()
          if (!text) return
          tail = tail.then(() => (signal.aborted ? undefined : say(text, signal))).catch((err) => {
            if (!signal.aborted) console.error('live speech route failed:', err)
          })
        },
        drain: () => tail
      }
    }
  }
}
