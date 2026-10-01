import { describe, expect, it } from 'vitest'
import { SpeechShaper, encodeWav } from '../src/main/services/speech-shaper'

const RATE = 24_000
const seconds = (samples: number): number => samples / RATE

function tone(durationS: number, amplitude: number, hz = 220): Int16Array {
  const samples = new Int16Array(Math.round(durationS * RATE))
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude * 32767)
  return samples
}
const silence = (durationS: number): Int16Array => new Int16Array(Math.round(durationS * RATE))
const concat = (...parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
function pieces(samples: Int16Array, pieceS = 0.48): Int16Array[] {
  const size = Math.round(pieceS * RATE)
  const out: Int16Array[] = []
  for (let i = 0; i < samples.length; i += size) out.push(samples.subarray(i, i + size))
  return out
}
function shape(input: Int16Array): { out: Float32Array; perPiece: number[] } {
  const shaper = new SpeechShaper(RATE)
  const parts = [...pieces(input).map((piece) => shaper.push(piece)), shaper.flush()]
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return { out, perPiece: parts.map((part) => part.length) }
}
const rms = (samples: Float32Array): number => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)

describe('SpeechShaper', () => {
  it('cuts the silence before the first word and all but a short tail after the last', () => {
    const { out } = shape(concat(silence(0.6), tone(1, 0.3), silence(0.9)))
    expect(seconds(out.length)).toBeGreaterThan(1)
    expect(seconds(out.length)).toBeLessThan(1.2)
    // The voice starts within the one frame of silence that is kept.
    const onset = out.findIndex((value) => Math.abs(value) > 0.01)
    expect(seconds(onset)).toBeLessThan(0.03)
  })

  it('keeps a breathy start quieter than the voice, which a cut at the first voiced frame took off', () => {
    // 80 ms of breath at an RMS of about 0.002 before the voice, as Qwen3-TTS starts "はい" (2026-10-01).
    const { out } = shape(concat(silence(0.4), tone(0.08, 0.0028, 1800), tone(0.5, 0.2), silence(0.6)))
    expect(seconds(out.length)).toBeGreaterThanOrEqual(0.02 + 0.08 + 0.5 + 0.1 - 0.001)
  })

  it('leaves out the noise floor before the voice, so that the first word is not delayed', () => {
    const { out } = shape(concat(tone(0.4, 0.0003, 900), tone(0.5, 0.2), silence(0.6)))
    expect(seconds(out.length)).toBeCloseTo(0.02 + 0.5 + 0.1, 2)
  })

  it('keeps the decay of the last word past the short tail, up to its limit', () => {
    const decay = (amplitude: number): Int16Array => tone(0.2, amplitude, 700)
    const { out } = shape(concat(silence(0.2), tone(0.5, 0.2), decay(0.002), silence(0.6)))
    // The voice, one frame before it, and the 200 ms of decay with one frame after it.
    expect(seconds(out.length)).toBeCloseTo(0.02 + 0.5 + 0.22, 2)
    const { out: long } = shape(concat(silence(0.2), tone(0.5, 0.2), tone(0.8, 0.002, 700), silence(0.6)))
    expect(seconds(long.length)).toBeCloseTo(0.02 + 0.5 + 0.3, 2)
  })

  it('keeps a pause between two phrases at its length', () => {
    const { out } = shape(concat(silence(0.3), tone(0.7, 0.3), silence(0.4), tone(0.7, 0.3), silence(0.5)))
    expect(seconds(out.length)).toBeGreaterThan(1.8)
    expect(seconds(out.length)).toBeLessThan(2)
  })

  it('releases nothing while only silence has arrived, so playback does not start on it', () => {
    const shaper = new SpeechShaper(RATE)
    expect(shaper.push(silence(0.48))).toHaveLength(0)
    expect(shaper.push(concat(silence(0.2), tone(0.28, 0.3))).length).toBeGreaterThan(0)
  })

  it('brings a quiet generation and a loud one to about the same level without clipping', () => {
    // The voiced RMS measured for one voice ranges from 0.011 to 0.056, and up to 0.107 across voices.
    const quiet = shape(concat(silence(0.3), tone(2, 0.016), silence(0.3))).out
    const loud = shape(concat(silence(0.3), tone(2, 0.15), silence(0.3))).out
    expect(rms(quiet) / rms(loud)).toBeGreaterThan(0.8)
    expect(rms(quiet) / rms(loud)).toBeLessThan(1.25)
  })

  it('changes the gain between two pieces gradually instead of stepping', () => {
    // One continuous 210 Hz tone whose level rises just before the second piece, which pulls the gain down at
    // the piece boundary. The level changes on a zero crossing, so the input has no jump of its own, while
    // the piece boundary falls near a peak of the tone, where a step of the gain would show.
    const input = tone(1.44, 1, 210)
    const boundary = Math.round((100 / 210) * RATE)
    for (let i = 0; i < input.length; i++) input[i] = Math.round(input[i] * (i < boundary ? 0.03 : 0.12))
    const { out } = shape(input)
    let largestJump = 0
    for (let i = 1; i < out.length; i++) largestJump = Math.max(largestJump, Math.abs(out[i] - out[i - 1]))
    // A 210 Hz tone of amplitude A moves at most 0.055 A per sample, and no sample here exceeds 0.45.
    expect(largestJump).toBeLessThan(0.04)
  })

  it('never clips, even when a loud piece follows a gain chosen for a soft one', () => {
    const { out } = shape(concat(tone(0.48, 0.02), tone(0.96, 0.6)))
    expect(out.reduce((max, value) => Math.max(max, Math.abs(value)), 0)).toBeLessThanOrEqual(0.951)
  })

  it('produces no audio for a generation that stays silent', () => {
    expect(shape(silence(2)).out).toHaveLength(0)
  })
})

describe('encodeWav', () => {
  it('writes a header that matches the samples', () => {
    const wav = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-1])], RATE)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(RATE)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([0, 16384, -32767])
  })
})
