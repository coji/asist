import { describe, expect, it } from 'vitest'
import { floatToPcm16, pcm16FromBytes, pcm16ToBytes, pcm16ToFloat, StreamResampler } from '../src/shared/pcm'
import { decodeOutput, encodeInput } from '../src/main/services/live/audio'

describe('pcm16', () => {
  it('round-trips the values between Float32 and 16 bit and clamps what lies outside the range', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5])
    const pcm = floatToPcm16(samples)
    expect(Array.from(pcm)).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768])
    const back = pcm16ToFloat(pcm)
    expect(back[1]).toBeCloseTo(0.5, 3)
    expect(back[4]).toBe(-1)
  })

  it('writes the bytes little-endian and drops a trailing odd byte', () => {
    const bytes = pcm16ToBytes(new Int16Array([1, -2]))
    expect(Array.from(bytes)).toEqual([1, 0, 254, 255])
    expect(Array.from(pcm16FromBytes(new Uint8Array([1, 0, 254, 255, 9])))).toEqual([1, -2])
  })
})

describe('StreamResampler', () => {
  it('passes the samples through at an unchanged rate, and keeps the length continuous across chunk boundaries when the rates differ', () => {
    expect(new StreamResampler(16000, 16000).process(new Float32Array(10)).length).toBe(10)
    const up = new StreamResampler(16000, 24000)
    let total = 0
    for (let i = 0; i < 10; i++) total += up.process(new Float32Array(160).fill(0.1)).length
    // 1600 samples become about 2400; the remainder carried over at each boundary makes it slightly fewer.
    expect(total).toBeGreaterThan(2380)
    expect(total).toBeLessThanOrEqual(2400)
  })

  it.each([128, 480, 1023, 1024, 4096])('keeps a 48 kHz to 16 kHz stream on one timeline across %i-sample chunks', (chunk) => {
    // On a ramp x[n] = n, linear interpolation returns the source position, so every output must read 3 × its index.
    const down = new StreamResampler(48_000, 16_000)
    const out: number[] = []
    for (let offset = 0; offset < 48_000; offset += chunk) {
      const ramp = new Float32Array(Math.min(chunk, 48_000 - offset)).map((_, i) => offset + i)
      out.push(...down.process(ramp))
    }
    expect(out).toHaveLength(16_000)
    expect(out.findIndex((value, index) => Math.abs(value - index * 3) > 1e-3)).toBe(-1)
  })
})

describe('live audio encode/decode', () => {
  it('encodes 16 kHz Float32 as base64 PCM16, and decodes the output base64 back to Float32', () => {
    const base64 = encodeInput(new Float32Array([0.5, -0.5]))
    expect(Buffer.from(base64, 'base64').length).toBe(4)
    const decoded = decodeOutput(base64)
    expect(decoded[0]).toBeCloseTo(0.5, 3)
    expect(decoded[1]).toBeCloseTo(-0.5, 3)
    expect(encodeInput(new Float32Array(0))).toBe('')
  })
})
