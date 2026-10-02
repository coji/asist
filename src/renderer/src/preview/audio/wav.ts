import type { Bytes } from '../fetch-range'
import { audioDamaged, type RangedFile } from './ranged-file'

/**
 * A WAV file's samples, read as they are: integer PCM of 8, 16, 24 or 32 bits and floating point of 32 or 64,
 * mono, stereo or more channels, in a RIFF file or in an RF64 one, which a recording past 4 GB is.
 */

export interface WavFormat {
  channels: number
  sampleRate: number
  /** The bytes of one frame: a sample of every channel. */
  blockAlign: number
  /** How a sample is written: unsigned 8-bit, signed integer or floating point, in this many bytes. */
  encoding: 'u8' | 'int' | 'float'
  bytesPerSample: number
  /** Where the samples start and end in the file. */
  dataStart: number
  dataEnd: number
}

const PCM = 1
const IEEE_FLOAT = 3
const EXTENSIBLE = 0xfffe
/** The data size a writer leaves while it is still recording, or for a size kept elsewhere, as RF64 does. */
const OPEN_SIZE = 0xffffffff

const text = (bytes: Bytes, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))

/** Whether the file starts as a WAV file does. */
export const isWav = (head: Bytes): boolean => ['RIFF', 'RF64'].includes(text(head, 0)) && text(head, 8) === 'WAVE'

function formatOf(fmt: Bytes): Omit<WavFormat, 'dataStart' | 'dataEnd'> | null {
  if (fmt.length < 16) throw audioDamaged()
  const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength)
  let tag = view.getUint16(0, true)
  // WAVE_FORMAT_EXTENSIBLE names the real format in the first two bytes of its subformat GUID.
  if (tag === EXTENSIBLE) {
    if (fmt.length < 40) throw audioDamaged()
    tag = view.getUint16(24, true)
  }
  const channels = view.getUint16(2, true)
  const sampleRate = view.getUint32(4, true)
  const blockAlign = view.getUint16(12, true)
  if (channels === 0 || sampleRate === 0 || blockAlign === 0 || blockAlign % channels !== 0) throw audioDamaged()
  // A sample is read by the size of its container, the block shared among the channels: fewer valid bits, such
  // as 20 in a container of 24, are left-justified in it and read as the full size.
  const bytesPerSample = blockAlign / channels
  if (tag === PCM && bytesPerSample <= 4) return { channels, sampleRate, blockAlign, encoding: bytesPerSample === 1 ? 'u8' : 'int', bytesPerSample }
  if (tag === IEEE_FLOAT && (bytesPerSample === 4 || bytesPerSample === 8)) return { channels, sampleRate, blockAlign, encoding: 'float', bytesPerSample }
  return null
}

/**
 * The format and where the samples lie, read from the chunk headers, or null for samples this does not read,
 * such as ADPCM or µ-law. A data size of 0 or 0xFFFFFFFF, or one past the end of the file, runs to the end of the
 * file, as FFmpeg reads it: a recorder that stopped before it wrote the size leaves such a header, and <audio>
 * plays those samples.
 */
export async function readWavFormat(file: RangedFile): Promise<WavFormat | null> {
  const head = await file.read(0, Math.min(file.size, 12))
  const rf64 = text(head, 0) === 'RF64'
  let format: Omit<WavFormat, 'dataStart' | 'dataEnd'> | null | undefined
  let bigDataSize: number | null = null
  for (let at = 12; at + 8 <= file.size; ) {
    const header = await file.read(at, at + 8)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const id = text(header, 0)
    const size = view.getUint32(4, true)
    const start = at + 8
    if (id === 'ds64' && rf64) {
      const ds64 = await file.read(start, Math.min(file.size, start + 16))
      if (ds64.length < 16) throw audioDamaged()
      const value = new DataView(ds64.buffer, ds64.byteOffset, ds64.byteLength).getBigUint64(8, true)
      bigDataSize = value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
    } else if (id === 'fmt ') {
      format = formatOf(await file.read(start, Math.min(file.size, start + size)))
    } else if (id === 'data') {
      // The format chunk comes before the data, as RIFF requires.
      if (format === undefined) throw audioDamaged()
      if (format === null) return null
      const declared = rf64 && size === OPEN_SIZE && bigDataSize !== null ? bigDataSize : size
      const open = declared === 0 || declared === OPEN_SIZE || start + declared > file.size
      const end = open ? file.size : start + declared
      return { ...format, dataStart: start, dataEnd: start + Math.floor((end - start) / format.blockAlign) * format.blockAlign }
    }
    // A chunk of odd size is followed by a pad byte.
    at = start + size + (size & 1)
  }
  throw audioDamaged()
}

/** The value a full-scale sample of each integer size reaches, by which it is scaled into -1 to 1. */
const FULL_SCALE = [0, 128, 32_768, 8_388_608, 2_147_483_648]

/**
 * The largest amplitude, from 0 to 1 for integer samples, among `frames` frames that start at `at` in `bytes`.
 * The bytes are read through a DataView, since a piece of the file starts on no particular boundary.
 */
export function wavPeak(bytes: Bytes, at: number, frames: number, format: WavFormat): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = at + frames * format.blockAlign
  const step = format.bytesPerSample
  let peak = 0
  switch (format.encoding) {
    case 'u8':
      for (let i = at; i < end; i++) peak = Math.max(peak, Math.abs(bytes[i] - 128))
      return peak / FULL_SCALE[1]
    case 'float':
      if (step === 4) for (let i = at; i < end; i += 4) peak = Math.max(peak, Math.abs(view.getFloat32(i, true)))
      else for (let i = at; i < end; i += 8) peak = Math.max(peak, Math.abs(view.getFloat64(i, true)))
      return peak
    case 'int':
      if (step === 2) for (let i = at; i < end; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)))
      else if (step === 4) for (let i = at; i < end; i += 4) peak = Math.max(peak, Math.abs(view.getInt32(i, true)))
      else for (let i = at; i < end; i += 3) peak = Math.max(peak, Math.abs(((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) << 8) >> 8))
      return peak / FULL_SCALE[step]
  }
}
