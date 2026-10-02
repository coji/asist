import type { Bytes } from '../fetch-range'
import { HeldBytes } from './held-bytes'
import { audioDamaged, type RangedFile } from './ranged-file'

/**
 * The sound track of an MPEG-4 file (.m4a), as ISO/IEC 14496-12 lays it out: the moov box, at the start of the
 * file or after the media data, describes each sample, and the samples are read from the media data in the order
 * they lie there. Only the moov box and the headers of the boxes in front of it are read to find the samples.
 */

export interface Mp4Track {
  config: AudioDecoderConfig
  /** How long the track lasts, by its sample table. */
  seconds: number
  timescale: number
  offsets: Float64Array
  sizes: Uint32Array
  /** The time-to-sample table: how many samples in a row, and the duration of each, in the timescale. */
  durations: Array<{ count: number; delta: number }>
}

interface Box {
  type: string
  /** Where the box's content starts, after its header, and where the box ends. */
  start: number
  end: number
}

const fourcc = (view: DataView, at: number): string => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))

/** A 64-bit size or offset. One past Number's exact integers is no real one. */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw audioDamaged()
  return Number(value)
}

/** The header of the box at `at`, which may not run past `limit`. A size of 0 runs to the limit. */
function boxAt(view: DataView, at: number, limit: number): Box {
  if (at + 8 > limit) throw audioDamaged()
  let size = view.getUint32(at)
  let header = 8
  if (size === 1) {
    if (at + 16 > limit) throw audioDamaged()
    size = u64(view, at + 8)
    header = 16
  } else if (size === 0) {
    size = limit - at
  }
  if (size < header || at + size > limit) throw audioDamaged()
  return { type: fourcc(view, at + 4), start: at + header, end: at + size }
}

/** The boxes inside a box. QuickTime ends some atoms with a 32-bit zero, shorter than any box, which is passed over. */
function children(view: DataView, start: number, end: number): Box[] {
  const found: Box[] = []
  for (let at = start; at + 8 <= end; ) {
    const box = boxAt(view, at, end)
    found.push(box)
    at = box.end
  }
  return found
}

const child = (view: DataView, parent: Box, type: string): Box | undefined => children(view, parent.start, parent.end).find((box) => box.type === type)

function required(view: DataView, parent: Box, ...path: string[]): Box {
  let box = parent
  for (const type of path) {
    const found = child(view, box, type)
    if (!found) throw audioDamaged()
    box = found
  }
  return box
}

/** The moov box's content, found by reading the headers of the boxes in front of it. */
async function readMoov(file: RangedFile): Promise<DataView> {
  for (let at = 0; at < file.size; ) {
    const head = await file.read(at, Math.min(file.size, at + 16))
    const box = boxAt(new DataView(head.buffer, head.byteOffset, head.byteLength), 0, file.size - at)
    if (box.type === 'moov') {
      const moov = await file.read(at, at + box.end)
      return new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
    }
    at += box.end
  }
  throw audioDamaged()
}

/** A descriptor of the esds box: its tag, and where its content starts and ends. Its length takes 7 bits a byte. */
function descriptorAt(view: DataView, at: number, limit: number): { tag: number; start: number; end: number } {
  if (at >= limit) throw audioDamaged()
  const tag = view.getUint8(at)
  let length = 0
  let i = at + 1
  for (let n = 0; ; n++) {
    if (n === 4 || i >= limit) throw audioDamaged()
    const byte = view.getUint8(i++)
    length = (length << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) break
  }
  if (i + length > limit) throw audioDamaged()
  return { tag, start: i, end: i + length }
}

/**
 * The codec and its configuration from the esds box: the object type of the decoder config descriptor, and the
 * AudioSpecificConfig its decoder specific info holds, which AudioDecoder takes as the description of AAC.
 */
function esdsCodec(view: DataView, esds: Box): { codec: string; description?: Bytes } {
  // The box starts with its version and flags.
  const es = descriptorAt(view, esds.start + 4, esds.end)
  if (es.tag !== 0x03) throw audioDamaged()
  const flags = view.getUint8(es.start + 2)
  let at = es.start + 3
  if (flags & 0x80) at += 2
  if (flags & 0x40) at += 1 + view.getUint8(at)
  if (flags & 0x20) at += 2
  const config = descriptorAt(view, at, es.end)
  if (config.tag !== 0x04 || config.start + 13 > config.end) throw audioDamaged()
  const objectType = view.getUint8(config.start)
  const specific = config.start + 13 < config.end ? descriptorAt(view, config.start + 13, config.end) : null
  const description = specific?.tag === 0x05 ? Uint8Array.from({ length: specific.end - specific.start }, (_, i) => view.getUint8(specific.start + i)) : undefined
  // MPEG-4 audio names its codec by the audio object type, the first 5 bits of the AudioSpecificConfig, or 32 plus
  // the next 6 when those hold 31.
  if (objectType === 0x40) {
    if (!description || description.length < 2) throw audioDamaged()
    const first = description[0] >> 3
    const audioObjectType = first === 31 ? 32 + (((description[0] & 7) << 3) | (description[1] >> 5)) : first
    return { codec: `mp4a.40.${audioObjectType}`, description }
  }
  return { codec: `mp4a.${objectType.toString(16).toUpperCase().padStart(2, '0')}`, ...(description ? { description } : {}) }
}

/**
 * The decoder's configuration from the first sample entry of the sample description box, or null for an entry
 * that is no MPEG-4 audio, such as Apple Lossless. QuickTime's sound description versions 1 and 2 add fields
 * before the boxes inside the entry, and version 1 keeps the esds box inside a wave box.
 */
function sampleEntryConfig(view: DataView, stsd: Box): AudioDecoderConfig | null {
  if (stsd.start + 8 > stsd.end || view.getUint32(stsd.start + 4) === 0) throw audioDamaged()
  const entry = boxAt(view, stsd.start + 8, stsd.end)
  if (entry.type !== 'mp4a') return null
  if (entry.start + 28 > entry.end) throw audioDamaged()
  const version = view.getUint16(entry.start + 8)
  let numberOfChannels = view.getUint16(entry.start + 16)
  let sampleRate = view.getUint32(entry.start + 24) >>> 16
  if (version === 2) {
    if (entry.start + 64 > entry.end) throw audioDamaged()
    sampleRate = view.getFloat64(entry.start + 32)
    numberOfChannels = view.getUint32(entry.start + 40)
  }
  const boxes = { start: entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), end: entry.end }
  const inner = children(view, boxes.start, boxes.end)
  const wave = inner.find((box) => box.type === 'wave')
  const esds = inner.find((box) => box.type === 'esds') ?? (wave ? child(view, wave, 'esds') : undefined)
  if (!esds) throw audioDamaged()
  return { ...esdsCodec(view, esds), sampleRate, numberOfChannels }
}

function fullBoxCount(view: DataView, box: Box, entryBytes: number, headerBytes = 8): number {
  if (box.start + headerBytes > box.end) throw audioDamaged()
  const count = view.getUint32(box.start + headerBytes - 4)
  if (box.start + headerBytes + count * entryBytes > box.end) throw audioDamaged()
  return count
}

/** Where each sample lies in the file, from the sizes, the chunk offsets and the sample-to-chunk table. */
function sampleTable(view: DataView, stbl: Box, fileSize: number): { offsets: Float64Array; sizes: Uint32Array } {
  const stsz = required(view, stbl, 'stsz')
  const count = fullBoxCount(view, stsz, 0, 12)
  const fixed = view.getUint32(stsz.start + 4)
  if (fixed === 0) fullBoxCount(view, stsz, 4, 12)
  const sizes = Uint32Array.from({ length: count }, (_, i) => (fixed !== 0 ? fixed : view.getUint32(stsz.start + 12 + i * 4)))

  const co64 = child(view, stbl, 'co64')
  const stco = co64 ?? required(view, stbl, 'stco')
  const entryBytes = co64 ? 8 : 4
  const chunks = fullBoxCount(view, stco, entryBytes)
  const chunkOffset = (i: number): number => (co64 ? u64(view, stco.start + 8 + i * 8) : view.getUint32(stco.start + 8 + i * 4))

  const stsc = required(view, stbl, 'stsc')
  const runs = fullBoxCount(view, stsc, 12)
  const offsets = new Float64Array(count)
  let sample = 0
  for (let r = 0; r < runs; r++) {
    const firstChunk = view.getUint32(stsc.start + 8 + r * 12) - 1
    const perChunk = view.getUint32(stsc.start + 12 + r * 12)
    const endChunk = r + 1 < runs ? view.getUint32(stsc.start + 8 + (r + 1) * 12) - 1 : chunks
    if (firstChunk < 0 || endChunk < firstChunk || endChunk > chunks) throw audioDamaged()
    for (let chunk = firstChunk; chunk < endChunk && sample < count; chunk++) {
      let offset = chunkOffset(chunk)
      for (let k = 0; k < perChunk && sample < count; k++) {
        offsets[sample] = offset
        offset += sizes[sample]
        sample++
      }
    }
  }
  if (sample !== count) throw audioDamaged()
  // The samples are read in one pass from the start of the file, so each has to lie after the one before it.
  for (let i = 0; i < count; i++) {
    if (offsets[i] + sizes[i] > fileSize || (i > 0 && offsets[i] < offsets[i - 1] + sizes[i - 1])) throw audioDamaged()
  }
  return { offsets, sizes }
}

/**
 * The file's first sound track, or null when it has none whose samples this reads: no sound track, a codec
 * that is no MPEG-4 audio, or a fragmented file, whose samples are described in boxes spread through the file.
 */
export async function readMp4Track(file: RangedFile): Promise<Mp4Track | null> {
  const view = await readMoov(file)
  const moov = boxAt(view, 0, view.byteLength)
  if (child(view, moov, 'mvex')) return null
  const track = children(view, moov.start, moov.end)
    .filter((box) => box.type === 'trak')
    .find((trak) => {
      const hdlr = required(view, trak, 'mdia', 'hdlr')
      return hdlr.start + 12 <= hdlr.end && fourcc(view, hdlr.start + 8) === 'soun'
    })
  if (!track) return null
  const mdia = required(view, track, 'mdia')
  const mdhd = required(view, mdia, 'mdhd')
  const timescaleAt = mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12)
  if (timescaleAt + 4 > mdhd.end) throw audioDamaged()
  const timescale = view.getUint32(timescaleAt)
  if (timescale === 0) throw audioDamaged()
  const stbl = required(view, mdia, 'minf', 'stbl')
  const config = sampleEntryConfig(view, required(view, stbl, 'stsd'))
  if (!config) return null
  const stts = required(view, stbl, 'stts')
  const durations = Array.from({ length: fullBoxCount(view, stts, 8) }, (_, i) => ({
    count: view.getUint32(stts.start + 8 + i * 8),
    delta: view.getUint32(stts.start + 12 + i * 8)
  }))
  const units = durations.reduce((sum, { count, delta }) => sum + count * delta, 0)
  return { config, seconds: units / timescale, timescale, durations, ...sampleTable(view, stbl, file.size) }
}

/** The track's samples in order, each with its start in microseconds. */
export async function* mp4Samples(track: Mp4Track, file: RangedFile): AsyncGenerator<{ bytes: Bytes; timestamp: number }> {
  const { offsets, sizes, durations, timescale } = track
  const count = offsets.length
  if (count === 0) return
  const held = new HeldBytes(file.pieces(offsets[0], offsets[count - 1] + sizes[count - 1]), offsets[0])
  let run = 0
  let leftInRun = durations[0]?.count ?? 0
  let units = 0
  try {
    for (let i = 0; i < count; i++) {
      const from = offsets[i]
      const to = from + sizes[i]
      while (held.end < to) {
        if (!(await held.more(from))) throw audioDamaged()
      }
      // A sample past the end of the time-to-sample table lasts as long as the last one it lists.
      while (leftInRun <= 0 && run + 1 < durations.length) leftInRun = durations[++run].count
      yield { bytes: held.bytes.subarray(from - held.start, to - held.start), timestamp: Math.round((units / timescale) * 1e6) }
      units += durations[run]?.delta ?? 0
      leftInRun--
    }
  } finally {
    await held.close()
  }
}
