import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { MLX_AUDIO_VERSION } from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import type { SpeechRuntime } from '@shared/platform'
import { errorMessage, t } from './i18n'
import { pythonEnv } from './child-env'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'
import { createEnvironment, environmentCurrent, installRequirements, recordEnvironment, venvPython } from './uv'

/**
 * The Python environment of the local speech models, which the speech recognition and, on a runtime that
 * has it, the Qwen3-TTS speech synthesis share, and the JSON-lines workers that run in it. The environment
 * is one uv-managed venv under userData, installed from the runtime's pinned requirements file, and each
 * service starts its own worker script in it. Which runtime that is comes from the capabilities; what
 * differs between runtimes is in `SPEECH_RUNTIMES`, and the rest of this module is the same for all of them.
 */

/** A Hugging Face model pinned to one revision. */
export interface PinnedModel {
  id: string
  revision: string
  label: string
  /** Every file of the revision, as paths inside the snapshot. A new revision needs its own list. */
  files: readonly string[]
}

/** A worker script under resources, and the prefix of its stderr lines in the app log. */
interface WorkerScript {
  file: string
  logName: string
}

/** What one speech runtime has of its own. */
interface RuntimeSpec {
  /** The folder of the environment under userData. */
  directory: string
  /** The pinned requirements file under resources that the environment is installed from. */
  requirements: string
  /** The environment is built again when either value differs from the one it was recorded with. */
  stamp: { version: string; lockVersion: number }
  /** The progress message while the environment is being built. */
  preparing: () => string
  /** The variable that names a Python to use in place of the environment's, for development and tests. */
  pythonOverride: string
  asr: WorkerScript
  /** The Qwen3-TTS worker, on a runtime that has one. */
  tts: WorkerScript | null
}

/** The torch the CUDA runtime's requirements file pins, built for CUDA 13.0. */
const CUDA_TORCH_VERSION = '2.14.0'

/**
 * Every runtime, with the files it needs under resources, which electron-builder.yml ships in the app of
 * the OS the runtime runs on.
 */
export const SPEECH_RUNTIMES: Readonly<Record<SpeechRuntime, RuntimeSpec>> = {
  mlx: {
    directory: 'mlx-audio-runtime',
    requirements: 'mlx-audio-requirements.txt',
    stamp: { version: MLX_AUDIO_VERSION, lockVersion: 1 },
    preparing: () => t('settingsModels.preparation.mlxRuntime', { version: MLX_AUDIO_VERSION }),
    pythonOverride: 'ASIST_MLX_PYTHON',
    asr: { file: 'mlx_asr_worker.py', logName: 'mlx-asr' },
    tts: { file: 'qwen_tts_worker.py', logName: 'qwen-tts' }
  },
  cuda: {
    directory: 'cuda-speech-runtime',
    requirements: 'cuda-speech-requirements.txt',
    stamp: { version: CUDA_TORCH_VERSION, lockVersion: 1 },
    preparing: () => t('settingsModels.preparation.cudaRuntime', { version: CUDA_TORCH_VERSION }),
    pythonOverride: 'ASIST_CUDA_PYTHON',
    asr: { file: 'cuda_asr_worker.py', logName: 'cuda-asr' },
    tts: null
  }
}

/** The worker a service starts: the speech recognition or the Qwen3-TTS speech synthesis. */
export type WorkerKind = 'asr' | 'tts'

const PROTOCOL_PREFIX = 'ASIST_JSON:'
const WORKER_READY_TIMEOUT_MS = 180_000
const DOWNLOAD_PROGRESS_INTERVAL_MS = 500

/** The runtime the capabilities name for this machine, or null where the local speech models do not run. */
function currentRuntime(): RuntimeSpec | null {
  const { kind } = platformCapabilities().speechRuntime
  return kind === null ? null : SPEECH_RUNTIMES[kind]
}

function runtimeDir(runtime: RuntimeSpec): string {
  return path.join(app.getPath('userData'), runtime.directory)
}

function pythonPath(runtime: RuntimeSpec): string {
  const configured = process.env[runtime.pythonOverride]?.trim()
  return configured || venvPython(runtimeDir(runtime))
}

/**
 * The Hugging Face cache the models are downloaded into and loaded from, which is huggingface_hub's own
 * default on macOS and on Windows. It is decided here and handed to every Python process as HF_HUB_CACHE,
 * because an HF_HOME or HF_HUB_CACHE in the environment the app was started from would otherwise send a
 * download to a folder this module never looks in. HF_HOME is left alone: it would also move the token
 * that `hf auth login` saved.
 */
function modelCache(): string {
  return path.join(homedir(), '.cache', 'huggingface', 'hub')
}

function repositoryCache(model: PinnedModel): string {
  return path.join(modelCache(), `models--${model.id.replace('/', '--')}`)
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
  const runtime = currentRuntime()
  return runtime !== null && installed(runtime)
}

function installed(runtime: RuntimeSpec): boolean {
  if (!fs.existsSync(pythonPath(runtime))) return false
  if (process.env[runtime.pythonOverride]?.trim()) return true
  return environmentCurrent(runtimeDir(runtime), runtime.stamp)
}

const workers = new Set<SpeechWorker>()
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
  worker: WorkerKind
  model: PinnedModel
  /** Every protocol message except `ready` and `fatal`. */
  onMessage: (message: Record<string, unknown>) => void
  /** The worker failed to load, crashed or exited on its own. It is not called after `stop()`. */
  onFailure: (error: Error) => void
}

/** One running worker script. `ready` settles once: true on the worker's `ready` message, false when it fails or is stopped first. */
export class SpeechWorker {
  readonly ready: Promise<boolean>
  /** The fields of the `ready` message, available once `ready` resolved true. */
  info: Record<string, unknown> = {}
  private stopped = false
  private settleReady!: (ready: boolean) => void

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly logName: string,
    private readonly options: WorkerOptions
  ) {
    this.ready = new Promise<boolean>((resolve) => { this.settleReady = resolve })
    const timeout = setTimeout(() => this.fail(new Error(`${logName} worker did not become ready`)), WORKER_READY_TIMEOUT_MS)
    void this.ready.then(() => clearTimeout(timeout))
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.error(`${logName}: ${line}`)
    })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code) => this.fail(new Error(`${logName} worker exited (${code ?? 'signal'})`)))
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
      this.fail(new Error(typeof message.error === 'string' && message.error ? message.error : `${this.logName} worker failed to load`))
    } else {
      this.options.onMessage(message)
    }
  }
}

/**
 * Starts a worker on the downloaded snapshot, or returns null when the environment, the script or the
 * model is missing. Asking for a worker the runtime does not have is a caller's mistake and throws: the
 * capabilities leave such a feature out before it is started.
 */
export function startWorker(options: WorkerOptions): SpeechWorker | null {
  const runtime = currentRuntime()
  if (runtime === null || !installed(runtime)) return null
  const worker = runtime[options.worker]
  if (worker === null) throw new Error(`the speech runtime has no ${options.worker} worker`)
  if (!modelInstalled(options.model)) return null
  const script = resourcePath(worker.file)
  if (!fs.existsSync(script)) return null
  const child = spawn(pythonPath(runtime), [script, snapshotPath(options.model), '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pythonEnv({ HF_HUB_CACHE: modelCache(), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' }),
    windowsHide: true
  })
  const started = new SpeechWorker(child, worker.logName, options)
  workers.add(started)
  registerQuitHook()
  return started
}


/** The downloads running now, which quitting the app stops. */
const downloads = new Set<ChildProcess>()

/**
 * The bytes written to the repository's cache since `since`: the files being downloaded and the ones
 * finished meanwhile. Files an earlier, interrupted download left behind are older and not counted.
 * huggingface_hub downloads into `blobs` and links a finished file into the snapshot, but where it cannot
 * create a symbolic link, as on Windows without Developer Mode, it moves the file into the snapshot
 * instead, so the snapshot's plain files count as well and its links do not.
 */
async function bytesWrittenSince(model: PinnedModel, since: number): Promise<number> {
  const folders = [path.join(repositoryCache(model), 'blobs'), snapshotPath(model)]
  let total = 0
  for (const folder of folders) {
    const entries = await fs.promises.readdir(folder, { recursive: true }).catch(() => [] as string[])
    for (const entry of entries) {
      const stat = await fs.promises.lstat(path.join(folder, entry)).catch(() => null)
      if (stat?.isFile() && stat.mtimeMs >= since) total += stat.size
    }
  }
  return total
}

/**
 * Downloads the pinned snapshot into the Hugging Face cache with hf_snapshot.py, reporting the bytes
 * written against the repository's size. hf-xet is turned off: it held the whole 2.5 GB file in memory and
 * wrote it only at the end (measured 2026-09-24), which leaves nothing to report while it runs.
 */
function downloadModel(runtime: RuntimeSpec, model: PinnedModel, signal: AbortSignal, onBytes: (done: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = (): DOMException => new DOMException(errorText('settingsModels.preparation.stopped'), 'AbortError')
    if (signal.aborted) return reject(stopped())
    const started = Date.now()
    const child = spawn(pythonPath(runtime), [resourcePath('hf_snapshot.py'), model.id, model.revision], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnv({ HF_HUB_CACHE: modelCache(), HF_HUB_DISABLE_XET: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' }),
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
function installRuntime(runtime: RuntimeSpec, signal: AbortSignal, onStart: (message: string) => void): Promise<void> {
  if (installed(runtime)) return Promise.resolve()
  onStart(runtime.preparing())
  if (installInFlight) return installInFlight
  const operation = install(runtime, signal).finally(() => {
    if (installInFlight === operation) installInFlight = null
  })
  installInFlight = operation
  return operation
}

async function install(runtime: RuntimeSpec, signal: AbortSignal): Promise<void> {
  await createEnvironment(runtimeDir(runtime), signal)
  await installRequirements(pythonPath(runtime), runtime.requirements, signal)
  await recordEnvironment(runtimeDir(runtime), runtime.stamp)
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
  const runtime = currentRuntime()
  if (runtime === null) return { ok: false, message: t('settingsModels.preparation.unsupported', { feature }) }
  try {
    await installRuntime(runtime, signal, progress)
    if (!modelInstalled(model)) {
      const message = t('settingsModels.preparation.downloading', { model: model.label })
      progress(message)
      await downloadModel(runtime, model, signal, (done, total) => onProgress({
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
