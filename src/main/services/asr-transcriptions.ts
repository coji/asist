import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'

/** The worker one request uses. A worker that is replaced while the request is being prepared does not change where it is sent. */
export interface TranscriptionWorker {
  child: ChildProcessWithoutNullStreams | null
  ready: Promise<boolean>
  isCurrent: () => boolean
  stop: () => void
}

/**
 * A worker that leaves a request unanswered this long is taken to be hung and is stopped. The worker
 * answers one request at a time in arrival order, so the time also covers the requests queued ahead.
 */
const ANSWER_TIMEOUT_MS = 60_000

type Result = { text: string } | { error: Error }
interface Request {
  id: string
  /** The language of this transcription, in the form the loaded model takes. */
  language: string
  resolve: (text: string) => void
  reject: (error: Error) => void
  worker: TranscriptionWorker | null
  wavPath: string | null
  preparing: boolean
  sent: boolean
  timer: NodeJS.Timeout | null
}

/** Owns a local transcription from its arrival to its completion, including the temporary WAV the request writes. */
export class Transcriptions {
  private readonly pending = new Map<string, Request>()

  constructor(private readonly directory: () => string) {}

  get size(): number {
    return this.pending.size
  }

  /**
   * Removes the WAVs of the user's voice that a run left behind when it ended before its own cleanup, as
   * on a crash or a forced quit. Only a moment with no request can tell a leftover from a WAV in use, so
   * it refuses while any request is open; at startup every file there is a leftover.
   */
  clearLeftovers(): void {
    if (this.pending.size > 0) throw new Error('clearLeftovers: a transcription is still open')
    fs.rmSync(this.directory(), { recursive: true, force: true })
  }

  start(
    samples: Float32Array,
    id: string,
    language: string,
    acquireWorker: () => TranscriptionWorker
  ): Promise<string> {
    if (this.pending.has(id)) return Promise.reject(new Error(`duplicate transcription request: ${id}`))
    return new Promise<string>((resolve, reject) => {
      const request: Request = {
        id, language, resolve, reject, worker: null, wavPath: null, preparing: true, sent: false, timer: null
      }
      this.pending.set(id, request)
      try {
        request.worker = acquireWorker()
        void this.prepare(request, samples).catch((error: unknown) => {
          this.finish(request, { error: error instanceof Error ? error : new Error(String(error)) })
        })
      } catch (error) {
        request.preparing = false
        this.finish(request, { error: error instanceof Error ? error : new Error(String(error)) })
      }
    })
  }

  complete(id: string, result: Result): void {
    const request = this.pending.get(id)
    if (request) this.finish(request, result)
  }

  cancel(id: string): boolean {
    const request = this.pending.get(id)
    if (!request) return false
    this.finish(request, { error: new DOMException(errorText('speechRecognition.errors.stopped'), 'AbortError') })
    // Python cannot abort just the inference that is running, so a request that has already been sent
    // can only be cancelled by stopping its worker. A request still being prepared is cancelled on its
    // own, which keeps the other work on the same worker alive.
    if (request.sent) request.worker?.stop()
    return true
  }

  failWorker(child: ChildProcessWithoutNullStreams, error: Error): void {
    for (const request of this.pending.values()) {
      if (request.worker?.child === child) this.finish(request, { error })
    }
  }

  failAll(error: Error): void {
    for (const request of this.pending.values()) this.finish(request, { error })
  }

  private ensureCurrent(request: Request): void {
    if (this.pending.get(request.id) !== request || !request.worker?.isCurrent()) {
      throw new DOMException(errorText('speechRecognition.errors.superseded'), 'AbortError')
    }
  }

  private async prepare(request: Request, samples: Float32Array): Promise<void> {
    const worker = request.worker!
    try {
      const ready = await worker.ready
      if (!ready || !worker.child?.stdin.writable) {
        throw new Error(errorText('speechRecognition.errors.mlxNotReady'))
      }
      this.ensureCurrent(request)
      const directory = this.directory()
      await fs.promises.mkdir(directory, { recursive: true })
      this.ensureCurrent(request)
      request.wavPath = path.join(directory, `${randomUUID()}.wav`)
      await fs.promises.writeFile(request.wavPath, encodeWav(samples), { mode: 0o600 })
      this.ensureCurrent(request)
      request.preparing = false
      request.timer = setTimeout(() => {
        this.finish(request, { error: new DOMException(errorText('speechRecognition.errors.timedOut'), 'TimeoutError') })
        worker.stop()
      }, ANSWER_TIMEOUT_MS)
      request.timer.unref?.()
      request.sent = true
      worker.child.stdin.write(`${JSON.stringify({ id: request.id, wavPath: request.wavPath, language: request.language })}\n`, (error) => {
        if (error) this.finish(request, { error })
      })
    } finally {
      request.preparing = false
      // On a cancellation during the write, removing the file first would let the slow writeFile create
      // it again, so the WAV of this request is released only once the write has finished.
      if (this.pending.get(request.id) !== request) await this.releaseFile(request)
    }
  }

  private finish(request: Request, result: Result): void {
    if (this.pending.get(request.id) !== request) return
    this.pending.delete(request.id)
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    if (!request.preparing) void this.releaseFile(request)
    if ('error' in result) request.reject(result.error)
    else request.resolve(result.text)
  }

  private async releaseFile(request: Request): Promise<void> {
    const wavPath = request.wavPath
    if (!wavPath) return
    request.wavPath = null
    try {
      await fs.promises.rm(wavPath, { force: true })
    } catch (error) {
      console.error('failed to delete the temporary MLX ASR audio:', error)
    }
  }
}

function encodeWav(samples: Float32Array, sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    data.writeInt16LE(Math.round(sample * 32767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
