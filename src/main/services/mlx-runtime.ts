import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { MLX_AUDIO_VERSION } from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { errorMessage, t } from './i18n'
import { childEnv } from './child-env'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'
import { createEnvironment, environmentCurrent, installRequirements, recordEnvironment } from './uv'

/**
 * The Python environment with mlx-audio that the MLX speech recognition and the Qwen3-TTS speech
 * synthesis share, and the JSON-lines workers that run in it. The environment is one uv-managed venv
 * under userData, installed from the pinned requirements file, and each service starts its own worker
 * script in it.
 */

/** A Hugging Face model pinned to one revision. */
export interface PinnedModel {
  id: string
  revision: string
  label: string
  /** Every file of the revision, as paths inside the snapshot. A new revision needs its own list. */
  files: readonly string[]
}

const PROTOCOL_PREFIX = 'ASIST_JSON:'
const WORKER_READY_TIMEOUT_MS = 180_000
const DOWNLOAD_PROGRESS_INTERVAL_MS = 500
const RUNTIME_LOCK_VERSION = 1
const STAMP = { version: MLX_AUDIO_VERSION, lockVersion: RUNTIME_LOCK_VERSION }

export function supported(): boolean {
  return platformCapabilities().speechRuntime.kind === 'mlx'
}

function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'mlx-audio-runtime')
}

function pythonPath(): string {
  const configured = process.env.ASIST_MLX_PYTHON?.trim()
  return configured || path.join(runtimeDir(), 'bin', 'python')
}

function repositoryCache(model: PinnedModel): string {
  return path.join(homedir(), '.cache', 'huggingface', 'hub', `models--${model.id.replace('/', '--')}`)
}

export function snapshotPath(model: PinnedModel): string {
  return path.join(repositoryCache(model), 'snapshots', model.revision)
}

/**
 * huggingface_hub links a file into the snapshot only once its download has finished, so a download
 * that failed or was cancelled leaves some of the files missing, and the worker cannot load the model
 * from such a snapshot. Only a snapshot with every file of the revision counts as installed.
 */
export function modelInstalled(model: PinnedModel): boolean {
  const snapshot = snapshotPath(model)
  return model.files.every((file) => fs.existsSync(path.join(snapshot, file)))
}

export function runtimeInstalled(): boolean {
  if (!supported()) return false
  if (!fs.existsSync(pythonPath())) return false
  if (process.env.ASIST_MLX_PYTHON?.trim()) return true
  return environmentCurrent(runtimeDir(), STAMP)
}

const workers = new Set<MlxWorker>()
let quitHookRegistered = false

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    for (const worker of [...workers]) worker.stop()
    for (const child of downloads) child.kill('SIGTERM')
  })
}

export interface WorkerOptions {
  /** The file name of the worker script under resources. */
  script: string
  model: PinnedModel
  /** The prefix of the worker's stderr lines in the app log. */
  logName: string
  /** Every protocol message except `ready` and `fatal`. */
  onMessage: (message: Record<string, unknown>) => void
  /** The worker failed to load, crashed or exited on its own. It is not called after `stop()`. */
  onFailure: (error: Error) => void
}

/** One running worker script. `ready` settles once: true on the worker's `ready` message, false when it fails or is stopped first. */
export class MlxWorker {
  readonly ready: Promise<boolean>
  /** The fields of the `ready` message, available once `ready` resolved true. */
  info: Record<string, unknown> = {}
  private stopped = false
  private settleReady!: (ready: boolean) => void

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly options: WorkerOptions) {
    this.ready = new Promise<boolean>((resolve) => { this.settleReady = resolve })
    const timeout = setTimeout(() => this.fail(new Error(`${options.logName} worker did not become ready`)), WORKER_READY_TIMEOUT_MS)
    void this.ready.then(() => clearTimeout(timeout))
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.error(`${options.logName}: ${line}`)
    })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code) => this.fail(new Error(`${options.logName} worker exited (${code ?? 'signal'})`)))
    // A write between the worker's death and its exit event fails with EPIPE, which becomes an uncaught
    // exception unless the stream has a listener.
    child.stdin.on('error', (error) => this.fail(error))
  }

  get alive(): boolean {
    return !this.stopped && this.child.exitCode === null && !this.child.killed
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    workers.delete(this)
    this.settleReady(false)
    if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGTERM')
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.stop()
    this.options.onFailure(error)
  }

  private handleLine(line: string): void {
    if (this.stopped) return
    const marker = line.indexOf(PROTOCOL_PREFIX)
    if (marker < 0) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line.slice(marker + PROTOCOL_PREFIX.length))
    } catch {
      return
    }
    if (message.type === 'ready') {
      this.info = message
      this.settleReady(true)
    } else if (message.type === 'fatal') {
      this.fail(new Error(typeof message.error === 'string' && message.error ? message.error : `${this.options.logName} worker failed to load`))
    } else {
      this.options.onMessage(message)
    }
  }
}

/** Starts a worker on the downloaded snapshot, or returns null when the environment, the script or the model is missing. */
export function startWorker(options: WorkerOptions): MlxWorker | null {
  if (!runtimeInstalled()) return null
  if (!modelInstalled(options.model)) return null
  const script = resourcePath(options.script)
  if (!fs.existsSync(script)) return null
  const child = spawn(pythonPath(), [script, snapshotPath(options.model), '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv({ HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONUNBUFFERED: '1' }),
    windowsHide: true
  })
  const worker = new MlxWorker(child, options)
  workers.add(worker)
  registerQuitHook()
  return worker
}

/** The downloads running now, which quitting the app stops. */
const downloads = new Set<ChildProcess>()

/**
 * The bytes written to the repository's cache since `since`: the files being downloaded and the ones
 * finished meanwhile. Files an earlier, interrupted download left behind are older and not counted.
 */
async function bytesWrittenSince(model: PinnedModel, since: number): Promise<number> {
  const blobs = path.join(repositoryCache(model), 'blobs')
  const names = await fs.promises.readdir(blobs).catch(() => [] as string[])
  let total = 0
  for (const name of names) {
    const stat = await fs.promises.stat(path.join(blobs, name)).catch(() => null)
    if (stat && stat.mtimeMs >= since) total += stat.size
  }
  return total
}

/**
 * Downloads the pinned snapshot into the Hugging Face cache with hf_snapshot.py, reporting the bytes
 * written against the repository's size. hf-xet is turned off: it held the whole 2.5 GB file in memory and
 * wrote it only at the end (measured 2026-09-24), which leaves nothing to report while it runs.
 */
function downloadModel(model: PinnedModel, signal: AbortSignal, onBytes: (done: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = (): DOMException => new DOMException(errorText('settingsModels.preparation.stopped'), 'AbortError')
    if (signal.aborted) return reject(stopped())
    const started = Date.now()
    const child = spawn(pythonPath(), [resourcePath('hf_snapshot.py'), model.id, model.revision], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ HF_HUB_DISABLE_XET: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONUNBUFFERED: '1' }),
      windowsHide: true
    })
    downloads.add(child)
    registerQuitHook()
    let total = 0
    let fatal = ''
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith(PROTOCOL_PREFIX)) return
      const message = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as { type?: string; bytes?: number; error?: string }
      if (message.type === 'total' && typeof message.bytes === 'number') total = message.bytes
      if (message.type === 'fatal') fatal = String(message.error ?? '')
    })
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.error(`hf-snapshot: ${line}`)
    })
    const timer = setInterval(() => {
      if (total > 0) void bytesWrittenSince(model, started).then((done) => onBytes(Math.min(done, total), total))
    }, DOWNLOAD_PROGRESS_INTERVAL_MS)
    const abort = (): void => {
      child.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })
    // A process that fails to spawn emits only 'error', never 'exit', so both end the download here.
    const finish = (error: Error | null): void => {
      clearInterval(timer)
      signal.removeEventListener('abort', abort)
      downloads.delete(child)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', finish)
    child.once('exit', (code) => {
      if (signal.aborted) finish(stopped())
      else if (code === 0 && modelInstalled(model)) finish(null)
      else finish(new Error(errorText('settingsModels.preparation.modelDownloadFailed', { model: model.label, detail: fatal || `exit ${code}` })))
    })
  })
}

let installInFlight: Promise<void> | null = null

/**
 * Creates the environment unless it is already installed. Two services preparing at once share one
 * installation, which the first caller's signal cancels.
 */
export function installRuntime(signal: AbortSignal, onStart: (message: string) => void): Promise<void> {
  if (runtimeInstalled()) return Promise.resolve()
  onStart(t('settingsModels.preparation.runtime', { version: MLX_AUDIO_VERSION }))
  if (installInFlight) return installInFlight
  const operation = install(signal).finally(() => {
    if (installInFlight === operation) installInFlight = null
  })
  installInFlight = operation
  return operation
}

async function install(signal: AbortSignal): Promise<void> {
  await createEnvironment(runtimeDir(), signal)
  await installRequirements(pythonPath(), 'mlx-audio-requirements.txt', signal)
  await recordEnvironment(runtimeDir(), STAMP)
}

export interface PrepareOptions {
  model: PinnedModel
  /** What the feature is called in the messages, already in the interface language. */
  feature: string
  signal: AbortSignal
  onProgress: (progress: SetupProgress) => void
  /** Starts the service's worker on the downloaded model and resolves to whether it became ready. */
  start: () => Promise<boolean>
}

/**
 * Installs the environment if needed, downloads the pinned model, then starts the worker on it, reporting
 * each step as setup progress. The download has no time limit, because the worker's ready timeout would
 * otherwise have to cover a 2.5 GB model on a slow line.
 */
export async function prepareModel(options: PrepareOptions): Promise<{ ok: boolean; message: string }> {
  const { model, feature, signal, onProgress, start } = options
  const progress = (message: string): void => onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
  if (!supported()) return { ok: false, message: t('settingsModels.preparation.unsupported', { feature }) }
  try {
    await installRuntime(signal, progress)
    if (!modelInstalled(model)) {
      const message = t('settingsModels.preparation.downloading', { model: model.label })
      progress(message)
      await downloadModel(model, signal, (done, total) => onProgress({
        status: 'downloading',
        pct: Math.min(99, Math.round((done / total) * 100)),
        downloadedMb: Math.round(done / 1e5) / 10,
        totalMb: Math.round(total / 1e6),
        message
      }))
    }
    progress(t('settingsModels.preparation.loading', { model: model.label }))
    if (!(await start())) throw new Error(errorText('settingsModels.preparation.startFailed', { model: model.label }))
    onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
    return { ok: true, message: t('settingsModels.preparation.done', { model: model.label }) }
  } catch (error) {
    const cancelled = signal.aborted
    const message = cancelled ? t('settingsModels.preparation.cancelled', { feature }) : errorMessage(error)
    onProgress({ status: cancelled ? 'cancelled' : 'error', pct: 0, downloadedMb: 0, totalMb: 0, message })
    return { ok: false, message }
  }
}
