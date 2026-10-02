/**
 * Recordings written byte by byte for the tests of the waveform reader: MP3 and ADTS frames whose content is a
 * marker byte rather than audio, WAV files of each sample format, and MPEG-4 files with a sound track. A frame's
 * marker never holds 0xff, so no sync pattern is found inside a frame by chance.
 */

const MP3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]

export const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0))

/** The length of an MPEG-1 Layer III frame at 44.1 kHz. */
export const mp3Length = (kbps: number, padding = 0): number => Math.floor((144 * kbps * 1000) / 44_100) + padding

/**
 * An MPEG-1 Layer III frame at 44.1 kHz, filled with `marker` after its header. A bitrate of 0 writes a
 * free-format header, whose length the header does not give, so `length` gives it.
 */
export function mp3Frame(kbps: number, marker: number, { mono = false, padding = 0, length }: { mono?: boolean; padding?: number; length?: number } = {}): Uint8Array {
  const index = MP3_KBPS.indexOf(kbps)
  if (index < 0) throw new Error(`no MPEG-1 Layer III bitrate ${kbps}`)
  const frame = new Uint8Array(length ?? mp3Length(kbps, padding)).fill(marker)
  frame.set([0xff, 0xfb, (index << 4) | (padding << 1), mono ? 0xc4 : 0x44])
  return frame
}

/** The Xing frame LAME writes first, counting `frames` frames, of a stereo stream at 128 kbps. */
export function xingFrame(frames: number): Uint8Array {
  const frame = mp3Frame(128, 0)
  frame.set(ascii('Xing'), 36)
  new DataView(frame.buffer).setUint32(40, 1)
  new DataView(frame.buffer).setUint32(44, frames)
  return frame
}

/** An ID3v2.4 tag of `size` bytes after its header, holding what looks like the header of an MP3 frame. */
export function id3Tag(size: number): Uint8Array {
  const tag = new Uint8Array(10 + size)
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
  tag.set([0xff, 0xfb, 0x90, 0x44], 20)
  return tag
}

/** An ADTS frame of AAC-LC at 44.1 kHz in stereo, `length` bytes with its header, filled with `marker`. */
export function adtsFrame(length: number, marker: number): Uint8Array {
  const frame = new Uint8Array(length).fill(marker)
  frame.set([0xff, 0xf1, 0x50, 0x80 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc])
  return frame
}

export type WavSamples = { bits: 8 | 16 | 24 | 32; float?: boolean; extensible?: boolean; channels: number; sampleRate: number }

/**
 * A WAV file of `frames` frames, each sample written from `sample(frame, channel)`, a value from -1 to 1. An
 * extensible header names the format in its subformat GUID.
 */
export function wavFile({ bits, float = false, extensible = false, channels, sampleRate }: WavSamples, frames: number, sample: (frame: number, channel: number) => number): Uint8Array<ArrayBuffer> {
  const bytes = bits / 8
  const blockAlign = bytes * channels
  const fmtSize = extensible ? 40 : 16
  const header = new Uint8Array(12 + 8 + fmtSize + 8)
  const view = new DataView(header.buffer)
  header.set(ascii('RIFF'), 0)
  view.setUint32(4, header.length - 8 + frames * blockAlign, true)
  header.set(ascii('WAVEfmt '), 8)
  view.setUint32(16, fmtSize, true)
  const tag = float ? 3 : 1
  view.setUint16(20, extensible ? 0xfffe : tag, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  if (extensible) {
    view.setUint16(36, 22, true)
    view.setUint16(38, bits, true)
    view.setUint16(44, tag, true)
  }
  header.set(ascii('data'), 20 + fmtSize)
  view.setUint32(24 + fmtSize, frames * blockAlign, true)
  const data = new Uint8Array(frames * blockAlign)
  const out = new DataView(data.buffer)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const value = sample(f, c)
      const at = f * blockAlign + c * bytes
      if (float && bits === 32) out.setFloat32(at, value, true)
      else if (bits === 8) out.setUint8(at, Math.round(value * 127) + 128)
      else if (bits === 16) out.setInt16(at, Math.round(value * 32_767), true)
      else if (bits === 24) {
        const v = Math.round(value * 8_388_607)
        out.setUint8(at, v & 0xff)
        out.setUint8(at + 1, (v >> 8) & 0xff)
        out.setUint8(at + 2, (v >> 16) & 0xff)
      } else out.setInt32(at, Math.round(value * 2_147_483_647), true)
    }
  }
  return concat(header, data)
}

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}
const u16 = (value: number): Uint8Array => Uint8Array.of(value >> 8, value & 0xff)
const box = (type: string, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(...content)
  return concat(u32(8 + body.length), ascii(type), body)
}
const fullBox = (type: string, ...content: Uint8Array[]): Uint8Array => box(type, u32(0), ...content)
const descriptor = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(...content)
  // The length in four bytes of seven bits, as many writers put it.
  const length = body.length
  return concat(Uint8Array.of(tag, 0x80 | ((length >> 21) & 0x7f), 0x80 | ((length >> 14) & 0x7f), 0x80 | ((length >> 7) & 0x7f), length & 0x7f), body)
}

/** The AudioSpecificConfig of AAC-LC at 44.1 kHz in stereo. */
export const AAC_LC_CONFIG = Uint8Array.of(0x12, 0x10)

export interface Mp4Options {
  /** The sizes of the samples, which are filled with their index. */
  sizes: number[]
  /** How many samples each chunk holds, the chunks lying in this order with `gap` bytes of other data between them. */
  chunks: number[]
  gap?: number
  /** Where the moov box goes, and whether the chunk offsets take 64 bits. */
  moovFirst?: boolean
  co64?: boolean
  /** The sample entry's type, mp4a by default, and the duration of each sample in a timescale of 44,100. */
  entry?: string
  delta?: number
}

/** An MPEG-4 file with one sound track of AAC-LC, and where its samples lie. */
export function mp4File({ sizes, chunks, gap = 16, moovFirst = false, co64 = false, entry = 'mp4a', delta = 1024 }: Mp4Options): { file: Uint8Array<ArrayBuffer>; offsets: number[] } {
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A isom'))
  const moovFor = (chunkOffsets: number[]): Uint8Array => {
    const esds = fullBox('esds', descriptor(0x03, u16(1), Uint8Array.of(0), descriptor(0x04, Uint8Array.of(0x40, 0x15), new Uint8Array(11), descriptor(0x05, AAC_LC_CONFIG))))
    const sampleEntry = box(entry, new Uint8Array(6), u16(1), new Uint8Array(8), u16(2), u16(16), new Uint8Array(4), u32(44_100 << 16), esds)
    const stsd = fullBox('stsd', u32(1), sampleEntry)
    const stts = fullBox('stts', u32(1), u32(sizes.length), u32(delta))
    // Runs of chunks with the same count, as writers compress the table.
    const runs: Array<[number, number]> = []
    chunks.forEach((count, i) => {
      if (runs.at(-1)?.[1] !== count) runs.push([i + 1, count])
    })
    const stsc = fullBox('stsc', u32(runs.length), ...runs.map(([first, count]) => concat(u32(first), u32(count), u32(1))))
    const stsz = fullBox('stsz', u32(0), u32(sizes.length), ...sizes.map(u32))
    const offsetsBox = co64
      ? fullBox('co64', u32(chunkOffsets.length), ...chunkOffsets.map((offset) => concat(u32(0), u32(offset))))
      : fullBox('stco', u32(chunkOffsets.length), ...chunkOffsets.map(u32))
    const stbl = box('stbl', stsd, stts, stsc, stsz, offsetsBox)
    const mdhd = fullBox('mdhd', u32(0), u32(0), u32(44_100), u32(sizes.length * delta), new Uint8Array(4))
    const hdlr = fullBox('hdlr', u32(0), ascii('soun'), new Uint8Array(12), Uint8Array.of(0))
    return box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', stbl))))
  }
  const media = (): { body: Uint8Array; chunkStarts: number[]; sampleStarts: number[] } => {
    const parts: Uint8Array[] = []
    const chunkStarts: number[] = []
    const sampleStarts: number[] = []
    let at = 0
    let sample = 0
    for (const count of chunks) {
      parts.push(new Uint8Array(gap).fill(0xee))
      at += gap
      chunkStarts.push(at)
      for (let k = 0; k < count; k++, sample++) {
        sampleStarts.push(at)
        parts.push(new Uint8Array(sizes[sample]).fill(sample & 0x7f))
        at += sizes[sample]
      }
    }
    return { body: concat(...parts), chunkStarts, sampleStarts }
  }
  const { body, chunkStarts, sampleStarts } = media()
  const mdatHeader = 8
  if (moovFirst) {
    // The moov box's length does not depend on the offsets it holds, so it is written once to measure it.
    const moovLength = moovFor(chunkStarts).length
    const base = ftyp.length + moovLength + mdatHeader
    const file = concat(ftyp, moovFor(chunkStarts.map((start) => base + start)), box('mdat', body))
    return { file, offsets: sampleStarts.map((start) => base + start) }
  }
  const base = ftyp.length + mdatHeader
  const file = concat(ftyp, box('mdat', body), moovFor(chunkStarts.map((start) => base + start)))
  return { file, offsets: sampleStarts.map((start) => base + start) }
}
