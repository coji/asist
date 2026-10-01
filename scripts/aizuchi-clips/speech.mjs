import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { ASR_MODEL_SPECS } from '../../src/shared/asr-models.ts'
import { IRODORI_TTS_MODEL, IRODORI_TTS_VOICE_IDS, QWEN_TTS_CODEC, QWEN_TTS_MODELS } from '../../src/shared/tts-models.ts'
import { RATE } from './cut.mjs'

/**
 * The bundled speech-worker and llama-server, run on the model files the app has prepared, so that the
 * clips are read by the same program and model as the rest of a reply.
 */

const root = path.resolve(import.meta.dirname, '../..')
const exe = process.platform === 'win32' ? '.exe' : ''

/** The app's speech models, or the folder ASIST_SPEECH_MODELS names. */
function modelsDir() {
  if (process.env.ASIST_SPEECH_MODELS) return process.env.ASIST_SPEECH_MODELS
  const userData = process.platform === 'win32' ? path.join(process.env.APPDATA, 'asist') : path.join(homedir(), 'Library/Application Support/asist')
  return path.join(userData, 'speech-models')
}

/** The path of a pinned model file the app has prepared. */
export function modelPath(file) {
  const found = path.join(modelsDir(), file.repo.replace('/', '--'), file.revision, file.file)
  if (!existsSync(found)) throw new Error(`${file.file} is not in ${modelsDir()}; prepare the model in the app first`)
  return found
}

function program(dir, name) {
  const found = path.join(root, 'resources', dir, name + exe)
  if (!existsSync(found)) throw new Error(`${found} is missing; run node scripts/prepare-resources.mjs dev`)
  return found
}

/**
 * The model each engine's clips are read with: Qwen3-TTS 0.6B, whose clips the app plays for both sizes, and
 * Irodori-TTS with the voice files the app ships.
 */
export const TTS_MODELS = {
  qwen3tts: QWEN_TTS_MODELS['0.6b'].talker,
  irodori: IRODORI_TTS_MODEL.model
}

function workerArgs(engine) {
  if (engine === 'qwen3tts') return [modelPath(TTS_MODELS.qwen3tts), modelPath(QWEN_TTS_CODEC)]
  if (engine !== 'irodori') throw new Error(`no aizuchi clips are made for ${engine}`)
  const voices = IRODORI_TTS_VOICE_IDS.flatMap((voice) => ['--voice', `${voice}=${path.join(root, 'resources', 'irodori-voices', `${voice}.voice.gguf`)}`])
  return [modelPath(IRODORI_TTS_MODEL.model), modelPath(IRODORI_TTS_MODEL.codec), ...voices]
}

/**
 * Halves the sample rate. A windowed-sinc low-pass at 0.45 of the new rate keeps what lies above the new
 * Nyquist frequency from folding back into the voice.
 */
function halve(samples) {
  const taps = 63
  const middle = (taps - 1) / 2
  const kernel = Array.from({ length: taps }, (_, i) => {
    const x = i - middle
    const sinc = x === 0 ? 0.45 : Math.sin(Math.PI * 0.45 * x) / (Math.PI * x)
    return sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)))
  })
  const sum = kernel.reduce((total, value) => total + value, 0)
  const out = new Float32Array(Math.floor(samples.length / 2))
  for (let n = 0; n < out.length; n++) {
    let value = 0
    for (let k = 0; k < taps; k++) {
      const index = 2 * n + k - middle
      if (index >= 0 && index < samples.length) value += samples[index] * kernel[k]
    }
    out[n] = value / sum
  }
  return out
}

/** Starts the worker on the engine's model and resolves to a function that reads a text and resolves to its samples at RATE. */
export async function startSynthesizer(engine) {
  const child = spawn(program('speech-worker', 'speech-worker'), workerArgs(engine), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const pending = new Map()
  let ready
  let rate = RATE
  const started = new Promise((resolve, reject) => {
    ready = resolve
    child.once('exit', (code) => reject(new Error(`speech-worker exited (${code})`)))
  })
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('ASIST_JSON:')) return
    const message = JSON.parse(line.slice('ASIST_JSON:'.length))
    if (message.type === 'ready') {
      rate = message.sampleRate
      if (rate !== RATE && rate !== 2 * RATE) throw new Error(`speech-worker speaks at ${rate} Hz, which the clips cannot be made from`)
      return ready()
    }
    if (message.type === 'fatal') throw new Error(`speech-worker: ${message.error}`)
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'chunk') request.chunks.push(Buffer.from(message.pcm, 'base64'))
    else {
      pending.delete(message.id)
      if (message.type === 'end') request.resolve(Buffer.concat(request.chunks))
      else request.reject(new Error(message.error))
    }
  })
  await started
  let next = 0
  return {
    speak(text, voice, language) {
      const id = String(next++)
      const bytes = new Promise((resolve, reject) => pending.set(id, { chunks: [], resolve, reject }))
      child.stdin.write(JSON.stringify({ id, text, voice, language }) + '\n')
      return bytes.then((pcm) => {
        const samples = new Float32Array(pcm.length / 2)
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
        return rate === RATE ? samples : halve(samples)
      })
    },
    stop: () => child.kill()
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function wav16k(samples) {
  const length = Math.floor((samples.length * 16_000) / RATE)
  const data = Buffer.alloc(length * 2)
  for (let i = 0; i < length; i++) {
    const at = (i * (samples.length - 1)) / Math.max(1, length - 1)
    const low = Math.floor(at)
    const value = samples[low] + (samples[Math.min(low + 1, samples.length - 1)] - samples[low]) * (at - low)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Starts llama-server on Qwen3-ASR 1.7B and resolves to a function that transcribes samples at RATE, in the
 * language named by its English name.
 */
export async function startRecognizer() {
  const spec = ASR_MODEL_SPECS['qwen3-asr-1.7b']
  const port = await freePort()
  const key = randomBytes(24).toString('hex')
  const child = spawn(program('llama.cpp', 'llama-server'), [
    '--model', modelPath(spec.model), '--mmproj', modelPath(spec.mmproj), '--n-gpu-layers', '99', '--ctx-size', '4096',
    '--parallel', '1', '--host', '127.0.0.1', '--port', String(port), '--api-key', key, '--no-webui', '--offline', '--log-verbosity', '1'
  ], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  const exited = new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`llama-server exited (${code})`))))
  const healthy = (async () => {
    for (;;) {
      const answer = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null)
      if (answer?.ok) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()
  await Promise.race([healthy, exited])
  return {
    async recognize(samples, language = 'Japanese') {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav16k(samples).toString('base64'), format: 'wav' } }] },
            { role: 'assistant', content: `language ${language}<asr_text>` }
          ],
          temperature: 0,
          max_tokens: 256
        })
      })
      if (!response.ok) throw new Error(`llama-server answered ${response.status}: ${await response.text()}`)
      const content = (await response.json()).choices[0].message.content
      return content.replace(/^language\s+\S+?<asr_text>/, '').trim()
    },
    stop: () => child.kill()
  }
}
