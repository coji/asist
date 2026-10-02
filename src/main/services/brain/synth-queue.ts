import type { SpeechSegment } from '@shared/ipc'

/**
 * The sentence-by-sentence TTS pipeline, which runs serially within a turn. Each request is emitted
 * as a segment as soon as its audio exists, so request N+1 can be synthesized while request N is
 * still playing. A streaming engine's segment is emitted with its first piece and the rest follows
 * as audio events. `take` decides how many of the waiting sentences one request reads.
 */

export type SynthesizedSentence =
  | { kind: 'whole'; audio: string | null; phonemes: SpeechSegment['phonemes'] }
  | { kind: 'stream'; sampleRate: number; pieces: AsyncIterable<Float32Array> }

export interface SynthQueueOptions {
  turnId: number
  signal: AbortSignal
  synthesize: (text: string, signal: AbortSignal) => Promise<SynthesizedSentence>
  /** The text of the next request out of the sentences waiting, and how many of them it reads. One at a time without it. */
  take?: (waiting: readonly string[]) => { text: string; count: number }
  emitSegment: (segment: SpeechSegment) => void
  /** Receives the next samples of the streamed segment `index`. `last` is sent exactly once per streamed segment, even when it fails or is aborted. */
  emitAudio: (index: number, samples: Float32Array, last: boolean) => void
  /** Receives the time until the first sentence had audio to play, which is reported as ttsMs. */
  onFirstSynth?: (ms: number) => void
  /**
   * Receives the first synthesis failure of the turn, and only the first: a speech engine that cannot
   * read the conversation language fails on every sentence, so one turn would otherwise raise as many
   * alarms as it has sentences.
   */
  onFailure: (err: unknown) => void
}

export class SynthQueue {
  private queue: string[] = []
  private index = 0
  private running = false
  private firstDone = false
  private failureReported = false

  constructor(private readonly options: SynthQueueOptions) {}

  push(text: string): void {
    this.queue.push(text)
    if (!this.running) void this.run()
  }

  private async run(): Promise<void> {
    const { turnId, signal, synthesize, take, emitSegment, emitAudio, onFirstSynth, onFailure } = this.options
    this.running = true
    while (this.queue.length > 0 && !signal.aborted) {
      const { text, count } = take ? take(this.queue) : { text: this.queue[0], count: 1 }
      this.queue.splice(0, count)
      const t0 = Date.now()
      try {
        const result = await synthesize(text, signal)
        if (signal.aborted) break
        if (!this.firstDone) {
          this.firstDone = true
          onFirstSynth?.(Date.now() - t0)
        }
        const index = this.index++
        if (result.kind === 'whole') {
          emitSegment({ turnId, index, text, audio: result.audio, phonemes: result.phonemes })
          continue
        }
        emitSegment({ turnId, index, text, audio: null, phonemes: null, stream: { sampleRate: result.sampleRate } })
        try {
          for await (const samples of result.pieces) {
            if (signal.aborted) break
            emitAudio(index, samples, false)
          }
        } finally {
          // A sentence that breaks off is played as far as it came, and the player must not wait for more.
          emitAudio(index, new Float32Array(0), true)
        }
      } catch (err) {
        if (signal.aborted) break
        // The speech engine stopped this sentence because the user chose another one, which reads the rest.
        if (err instanceof DOMException && err.name === 'AbortError') continue
        // The reply itself is already on screen and the sentences after this one may still be
        // spoken, so a failure skips the sentence instead of ending the turn. It does not pass in
        // silence either: the user is told once, because a setting that leaves the engine unable to
        // speak the language of the conversation would otherwise only show up as a missing voice.
        if (!this.failureReported) {
          this.failureReported = true
          onFailure(err)
        }
      }
    }
    this.running = false
  }

  /** Waits until the queue is empty, and returns immediately on abort. */
  async drain(): Promise<void> {
    while (this.running && !this.options.signal.aborted) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
