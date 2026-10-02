import { HeldBytes } from '../audio/held-bytes'
import { mp4Samples, readMp4Track } from '../audio/mp4-samples'
import { afterId3, infoFrame, mpegFrames, type MpegHeader } from '../audio/mpeg-frames'
import { PeakTrack } from '../audio/peaks'
import { audioDamaged, openRangedFile, type RangedFile } from '../audio/ranged-file'
import { isWav, readWavFormat, wavPeak } from '../audio/wav'
import type { Bytes } from '../fetch-range'
import type { OpenPreviewDocument } from '../serve'

/**
 * The waveform of a recording, built as the file is read from its start a piece at a time, so that what it holds
 * stays the same however long the recording is: WAV from its samples, and MP3, AAC in ADTS and AAC in MPEG-4
 * decoded a frame at a time by WebCodecs' AudioDecoder. The viewers ask for the peaks again and again, each time
 * from where they have got to, and draw them as they come. Opening the document starts the reading, which goes
 * on until the end of the file or until the document is closed.
 */

/** What a viewer is told each time it asks for the peaks. */
export type PeaksAnswer =
  /** The file is none whose waveform is drawn here, or its codec is one the decoder does not take. */
  | { supported: false }
  | {
      supported: true
      /** The peaks from where the viewer asked on, each the largest amplitude over `peakSeconds` of the recording. */
      peaks: Float32Array
      peakSeconds: number
      /** How long the recording is: as its header gives it while it is read, and as decoded once `done`. */
      seconds: number
      done: boolean
    }

/**
 * How long an answer after the first waits to gather more peaks. A viewer asks again as soon as it is answered,
 * so without it the viewer would be answered and would draw again for every frame decoded.
 */
const GATHER_MS = 100
/** How far past its tags an MPEG stream's first frame may lie. A file with none so far is taken for no MPEG audio. */
const FIRST_FRAME_WITHIN = 64 * 1024
/** How many chunks the decoder is given ahead of what it has decoded. */
const DECODE_AHEAD = 64

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class Waveform {
  /** How long the recording is by its header, until it is decoded. */
  seconds = 0
  track: PeakTrack | null = null
  private state: 'reading' | 'done' | 'unsupported' | 'failed' = 'reading'
  private error: unknown = null
  private waiting: Array<() => void> = []

  /** Adds the decoded frames, each channel copied into its own buffer, which `planes` keeps for the next. */
  addDecoded(data: AudioData, planes: Float32Array[]): void {
    this.track ??= new PeakTrack(data.sampleRate, this.seconds)
    const frames = data.numberOfFrames
    for (let c = 0; c < data.numberOfChannels; c++) {
      if (!planes[c] || planes[c].length < frames) planes[c] = new Float32Array(frames)
      data.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' })
    }
    this.track.addChannels(planes, data.numberOfChannels, frames)
    this.changed()
  }

  changed(): void {
    for (const resolve of this.waiting.splice(0)) resolve()
  }

  unsupported(): void {
    this.settle('unsupported')
  }

  end(): void {
    this.track?.end()
    this.settle('done')
  }

  fail(error: unknown): void {
    this.error = error
    this.settle('failed')
  }

  async after(from: number): Promise<PeaksAnswer> {
    while (this.state === 'reading' && (this.track?.count ?? 0) <= from) await new Promise<void>((resolve) => this.waiting.push(resolve))
    // The first answer goes at once, so that the first peaks are drawn as soon as they are decoded.
    if (from > 0 && this.state === 'reading') await sleep(GATHER_MS)
    if (this.state === 'failed') throw this.error
    if (this.state === 'unsupported') return { supported: false }
    const done = this.state === 'done'
    const track = this.track
    return {
      supported: true,
      peaks: track?.peaks(from) ?? new Float32Array(0),
      peakSeconds: track?.peakSeconds ?? 0,
      seconds: done && track ? track.seconds : this.seconds,
      done
    }
  }

  private settle(state: 'done' | 'unsupported' | 'failed'): void {
    if (this.state !== 'reading') return
    this.state = state
    this.changed()
  }
}

interface Chunk {
  bytes: Bytes
  /** In microseconds. */
  timestamp: number
}

/**
 * Decodes the chunks in order and adds what comes out to the waveform, giving the decoder no more than
 * DECODE_AHEAD chunks ahead of its output. False when the decoder does not take the configuration.
 */
async function decodeInto(config: AudioDecoderConfig, chunks: AsyncIterable<Chunk>, waveform: Waveform, signal: AbortSignal): Promise<boolean> {
  // A configuration the decoder cannot even read was made from a file whose header is wrong.
  const { supported } = await AudioDecoder.isConfigSupported(config).catch(() => {
    throw audioDamaged()
  })
  if (!supported) return false
  let failed = false
  let wake = (): void => undefined
  const planes: Float32Array[] = []
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        waveform.addDecoded(data, planes)
      } finally {
        data.close()
      }
    },
    error: () => {
      failed = true
      wake()
    }
  })
  decoder.addEventListener('dequeue', () => wake())
  signal.addEventListener('abort', () => wake(), { once: true })
  decoder.configure(config)
  try {
    for await (const chunk of chunks) {
      while (decoder.decodeQueueSize >= DECODE_AHEAD && !failed && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve))
      if (failed || signal.aborted) break
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, data: chunk.bytes }))
    }
    // A decoder that fails while it flushes rejects the flush as well as calling its error callback.
    if (!failed && !signal.aborted) await decoder.flush().catch(() => undefined)
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
  if (failed) throw audioDamaged()
  return true
}

async function buildWav(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const format = await readWavFormat(file)
  if (!format) return waveform.unsupported()
  const { dataStart, dataEnd, blockAlign, sampleRate } = format
  waveform.seconds = (dataEnd - dataStart) / blockAlign / sampleRate
  const track = (waveform.track = new PeakTrack(sampleRate, waveform.seconds))
  const held = new HeldBytes(file.pieces(dataStart, dataEnd), dataStart)
  try {
    for (let at = dataStart; at < dataEnd && !signal.aborted; ) {
      let frames = Math.floor((held.end - at) / blockAlign)
      if (frames === 0) {
        if (!(await held.more(at))) throw audioDamaged()
        continue
      }
      for (let i = at - held.start; frames > 0; ) {
        const take = Math.min(track.room, frames)
        track.add(wavPeak(held.bytes, i, take, format), take)
        i += take * blockAlign
        at += take * blockAlign
        frames -= take
      }
      waveform.changed()
    }
  } finally {
    await held.close()
  }
}

/**
 * How long an MPEG stream lasts: by the frame count of its Xing or VBRI frame, or else by the bitrate of its first
 * frame, which is exact for a constant bitrate. A stream of variable bitrate without such a frame is only
 * estimated, and the waveform is redrawn to its decoded length at the end.
 */
function mpegSeconds(header: MpegHeader, frames: number | null, bytes: number): number {
  if (frames !== null) return (frames * header.samples) / header.sampleRate
  if (header.bitrate !== null) return (bytes * 8) / header.bitrate
  return (bytes / header.length) * (header.samples / header.sampleRate)
}

async function buildMpeg(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const start = await afterId3(file.size, file.read)
  const held = new HeldBytes(file.pieces(start, file.size), start)
  const frames = mpegFrames(held, FIRST_FRAME_WITHIN)
  try {
    const first = await frames.next()
    if (first.done) return waveform.unsupported()
    const { header } = first.value
    const info = infoFrame(first.value)
    waveform.seconds = mpegSeconds(header, info?.frames ?? null, file.size - first.value.at)
    async function* chunks(): AsyncGenerator<Chunk> {
      let samples = 0
      const timestamp = (): number => Math.round((samples / header.sampleRate) * 1e6)
      if (!info) {
        yield { bytes: first.value.bytes, timestamp: timestamp() }
        samples += header.samples
      }
      for await (const frame of frames) {
        yield { bytes: frame.bytes, timestamp: timestamp() }
        samples += frame.header.samples
      }
    }
    const config = { codec: header.codec, sampleRate: header.sampleRate, numberOfChannels: header.channels }
    if (!(await decodeInto(config, chunks(), waveform, signal))) waveform.unsupported()
  } finally {
    await frames.return(undefined)
    await held.close()
  }
}

async function buildMp4(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const track = await readMp4Track(file)
  if (!track) return waveform.unsupported()
  waveform.seconds = track.seconds
  if (!(await decodeInto(track.config, mp4Samples(track, file), waveform, signal))) waveform.unsupported()
}

async function build(url: string, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const file = await openRangedFile(url, signal)
  const head = await file.read(0, Math.min(file.size, 12))
  if (isWav(head)) return buildWav(file, waveform, signal)
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return buildMp4(file, waveform, signal)
  return buildMpeg(file, waveform, signal)
}

const openAudio = async (url: string) => {
  const waveform = new Waveform()
  const stop = new AbortController()
  // A document closed partway leaves its waveform unfinished, since no viewer asks for it any more.
  void build(url, waveform, stop.signal).then(
    () => (stop.signal.aborted ? undefined : waveform.end()),
    (error: unknown) => waveform.fail(error)
  )
  return {
    methods: {
      peaks: ({ from }: { from: number }): Promise<PeaksAnswer> => waveform.after(from)
    },
    close: () => stop.abort()
  }
}

export default openAudio satisfies OpenPreviewDocument
