import type { Bytes } from '../fetch-range'

/**
 * The part of a range read in pieces that a reader still needs. The reader works on `bytes` and asks for more
 * once it has to look past them, saying where it has got to, and what lies before that point is let go.
 */
export class HeldBytes {
  /** The bytes held, which start at `start` in the file. */
  bytes: Bytes = new Uint8Array(0)
  start: number
  /** Whether the range has no piece left beyond what is held. */
  ended = false
  private readonly pieces: AsyncIterator<Bytes>

  constructor(pieces: AsyncIterable<Bytes>, start: number) {
    this.pieces = pieces[Symbol.asyncIterator]()
    this.start = start
  }

  get end(): number {
    return this.start + this.bytes.length
  }

  /**
   * Reads the next piece onto the bytes held from `from` on, and lets go of the rest. False when the range has
   * ended, which leaves the bytes as they are.
   */
  async more(from: number): Promise<boolean> {
    const next = await this.pieces.next()
    if (next.done) {
      this.ended = true
      return false
    }
    const keepFrom = Math.min(Math.max(from, this.start), this.end)
    const kept = this.bytes.subarray(keepFrom - this.start)
    if (kept.length === 0) {
      this.bytes = next.value
    } else {
      const joined = new Uint8Array(kept.length + next.value.length)
      joined.set(kept)
      joined.set(next.value, kept.length)
      this.bytes = joined
    }
    this.start = keepFrom
    return true
  }

  /** Stops reading, so that the piece asked for ahead is not waited for. */
  async close(): Promise<void> {
    await this.pieces.return?.()
  }
}
