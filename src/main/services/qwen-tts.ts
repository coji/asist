import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { QWEN_TTS_CODEC, QWEN_TTS_MODELS, qwenTtsFiles, type QwenTtsSize, type QwenTtsVoice } from '@shared/tts-models'
import type { SetupProgress } from '@shared/ipc'
import { platformCapabilities } from './platform'
import { getSettings } from './settings'
import { ttsWorkerPath } from './speech-binaries'
import { filesInstalled, modelFilePath, prepareModelFiles } from './speech-models'
import { SpeechShaper, encodeWav } from './speech-shaper'
import { startSpeechWorker, type SpeechWorker } from './speech-worker'

/**
 * Speech synthesis with Qwen3-TTS in qwen3-tts-worker, on the GPU the capabilities chose, at the size the
 * setting names. The worker serves one request at a time in arrival order and returns the audio in pieces
 * while the sentence is still being generated: its first frame alone, then four frames at a time, so a
 * caller can start playback after the first piece.
 */

export interface QwenSpeechRequest {
  text: string
  voice: QwenTtsVoice
  /** The model's language name, from `qwenTtsLanguage`. */
  language: string
  /** The speaking rate, where 1.0 is normal. */
  speed?: number
}

/**
 * A worker that sends nothing for this long while requests are waiting is taken to be hung and is
 * replaced. A piece normally follows the previous one within a second.
 */
const SILENT_WORKER_TIMEOUT_MS = 30_000

/** The pieces of one request, handed from the worker's messages to the consumer's `for await`. */
class PieceQueue {
  private readonly pieces: Int16Array[] = []
  private ended = false
  private error: Error | null = null
  private wake: (() => void) | null = null

  push(piece: Int16Array): void {
    this.pieces.push(piece)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  fail(error: Error): void {
    this.error ??= error
    this.wake?.()
  }

  async *read(): AsyncGenerator<Int16Array> {
    for (;;) {
      const piece = this.pieces.shift()
      if (piece) yield piece
      else if (this.error) throw this.error
      else if (this.ended) return
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

let worker: SpeechWorker | null = null
/** The size the running worker loaded. */
let workerSize: QwenTtsSize | null = null
let workerReady = false
let starting: Promise<boolean> | null = null
let silenceTimer: NodeJS.Timeout | null = null
const requests = new Map<string, PieceQueue>()

/** Whether the files of the size are there. */
export function installationStatus(size: QwenTtsSize = getSettings().qwenTtsSize): { modelInstalled: boolean } {
  return { modelInstalled: filesInstalled(qwenTtsFiles(size)) }
}

export function available(): boolean {
  return Boolean(worker && workerReady && worker.alive && workerSize === getSettings().qwenTtsSize)
}

/** True while a worker this app started is loading the model. */
export function isStarting(): boolean {
  return starting !== null
}

/** The sample rate of the pieces, known once the worker is ready. */
export function sampleRate(): number {
  const rate = worker?.info.sampleRate
  if (typeof rate !== 'number') throw new Error('Qwen3-TTS worker is not ready')
  return rate
}

function armSilenceTimer(): void {
  if (silenceTimer) clearTimeout(silenceTimer)
  silenceTimer = requests.size === 0
    ? null
    : setTimeout(() => stopWorker(new Error('Qwen3-TTS worker stopped responding')), SILENT_WORKER_TIMEOUT_MS)
}

function handleMessage(message: Record<string, unknown>): void {
  const queue = typeof message.id === 'string' ? requests.get(message.id) : undefined
  if (!queue) return
  if (message.type === 'chunk' && typeof message.pcm === 'string') {
    const bytes = Buffer.from(message.pcm, 'base64')
    // The copy gives the samples their own aligned buffer; a Buffer from the pool can start at an odd offset.
    queue.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
  } else {
    requests.delete(message.id as string)
    if (message.type === 'end') queue.end()
    else queue.fail(new Error(typeof message.error === 'string' && message.error ? message.error : 'Qwen3-TTS synthesis failed'))
  }
  armSilenceTimer()
}

async function startWorker(): Promise<boolean> {
  if (available()) return true
  if (starting) return starting
  stopWorker()
  const size = getSettings().qwenTtsSize
  const { localSpeech } = platformCapabilities()
  // The capabilities leave Qwen3-TTS out where the local speech does not run, so a start here is a caller's mistake.
  if (localSpeech.backend === null) throw new Error('Qwen3-TTS cannot run on this machine')
  if (!installationStatus(size).modelInstalled) return false
  // The worker ships with the app, so a missing one is a broken build rather than something to prepare.
  if (!fs.existsSync(ttsWorkerPath())) throw new Error(`qwen3-tts-worker is missing from ${ttsWorkerPath()}`)
  const started: SpeechWorker = startSpeechWorker(
    ttsWorkerPath(),
    [modelFilePath(QWEN_TTS_MODELS[size].talker), modelFilePath(QWEN_TTS_CODEC), '--device', localSpeech.device],
    'qwen3-tts',
    {
      onMessage: (message) => {
        if (worker === started) handleMessage(message)
      },
      onFailure: (error) => {
        if (worker === started) stopWorker(error)
      }
    }
  )
  worker = started
  workerSize = size
  const operation = started.ready
    .then((ready) => {
      if (worker !== started) return false
      if (!ready) stopWorker()
      workerReady = ready
      return ready
    })
    .finally(() => {
      if (starting === operation) starting = null
    })
  starting = operation
  return operation
}

/** Starts the worker on the size the setting names. Resolves false when the worker or the model files are missing. */
export function ensureWorker(): Promise<boolean> {
  return startWorker()
}

export function stop(): void {
  stopWorker()
}

function stopWorker(error: Error = new DOMException('Qwen3-TTS worker stopped', 'AbortError')): void {
  const stale = worker
  worker = null
  workerSize = null
  workerReady = false
  starting = null
  stale?.stop()
  for (const queue of requests.values()) queue.fail(error)
  requests.clear()
  armSilenceTimer()
}

/**
 * On a short interjection the model often rambles instead of stopping. Measured on 2026-09-21 with
 * `ono_anna`, eight generations each: "あー。" came out between 0.6 and 6.5 s and "はいはい。" between
 * 0.5 and 7.0 s, where a natural reading takes under a second, and between 40% and 90% of the
 * generations were plausible. Whole sentences are read at about 0.16 s per character and do not show
 * this. Every generation is cancelled once it passes a length no natural reading reaches, and a clip
 * is generated again until it stays below it; each generation is sampled afresh.
 *
 * A digit is read as a word of its own and takes longer than a character of text, so it is allowed
 * twice the time. Measured on 2026-09-26 with `ono_anna`, 16 readings: "暗証番号は4桁で、8264です。"
 * took up to 5.9 s, which the allowance by characters alone, 5.4 s, cut before "四です".
 */
const plausibleSeconds = (text: string): number =>
  0.6 + 0.3 * text.length + 0.3 * (text.match(/\p{Nd}/gu)?.length ?? 0)
const CLIP_ATTEMPTS = 6

/**
 * Synthesizes one text and yields mono pieces of up to a third of a second each as they are generated,
 * with the silence around the sentence cut and the level evened out. The stream ends early when
 * the model rambles past a plausible length. Aborting the signal, or leaving the loop early, cancels
 * the request in the worker.
 */
export async function* stream(request: QwenSpeechRequest, signal?: AbortSignal): AsyncGenerator<Float32Array> {
  if (!(await ensureWorker()) || !worker) throw new Error('Qwen3-TTS is not installed or failed to start')
  signal?.throwIfAborted()
  const active = worker
  const id = randomUUID()
  const queue = new PieceQueue()
  // Still registered means the worker has not finished the request.
  const cancel = (): void => {
    if (requests.delete(id) && worker === active) active.send({ type: 'cancel', id })
    armSilenceTimer()
  }
  // The abort reaches the worker at once, even while the consumer is not pulling the next piece.
  const abort = (): void => {
    queue.fail(signal?.reason instanceof Error ? signal.reason : new DOMException('Speech synthesis aborted', 'AbortError'))
    cancel()
  }
  requests.set(id, queue)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    active.send({ id, text: request.text, voice: request.voice, language: request.language, speed: request.speed ?? 1 })
    armSilenceTimer()
    const shaper = new SpeechShaper(sampleRate())
    const limit = plausibleSeconds(request.text) * sampleRate()
    let samples = 0
    for await (const piece of queue.read()) {
      const shaped = shaper.push(piece)
      if (shaped.length > 0) yield shaped
      samples += shaped.length
      if (samples > limit) return
    }
    const tail = shaper.flush()
    if (tail.length > 0) yield tail
  } finally {
    signal?.removeEventListener('abort', abort)
    cancel()
  }
}

/** Synthesizes the whole text into a WAV file, for clips that are cached and played at once. `volume` scales the samples. */
export async function synthesizeWav(request: QwenSpeechRequest, signal?: AbortSignal, volume = 1): Promise<Buffer> {
  for (let attempt = 0; attempt < CLIP_ATTEMPTS; attempt++) {
    const pieces: Float32Array[] = []
    let samples = 0
    for await (const piece of stream(request, signal)) {
      pieces.push(volume === 1 ? piece : piece.map((value) => value * volume))
      samples += piece.length
    }
    if (samples > 0 && samples <= plausibleSeconds(request.text) * sampleRate()) return encodeWav(pieces, sampleRate())
  }
  throw new Error(`Qwen3-TTS produced no plausible reading of "${request.text}" in ${CLIP_ATTEMPTS} attempts`)
}

let prepareInFlight: Promise<{ ok: boolean; message: string }> | null = null
let prepareController: AbortController | null = null

/** Downloads the files of the size the setting names and starts the worker on them. Progress arrives through `onProgress`. */
export function prepare(onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
  if (prepareInFlight) return prepareInFlight
  const controller = new AbortController()
  prepareController = controller
  const size = getSettings().qwenTtsSize
  const operation = prepareModelFiles({
    files: qwenTtsFiles(size),
    label: QWEN_TTS_MODELS[size].label,
    feature: 'Qwen3-TTS',
    signal: controller.signal,
    onProgress,
    start: () => startWorker()
  }).finally(() => {
    if (prepareInFlight === operation) prepareInFlight = null
    if (prepareController === controller) prepareController = null
  })
  prepareInFlight = operation
  return operation
}

export function cancelPreparation(): boolean {
  if (!prepareController) return false
  prepareController.abort()
  stopWorker()
  return true
}
