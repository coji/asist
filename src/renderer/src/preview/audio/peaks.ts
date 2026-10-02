/**
 * How many peaks a recording is split into, by the length its header gives; the card draws its bars from them.
 * The length is only known for certain once the whole recording is decoded, and peaks finer than the bars keep
 * the drawing right when the header was wrong by a few times.
 */
export const PEAKS = 2000

/**
 * The peaks of a recording, added in order as it is decoded: the largest amplitude in each stretch of
 * `framesPerPeak` frames, a frame being one sample of every channel.
 */
export class PeakTrack {
  readonly framesPerPeak: number
  /** The frames added so far. */
  frames = 0
  private values = new Float32Array(PEAKS)
  private finished = 0
  /** The largest amplitude of the peak being filled, and how many frames it holds. */
  private current = 0
  private filled = 0

  constructor(
    readonly sampleRate: number,
    expectedSeconds: number
  ) {
    this.framesPerPeak = Math.max(1, Math.round((expectedSeconds * sampleRate) / PEAKS))
  }

  /** How many more frames the peak being filled takes. */
  get room(): number {
    return this.framesPerPeak - this.filled
  }

  /** The peaks that are complete. */
  get count(): number {
    return this.finished
  }

  get peakSeconds(): number {
    return this.framesPerPeak / this.sampleRate
  }

  get seconds(): number {
    return this.frames / this.sampleRate
  }

  /** Adds `frames` frames, no more than `room`, whose largest amplitude is `peak`. */
  add(peak: number, frames: number): void {
    if (peak > this.current) this.current = peak
    this.filled += frames
    this.frames += frames
    if (this.filled >= this.framesPerPeak) this.close()
  }

  /** Adds `length` frames held in one array for each of the first `channels` arrays. */
  addChannels(planes: readonly Float32Array[], channels: number, length: number): void {
    for (let at = 0; at < length; ) {
      const take = Math.min(this.room, length - at)
      const end = at + take
      let peak = 0
      for (let c = 0; c < channels; c++) {
        const plane = planes[c]
        for (let i = at; i < end; i++) {
          const value = plane[i] < 0 ? -plane[i] : plane[i]
          if (value > peak) peak = value
        }
      }
      this.add(peak, take)
      at = end
    }
  }

  /** Ends the recording, completing the peak being filled with the frames it holds. */
  end(): void {
    if (this.filled > 0) this.close()
  }

  /** The complete peaks from `from` on, in a buffer of their own. */
  peaks(from: number): Float32Array {
    return this.values.slice(from, this.finished)
  }

  private close(): void {
    if (this.finished === this.values.length) {
      const grown = new Float32Array(this.values.length * 2)
      grown.set(this.values)
      this.values = grown
    }
    this.values[this.finished++] = this.current
    this.current = 0
    this.filled = 0
  }
}
