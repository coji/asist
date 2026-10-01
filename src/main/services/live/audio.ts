import { floatToPcm16, pcm16FromBytes, pcm16ToBytes, pcm16ToFloat } from '@shared/pcm'

/**
 * Converts audio between the Live API and the renderer. The renderer sends Float32 at 16 kHz, which is
 * the rate the API takes, as base64 of 16-bit PCM. The API's output is base64 of 16-bit PCM at 24 kHz
 * and reaches the renderer as Float32.
 */

/** Turns Float32 at 16 kHz into base64 PCM16. */
export function encodeInput(frame16k: Float32Array): string {
  if (frame16k.length === 0) return ''
  return Buffer.from(pcm16ToBytes(floatToPcm16(frame16k))).toString('base64')
}

/** Turns an API's output, base64 PCM16, into Float32. */
export function decodeOutput(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  return pcm16ToFloat(pcm16FromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
}
