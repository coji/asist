import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import type { SetupProgress } from '@shared/ipc'
import type { MessageKey } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { pythonEnv } from './child-env'
import { errorMessage, t } from './i18n'
import {
  downloadMissing,
  ensureRuntime,
  pythonPath,
  runtimeInstalled,
  type PinnedFile
} from './onnx-runtime'
import { resourcePath } from './resource-path'

/**
 * A model that a resident worker serves in the shared ONNX environment, from its preparation to its
 * requests: the aizuchi classifier and the memory embedding. The model's files are fetched at a pinned
 * commit into a folder under userData, only on an explicit preparation, and the worker reads nothing but
 * those files. Requests go to the one worker, which answers them in arrival order.
 */

const WORKER_READY_TIMEOUT_MS = 120_000
/** With two or more threads, onnxruntime's spin-waiting delays the renderer's VAD. */
const WORKER_THREADS = 1

/** A line of the worker's protocol as the service reads it, with the answer of a result already decoded. */
export type OnnxWorkerLine<Answer> =
  | {
      type: 'ready'
      /** Why this worker must not be used, as when its files do not belong to the pinned model. */
      refusal: string | null
    }
  | { type: 'result'; id: string; answer: Answer }
  | { type: 'error'; id: string; error: string }
  | { type: 'fatal'; error: string }

export interface OnnxWorkerOptions<Answer> {
  /** The prefix of the worker's lines in the app log, and its name in errors. */
  name: string
  /** The worker script under resources. */
  script: string
  /** The folder under userData that holds the model's files. */
  modelsDir: string
  /** The model's files, which the worker takes as its arguments in this order, followed by the thread count. */
  files: readonly PinnedFile[]
  /** The model's name in the log and in the preparation's messages. */
  modelLabel: string
  /** The feature the model serves, as the preparation's messages name it. */
  feature: Extract<MessageKey, `settingsModels.features.${string}`>
  /** Reads one line of stdout, returning null for a line that is not part of the protocol. */
  read: (line: string) => OnnxWorkerLine<Answer> | null
  /** A worker that leaves a request unanswered this long is taken to be hung and is stopped. */
  requestTimeoutMs: number
}

interface PendingRequest<Answer> {
  resolve: (answer: Answer) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  removeAbortListener: () => void
}

export class OnnxWorker<Answer> {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private starting: Promise<boolean> | null = null
  /** Settles the start of the current worker, once: true on its ready line, false when it goes first. */
  private settleStart: ((ready: boolean) => void) | null = null
  private readonly pending = new Map<string, PendingRequest<Answer>>()
  private preparing: Promise<{ ok: boolean; message: string }> | null = null
  private prepareController: AbortController | null = null
  private quitHookRegistered = false

  constructor(private readonly options: OnnxWorkerOptions<Answer>) {}

  /** The file name carries the commit, so that changing the model lands on a different file. */
  private targets(): string[] {
    const dir = path.join(app.getPath('userData'), this.options.modelsDir)
    return this.options.files.map((file) => path.join(dir, `${file.revision.slice(0, 7)}-${path.basename(file.file)}`))
  }

  modelInstalled(): boolean {
    return this.targets().every((target) => fs.existsSync(target))
  }

  running(): boolean {
    return Boolean(this.child && this.ready && this.child.exitCode === null)
  }

  status(): { runtimeInstalled: boolean; modelInstalled: boolean; running: boolean } {
    return { runtimeInstalled: runtimeInstalled(), modelInstalled: this.modelInstalled(), running: this.running() }
  }

  /**
   * Starts the worker, returning true at once when it already runs and false when the runtime or the model
   * is missing. A caller that arrives while the worker loads waits for it instead of starting another.
   */
  ensureStarted(): Promise<boolean> {
    if (this.running()) return Promise.resolve(true)
    if (this.starting) return this.starting
    const operation = this.start().finally(() => {
      if (this.starting === operation) this.starting = null
    })
    this.starting = operation
    return operation
  }

  private start(): Promise<boolean> {
    this.stop()
    const script = resourcePath(this.options.script)
    if (!runtimeInstalled() || !this.modelInstalled() || !fs.existsSync(script)) return Promise.resolve(false)
    const { name } = this.options
    const spawned = spawn(pythonPath(), [script, ...this.targets(), String(WORKER_THREADS)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonEnv(),
      windowsHide: true
    })
    this.child = spawned
    this.ready = false
    this.registerQuitHook()
    const started = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child === spawned) this.stop()
      }, WORKER_READY_TIMEOUT_MS)
      this.settleStart = (ready) => {
        clearTimeout(timer)
        this.settleStart = null
        resolve(ready)
      }
    })
    readline.createInterface({ input: spawned.stdout }).on('line', (line) => {
      if (this.child === spawned) this.handleLine(line)
    })
    readline.createInterface({ input: spawned.stderr }).on('line', (line) => {
      if (line.trim()) console.log(`${name}: ${line}`)
    })
    const detach = (reason: string): void => {
      if (this.child !== spawned) return
      this.child = null
      this.ready = false
      this.settleStart?.(false)
      this.failAll(new Error(reason))
    }
    spawned.on('error', (error) => detach(`${name} worker error: ${error.message}`))
    spawned.on('exit', (code) => detach(`${name} worker exited (${code ?? 'signal'})`))
    // A write between the worker's death and its exit event fails with EPIPE, which becomes an uncaught
    // exception unless the stream has a listener. The request that wrote gets the error through its callback.
    spawned.stdin.on('error', (error) => {
      console.warn(`${name}: worker input failed: ${error.message}`)
      if (this.child === spawned) this.stop()
    })
    return started
  }

  private handleLine(line: string): void {
    const { name } = this.options
    const message = this.options.read(line)
    if (message === null) {
      if (line.trim()) console.log(`${name}: ${line}`)
      return
    }
    switch (message.type) {
      case 'ready':
        if (message.refusal) {
          console.warn(`${name}: ${message.refusal}`)
          this.stop(new Error(message.refusal))
          return
        }
        this.ready = true
        console.log(`${name}: worker ready (${this.options.modelLabel})`)
        this.settleStart?.(true)
        return
      case 'fatal':
        console.warn(`${name}: worker fatal: ${message.error}`)
        this.stop(new Error(message.error))
        return
      case 'result':
        this.take(message.id)?.resolve(message.answer)
        return
      case 'error':
        this.take(message.id)?.reject(new Error(message.error))
    }
  }

  /**
   * Sends one request and resolves to its answer. It rejects while the worker is not running, and with the
   * signal's reason once the signal aborts.
   */
  request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const child = this.child
    if (!this.running() || !child?.stdin.writable) {
      return Promise.reject(new Error(`the ${this.options.name} worker is not running`))
    }
    const id = randomUUID()
    return new Promise<Answer>((resolve, reject) => {
      const { requestTimeoutMs } = this.options
      const timer = setTimeout(() => {
        this.take(id)?.reject(new Error(`the ${this.options.name} worker did not answer within ${requestTimeoutMs / 1000} seconds`))
        this.stop()
      }, requestTimeoutMs)
      timer.unref?.()
      // The computation on the Python side runs to the end on the shared worker: the request and its
      // timeout are dropped and a late answer is discarded. Killing the worker would also fail the other
      // requests queued on it.
      const abort = (): void => { this.take(id)?.reject(signal?.reason) }
      this.pending.set(id, {
        resolve, reject, timer,
        removeAbortListener: () => signal?.removeEventListener('abort', abort)
      })
      signal?.addEventListener('abort', abort, { once: true })
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error) this.take(id)?.reject(error)
      })
    })
  }

  private take(id: string): PendingRequest<Answer> | null {
    const request = this.pending.get(id)
    if (!request) return null
    this.pending.delete(id)
    clearTimeout(request.timer)
    request.removeAbortListener()
    return request
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.take(id)?.reject(error)
  }

  /** Stops the worker and fails every request that waits on it with `error`. */
  stop(error: Error = new Error(`the ${this.options.name} worker stopped`)): void {
    const stale = this.child
    this.child = null
    this.ready = false
    this.settleStart?.(false)
    if (stale && stale.exitCode === null && !stale.killed) {
      try {
        stale.stdin.end()
      } catch {
        // The stream is already closed.
      }
      const killTimer = setTimeout(() => {
        if (stale.exitCode === null && !stale.killed) stale.kill('SIGTERM')
      }, 1_000)
      killTimer.unref?.()
    }
    this.failAll(error)
  }

  private registerQuitHook(): void {
    if (this.quitHookRegistered) return
    this.quitHookRegistered = true
    app.on('will-quit', () => this.stop())
  }

  /** Builds the environment if needed, fetches the missing files and starts the worker, reporting each step. */
  prepare(onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
    if (this.preparing) return this.preparing
    const operation = this.prepareOnce(onProgress).finally(() => {
      if (this.preparing === operation) this.preparing = null
      this.prepareController = null
    })
    this.preparing = operation
    return operation
  }

  cancelPreparation(): boolean {
    if (!this.prepareController) return false
    this.prepareController.abort()
    this.stop()
    return true
  }

  private async prepareOnce(onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
    const feature = t(this.options.feature)
    const model = this.options.modelLabel
    const controller = new AbortController()
    this.prepareController = controller
    const progress = (message: string): void =>
      onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
    try {
      await ensureRuntime(controller.signal, progress, feature)
      const targets = this.targets()
      await downloadMissing(
        this.options.files.map((file, index) => ({ file, target: targets[index] })),
        controller.signal,
        ({ pct, downloadedMb, totalMb, file }) =>
          onProgress({
            status: 'downloading',
            pct,
            downloadedMb,
            totalMb,
            message: t('settingsModels.preparation.modelFile', { model, file })
          })
      )
      progress(t('settingsModels.preparation.loading', { model }))
      const ready = await this.ensureStarted()
      if (!ready) throw new Error(errorText('settingsModels.preparation.startFailed', { model }))
      onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
      return { ok: true, message: t('settingsModels.preparation.ready', { feature, model }) }
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const message = cancelled ? t('settingsModels.preparation.cancelled', { feature }) : errorMessage(error)
      onProgress({ status: cancelled ? 'cancelled' : 'error', pct: 0, downloadedMb: 0, totalMb: 0, message })
      return { ok: false, message }
    }
  }
}
