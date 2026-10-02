import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { IRODORI_TTS_MODEL, IRODORI_TTS_VOICE_IDS, QWEN_TTS_CODEC, QWEN_TTS_MODELS, isLocalTtsEngine, localTtsModel, type LocalTtsEngine, type LocalTtsModel } from '@shared/tts-models'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'
import { getSettings } from './settings'
import { speechWorkerPath } from './speech-binaries'
import { filesInstalled, modelFilePath, prepareModelFiles } from './speech-models'
import { SpeechShaper, encodeWav } from './speech-shaper'
import { startSpeechWorker, type SpeechWorker } from './speech-worker'

/**
 * Speech synthesis on the GPU the capabilities chose, in speech.cpp's worker, which runs one model per
 * process: Irodori-TTS, or Qwen3-TTS at the size the setting names. Choosing the other engine or size starts
 * the worker again. The worker serves one request at a time in arrival order and returns the audio in pieces:
 * Qwen3-TTS while the sentence is still being generated, its first frame alone and then four frames at a
 * time, and Irodori-TTS once the whole sentence is made, as its codec decodes it.
 */

export interface LocalSpeechRequest {
  text: string
  voice: string
  /** The BCP 47 tag of the language. */
  language: string
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

/** What one worker runs. Two starts run the same worker when their keys match. */
interface WorkerSpec {
  key: string
  model: LocalTtsModel
  logName: string
  args: string[]
}

/** The voice files ASIST ships for Irodori-TTS, which needs at least one at start and switches between them per request. */
const irodoriVoicePath = (voice: string): string => resourcePath(`irodori-voices/${voice}.voice.gguf`)

function workerSpec(engine: LocalTtsEngine): WorkerSpec {
  const size = getSettings().qwenTtsSize
  const model = localTtsModel(engine, size)
  if (engine === 'irodori') {
    return {
      key: 'irodori',
      model,
      logName: 'irodori-tts',
      args: [
        modelFilePath(IRODORI_TTS_MODEL.model),
        modelFilePath(IRODORI_TTS_MODEL.codec),
        ...IRODORI_TTS_VOICE_IDS.flatMap((voice) => ['--voice', `${voice}=${irodoriVoicePath(voice)}`])
      ]
    }
  }
  return { key: `qwen3tts:${size}`, model, logName: 'qwen3-tts', args: [modelFilePath(QWEN_TTS_MODELS[size].talker), modelFilePath(QWEN_TTS_CODEC)] }
}

let worker: SpeechWorker | null = null
/** The spec the running worker was started with. */
let workerKey: string | null = null
let workerLabel = ''
let workerReady = false
let starting: Promise<boolean> | null = null
let silenceTimer: NodeJS.Timeout | null = null
const requests = new Map<string, PieceQueue>()

/** Whether the files of the engine's model, as the settings name it, are there. */
export function installationStatus(engine: LocalTtsEngine): { modelInstalled: boolean } {
  return { modelInstalled: filesInstalled(localTtsModel(engine, getSettings().qwenTtsSize).files) }
}

export function available(engine: LocalTtsEngine): boolean {
  return Boolean(worker && workerReady && worker.alive && workerKey === workerSpec(engine).key)
}

/** True while a worker this app started is loading its model. */
export function isStarting(): boolean {
  return starting !== null
}

/** The sample rate of the pieces, known once the worker is ready. */
export function sampleRate(): number {
  const rate = worker?.info.sampleRate
  if (typeof rate !== 'number') throw new Error('the speech worker is not ready')
  return rate
}

function armSilenceTimer(): void {
  if (silenceTimer) clearTimeout(silenceTimer)
  silenceTimer = requests.size === 0
    ? null
    : setTimeout(() => stopWorker(new Error(errorText('voice.speech.engineNoResponse', { engine: workerLabel }))), SILENT_WORKER_TIMEOUT_MS)
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
    else if (typeof message.error === 'string' && message.error) queue.fail(workerFailure(new Error(message.error)))
    else queue.fail(new Error(errorText('voice.speech.engineFailedWithoutReason', { engine: workerLabel })))
  }
  armSilenceTimer()
}

async function startWorker(engine: LocalTtsEngine): Promise<boolean> {
  if (available(engine)) return true
  const spec = workerSpec(engine)
  if (starting && workerKey === spec.key) return starting
  stopWorker()
  const { localSpeech } = platformCapabilities()
  // The capabilities leave the local engines out where the local speech does not run, so a start here is a caller's mistake.
  if (localSpeech.backend === null) throw new Error(`${spec.model.label} cannot run on this machine`)
  if (!filesInstalled(spec.model.files)) return false
  // The worker ships with the app, so a missing one is a broken build rather than something to prepare.
  if (!fs.existsSync(speechWorkerPath())) throw new Error(`speech-worker is missing from ${speechWorkerPath()}`)
  const started: SpeechWorker = startSpeechWorker(speechWorkerPath(), [...spec.args, '--device', localSpeech.device], spec.logName, {
    onMessage: (message) => {
      if (worker === started) handleMessage(message)
    },
    onFailure: (error) => {
      if (worker === started) stopWorker(workerFailure(error))
    }
  })
  worker = started
  workerKey = spec.key
  workerLabel = spec.model.label
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

/** Starts the worker on the engine's model as the settings name it. Resolves false when the model files are missing. */
export function ensureWorker(engine: LocalTtsEngine): Promise<boolean> {
  return startWorker(engine)
}

export function stop(): void {
  stopWorker()
}

/**
 * The error of a request the worker failed. The conversation shows the error of a sentence that breaks off,
 * so it names the engine in the user's language and carries the worker's own message as its detail.
 */
const workerFailure = (reason: Error): Error =>
  new Error(errorText('voice.speech.engineFailed', { engine: workerLabel, detail: reason.message }), { cause: reason })

/**
 * Stops the worker and ends every request on it with `error`. A stop asked for, as when another engine or
 * size is chosen, ends them as aborted, which the conversation does not report as a failure.
 */
function stopWorker(error: Error = new DOMException(errorText('voice.speech.engineStopped', { engine: workerLabel }), 'AbortError')): void {
  const stale = worker
  worker = null
  workerKey = null
  workerReady = false
  starting = null
  stale?.stop()
  for (const queue of requests.values()) queue.fail(error)
  requests.clear()
  armSilenceTimer()
}

/**
 * On a short interjection Qwen3-TTS often rambles instead of stopping. Measured on 2026-09-21 with
 * `ono_anna`, eight generations each: "あー。" came out between 0.6 and 6.5 s and "はいはい。" between
 * 0.5 and 7.0 s, where a natural reading takes under a second, and between 40% and 90% of the
 * generations were plausible. Whole sentences are read at about 0.16 s per character and do not show
 * this. Every generation is cancelled once it passes a length no natural reading reaches, and a clip
 * is generated again until it stays below it; each generation is sampled afresh.
 *
 * A digit is read as a word of its own and takes longer than a character of text, so it is allowed
 * twice the time. Measured on 2026-09-26 with `ono_anna`, 16 readings: "暗証番号は4桁で、8264です。"
 * took up to 5.9 s, which the allowance by characters alone, 5.4 s, cut before "四です".
 *
 * Irodori-TTS fixes a sentence's length before it makes it, so it has no limit here.
 */
const plausibleSeconds = (engine: LocalTtsEngine, text: string): number =>
  engine === 'qwen3tts' ? 0.6 + 0.3 * text.length + 0.3 * (text.match(/\p{Nd}/gu)?.length ?? 0) : Infinity
const CLIP_ATTEMPTS = 6

/**
 * Synthesizes one text and yields mono pieces of up to a third of a second each as they are made,
 * with the silence around the sentence cut and the level evened out. A stream of Qwen3-TTS ends early
 * when the model rambles past a plausible length. Aborting the signal, or leaving the loop early, cancels
 * the request in the worker.
 */
export async function* stream(engine: LocalTtsEngine, request: LocalSpeechRequest, signal?: AbortSignal): AsyncGenerator<Float32Array> {
  if (!(await ensureWorker(engine)) || !worker) throw new Error(`${localTtsModel(engine, getSettings().qwenTtsSize).label} is not installed or failed to start`)
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
    active.send({ id, text: request.text, voice: request.voice, language: request.language })
    armSilenceTimer()
    const shaper = new SpeechShaper(sampleRate())
    const limit = plausibleSeconds(engine, request.text) * sampleRate()
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
export async function synthesizeWav(engine: LocalTtsEngine, request: LocalSpeechRequest, signal?: AbortSignal, volume = 1): Promise<Buffer> {
  for (let attempt = 0; attempt < CLIP_ATTEMPTS; attempt++) {
    const pieces: Float32Array[] = []
    let samples = 0
    for await (const piece of stream(engine, request, signal)) {
      pieces.push(volume === 1 ? piece : piece.map((value) => value * volume))
      samples += piece.length
    }
    if (samples > 0 && samples <= plausibleSeconds(engine, request.text) * sampleRate()) return encodeWav(pieces, sampleRate())
  }
  throw new Error(`${workerLabel} produced no plausible reading of "${request.text}" in ${CLIP_ATTEMPTS} attempts`)
}

/** The preparation under way, with the key of the worker that runs the model whose files it fetches. */
let preparation: { key: string; controller: AbortController; operation: Promise<{ ok: boolean; message: string }> } | null = null

/**
 * Downloads the files of the engine's model as the settings name it, and starts the worker on them if the
 * settings still select that engine and size once the files are there. Progress arrives through `onProgress`.
 */
export function prepare(engine: LocalTtsEngine, onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
  if (preparation) return preparation.operation
  const controller = new AbortController()
  const { key, model } = workerSpec(engine)
  const operation = prepareModelFiles({
    files: model.files,
    label: model.label,
    feature: model.label,
    signal: controller.signal,
    onProgress,
    selected: () => {
      const chosen = getSettings().ttsEngine
      return isLocalTtsEngine(chosen) && workerSpec(chosen).key === key
    },
    start: () => startWorker(engine)
  }).finally(() => {
    if (preparation?.operation === operation) preparation = null
  })
  preparation = { key, controller, operation }
  return operation
}

export function cancelPreparation(): boolean {
  if (!preparation) return false
  preparation.controller.abort()
  // A worker on another model is the one the settings moved to while the files downloaded, which the preparation did not start.
  if (workerKey === preparation.key) stopWorker()
  return true
}
