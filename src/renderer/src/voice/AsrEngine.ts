import { errorText } from '@shared/i18n/error-text'
import type { AsrRequest, AsrResponse } from './asr-worker'

/**
 * The model downloads once and is cached afterwards. Small is chosen over base because it stands up
 * better to real microphone audio, at the cost of a roughly 250 MB download.
 */
const DEFAULT_MODEL = 'onnx-community/whisper-small'
/** Hugging Face model HEAD verified on 2026-08-03; never fetch floating `main`. */
export const DEFAULT_MODEL_REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732'
const DEFAULT_INIT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60_000

export interface AsrProgress {
  /** The progress over all files together, from 0 to 100. */
  progress: number
}

export interface AsrEngineOptions {
  /** Replaces how the Worker is created, for tests and for hosts that embed the renderer. */
  workerFactory?: () => Worker
  initTimeoutMs?: number
  transcribeTimeoutMs?: number
}

interface PendingTranscription {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface Initialization {
  promise: Promise<string>
  resolve: (device: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * The typed client of asr-worker. A broken worker fails everything waiting on it and is then thrown
 * away, and because the next init creates a new worker, the engine can come back after the machine
 * wakes from sleep or after the WebGPU device is lost.
 */
export class AsrEngine {
  private worker: Worker | null = null
  private initialization: Initialization | null = null
  private readyDevice: string | null = null
  private nextId = 1
  private pending = new Map<number, PendingTranscription>()
  private progressListeners = new Set<(info: AsrProgress) => void>()
  private readonly workerFactory: () => Worker
  private readonly initTimeoutMs: number
  private readonly transcribeTimeoutMs: number

  constructor(options: AsrEngineOptions = {}) {
    this.workerFactory =
      options.workerFactory ??
      (() => new Worker(new URL('./asr-worker.ts', import.meta.url), { type: 'module' }))
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
    this.transcribeTimeoutMs = options.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS
  }

  init(onProgress?: (info: AsrProgress) => void): Promise<string> {
    if (this.readyDevice) return Promise.resolve(this.readyDevice)
    if (onProgress) this.progressListeners.add(onProgress)

    // Concurrent callers must still share one model load and one worker.
    if (this.initialization) return this.initialization.promise

    let worker: Worker
    try {
      worker = this.workerFactory()
    } catch (error) {
      this.progressListeners.clear()
      return Promise.reject(this.toError(error, errorText('speechRecognition.errors.workerStartFailed')))
    }
    this.worker = worker

    let resolveInitialization!: (device: string) => void
    let rejectInitialization!: (error: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveInitialization = resolve
      rejectInitialization = reject
    })
    const timeout = setTimeout(() => {
      this.invalidateWorker(
        new Error(errorText('speechRecognition.errors.initTimeout', { ms: this.initTimeoutMs })),
        worker
      )
    }, this.initTimeoutMs)
    this.initialization = {
      promise,
      resolve: resolveInitialization,
      reject: rejectInitialization,
      timeout
    }

    // Summing loaded and total over the files gives an overall progress that only increases.
    const files = new Map<string, { loaded: number; total: number }>()

    worker.onmessage = (event: MessageEvent<AsrResponse>): void => {
      if (this.worker !== worker) return
      const message = event.data
      switch (message.type) {
        case 'progress': {
          files.set(message.file, { loaded: message.loaded, total: message.total })
          let loaded = 0
          let total = 0
          for (const file of files.values()) {
            loaded += file.loaded
            total += file.total
          }
          if (total > 0) {
            const info = { progress: (loaded / total) * 100 }
            for (const listener of this.progressListeners) listener(info)
          }
          break
        }
        case 'ready': {
          this.readyDevice = message.device
          const initialization = this.initialization
          this.initialization = null
          if (initialization) clearTimeout(initialization.timeout)
          this.progressListeners.clear()
          initialization?.resolve(message.device)
          break
        }
        case 'result':
          this.settlePending(message.id, undefined, message.text)
          break
        case 'error': {
          if (message.id !== undefined) {
            this.settlePending(message.id, new Error(message.message))
          } else {
            // Only loading the model fails without an id, with a message from transformers.js or ONNX Runtime.
            this.invalidateWorker(
              new Error(errorText('speechRecognition.errors.modelLoadFailed', { detail: message.message })),
              worker
            )
          }
          break
        }
      }
    }
    worker.onerror = (event): void => {
      this.invalidateWorker(new Error(event.message || errorText('speechRecognition.errors.workerStopped')), worker)
    }

    try {
      worker.postMessage({
        type: 'init',
        model: DEFAULT_MODEL,
        revision: DEFAULT_MODEL_REVISION
      } satisfies AsrRequest)
    } catch (error) {
      this.invalidateWorker(this.toError(error, errorText('speechRecognition.errors.workerInitFailed')), worker)
    }
    return promise
  }

  /** `language` is the English name of the conversation language in lower case, such as `japanese`. */
  transcribe(audio: Float32Array, language: string): Promise<string> {
    const worker = this.worker
    if (!worker || !this.readyDevice) {
      return Promise.reject(new Error('AsrEngine not initialized'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.invalidateWorker(
          new Error(errorText('speechRecognition.errors.transcribeTimeout', { ms: this.transcribeTimeoutMs })),
          worker
        )
      }, this.transcribeTimeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        worker.postMessage({ type: 'transcribe', id, audio, language } satisfies AsrRequest)
      } catch (error) {
        this.invalidateWorker(this.toError(error, errorText('speechRecognition.errors.sendFailed')), worker)
      }
    })
  }

  /** Discards the worker and everything waiting on it, so that the next init builds it again. */
  reset(reason = errorText('speechRecognition.errors.restarting')): void {
    this.invalidateWorker(new Error(reason))
  }

  dispose(): void {
    this.invalidateWorker(new Error('AsrEngine disposed'))
  }

  private settlePending(id: number, error?: Error, text?: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(id)
    if (error) pending.reject(error)
    else pending.resolve(text ?? '')
  }

  private invalidateWorker(error: Error, expectedWorker?: Worker): void {
    if (expectedWorker && this.worker !== expectedWorker) return

    const worker = this.worker
    this.worker = null
    this.readyDevice = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }

    const initialization = this.initialization
    this.initialization = null
    if (initialization) clearTimeout(initialization.timeout)
    this.progressListeners.clear()
    initialization?.reject(error)

    for (const id of [...this.pending.keys()]) this.settlePending(id, error)
  }

  private toError(error: unknown, fallback: string): Error {
    if (error instanceof Error) return error
    const message = String(error)
    return new Error(message && message !== '[object Object]' ? message : fallback)
  }
}
