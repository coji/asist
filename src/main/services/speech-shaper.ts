/**
 * Shapes the raw output of the local engines while it streams. Measured on 2026-09-21 over 20 Japanese
 * generations of Qwen3-TTS with four voices: a generation starts with 0.2 to 0.75 s of silence and ends
 * with 0.3 to 1.0 s of it, which would delay the first word and leave gaps of over a second between
 * sentences; and the level of one voice varies between generations by 15 dB (voiced RMS 0.011 to
 * 0.056 for `ono_anna`). A 20 ms frame counts as voiced from an RMS of 0.004.
 *
 * The shaper drops the leading silence, holds silence back until voiced audio follows it so that
 * the trailing silence can be cut to a short tail, and brings the voiced level to a common target.
 */

const FRAME_SECONDS = 0.02
const VOICED_FRAME_RMS = 0.004
/**
 * The level that still belongs to the voice around its voiced frames: the breath before a word and the decay
 * after the last one. Measured on 2026-10-01 in 20 raw readings of Qwen3-TTS 0.6B with two voices, the noise
 * floor before the voice had a median RMS of 0.00024 (0.001 at the 90th percentile), while frames from 0.001
 * up ran 40 ms before the first voiced frame in the median, 80 ms at the 90th percentile and 120 ms at most,
 * and 50 ms after the last one, 180 ms at the 90th percentile and 460 ms at most. Keeping one frame before the
 * voice and 100 ms after it took the breathy start off "はい" and cut the decay of a sentence's end.
 * Irodori-TTS, with a noise floor of 0.00014, has 40 ms of either at most.
 */
const TRAILING_RMS = 0.001
/** How far the start of the voice is followed back through quieter frames. */
const MAX_LEAD_FRAMES = 6
/** Frames kept after the last voiced frame: at least the shortest tail, and its decay up to the longest. */
const TAIL_FRAMES = 5
const MAX_TAIL_FRAMES = 15
/** The voiced RMS the louder voices produce on their own, which is also about the level of VOICEVOX. */
const TARGET_RMS = 0.07
const MIN_GAIN = 0.5
const MAX_GAIN = 6
const PEAK_CEILING = 0.95
/** A change of gain between two pieces is spread over this many frames. */
const GAIN_RAMP_FRAMES = 5

interface Frame {
  samples: Float32Array
  rms: number
}

export class SpeechShaper {
  private readonly frameSize: number
  private carry = new Float32Array(0)
  private started = false
  /** The silent frames just before the voice starts, the most recent last. */
  private before: Frame[] = []
  private held: Frame[] = []
  private voicedSquares = 0
  private voicedSamples = 0
  private peak = 0
  private gain: number | null = null

  constructor(sampleRate: number) {
    this.frameSize = Math.round(sampleRate * FRAME_SECONDS)
  }

  /** Takes the next piece from the model and returns the samples that are ready to play, which may be none. */
  push(piece: Int16Array): Float32Array {
    const samples = new Float32Array(this.carry.length + piece.length)
    samples.set(this.carry)
    for (let i = 0; i < piece.length; i++) samples[this.carry.length + i] = piece[i] / 32768
    const frameCount = Math.floor(samples.length / this.frameSize)
    this.carry = samples.slice(frameCount * this.frameSize)

    const released: Float32Array[] = []
    for (let f = 0; f < frameCount; f++) {
      const frame = samples.subarray(f * this.frameSize, (f + 1) * this.frameSize)
      let squares = 0
      let peak = 0
      for (const value of frame) {
        squares += value * value
        peak = Math.max(peak, Math.abs(value))
      }
      const rms = Math.sqrt(squares / frame.length)
      if (rms < VOICED_FRAME_RMS) {
        if (this.started) this.held.push({ samples: frame, rms })
        else this.before = [...this.before, { samples: frame, rms }].slice(-(MAX_LEAD_FRAMES + 1))
        continue
      }
      this.voicedSquares += squares
      this.voicedSamples += frame.length
      this.peak = Math.max(this.peak, peak)
      if (!this.started) {
        this.started = true
        released.push(...this.lead().map((one) => one.samples))
        this.before = []
      }
      released.push(...this.held.map((one) => one.samples), frame)
      this.held = []
    }
    return this.level(released)
  }

  /** Returns the tail that ends the sentence: the decay of its last word and a short silence. */
  flush(): Float32Array {
    let decay = 0
    while (decay < this.held.length && decay < MAX_TAIL_FRAMES && this.held[decay].rms >= TRAILING_RMS) decay++
    const tail = this.started ? this.held.slice(0, Math.min(MAX_TAIL_FRAMES, Math.max(TAIL_FRAMES, decay + 1))) : []
    this.held = []
    this.carry = new Float32Array(0)
    return this.level(tail.map((one) => one.samples))
  }

  /** The frames before the first voiced one that belong to the voice, and one more, so that an onset is not clipped. */
  private lead(): Frame[] {
    let quiet = this.before.length
    while (quiet > 0 && this.before.length - quiet < MAX_LEAD_FRAMES && this.before[quiet - 1].rms >= TRAILING_RMS) quiet--
    return this.before.slice(Math.max(0, quiet - 1))
  }

  /** The whole piece is measured before any of it is released, so its own level already counts towards its gain. */
  private level(frames: Float32Array[]): Float32Array {
    const length = frames.reduce((sum, frame) => sum + frame.length, 0)
    const output = new Float32Array(length)
    if (length === 0) return output
    const rms = Math.sqrt(this.voicedSquares / Math.max(1, this.voicedSamples))
    const target = Math.min(Math.max(TARGET_RMS / rms, MIN_GAIN), MAX_GAIN, PEAK_CEILING / this.peak)
    // The previous gain was chosen before this piece was known, so it is capped to what this piece can take without clipping.
    const loudest = frames.reduce((peak, frame) => frame.reduce((max, value) => Math.max(max, Math.abs(value)), peak), 0)
    const from = Math.min(this.gain ?? target, PEAK_CEILING / loudest)
    const rampSamples = GAIN_RAMP_FRAMES * this.frameSize
    let offset = 0
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        const position = offset + i
        const gain = position >= rampSamples ? target : from + ((target - from) * position) / rampSamples
        output[position] = frame[i] * gain
      }
      offset += frame.length
    }
    this.gain = target
    return output
  }
}

/** Encodes mono samples as a 16-bit PCM WAV file. */
export function encodeWav(pieces: Float32Array[], sampleRate: number): Buffer {
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const wav = Buffer.alloc(44 + length * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + length * 2, 4)
  wav.write('WAVEfmt ', 8, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(length * 2, 40)
  let offset = 44
  for (const piece of pieces) {
    for (const value of piece) {
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), offset)
      offset += 2
    }
  }
  return wav
}
