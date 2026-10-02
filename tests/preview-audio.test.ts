import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import { HeldBytes } from '@/preview/audio/held-bytes'
import { mp4Samples, readMp4Track } from '@/preview/audio/mp4-samples'
import { afterId3, infoFrame, mpegFrames, type MpegFrame } from '@/preview/audio/mpeg-frames'
import { openRangedFile, PIECE_BYTES } from '@/preview/audio/ranged-file'
import { readWavFormat, wavPeak } from '@/preview/audio/wav'
import openAudio, { type PeaksAnswer } from '@/preview/methods/audio'
import { fileUrl, handleFileScheme } from '../src/main/file-protocol'
import { AAC_LC_CONFIG, adtsFrame, concat, id3Tag, mp3Frame, mp3Length, mp4File, wavFile, xingFrame } from './helpers/audio-files'
import { longTempFolder } from './helpers/temp'

/**
 * The waveform reader of the preview page: how it splits MP3 and ADTS into frames, reads an MPEG-4 file's sample
 * table, reads each WAV sample format, and how the audio document reads a file in pieces from its start and
 * reports the peaks in order. The file is served as asist-file answers a Range request, and the server records
 * the ranges it was asked for. WebCodecs is not in Node, so the MPEG tests give the page a decoder that turns each
 * frame into samples as loud as the frame's marker byte.
 */

const electron = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle } }))

const URL = 'asist-file:///tmp/talk.mp3'

/** The ranges asked for, as [start, end) pairs, in the order they were asked for. */
let asked: Array<[number, number]> = []

function serve(file: Uint8Array): void {
  asked = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    if (!range) throw new Error('the reader asks for ranges only')
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), file.length - 1)
    if (start > end) return new Response(file.slice(), { status: 200 })
    asked.push([start, end + 1])
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The pieces of `bytes` in the sizes given in turn, as a reader that is handed them one at a time sees them. */
async function* piecesOf(bytes: Uint8Array<ArrayBuffer>, sizes: number[]): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length]
    yield bytes.slice(at, at + size)
    at += size
  }
}

async function framesOf(stream: Uint8Array<ArrayBuffer>, sizes = [stream.length], firstWithin = Infinity): Promise<MpegFrame[]> {
  const frames: MpegFrame[] = []
  for await (const frame of mpegFrames(new HeldBytes(piecesOf(stream, sizes), 0), firstWithin)) frames.push(frame)
  return frames
}

/** The marker each frame is filled with, which a frame that took in bytes of another holds at one end only. */
const markers = (frames: MpegFrame[]): number[] =>
  frames.map(({ header, bytes }) => {
    const first = bytes[header.codec === 'mp3' ? 4 : 7]
    return first === bytes[bytes.length - 1] ? first : NaN
  })

describe('splitting MP3 into frames', () => {
  it('takes every frame of a stream of variable bitrate whole, wherever the pieces it arrives in end', async () => {
    const kbps = [128, 160, 64, 320, 32, 192, 96, 128]
    const stream = concat(...kbps.map((rate, i) => mp3Frame(rate, i + 1, { padding: i % 2 })))
    for (const sizes of [[stream.length], [1], [5, 3, 417], [418]]) {
      const frames = await framesOf(stream, sizes)
      expect(markers(frames)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(frames.map((frame) => frame.bytes.length)).toEqual(kbps.map((rate, i) => mp3Length(rate, i % 2)))
      expect(frames.map((frame) => frame.at)).toEqual(frames.map((_, i) => kbps.slice(0, i).reduce((sum, rate, k) => sum + mp3Length(rate, k % 2), 0)))
    }
  })

  it('reads the frame count of a Xing frame, which holds no audio', async () => {
    const stream = concat(xingFrame(3), mp3Frame(128, 1), mp3Frame(192, 2), mp3Frame(64, 3))
    const frames = await framesOf(stream)
    expect(frames).toHaveLength(4)
    expect(infoFrame(frames[0])).toEqual({ frames: 3 })
    expect(frames.slice(1).map(infoFrame)).toEqual([null, null, null])
  })

  it('passes over a frame cut short and takes the whole frames after it', async () => {
    const cut = mp3Frame(128, 3).subarray(0, 200)
    const stream = concat(mp3Frame(128, 1), mp3Frame(128, 2), cut, mp3Frame(128, 4), mp3Frame(128, 5))
    expect(markers(await framesOf(stream))).toEqual([1, 2, 4, 5])
    expect(markers(await framesOf(stream, [7]))).toEqual([1, 2, 4, 5])
  })

  it('takes no free-format frame, which the decoder refuses, so a stream in free format yields none', async () => {
    const header = mp3Frame(128, 1)
    header[2] = 0x00
    const stream = concat(...[1, 2, 3, 4].map((marker) => concat(header.subarray(0, 4), new Uint8Array(596).fill(marker))))
    expect(await framesOf(stream)).toEqual([])
  })

  it('passes over bytes that are no frame, with the frame they follow, which no frame confirms, and takes the last frame before a tag', async () => {
    const junk = Uint8Array.of(0xff, 0xfb, 0x90)
    const stream = concat(new Uint8Array(37).fill(0x20), mp3Frame(128, 1), mp3Frame(128, 2), junk, mp3Frame(128, 3), mp3Frame(128, 4), new TextEncoder().encode('TAG'), new Uint8Array(125))
    expect(markers(await framesOf(stream))).toEqual([1, 3, 4])
  })

  it('gives up on a file whose first frame is not within the bytes it may search', async () => {
    const stream = concat(new Uint8Array(5000), mp3Frame(128, 1), mp3Frame(128, 2))
    expect(await framesOf(stream, [1000], 4096)).toEqual([])
    expect(markers(await framesOf(stream, [1000], 8192))).toEqual([1, 2])
  })

  it('takes the frames of AAC in ADTS and their codec', async () => {
    const stream = concat(adtsFrame(300, 1), adtsFrame(371, 2), adtsFrame(280, 3))
    const frames = await framesOf(stream, [64])
    expect(markers(frames)).toEqual([1, 2, 3])
    expect(frames[0].header).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44_100, channels: 2, samples: 1024 })
  })

  it('finds where the ID3 tags end from their headers alone', async () => {
    const file = concat(id3Tag(3000), id3Tag(100), mp3Frame(128, 1))
    const read = vi.fn(async (start: number, end: number) => file.slice(start, end))
    expect(await afterId3(file.length, read)).toBe(3010 + 110)
    expect(read.mock.calls).toEqual([
      [0, 10],
      [3010, 3020],
      [3120, 3130]
    ])
  })
})

describe('reading the sample table of an MPEG-4 file', () => {
  const sizes = [300, 310, 290, 305, 280, 315, 299, 301]
  const chunks = [3, 3, 2]

  it.each([
    { moovFirst: false, co64: false },
    { moovFirst: true, co64: true }
  ])('finds every sample of the sound track, its codec and its length (moov first: $moovFirst, 64-bit offsets: $co64)', async (layout) => {
    const { file, offsets } = mp4File({ sizes, chunks, ...layout })
    serve(file)
    const opened = await openRangedFile(URL)
    const track = (await readMp4Track(opened))!
    expect(track.config).toEqual({ codec: 'mp4a.40.2', description: AAC_LC_CONFIG, sampleRate: 44_100, numberOfChannels: 2 })
    expect([...track.offsets]).toEqual(offsets)
    expect([...track.sizes]).toEqual(sizes)
    expect(track.seconds).toBeCloseTo((8 * 1024) / 44_100)
    const samples = []
    for await (const sample of mp4Samples(track, opened)) samples.push(sample)
    expect(samples.map(({ bytes }) => [bytes.length, bytes[0]])).toEqual(sizes.map((size, i) => [size, i]))
    expect(samples.map(({ timestamp }) => timestamp)).toEqual(sizes.map((_, i) => Math.round(((i * 1024) / 44_100) * 1e6)))
  })

  it('reads the boxes in front of a moov box at the end by their headers, without reading the media data', async () => {
    const { file } = mp4File({ sizes: Array.from({ length: 600 }, () => 9000), chunks: Array.from({ length: 100 }, () => 6) })
    expect(file.length).toBeGreaterThan(PIECE_BYTES)
    serve(file)
    await readMp4Track(await openRangedFile(URL))
    const read = asked.reduce((sum, [start, end]) => sum + end - start, 0)
    expect(read - PIECE_BYTES).toBeLessThan(20_000)
  })

  it('takes a track of another codec, such as Apple Lossless, for one without a waveform', async () => {
    serve(mp4File({ sizes, chunks, entry: 'alac' }).file)
    expect(await readMp4Track(await openRangedFile(URL))).toBeNull()
  })

  it('says a file whose samples run past its end is damaged', async () => {
    const { file } = mp4File({ sizes, chunks, moovFirst: true })
    serve(file.subarray(0, file.length - 100))
    await expect(readMp4Track(await openRangedFile(URL))).rejects.toThrow(errorKey('files.errors.audioDamaged'))
  })
})

describe('reading the samples of a WAV file', () => {
  const peakOf = async (file: Uint8Array<ArrayBuffer>, frames: number): Promise<number> => {
    serve(file)
    const format = (await readWavFormat(await openRangedFile(URL)))!
    return wavPeak(file, format.dataStart, frames, format)
  }

  it.each([
    { bits: 16, channels: 2 },
    { bits: 16, channels: 1 },
    { bits: 24, channels: 1 },
    { bits: 24, channels: 2, extensible: true },
    { bits: 32, channels: 2 },
    { bits: 8, channels: 1 },
    { bits: 32, channels: 2, float: true },
    { bits: 32, channels: 1, float: true, extensible: true }
  ] as const)('reads $bits-bit samples of $channels channels (float: $float, extensible: $extensible)', async (samples) => {
    const format = { sampleRate: 22_050, ...samples }
    // The loudest sample is the second channel's in a stereo file, and negative.
    const file = wavFile(format, 100, (frame, channel) => (frame === 40 ? (channel === samples.channels - 1 ? -0.75 : 0.5) : 0.1))
    serve(file)
    const read = (await readWavFormat(await openRangedFile(URL)))!
    expect(read).toMatchObject({ channels: samples.channels, sampleRate: 22_050, blockAlign: (samples.bits / 8) * samples.channels, dataEnd: file.length })
    // Eight bits hold the amplitude to within 1/128.
    const digits = samples.bits === 8 ? 1 : 2
    expect(await peakOf(file, 100)).toBeCloseTo(0.75, digits)
    expect(await peakOf(file, 40)).toBeCloseTo(0.1, digits)
  })

  it('takes the data to the end of the file when its size was never written, as a recorder that stopped leaves it', async () => {
    const file = wavFile({ bits: 16, channels: 2, sampleRate: 8000 }, 50, () => 0.5)
    new DataView(file.buffer).setUint32(40, 0, true)
    serve(concat(file, Uint8Array.of(1)))
    expect(await readWavFormat(await openRangedFile(URL))).toMatchObject({ dataStart: 44, dataEnd: 44 + 200 })
  })

  it('reads no samples it cannot read, such as µ-law, and says so', async () => {
    const file = wavFile({ bits: 8, channels: 1, sampleRate: 8000 }, 10, () => 0)
    new DataView(file.buffer).setUint16(20, 7, true)
    serve(file)
    expect(await readWavFormat(await openRangedFile(URL))).toBeNull()
  })
})

/** Asks the document for the peaks until it is done, as a viewer does, and keeps every answer. */
async function answers(document: Awaited<ReturnType<typeof openAudio>>): Promise<Array<PeaksAnswer & { from: number }>> {
  const all: Array<PeaksAnswer & { from: number }> = []
  let from = 0
  for (;;) {
    const answer = await document.methods.peaks({ from })
    all.push({ ...answer, from })
    if (!answer.supported || answer.done) return all
    from += answer.peaks.length
  }
}

const joined = (all: PeaksAnswer[]): number[] => all.flatMap((answer) => (answer.supported ? [...answer.peaks] : []))

describe('the audio document', () => {
  it('reads a WAV file once from its start in pieces and reports its peaks in order as they grow', async () => {
    // 4,000,000 frames of 24-bit stereo, 24 MB, whose loudness rises over the recording: a piece ends inside a frame.
    const frames = 4_000_000
    const file = wavFile({ bits: 24, channels: 2, sampleRate: 48_000 }, frames, (frame, channel) => (channel === 1 ? frame / frames : 0) * (frame % 2 ? 1 : -1))
    serve(file)
    const document = await openAudio(URL)
    const all = await answers(document)
    document.close?.()

    expect(asked).toEqual(Array.from({ length: Math.ceil(file.length / PIECE_BYTES) }, (_, i) => [i * PIECE_BYTES, Math.min(file.length, (i + 1) * PIECE_BYTES)]))
    expect(all.length).toBeGreaterThan(1)
    expect(all.every((answer, i) => i === 0 || answer.from === all[i - 1].from + (all[i - 1] as { peaks: Float32Array }).peaks.length)).toBe(true)
    const last = all.at(-1) as Extract<PeaksAnswer, { supported: true }>
    expect(last.done).toBe(true)
    expect(last.seconds).toBeCloseTo(frames / 48_000)
    const peaks = joined(all)
    expect(peaks).toHaveLength(2000)
    // Each peak is the loudest frame of its stretch, the last one, which rises with time.
    const perPeak = frames / 2000
    expect(peaks.map((peak, i) => Math.abs(peak - ((i + 1) * perPeak - 1) / frames) < 1e-4)).toEqual(peaks.map(() => true))
    expect(last.peakSeconds).toBeCloseTo(perPeak / 48_000)
  })

  it('reads a file through the asist-file scheme itself', async () => {
    const folder = longTempFolder('asist-audio-')
    try {
      handleFileScheme(() => [folder])
      const handler = electron.handle.mock.calls[0][1] as (request: { url: string; headers: Headers }) => Response
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => handler({ url, headers: new Headers(init?.headers) }))
      const target = path.join(folder, 'memo.wav')
      writeFileSync(target, wavFile({ bits: 16, channels: 1, sampleRate: 16_000 }, 3_000_000, (frame) => (frame === 2_999_999 ? 1 : 0.25)))
      const all = await answers(await openAudio(fileUrl(target)))
      const peaks = joined(all)
      expect(peaks).toHaveLength(2000)
      expect(peaks.at(-1)).toBeCloseTo(1, 3)
      expect(peaks[0]).toBeCloseTo(0.25, 3)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('says the file changed when a later piece comes from a file of another length', async () => {
    const file = wavFile({ bits: 16, channels: 2, sampleRate: 44_100 }, 2_000_000, () => 0.5)
    serve(file)
    const fetchFile = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const response = await fetchFile(url, init)
      const range = response.headers.get('Content-Range')!
      return range.startsWith('bytes 0-') ? response : new Response(await response.arrayBuffer(), { status: 206, headers: { 'Content-Range': range.replace(/\/\d+$/, `/${file.length + 4}`) } })
    })
    const document = await openAudio(URL)
    await expect(answers(document)).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
  })

  it('stops reading once it is closed', async () => {
    serve(wavFile({ bits: 16, channels: 2, sampleRate: 44_100 }, 6_000_000, () => 0.5))
    // Each piece takes a while to come, as a file on a slow disk does, and a request stopped meanwhile is not answered.
    const fetchFile = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return fetchFile(url, init)
    })
    const document = await openAudio(URL)
    await document.methods.peaks({ from: 0 })
    document.close?.()
    const read = asked.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked.length).toBe(read)
    expect(read).toBeLessThan(Math.ceil((6_000_000 * 4) / PIECE_BYTES))
  })

  it('says a file that is no recording it reads, such as FLAC, gets no waveform', async () => {
    serve(concat(new TextEncoder().encode('fLaC'), new Uint8Array(100_000).fill(0x12)))
    expect(await answers(await openAudio(URL))).toEqual([{ supported: false, from: 0 }])
  })
})

describe('the audio document with the decoder', () => {
  /** What the page configured its decoders with, and the frames each one was given. */
  let configs: AudioDecoderConfig[]
  let decoded: number[]
  let supported: (config: AudioDecoderConfig) => boolean
  let failAt: number | null

  beforeEach(() => {
    configs = []
    decoded = []
    supported = () => true
    failAt = null
    vi.stubGlobal(
      'EncodedAudioChunk',
      class {
        readonly data: Uint8Array
        readonly timestamp: number
        constructor(init: { data: Uint8Array; timestamp: number }) {
          this.data = init.data.slice()
          this.timestamp = init.timestamp
        }
      }
    )
    vi.stubGlobal(
      'AudioDecoder',
      class extends EventTarget {
        static isConfigSupported = async (config: AudioDecoderConfig) => ({ supported: supported(config), config })
        state = 'unconfigured'
        decodeQueueSize = 0
        constructor(private readonly init: { output: (data: unknown) => void; error: (error: Error) => void }) {
          super()
        }
        configure(config: AudioDecoderConfig): void {
          configs.push(config)
          this.state = 'configured'
        }
        decode(chunk: { data: Uint8Array }): void {
          this.decodeQueueSize++
          const marker = chunk.data[chunk.data.length - 1]
          setTimeout(() => {
            this.decodeQueueSize--
            this.dispatchEvent(new Event('dequeue'))
            if (this.state === 'closed') return
            if (marker === failAt) {
              this.state = 'closed'
              this.init.error(new Error('EncodingError'))
              return
            }
            decoded.push(marker)
            // Each frame decodes to 1152 samples of two channels, as loud as its marker.
            this.init.output({
              sampleRate: 44_100,
              numberOfFrames: 1152,
              numberOfChannels: 2,
              copyTo: (plane: Float32Array, { planeIndex }: { planeIndex: number }) => plane.fill(planeIndex === 0 ? marker / 100 : 0, 0, 1152),
              close: () => undefined
            })
          })
        }
        async flush(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        close(): void {
          this.state = 'closed'
        }
      }
    )
  })

  it('decodes the frames of an MP3 after its tags in order, without its Xing frame, and reports a peak for each stretch', async () => {
    const markers = Array.from({ length: 40 }, (_, i) => (i % 50) + 1)
    serve(concat(id3Tag(2048), xingFrame(40), ...markers.map((marker) => mp3Frame(128, marker))))
    const all = await answers(await openAudio(URL))
    expect(configs).toEqual([{ codec: 'mp3', sampleRate: 44_100, numberOfChannels: 2 }])
    expect(decoded).toEqual(markers)
    const last = all.at(-1) as Extract<PeaksAnswer, { supported: true }>
    expect(last.seconds).toBeCloseTo((40 * 1152) / 44_100)
    // 40 frames by their Xing frame make 46,080 frames of samples, 23 a peak.
    expect(last.peakSeconds).toBeCloseTo(23 / 44_100)
    const peaks = joined(all)
    expect(peaks).toHaveLength(Math.ceil((40 * 1152) / 23))
    const expected = peaks.map((_, i) => Math.max(...markers.slice(Math.floor((i * 23) / 1152), Math.floor(((i + 1) * 23 - 1) / 1152) + 1)) / 100)
    expect(peaks.map((peak, i) => Math.abs(peak - expected[i]) < 1e-6)).toEqual(peaks.map(() => true))
  })

  it('says a recording whose codec the decoder does not take gets no waveform', async () => {
    supported = () => false
    serve(concat(...[1, 2, 3].map((marker) => adtsFrame(400, marker))))
    expect(await answers(await openAudio(URL))).toEqual([{ supported: false, from: 0 }])
    expect(decoded).toEqual([])
  })

  it('fails the waveform with the error the viewer shows when the decoder fails on a frame', async () => {
    failAt = 3
    serve(concat(...[1, 2, 3, 4].map((marker) => mp3Frame(128, marker))))
    await expect(answers(await openAudio(URL))).rejects.toThrow(errorKey('files.errors.audioDamaged'))
  })
})
