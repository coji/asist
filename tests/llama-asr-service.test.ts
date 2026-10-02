import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASR_MODEL_SPECS, type AsrModel } from '@shared/asr-models'
import { errorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  downloadMissing: vi.fn(),
  settings: { uiLocale: 'en-US', conversationLocale: 'ja-JP', asrModel: 'auto' as AsrModel }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/pinned-download', () => ({ downloadMissing: mocks.downloadMissing }))
vi.mock('../src/main/services/conversation-locale', () => ({ conversationLocale: () => 'ja-JP' }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data', on: vi.fn() } }))

const MODEL = ASR_MODEL_SPECS['qwen3-asr-1.7b']
const SMALL = ASR_MODEL_SPECS['qwen3-asr-0.6b']

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn()
  })
  child.kill.mockImplementation(() => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0)
    return true
  })
  return child
}

interface Started {
  child: ReturnType<typeof fakeChild>
  args: string[]
}
let started: Started[] = []
/** Whether /health answers, which is when a server has loaded its model. */
let healthy = true
let answer: (body: Record<string, unknown>) => Promise<Response> = async () => chat('language Japanese<asr_text>こんにちは。')
const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []

const chat = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
const argAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
let asr: typeof import('../src/main/services/llama-asr')

beforeEach(async () => {
  vi.resetModules()
  mocks.settings.asrModel = 'auto'
  started = []
  healthy = true
  requests.length = 0
  answer = async () => chat('language Japanese<asr_text>こんにちは。')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  mocks.spawn.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = fakeChild()
    started.push({ child, args })
    return child
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return healthy ? new Response('{"status":"ok"}', { status: 200 }) : new Response('{"status":"loading"}', { status: 503 })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, headers: init?.headers as Record<string, string>, body })
    const signal = init?.signal
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      void answer(body).then(resolve, reject)
    })
  }))
  asr = await import('../src/main/services/llama-asr')
})
afterEach(() => {
  vi.useRealTimers()
  asr.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('speech recognition on llama-server', () => {
  it('starts the server on the model and its projector, on the chosen GPU, on the loopback interface with a key of its own', async () => {
    await expect(asr.ensureServer(MODEL)).resolves.toBe(true)
    const { args } = started[0]
    expect(path.basename(argAfter(args, '--model'))).toBe(MODEL.model.file)
    expect(path.basename(argAfter(args, '--mmproj'))).toBe(MODEL.mmproj.file)
    expect(argAfter(args, '--device')).toBe('MTL0')
    expect(argAfter(args, '--host')).toBe('127.0.0.1')
    expect(argAfter(args, '--api-key')).toMatch(/^[0-9a-f]{48}$/)
    expect(args).toContain('--offline')
  })

  it('sends the recording as a 16 kHz mono WAV with the key, fixes the language by the start of the answer, and returns the text alone', async () => {
    const samples = new Float32Array(16_000).fill(0.25)
    await expect(asr.transcribe(MODEL, samples, 'r1')).resolves.toBe('こんにちは。')
    const [request] = requests
    expect(request.headers.authorization).toBe(`Bearer ${argAfter(started[0].args, '--api-key')}`)
    const [user, assistant] = request.body.messages as Array<{ role: string; content: unknown }>
    expect(assistant).toEqual({ role: 'assistant', content: 'language Japanese<asr_text>' })
    const audio = (user.content as Array<{ type: string; input_audio: { data: string; format: string } }>)[0]
    expect(audio.input_audio.format).toBe('wav')
    const wav = Buffer.from(audio.input_audio.data, 'base64')
    expect([wav.toString('ascii', 0, 4), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual(['RIFF', 1, 16_000, 16])
    expect(wav.length).toBe(44 + samples.length * 2)
  })

  it('skips a partial transcription while another request is open, which it would only delay', async () => {
    let release!: () => void
    answer = () => new Promise((resolve) => { release = () => resolve(chat('language Japanese<asr_text>最後まで。')) })
    const final = asr.transcribe(MODEL, new Float32Array(1600), 'final')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await expect(asr.transcribePartial(MODEL, new Float32Array(1600))).resolves.toBe('')
    expect(requests).toHaveLength(1)
    release()
    await expect(final).resolves.toBe('最後まで。')
  })

  it('stops a cancelled request with the reason the user sees', async () => {
    answer = () => new Promise(() => {})
    const pending = asr.transcribe(MODEL, new Float32Array(1600), 'r2')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(asr.cancelTranscription('r2')).toBe(true)
    await expect(pending).rejects.toThrow(errorText('speechRecognition.errors.stopped'))
  })

  it('starts a new server for the next request after the server exits on its own', async () => {
    await asr.ensureServer(MODEL)
    started[0].child.exitCode = 1
    started[0].child.emit('exit', 1)
    await expect(asr.transcribe(MODEL, new Float32Array(1600), 'r3')).resolves.toBe('こんにちは。')
    expect(started).toHaveLength(2)
  })

  it('answers whether the server is ready without waiting for a server that is still loading', async () => {
    healthy = false
    const starting = asr.ensureServer(MODEL)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(asr.available(MODEL)).toBe(false)
    healthy = true
    await expect(starting).resolves.toBe(true)
    expect(asr.available(MODEL)).toBe(true)
  })

  it('gives a request its full time even when the server took longer than that to load', async () => {
    vi.useFakeTimers()
    healthy = false
    const pending = asr.transcribe(MODEL, new Float32Array(1600), 'slow-start')
    await vi.advanceTimersByTimeAsync(90_000)
    healthy = true
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBe('こんにちは。')
    expect(started).toHaveLength(1)
    expect(started[0].child.kill).not.toHaveBeenCalled()
  })

  it('stops a server still loading one model and starts the other when the model changes', async () => {
    healthy = false
    const first = asr.ensureServer(MODEL)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const second = asr.ensureServer(SMALL)
    await expect(first).resolves.toBe(false)
    expect(started[0].child.kill).toHaveBeenCalled()
    await vi.waitFor(() => expect(started).toHaveLength(2))
    healthy = true
    await expect(second).resolves.toBe(true)
    expect(path.basename(argAfter(started[1].args, '--model'))).toBe(SMALL.model.file)
    expect(asr.available(SMALL)).toBe(true)
  })

  it('never spawns a server that was stopped while it was still looking for a port', async () => {
    const starting = asr.ensureServer(MODEL)
    asr.stop()
    await expect(starting).resolves.toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('writes the server\'s warnings as warnings and its errors, with the lines that continue them, as errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await asr.ensureServer(MODEL)
    started[0].child.stderr.write('W init_audio: audio input is in experimental stage\nE llama_model_load: error loading model\n    at the second line\n')
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2))
    expect(warn.mock.calls.map(([line]) => line)).toEqual(['llama-server: init_audio: audio input is in experimental stage'])
    expect(error.mock.calls.map(([line]) => line)).toEqual(['llama-server: llama_model_load: error loading model', 'llama-server:     at the second line'])
  })

  it('starts nothing while a file of the model is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !String(file).endsWith(MODEL.mmproj.file))
    await expect(asr.ensureServer(MODEL)).resolves.toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('fails loudly when the app shipped without llama-server', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !/llama-server(\.exe)?$/.test(String(file)))
    await expect(asr.ensureServer(MODEL)).rejects.toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

describe('the model the setting stands for', () => {
  let service: typeof import('../src/main/services/asr')
  /** Ends the download of the prepared model's files, which takes minutes in the app. */
  let finishDownload: () => void
  const modelOf = (server: Started): string => path.basename(argAfter(server.args, '--model'))

  beforeEach(async () => {
    service = await import('../src/main/services/asr')
    // Qwen3-ASR 0.6B is installed and 1.7B is not, until its download ends.
    let largeInstalled = false
    const large = [MODEL.model.file, MODEL.mmproj.file]
    vi.mocked(fs.existsSync).mockImplementation((file) => largeInstalled || !large.includes(path.basename(String(file))))
    mocks.downloadMissing.mockReset().mockImplementation((_files: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        finishDownload = () => {
          largeInstalled = true
          resolve()
        }
      }))
  })

  /** A transcription the server answers only once the test releases it. */
  async function transcriptionUnderWay(): Promise<{ transcription: Promise<string>; release: () => void }> {
    let release!: () => void
    answer = () => new Promise((resolve) => { release = () => resolve(chat('language Japanese<asr_text>はい。')) })
    const transcription = service.transcribe(new Float32Array(1600), 'under-way')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    return { transcription, release }
  }

  it('keeps the server and the transcription under way when the setting moves from auto to the model auto stands for', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // Auto stands for 1.7B on the fixture's 32 GB Mac.
    await expect(service.ensureServer()).resolves.toBe(true)
    const { transcription, release } = await transcriptionUnderWay()

    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    await expect(service.switchModel('auto')).resolves.toBe(true)
    release()

    await expect(transcription).resolves.toBe('はい。')
    expect(started).toHaveLength(1)
    expect(started[0].child.kill).not.toHaveBeenCalled()
  })

  it('stops the server, and the transcription under way with the reason the user sees, when the setting moves to another model', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    await service.ensureServer()
    const { transcription } = await transcriptionUnderWay()

    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('auto')).resolves.toBe(true)

    await expect(transcription).rejects.toThrow(errorText('speechRecognition.errors.stopped'))
    expect(started[0].child.kill).toHaveBeenCalled()
    expect(started.map(modelOf)).toEqual([MODEL.model.file, SMALL.model.file])
  })

  it('keeps the server of the model the setting names when a preparation of another model ends after the user turned back', async () => {
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await service.ensureServer()
    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    await expect(service.switchModel('qwen3-asr-0.6b')).resolves.toBe(false)
    const preparation = service.prepareModel('qwen3-asr-1.7b', () => {})
    await vi.waitFor(() => expect(mocks.downloadMissing).toHaveBeenCalled())

    // The download is slow, and the user goes back to 0.6B.
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('qwen3-asr-1.7b')).resolves.toBe(true)
    const selected = started.at(-1)!
    finishDownload()

    expect((await preparation).ok).toBe(true)
    expect(started.map(modelOf)).toEqual([SMALL.model.file, SMALL.model.file])
    expect(selected.child.kill).not.toHaveBeenCalled()
    await expect(service.available()).resolves.toBe(true)
  })

  it('keeps the server of the model the setting names when the user cancels the preparation of a model they turned away from', async () => {
    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    const preparation = service.prepareModel('qwen3-asr-1.7b', () => {})
    await vi.waitFor(() => expect(mocks.downloadMissing).toHaveBeenCalled())
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('qwen3-asr-1.7b')).resolves.toBe(true)

    expect(service.cancelPreparation()).toBe(true)
    expect((await preparation).ok).toBe(false)
    expect(started[0].child.kill).not.toHaveBeenCalled()
    await expect(service.available()).resolves.toBe(true)
  })
})

describe('the environment of llama-server', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('starts the server without the user\'s llama.cpp settings, which would move it off the plain HTTP and /health it is reached at', async () => {
    vi.stubEnv('LLAMA_ARG_API_PREFIX', '/llama')
    vi.stubEnv('LLAMA_ARG_SSL_KEY_FILE', '/Users/someone/server.key')
    vi.stubEnv('GGML_VK_VISIBLE_DEVICES', '1')
    await expect(asr.ensureServer(MODEL)).resolves.toBe(true)
    const env = mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(Object.keys(env).filter((name) => name.startsWith('LLAMA_'))).toEqual([])
    // A GGML_ variable picks the GPU, which a user may set on purpose for every program that uses ggml.
    expect(env.GGML_VK_VISIBLE_DEVICES).toBe('1')
  })
})
