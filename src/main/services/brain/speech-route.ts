import type { ConversationLocale } from '@shared/conversation-locale'
import type { TurnEvent } from '@shared/ipc'
import * as tts from '../tts'
import { errMessage } from '@shared/api-errors'
import { SynthQueue } from './synth-queue'

/**
 * Where the sentences the brain produces are spoken.
 *
 * - tts: synthesizes each sentence with the chosen speech engine and sends it to the renderer's
 *   playback queue as a segment.
 * - silent: text-to-speech is off, so nothing is produced.
 *
 * runTurn knows none of this: it pushes sentences into the SpeechSink returned by open() and waits on
 * drain(). The session picks the route from the settings, and a caller can fix the route of a single
 * turn, as job reporting does to judge the delivery by the route the report was spoken through.
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
  kind: 'tts' | 'silent'
  open(ctx: SpeechRouteContext): SpeechSink
}

/** The synthesis time of the first sentence is reported as ttsMs in the metrics. */
export const ttsRoute: SpeechRoute = {
  kind: 'tts',
  open: ({ turnId, signal, emit, locale }) =>
    new SynthQueue({
      turnId,
      signal,
      synthesize: (text, s) => tts.synthesizeSentence(text, locale, s),
      take: (waiting) => tts.nextRequest(waiting, locale),
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
