import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import type { AppSettings, SetupProgress, VapState, VapStatus } from '@shared/ipc'
import { conversationFeatures } from '@shared/conversation-locale'
import { parseVapWorkerLine } from '@shared/vap-protocol'
import { errorText } from '@shared/i18n/error-text'
import { errorMessage, t } from './i18n'
import { pythonEnv } from './child-env'
import { downloadPinnedFile } from './onnx-runtime'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'
import { createEnvironment, environmentCurrent, installRequirements, recordEnvironment } from './uv'

/**
 * The lifecycle of the MaAI turn-taking worker, vap_worker.py.
 *
 * It is built like mlx-asr: uv creates a dedicated Python environment, the models are fetched at a
 * pinned revision and verified by sha256, and audio is streamed to a worker that stays resident. The
 * worker takes 16 kHz stereo, with the user on channel 0 and the assistant's TTS on channel 1, and
 * returns, for every 80 ms frame, the probabilities of holding the turn, of an aizuchi being due, of the
 * user currently producing one, and of a nod.
 *
 * Every stage fails open: when the runtime is not installed, the worker will not start, or it crashes,
 * the renderer keeps running on its heuristics, a fixed hangover and aizuchi placed at textual breaks.
 */

const WORKER_READY_TIMEOUT_MS = 120_000
/**
 * How often a resident worker that stopped on its own is started again within RESTART_WINDOW_MS. One that
 * keeps crashing after it has loaded would otherwise load again on every watchdog tick, several seconds
 * of CPU each time, until the app quits.
 */
const RESTART_LIMIT = 3
const RESTART_WINDOW_MS = 10 * 60_000
/** The generation of the Python environment. Raising it after a requirements change rebuilds the environment. */
const RUNTIME_LOCK_VERSION = 2
const VAP_RUNTIME_VERSION = '2'
const STAMP = { version: VAP_RUNTIME_VERSION, lockVersion: RUNTIME_LOCK_VERSION }
const MAAI = 'MaAI'

interface ModelFile {
  file: string
  url: string
  sha256: string
  mb: number
}

/**
 * Where the models come from. A Hugging Face URL pins a commit and the content is verified by sha256.
 * The frame rate and the context length are the training conditions baked into the file names, and they
 * are passed to the worker unchanged.
 */
const VAP_FRAME_RATE = 12.5
const VAP_CONTEXT_SEC = 20
const AUX_FRAME_RATE = 10
const AUX_CONTEXT_SEC = 5
/**
 * The thread count torch and ONNX Runtime use inside the worker. At 2 the spin-waiting kept the CPU at
 * about 77% continuously, which delayed the renderer's Silero VAD and DeepFilterNet enough for
 * utterances to be dropped. At 1 it sits at about 50% and inference takes about 31 ms per frame, inside
 * the 80 ms budget.
 */
const VAP_WORKER_THREADS = 1

const HF = (repo: string, revision: string, file: string): string =>
  `https://huggingface.co/${repo}/resolve/${revision}/${file}`

const MODELS: Record<'vap' | 'bcDet' | 'mimiOnnx' | 'mimiMeta' | 'bc' | 'nod' | 'cpc', ModelFile> = {
  // Turn taking: maai-kyoto/vap_jp_kyoto (MIT), the variant built on the Mimi encoder.
  vap: {
    file: 'vap_mimi_state_dict_jp_kyoto_12.5hz_20000msec.pt',
    url: HF(
      'maai-kyoto/vap_jp_kyoto',
      'fe24ac60d8fcc80463edde97ed90e3ceca5e5b88',
      'vap_mimi_state_dict_jp_kyoto_12.5hz_20000msec.pt'
    ),
    sha256: 'fe61c494f58456d8fae2c22c80ff8821db75b65cf96e0f3e0ce034a38490967e',
    mb: 15.1
  },
  // Aizuchi detection: maai-kyoto/bc_det_jp (MIT), the variant built on the Mimi encoder. It runs at the
  // same 12.5 Hz with the same 20 second context as vap, so the two share one encoder. It decides
  // whether the user is producing an aizuchi right now, from the activity on the other channel, the TTS.
  bcDet: {
    file: 'bc_det_mimi_state_dict_jp_12.5hz_20000msec.pt',
    url: HF(
      'maai-kyoto/bc_det_jp',
      'db632d5ff03c08c3c6c7630abb8432a585377bb3',
      'bc_det_mimi_state_dict_jp_12.5hz_20000msec.pt'
    ),
    sha256: '63b013ee731d9a9ac76ef04fedbca9338559fc804f504efa628cde197621fb75',
    mb: 17.4
  },
  // The streaming ONNX build of the Mimi encoder by kyutai (CC BY 4.0): maai-kyoto/continuous-mimi-onnx.
  mimiOnnx: {
    file: 'continuous_mimi_fp32.onnx',
    url: HF(
      'maai-kyoto/continuous-mimi-onnx',
      'f1bc2ed348af1b352a8d9fc56de5b1d94ce42fc8',
      'continuous_mimi_fp32.onnx'
    ),
    sha256: '416a2b3ac615e112eea41a9716667aec0545d3cd525231cdd4fd482412156e91',
    mb: 155.9
  },
  mimiMeta: {
    file: 'continuous_mimi_fp32.json',
    url: HF(
      'maai-kyoto/continuous-mimi-onnx',
      'f1bc2ed348af1b352a8d9fc56de5b1d94ce42fc8',
      'continuous_mimi_fp32.json'
    ),
    sha256: '586ebed41c6a31c6774a6c919fa9d45b6aec42193c4cb21b7a67ca8a66c5d71a',
    mb: 0.01
  },
  // Aizuchi in two types: maai-kyoto/vap_bc_2type_jp (MIT), the variant built on the CPC encoder.
  bc: {
    file: 'vap-bc-2type_state_dict_jp_10hz_5000msec.pt',
    url: HF(
      'maai-kyoto/vap_bc_2type_jp',
      '10d3ae0dfccb3c7fd6fb169d111399342de183a9',
      'vap-bc-2type_state_dict_jp_10hz_5000msec.pt'
    ),
    sha256: '3097eb651e136c5c7495a339b5fda779afd871842de6f7c4fca7d830eccae476',
    mb: 24.5
  },
  // Nodding: maai-kyoto/vap_nod_jp (MIT), the variant built on the CPC encoder.
  nod: {
    file: 'vap-nod_state_dict_erica_10hz_5000msec.pt',
    url: HF(
      'maai-kyoto/vap_nod_jp',
      '0fcd5ffbb86eb1f82a2a687fc98a20fe6df11c51',
      'vap-nod_state_dict_erica_10hz_5000msec.pt'
    ),
    sha256: '91e2d899b25cfdcc827f985259eda48925446fefda58071689a1841b9e9f5b00',
    mb: 24.5
  },
  // The pretrained CPC weights from facebookresearch/CPC_audio (MIT), the encoder for bc and nod.
  cpc: {
    file: '60k_epoch4-d0f474de.pt',
    url: 'https://dl.fbaipublicfiles.com/librilight/CPC_checkpoints/60k_epoch4-d0f474de.pt',
    sha256: 'd0f474de968c7243c20f43dee1626681618f2f150d3e638e82b79e22563b17f1',
    mb: 7.4
  }
}

let child: ChildProcessWithoutNullStreams | null = null
let workerReady = false
let startInFlight: Promise<boolean> | null = null
let prepareInFlight: Promise<{ ok: boolean; message: string }> | null = null
let prepareController: AbortController | null = null
let onState: ((state: VapState) => void) | null = null
/**
 * The worker has been running and nothing asked it to stop, so a worker that died on its own is started
 * again. A restart that fails to load clears it: loading takes several seconds of CPU, which a worker that
 * cannot load would repeat on every watchdog tick.
 */
let resident = false
let restartTimestamps: number[] = []
let quitHookRegistered = false

function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'vap-runtime')
}

function pythonPath(): string {
  const configured = process.env.ASIST_VAP_PYTHON?.trim()
  return configured || path.join(runtimeDir(), 'bin', 'python')
}

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'vap', 'models')
}

function modelPath(model: ModelFile): string {
  return path.join(modelsDir(), model.file)
}

function missingModels(): ModelFile[] {
  return Object.values(MODELS).filter((model) => !fs.existsSync(modelPath(model)))
}

export function runtimeInstalled(): boolean {
  if (!platformCapabilities().cpuSidecars) return false
  if (!fs.existsSync(pythonPath())) return false
  if (process.env.ASIST_VAP_PYTHON?.trim()) return true
  return environmentCurrent(runtimeDir(), STAMP)
}

function workerRunning(): boolean {
  return Boolean(child && workerReady && child.exitCode === null)
}

export function installationStatus(): VapStatus {
  return {
    runtimeInstalled: runtimeInstalled(),
    modelsInstalled: missingModels().length === 0,
    running: workerRunning()
  }
}

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    stop()
  })
}

/** Whether the worker should be running: it was resident, and the setting and the conversation's language still want it. */
export function wanted(settings: AppSettings): boolean {
  return resident && settings.vapEnabled && conversationFeatures(settings.conversationLocale).maai
}

/**
 * Starts a resident worker again after it stopped on its own, keeping the conversation's state handler.
 * Past the limit of restarts it waits for the conversation to start it.
 */
export async function restart(): Promise<boolean> {
  if (workerRunning()) return true
  if (startInFlight) return startInFlight
  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((time) => now - time < RESTART_WINDOW_MS)
  if (restartTimestamps.length >= RESTART_LIMIT) {
    console.warn('vap: the worker keeps stopping; it is left off until the microphone is turned on again')
    resident = false
    return false
  }
  restartTimestamps.push(now)
  const ready = await start()
  if (!ready) resident = false
  return ready
}

function handleStdoutLine(line: string): void {
  const message = parseVapWorkerLine(line)
  if (message === null) {
    // MaAI's own log lines, such as the encoder it chose and the RTF, are passed through as they are.
    if (line.trim()) console.log(`vap: ${line}`)
    return
  }
  if (message.type === 'ready') {
    workerReady = true
    console.log(`vap: worker ready (${message.device}, ${message.frameHz}Hz)`)
    return
  }
  if (message.type === 'fatal') {
    console.warn(`vap: worker fatal: ${message.error}`)
    stopWorker()
    return
  }
  onState?.(message.state)
}

async function waitUntilReady(spawned: ChildProcessWithoutNullStreams): Promise<boolean> {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
  while (child === spawned && Date.now() < deadline) {
    if (workerReady) return true
    if (spawned.exitCode !== null || spawned.killed) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return workerReady && child === spawned
}

function workerArgs(): string[] {
  return [
    resourcePath('vap_worker.py'),
    '--vap-model',
    modelPath(MODELS.vap),
    '--vap-frame-rate',
    String(VAP_FRAME_RATE),
    '--vap-context',
    String(VAP_CONTEXT_SEC),
    '--bc-det-model',
    modelPath(MODELS.bcDet),
    '--mimi-onnx',
    modelPath(MODELS.mimiOnnx),
    '--mimi-meta',
    modelPath(MODELS.mimiMeta),
    '--bc-model',
    modelPath(MODELS.bc),
    '--nod-model',
    modelPath(MODELS.nod),
    '--aux-frame-rate',
    String(AUX_FRAME_RATE),
    '--aux-context',
    String(AUX_CONTEXT_SEC),
    '--cpc',
    modelPath(MODELS.cpc),
    '--threads',
    String(VAP_WORKER_THREADS)
  ]
}

async function startWorker(): Promise<boolean> {
  if (workerRunning()) return true
  stopWorker()
  if (!runtimeInstalled()) return false
  if (missingModels().length > 0) return false
  if (!fs.existsSync(resourcePath('vap_worker.py'))) return false

  const spawned = spawn(pythonPath(), workerArgs(), {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The models are handed over as local paths, and the route out to Hugging Face is closed at run time.
    env: pythonEnv({ HF_HUB_OFFLINE: '1' }),
    windowsHide: true
  })
  child = spawned
  workerReady = false
  registerQuitHook()
  readline.createInterface({ input: spawned.stdout }).on('line', handleStdoutLine)
  readline.createInterface({ input: spawned.stderr }).on('line', (line) => {
    if (line.trim()) console.log(`vap: ${line}`)
  })
  const detach = (): void => {
    if (child === spawned) {
      child = null
      workerReady = false
    }
  }
  spawned.on('error', detach)
  spawned.on('exit', detach)
  // A write between the worker's death and its exit event, or after it closed its input, fails with
  // EPIPE, which becomes an uncaught exception unless the stream has a listener.
  spawned.stdin.on('error', (error) => {
    console.warn(`vap: worker input failed: ${error.message}`)
    if (child === spawned) stopWorker()
  })

  const ready = await waitUntilReady(spawned)
  if (!ready && child === spawned) stopWorker()
  if (ready) resident = true
  return ready
}

/** Every start goes through here, so that a second caller waits for the worker being loaded instead of stopping it. */
function start(): Promise<boolean> {
  if (workerRunning()) return Promise.resolve(true)
  if (startInFlight) return startInFlight
  const operation = startWorker().finally(() => {
    if (startInFlight === operation) startInFlight = null
  })
  startInFlight = operation
  return operation
}

/**
 * Starts the worker, returning true immediately when it is already running, and keeps pushing state to
 * the callback. Turning the microphone off does not stop it, so the few seconds of model loading are not
 * paid again and again; it stops only when the app quits or stop() is called after the setting is turned
 * off.
 */
export function ensureStarted(stateHandler: (state: VapState) => void): Promise<boolean> {
  onState = stateHandler
  return start()
}

/** Takes the two 16 kHz channels and writes them interleaved to the worker. Audio is dropped while the worker is not running. */
export function pushAudio(user: Float32Array, assistant: Float32Array): void {
  if (!child || !workerReady || child.exitCode !== null || !child.stdin.writable) return
  const frames = Math.min(user.length, assistant.length)
  if (frames === 0) return
  const interleaved = new Float32Array(frames * 2)
  for (let index = 0; index < frames; index++) {
    interleaved[index * 2] = user[index]
    interleaved[index * 2 + 1] = assistant[index]
  }
  child.stdin.write(Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength))
}

/** Stops the worker for good, until the conversation or a preparation starts it again. */
export function stop(): void {
  resident = false
  restartTimestamps = []
  stopWorker()
}

function stopWorker(): void {
  const stale = child
  child = null
  workerReady = false
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
}

export function cancelPreparation(): boolean {
  if (!prepareController) return false
  prepareController.abort()
  stop()
  return true
}

export function prepare(
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (prepareInFlight) return prepareInFlight
  const operation = prepareOnce(onProgress).finally(() => {
    if (prepareInFlight === operation) prepareInFlight = null
    prepareController = null
  })
  prepareInFlight = operation
  return operation
}

async function prepareOnce(
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (!platformCapabilities().cpuSidecars) {
    return { ok: false, message: t('settingsModels.preparation.unsupported', { feature: t('settingsModels.features.turnTaking') }) }
  }
  const controller = new AbortController()
  prepareController = controller
  const progress = (message: string): void =>
    onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
  try {
    if (!runtimeInstalled()) {
      progress(t('settingsModels.preparation.python', { feature: t('settingsModels.features.turnTaking') }))
      // The environment is rebuilt from scratch whenever its recorded version does not match the current
      // requirements.
      await createEnvironment(runtimeDir(), controller.signal)
      progress(t('settingsModels.preparation.torchPackages'))
      await installRequirements(pythonPath(), 'vap-requirements.txt', controller.signal)
      progress(t('settingsModels.preparation.maai'))
      await installRequirements(pythonPath(), 'vap-requirements-maai.txt', controller.signal, ['--no-deps'])
      await recordEnvironment(runtimeDir(), STAMP)
    }
    const missing = missingModels()
    if (missing.length > 0) {
      const totalMb = missing.reduce((sum, model) => sum + model.mb, 0)
      let downloaded = 0
      for (const model of missing) {
        await downloadPinnedFile(model, modelPath(model), controller.signal, (bytes) => {
          downloaded += bytes
          const downloadedMb = downloaded / 1e6
          onProgress({
            status: 'downloading',
            pct: Math.min(99, Math.round((downloadedMb / totalMb) * 100)),
            downloadedMb: Math.round(downloadedMb * 10) / 10,
            totalMb: Math.round(totalMb),
            message: t('settingsModels.preparation.modelFile', { model: MAAI, file: model.file })
          })
        })
      }
    }
    progress(t('settingsModels.preparation.loading', { model: MAAI }))
    const ready = await start()
    if (!ready) throw new Error(errorText('settingsModels.preparation.startFailed', { model: MAAI }))
    onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
    return { ok: true, message: t('settingsModels.preparation.ready', { feature: t('settingsModels.features.turnTaking'), model: MAAI }) }
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    const message = cancelled
      ? t('settingsModels.preparation.cancelled', { feature: t('settingsModels.features.turnTaking') })
      : errorMessage(error)
    onProgress({
      status: cancelled ? 'cancelled' : 'error',
      pct: 0,
      downloadedMb: 0,
      totalMb: 0,
      message
    })
    return { ok: false, message }
  }
}
