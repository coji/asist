import type { Bytes } from '../fetch-range'
import type { HeldBytes } from './held-bytes'

/**
 * MP3 and AAC in ADTS (an .aac file), split into the frames WebCodecs' AudioDecoder takes. Each frame begins with
 * a header that gives its length, and a frame is taken only when another frame of the same stream begins where it
 * ends, or the stream does: a sync pattern inside a tag or a picture, or a frame cut short and followed by the
 * next whole one, is passed over byte by byte until frames chain again. Chromium's decoder fails on a chunk that
 * holds more than one frame ("mpa: invalid packet length", Chrome 154, 2026-10-02), so each frame goes alone.
 */

export interface MpegHeader {
  /** The WebCodecs codec: mp3, or mp4a.40.<object type> for AAC. */
  codec: string
  /** The frame's length in bytes, its header included. */
  length: number
  sampleRate: number
  channels: number
  /** How many samples of each channel the frame decodes to. */
  samples: number
  /** Bits per second, from an MP3 header; ADTS gives none. */
  bitrate: number | null
}

export interface MpegFrame {
  header: MpegHeader
  bytes: Bytes
  /** Where the frame starts in the file. */
  at: number
}

/** The most bytes a header is read from, which is what an ADTS header with its buffer fullness and block count takes. */
const HEADER_BYTES = 7

/** kbps by bitrate index, for MPEG-1 and for MPEG-2 and 2.5, of Layer III. */
const MP3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
]
const MP3_RATES = [44_100, 48_000, 32_000]
const ADTS_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]

/**
 * An MPEG audio Layer III header. A free-format frame, whose bitrate index is 0, is not taken: Chromium's
 * decoder refuses it ("mpa: free bit-rate is not supported", Chrome 154, 2026-10-02). Layers I and II are not
 * taken either, being no MP3.
 */
function mp3Header(bytes: Bytes, at: number): MpegHeader | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null
  // 0 is MPEG-2.5, 1 reserved, 2 MPEG-2 and 3 MPEG-1; layer 1 is Layer III.
  const version = (bytes[at + 1] >> 3) & 3
  const layer = (bytes[at + 1] >> 1) & 3
  const bitrateIndex = bytes[at + 2] >> 4
  const rateIndex = (bytes[at + 2] >> 2) & 3
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (bytes[at + 3] & 3) === 2) return null
  const mpeg1 = version === 3
  const sampleRate = MP3_RATES[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4)
  const bitrate = MP3_BITRATES[mpeg1 ? 0 : 1][bitrateIndex] * 1000
  const samples = mpeg1 ? 1152 : 576
  const padding = (bytes[at + 2] >> 1) & 1
  return {
    codec: 'mp3',
    length: Math.floor((samples / 8) * (bitrate / sampleRate)) + padding,
    sampleRate,
    channels: bytes[at + 3] >> 6 === 3 ? 1 : 2,
    samples,
    bitrate
  }
}

/** An ADTS header. A channel configuration of 0, which leaves the channels to a program config element, is not taken. */
function adtsHeader(bytes: Bytes, at: number): MpegHeader | null {
  if (at + HEADER_BYTES > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xf6) !== 0xf0) return null
  const profile = bytes[at + 2] >> 6
  const rateIndex = (bytes[at + 2] >> 2) & 0xf
  const channelConfig = ((bytes[at + 2] & 1) << 2) | (bytes[at + 3] >> 6)
  const length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5)
  const headerLength = bytes[at + 1] & 1 ? 7 : 9
  if (profile === 3 || rateIndex >= ADTS_RATES.length || channelConfig === 0 || length <= headerLength) return null
  return {
    codec: `mp4a.40.${profile + 1}`,
    length,
    sampleRate: ADTS_RATES[rateIndex],
    channels: channelConfig === 7 ? 8 : channelConfig,
    samples: 1024 * ((bytes[at + 6] & 3) + 1),
    bitrate: null
  }
}

const headerAt = (bytes: Bytes, at: number): MpegHeader | null => mp3Header(bytes, at) ?? adtsHeader(bytes, at)

/** Whether two frames belong to one stream, which the decoder was configured for from the first. */
const sameStream = (a: MpegHeader, b: MpegHeader): boolean => a.codec === b.codec && a.sampleRate === b.sampleRate && a.channels === b.channels

const startsWith = (bytes: Bytes, at: number, text: string): boolean => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0))

/** The tags an MP3 can end with: ID3v1, APEv2, Lyrics3 and an ID3v2 appended at the end. */
const isTrailingTag = (bytes: Bytes, at: number): boolean => ['TAG', 'APETAGE', 'LYRICSB', 'ID3'].some((tag) => startsWith(bytes, at, tag))

/**
 * The frames of the stream held by `held`, from its start on. A stream whose first frame is not found within
 * `firstWithin` bytes is taken for no MPEG audio at all and yields nothing, rather than being read to its end.
 */
export async function* mpegFrames(held: HeldBytes, firstWithin: number): AsyncGenerator<MpegFrame> {
  const origin = held.start
  let first: MpegHeader | null = null
  let at = origin
  for (;;) {
    const { bytes, start, ended } = held
    let i = at - start
    let waiting = false
    while (i < bytes.length) {
      if (!first && start + i - origin > firstWithin) return
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      if (i + HEADER_BYTES > bytes.length && !ended) {
        waiting = true
        break
      }
      const header = headerAt(bytes, i)
      if (!header || (first && !sameStream(first, header))) {
        i++
        continue
      }
      const next = i + header.length
      if (next + HEADER_BYTES > bytes.length && !ended) {
        waiting = true
        break
      }
      const after = next + HEADER_BYTES <= bytes.length ? headerAt(bytes, next) : null
      // At the end of the range, a frame is taken when it is whole, whatever fewer bytes than a header follow it.
      const chained =
        next <= bytes.length &&
        (next + HEADER_BYTES > bytes.length || (after !== null && sameStream(header, after)) || isTrailingTag(bytes, next))
      if (!chained) {
        i++
        continue
      }
      first ??= header
      at = start + next
      yield { header, bytes: bytes.subarray(i, next), at: start + i }
      i = next
    }
    at = start + i
    if (ended && !waiting) return
    await held.more(at)
  }
}

/**
 * Where the ID3v2 tags at the start of a file end. Only their headers are read, so a tag that holds a large
 * picture is passed over without its bytes being read.
 */
export async function afterId3(size: number, read: (start: number, end: number) => Promise<Bytes>): Promise<number> {
  let at = 0
  for (;;) {
    if (at + 10 > size) return at
    const header = await read(at, at + 10)
    if (!startsWith(header, 0, 'ID3')) return at
    const length = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f)
    // A footer, flagged in the header, repeats the header after the tag.
    at += 10 + length + (header[5] & 0x10 ? 10 : 0)
  }
}

/**
 * Whether the frame is a Xing, Info or VBRI frame, which an encoder writes first in a stream: it holds no audio
 * and is not decoded, and it gives the number of frames the stream holds, unless that is left out. null says the
 * frame is audio.
 */
export function infoFrame({ header, bytes }: MpegFrame): { frames: number | null } | null {
  if (header.codec !== 'mp3') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The Xing tag follows the side information, whose length depends on the version and the channels.
  const xing = 4 + (header.samples === 1152 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17)
  if (startsWith(bytes, xing, 'Xing') || startsWith(bytes, xing, 'Info')) {
    const counted = xing + 12 <= bytes.length && (view.getUint32(xing + 4) & 1) === 1
    return { frames: counted ? view.getUint32(xing + 8) : null }
  }
  // The VBRI tag sits 32 bytes after the header whatever the stream.
  if (startsWith(bytes, 36, 'VBRI')) return { frames: 36 + 18 <= bytes.length ? view.getUint32(36 + 14) : null }
  return null
}
