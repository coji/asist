import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { asrLanguage, type AsrModelSpec } from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import { conversationLocale } from './conversation-locale'
import { Transcriptions } from './asr-transcriptions'
import { t } from './i18n'
import * as runtime from './speech-runtime'

/**
 * How long a caller waits for a partial transcription. The worker still finishes a partial that took
 * longer: stopping it would also fail the final transcription queued behind the partial.
 */
const PARTIAL_WAIT_MS = 4_000

let worker: runtime.SpeechWorker | null = null
let workerModel: AsrModelSpec | null = null
let workerReady = false
let ensureInFlight: Promise<boolean> | null = null
let ensureModel: AsrModelSpec | null = null
let prepareInFlight: Promise<{ ok: boolean; message: string }> | null = null
const transcriptions = new Transcriptions(() => path.join(app.getPath('userData'), 'asr-temp'))

/** Called once at startup, before the first transcription, to remove the recordings an earlier run left behind. */
export function clearTemporaryAudio(): void {
  transcriptions.clearLeftovers()
}

/** A model the runtime does not offer, passed as null, is never installed. */
export function installationStatus(model: AsrModelSpec | null): {
  runtimeInstalled: boolean
  modelInstalled: boolean
} {
  return { runtimeInstalled: runtime.runtimeInstalled(), modelInstalled: model !== null && runtime.modelInstalled(model) }
}

function running(model: AsrModelSpec): boolean {
  return Boolean(worker && workerModel === model && workerReady && worker.alive)
}

async function startWorker(model: AsrModelSpec): Promise<boolean> {
  if (running(model)) return true
  stopWorker()
  const started = runtime.startWorker({
    worker: 'asr',
    model,
    onMessage: (message) => {
      if (worker !== started || typeof message.id !== 'string') return
      transcriptions.complete(message.id, message.type === 'result'
        ? { text: String(message.text ?? '').trim() }
        : { error: new Error(typeof message.error === 'string' && message.error ? message.error : 'MLX ASR inference failed') })
    },
    onFailure: (error) => {
      if (worker === started) stopWorker(error)
    }
  })
  if (!started) return false
  worker = started
  workerModel = model
  const ready = await started.ready
  if (worker !== started) return false
  if (!ready) stopWorker()
  workerReady = ready
  return ready
}

export function ensureServer(model: AsrModelSpec): Promise<boolean> {
  if (running(model)) return Promise.resolve(true)
  if (ensureInFlight && ensureModel === model) return ensureInFlight
  const operation = startWorker(model).finally(() => {
    if (ensureInFlight === operation) {
      ensureInFlight = null
      ensureModel = null
    }
  })
  ensureInFlight = operation
  ensureModel = model
  return operation
}

export async function available(model: AsrModelSpec): Promise<boolean> {
  return running(model)
}

export function stop(): void {
  stopWorker()
  transcriptions.failAll(new DOMException('MLX ASR worker stopped', 'AbortError'))
}

/** Fails only the requests bound to the old worker, leaving the ones that are still acquiring the next worker alone. */
function stopWorker(error: Error = new DOMException('MLX ASR worker stopped', 'AbortError')): void {
  const stale = worker
  worker = null
  workerModel = null
  workerReady = false
  ensureInFlight = null
  ensureModel = null
  if (!stale) return
  stale.stop()
  transcriptions.failWorker(stale.child, error)
}

function sendRequest(model: AsrModelSpec, samples: Float32Array, id: string): Promise<string> {
  // The language is read here, per request, so that a change of the setting applies to the next
  // utterance without reloading the model.
  return transcriptions.start(samples, id, asrLanguage(model, conversationLocale()), () => {
    // ensureServer waits for ready after the spawn, so the child is captured here, before any await, and
    // this request stays bound to that one child.
    const ready = ensureServer(model)
    const requestedWorker = worker
    return {
      child: requestedWorker?.child ?? null,
      ready,
      isCurrent: () => worker === requestedWorker && workerModel === model,
      stop: () => { if (worker === requestedWorker) stopWorker() }
    }
  })
}

export function transcribe(
  model: AsrModelSpec,
  samples: Float32Array,
  requestId?: string
): Promise<string> {
  return sendRequest(model, samples, requestId || randomUUID())
}

export async function transcribePartial(
  model: AsrModelSpec,
  samples: Float32Array
): Promise<string> {
  // The worker answers in arrival order, so a partial sent while it still works on another request,
  // an abandoned partial included, would only delay the final transcription.
  if (transcriptions.size > 0) return ''
  const answer = sendRequest(model, samples, randomUUID()).catch(() => '')
  let timer: NodeJS.Timeout | undefined
  const abandoned = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(''), PARTIAL_WAIT_MS)
  })
  try {
    return await Promise.race([answer, abandoned])
  } finally {
    clearTimeout(timer)
  }
}

export function cancelTranscription(requestId: string): boolean {
  return transcriptions.cancel(requestId)
}

let prepareController: AbortController | null = null

export function cancelPreparation(): boolean {
  if (!prepareController) return false
  prepareController.abort()
  stop()
  return true
}

export function prepare(
  model: AsrModelSpec,
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (prepareInFlight) return prepareInFlight
  const controller = new AbortController()
  prepareController = controller
  const operation = runtime.prepareModel({
    model,
    feature: t('settingsModels.features.mlxAsr'),
    signal: controller.signal,
    onProgress,
    start: () => ensureServer(model)
  }).finally(() => {
    if (prepareInFlight === operation) prepareInFlight = null
    prepareController = null
  })
  prepareInFlight = operation
  return operation
}
