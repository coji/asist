import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import readline from 'node:readline'
import { asrLanguage, asrModelFiles, type AsrModelSpec } from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { llamaServerEnv } from './child-env'
import { conversationLocale } from './conversation-locale'
import { t } from './i18n'
import { platformCapabilities } from './platform'
import { llamaServerPath } from './speech-binaries'
import { filesInstalled, modelFilePath, prepareModelFiles } from './speech-models'
import { stopOnQuit } from './speech-worker'

/**
 * Speech recognition with Qwen3-ASR in llama.cpp's llama-server, on the GPU the capabilities chose. The
 * server listens on the loopback interface with a key made for each start, so that neither a web page nor
 * another user of the machine can use it, and transcribes one request at a time. A recording goes to it as a WAV in the
 * request body and is never written to disk.
 */

/**
 * Loading a model and compiling its GPU kernels comes before the server answers /health. The first start
 * of llama.cpp's Vulkan build compiled its shaders for a few seconds on an RTX 2080 (2026-09-29).
 */
const READY_TIMEOUT_MS = 180_000
const HEALTH_POLL_MS = 250

/**
 * A request left unanswered this long means the server is hung, and it is stopped. The server answers one
 * request at a time, so the time also covers the requests queued ahead.
 */
const ANSWER_TIMEOUT_MS = 60_000

/**
 * How long a caller waits for a partial transcription. The server still finishes a partial that took
 * longer: stopping it would also fail the final transcription queued behind the partial.
 */
const PARTIAL_WAIT_MS = 4_000

/** The start of Qwen3-ASR's answer, which names the language before the transcription. */
const LANGUAGE_PREFIX = /^language\s+\S+?<asr_text>/

interface Server {
  model: AsrModelSpec
  /** Null until a free port has been found and the process spawned. */
  child: ChildProcess | null
  port: number
  key: string
  /** Settles once the server answers /health, or fails to start. */
  ready: Promise<boolean>
  /** Whether it answered /health, which a status check reads without waiting for a start. */
  healthy: boolean
  stopped: boolean
}

let server: Server | null = null
const requests = new Map<string, AbortController>()
/** The preparation under way, with the model whose files it fetches. */
let preparation: { model: AsrModelSpec; controller: AbortController; operation: Promise<{ ok: boolean; message: string }> } | null = null

/** Whether the files of the model are there. */
export function installationStatus(model: AsrModelSpec): { modelInstalled: boolean } {
  return { modelInstalled: filesInstalled(asrModelFiles(model)) }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function waitUntilHealthy(started: Server): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!started.stopped && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return true
    } catch {
      // Not listening yet, or still loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }
  if (!started.stopped) console.error('llama-server did not become ready')
  return false
}

/**
 * Writes llama-server's messages to the app log at their own level. Each message starts with its level
 * letter, and a message that spans lines continues without one. Loading Qwen3-ASR always warns about a
 * token type and about audio input being experimental, which are not failures.
 */
function logLevels(stderr: NodeJS.ReadableStream): void {
  let level: 'error' | 'warn' | 'log' = 'error'
  readline.createInterface({ input: stderr }).on('line', (line) => {
    const prefixed = /^([DIWE]) (.*)$/.exec(line)
    if (prefixed) level = prefixed[1] === 'E' ? 'error' : prefixed[1] === 'W' ? 'warn' : 'log'
    const text = prefixed ? prefixed[2] : line
    if (text.trim()) console[level](`llama-server: ${text}`)
  })
}

/** Finds a port, spawns the server on it and waits for /health, unless the start is stopped on the way. */
async function launch(started: Server, device: string): Promise<boolean> {
  started.port = await freePort()
  if (started.stopped) return false
  // The key goes in the environment, not on the command line: a Mac's ps is setuid root and shows every
  // user the arguments of all processes, and the environment of their own processes alone (macOS 26.2,
  // 2026-10-02). llama-server reads it from there as it would from --api-key.
  const env = { ...llamaServerEnv(), LLAMA_API_KEY: started.key }
  const child = spawn(llamaServerPath(), [
    '--model', modelFilePath(started.model.model),
    '--mmproj', modelFilePath(started.model.mmproj),
    '--device', device,
    '--n-gpu-layers', '99',
    '--ctx-size', '4096',
    '--parallel', '1',
    '--host', '127.0.0.1',
    '--port', String(started.port),
    '--no-webui',
    '--offline',
    // Warnings and errors only; the informational lines run to hundreds per start.
    '--log-verbosity', '2',
    // On Windows the automatic setting colours output that goes to a pipe, and the escape codes reach the log.
    '--log-colors', 'off',
    '--no-log-timestamps'
  ], { stdio: ['ignore', 'ignore', 'pipe'], env, windowsHide: true })
  started.child = child
  stopOnQuit(child)
  logLevels(child.stderr!)
  const exited = new Promise<boolean>((resolve) => {
    child.once('error', (error) => {
      console.error('llama-server could not be started:', error)
      resolve(false)
    })
    child.once('exit', (code) => {
      if (!started.stopped) console.error(`llama-server exited (${code ?? 'signal'})`)
      if (server === started) stopServer()
      resolve(false)
    })
  })
  return Promise.race([waitUntilHealthy(started), exited])
}

/**
 * Starts the server on the model unless it is running or starting on it already; a server on another model
 * is stopped first. Resolves false when the files are missing or the server fails to start.
 */
export async function ensureServer(model: AsrModelSpec): Promise<boolean> {
  if (server && server.model === model && !server.stopped) return server.ready
  stopServer()
  const { localSpeech } = platformCapabilities()
  // The capabilities leave the local speech recognition out where it does not run, so a start here is a caller's mistake.
  if (localSpeech.backend === null) throw new Error('the local speech recognition cannot run on this machine')
  if (!installationStatus(model).modelInstalled) return false
  // llama-server ships with the app, so a missing one is a broken build rather than something to prepare.
  if (!fs.existsSync(llamaServerPath())) throw new Error(`llama-server is missing from ${llamaServerPath()}`)
  const started: Server = { model, child: null, port: 0, key: randomBytes(24).toString('hex'), ready: Promise.resolve(false), healthy: false, stopped: false }
  // The server is in place before the first await, so that a stop or a start on another model made while
  // this one looks for a port stops it rather than leaving it to spawn afterwards.
  server = started
  started.ready = launch(started, localSpeech.device).then(
    (ready) => {
      started.healthy = ready && !started.stopped
      if (!started.healthy && server === started) stopServer()
      return started.healthy
    },
    (error: unknown) => {
      if (server === started) stopServer()
      throw error
    }
  )
  return started.ready
}

export function available(model: AsrModelSpec): boolean {
  return server !== null && server.model === model && !server.stopped && server.healthy
}

function stopServer(): void {
  const stale = server
  server = null
  if (!stale || stale.stopped) return
  stale.stopped = true
  stale.healthy = false
  if (stale.child && stale.child.exitCode === null && !stale.child.killed) stale.child.kill('SIGTERM')
}

/** Stops the server and fails every open request. */
export function stop(): void {
  stopServer()
  for (const controller of requests.values()) controller.abort(new DOMException(errorText('speechRecognition.errors.stopped'), 'AbortError'))
  requests.clear()
}

/** A 16 kHz mono 16-bit WAV of the samples. */
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

async function request(model: AsrModelSpec, samples: Float32Array, id: string): Promise<string> {
  if (requests.has(id)) throw new Error(`duplicate transcription request: ${id}`)
  const controller = new AbortController()
  requests.set(id, controller)
  let timer: NodeJS.Timeout | undefined
  try {
    // The language is read here, per request, so that a change of the setting applies to the next
    // utterance without reloading the model.
    const language = asrLanguage(conversationLocale())
    if (!(await ensureServer(model)) || !server) throw new Error(errorText('speechRecognition.errors.notReady'))
    controller.signal.throwIfAborted()
    const target = server
    // The time runs from the request, not from the start of the server, which has its own limit.
    timer = setTimeout(() => {
      controller.abort(new DOMException(errorText('speechRecognition.errors.timedOut'), 'TimeoutError'))
      if (server === target) stopServer()
    }, ANSWER_TIMEOUT_MS)
    timer.unref?.()
    const response = await fetch(`http://127.0.0.1:${target.port}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: encodeWav(samples).toString('base64'), format: 'wav' } }] },
          // Qwen3-ASR writes the language before the transcription; starting its answer with it fixes the language.
          { role: 'assistant', content: `language ${language}<asr_text>` }
        ],
        temperature: 0,
        max_tokens: 512
      })
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`llama-server answered ${response.status}: ${body.slice(0, 300)}`)
    const content = (JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error(`llama-server answered without a transcription: ${body.slice(0, 300)}`)
    return content.replace(LANGUAGE_PREFIX, '').trim()
  } catch (error) {
    // An abort rejects fetch with the signal's reason, which is the error the caller should see.
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error
  } finally {
    clearTimeout(timer)
    requests.delete(id)
  }
}

export function transcribe(model: AsrModelSpec, samples: Float32Array, requestId?: string): Promise<string> {
  return request(model, samples, requestId || randomUUID())
}

export async function transcribePartial(model: AsrModelSpec, samples: Float32Array): Promise<string> {
  // The server answers one request at a time, so a partial sent while it still works on another request,
  // an abandoned partial included, would only delay the final transcription.
  if (requests.size > 0) return ''
  const answer = request(model, samples, randomUUID()).catch(() => '')
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
  const controller = requests.get(requestId)
  if (!controller) return false
  controller.abort(new DOMException(errorText('speechRecognition.errors.stopped'), 'AbortError'))
  return true
}

export function cancelPreparation(): boolean {
  if (!preparation) return false
  preparation.controller.abort()
  // A server on another model is the one the setting moved to while the files downloaded, which the preparation did not start.
  if (server?.model === preparation.model) stop()
  return true
}

/**
 * Downloads the files of the model, and starts its server on them if the setting still stands for the model
 * once they are there, which only the caller can tell.
 */
export function prepare(
  model: AsrModelSpec,
  selected: () => boolean,
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (preparation) return preparation.operation
  const controller = new AbortController()
  const operation = prepareModelFiles({
    files: asrModelFiles(model),
    label: model.label,
    feature: t('settingsModels.features.speechRecognition'),
    signal: controller.signal,
    onProgress,
    selected,
    start: () => ensureServer(model)
  }).finally(() => {
    if (preparation?.operation === operation) preparation = null
  })
  preparation = { model, controller, operation }
  return operation
}
