import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TtsEngine } from '@shared/ipc'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { IRODORI_TTS_MODEL, IRODORI_TTS_VOICE_IDS, QWEN_TTS_CODEC, QWEN_TTS_MODELS, localTtsModel, qwenTtsLanguage } from '@shared/tts-models'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  downloadMissing: vi.fn(),
  settings: { uiLocale: 'en-US', ttsEngine: 'qwen3tts' as TtsEngine, qwenTtsSize: '0.6b' as '0.6b' | '1.7b' }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/pinned-download', () => ({ downloadMissing: mocks.downloadMissing }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data', on: vi.fn() } }))

const RATE = 24_000
function fakeChild() {
  const input: Array<Record<string, unknown>> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null as number | null, kill: vi.fn(), input
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) input.push(JSON.parse(line))
  })
  return child
}
type Child = ReturnType<typeof fakeChild>
let children: Child[] = []
let local: typeof import('../src/main/services/local-tts')

const say = (child: Child, message: Record<string, unknown>): void => { child.stdout.write(`ASIST_JSON:${JSON.stringify(message)}\n`) }
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
/** A piece of loud tone, which the shaper passes on at once. */
function voiced(seconds = 0.48): string {
  const samples = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 10) * 8000)
  return Buffer.from(samples.buffer).toString('base64')
}
const REQUEST = { text: 'こんにちは。', voice: 'ono_anna', language: 'ja' } as const

beforeEach(async () => {
  vi.resetModules()
  mocks.settings.ttsEngine = 'qwen3tts'
  mocks.settings.qwenTtsSize = '0.6b'
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  children = []
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    // The worker reports ready as soon as something listens, as a loaded model would.
    setTimeout(() => say(child, { type: 'ready', sampleRate: RATE, voices: ['ono_anna'], languages: ['ja'] }), 0)
    return child
  })
  local = await import('../src/main/services/local-tts')
})
afterEach(() => {
  local.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const child of children) {
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
  }
})

async function collect(stream: AsyncIterable<Float32Array>): Promise<number> {
  let samples = 0
  for await (const piece of stream) samples += piece.length
  return samples
}

describe('Qwen3-TTS service', () => {
  it('yields the pieces of a request while they arrive and ends with the worker\'s end message', async () => {
    const stream = local.stream('qwen3tts', REQUEST)
    const first = stream.next()
    await settle()
    const child = children[0]
    const request = child.input.find((message) => message.text === REQUEST.text)!
    expect(request).toMatchObject({ voice: 'ono_anna', language: 'ja' })
    say(child, { type: 'chunk', id: request.id, seq: 0, pcm: voiced() })
    // The first piece is delivered before the sentence is finished.
    expect((await first).value!.length).toBeGreaterThan(0)
    say(child, { type: 'chunk', id: request.id, seq: 1, pcm: voiced() })
    say(child, { type: 'end', id: request.id, samples: 0 })
    expect(await collect(stream)).toBeGreaterThan(0)
    expect(child.input.some((message) => message.type === 'cancel')).toBe(false)
  })

  it('cancels the request in the worker as soon as the signal aborts, without waiting for the consumer', async () => {
    const controller = new AbortController()
    const stream = local.stream('qwen3tts', REQUEST, controller.signal)
    const first = stream.next()
    await settle()
    const child = children[0]
    const id = child.input.find((message) => message.text)!.id
    say(child, { type: 'chunk', id, seq: 0, pcm: voiced() })
    await first
    controller.abort()
    await settle()
    expect(child.input).toContainEqual({ type: 'cancel', id })
    await expect(stream.next()).rejects.toThrow()
  })

  it('cancels a request the consumer stops reading', async () => {
    const stream = local.stream('qwen3tts', REQUEST)
    const first = stream.next()
    await settle()
    const child = children[0]
    const id = child.input.find((message) => message.text)!.id
    say(child, { type: 'chunk', id, seq: 0, pcm: voiced() })
    await first
    await stream.return(undefined)
    expect(child.input).toContainEqual({ type: 'cancel', id })
  })

  it('fails every waiting request when the worker dies, and starts a new worker for the next request', async () => {
    const one = collect(local.stream('qwen3tts', REQUEST))
    const two = collect(local.stream('qwen3tts', { ...REQUEST, text: '次の文。' }))
    await settle()
    children[0].exitCode = 1
    children[0].emit('exit', 1)
    await expect(one).rejects.toThrow('exited')
    await expect(two).rejects.toThrow('exited')

    const again = local.stream('qwen3tts', REQUEST)
    const first = again.next()
    await settle()
    expect(children).toHaveLength(2)
    const id = children[1].input.find((message) => message.text)!.id
    say(children[1], { type: 'chunk', id, seq: 0, pcm: voiced() })
    expect((await first).done).toBe(false)
  })

  it('reports the worker\'s error for one request and keeps serving the others', async () => {
    const failing = collect(local.stream('qwen3tts', REQUEST))
    const healthy = collect(local.stream('qwen3tts', { ...REQUEST, text: '次の文。' }))
    await settle()
    const child = children[0]
    const [a, b] = child.input.filter((message) => message.text).map((message) => message.id)
    say(child, { type: 'error', id: a, error: 'unknown voice' })
    say(child, { type: 'chunk', id: b, seq: 0, pcm: voiced() })
    say(child, { type: 'end', id: b, samples: 0 })
    await expect(failing).rejects.toThrow('unknown voice')
    expect(await healthy).toBeGreaterThan(0)
  })

  it('generates a clip again when the model rambles, cancelling the rambling generation, and returns the first plausible one', async () => {
    const wav = local.synthesizeWav('qwen3tts', { ...REQUEST, text: 'うん。' })
    await settle()
    const child = children[0]
    const requests = (): Array<Record<string, unknown>> => child.input.filter((message) => message.text)
    // "うん。" may take 1.5 s; this generation is still going after 1.9 s.
    for (let seq = 0; seq < 4; seq++) say(child, { type: 'chunk', id: requests()[0].id, seq, pcm: voiced() })
    await settle()
    expect(child.input).toContainEqual({ type: 'cancel', id: requests()[0].id })
    expect(requests()).toHaveLength(2)
    say(child, { type: 'chunk', id: requests()[1].id, seq: 0, pcm: voiced() })
    say(child, { type: 'end', id: requests()[1].id, samples: 0 })
    const result = await wav
    expect(result.toString('ascii', 0, 4)).toBe('RIFF')
    // Only the second generation is in the file: 0.48 s of voice and the short tail at most.
    expect(result.readUInt32LE(40) / 2 / RATE).toBeLessThan(0.7)
  })

  it('lets a slow reading of a sentence full of digits finish, and still cuts one that rambles on past it', async () => {
    const text = '暗証番号は4桁で、8264です。'
    const reading = collect(local.stream('qwen3tts', { ...REQUEST, text }))
    await settle()
    const child = children[0]
    const first = child.input.find((message) => message.text === text)!.id
    // 6.2 s: a reading measured at 5.9 s lost its last digit to an allowance counted by characters alone.
    for (let seq = 0; seq < 13; seq++) say(child, { type: 'chunk', id: first, seq, pcm: voiced() })
    say(child, { type: 'end', id: first, samples: 0 })
    expect(await reading / RATE).toBeGreaterThan(6.2)
    expect(child.input).not.toContainEqual({ type: 'cancel', id: first })

    const rambling = collect(local.stream('qwen3tts', { ...REQUEST, text }))
    await settle()
    const second = child.input.filter((message) => message.text === text)[1].id
    for (let seq = 0; seq < 40; seq++) say(child, { type: 'chunk', id: second, seq, pcm: voiced() })
    expect(await rambling / RATE).toBeLessThan(8)
    expect(child.input).toContainEqual({ type: 'cancel', id: second })
  })

  it('gives up on a clip the model never reads plausibly instead of caching a bad one', async () => {
    const wav = local.synthesizeWav('qwen3tts', { ...REQUEST, text: 'うん。' })
    const outcome = wav.then(() => 'resolved', (error: Error) => error.message)
    const child = () => children[0]
    for (let attempt = 0; attempt < 6; attempt++) {
      await settle()
      const id = child().input.filter((message) => message.text)[attempt].id
      say(child(), { type: 'chunk', id, seq: 0, pcm: Buffer.alloc(RATE).toString('base64') })
      say(child(), { type: 'end', id, samples: 0 })
    }
    expect(await outcome).toContain('no plausible reading')
    expect(child().input.filter((message) => message.text)).toHaveLength(6)
  })

  it('does not start a worker while a file of the model is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !String(file).endsWith('qwen3-tts-codec-12hz-f16.gguf'))
    await expect(collect(local.stream('qwen3tts', REQUEST))).rejects.toThrow('not installed')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('runs the worker on the talker of the size the setting names, the shared codec and the GPU the capabilities chose', async () => {
    await expect(local.ensureWorker('qwen3tts')).resolves.toBe(true)
    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(path.basename(command)).toMatch(/^speech-worker(\.exe)?$/)
    expect(args.map((arg) => (arg.endsWith('.gguf') ? path.basename(arg) : arg))).toEqual([
      QWEN_TTS_MODELS['0.6b'].talker.file, QWEN_TTS_CODEC.file, '--device', 'MTL0'
    ])
  })

  it('starts the worker again on the other talker when the size changes', async () => {
    await expect(local.ensureWorker('qwen3tts')).resolves.toBe(true)
    mocks.settings.qwenTtsSize = '1.7b'
    expect(local.available('qwen3tts')).toBe(false)
    await expect(local.ensureWorker('qwen3tts')).resolves.toBe(true)
    expect(children[0].kill).toHaveBeenCalled()
    expect(path.basename((mocks.spawn.mock.calls[1] as [string, string[]])[1][0])).toBe(QWEN_TTS_MODELS['1.7b'].talker.file)
  })
})

describe('a sentence the worker fails after its first piece', () => {
  /** Starts a sentence, delivers its first piece, applies the failure and returns the error the rest of the sentence ends with. */
  async function failedAfterFirstPiece(fail: (child: Child, id: string) => void | Promise<void>): Promise<Error> {
    const stream = local.stream('qwen3tts', REQUEST)
    const first = stream.next()
    await settle()
    const child = children[0]
    const id = child.input.find((message) => message.text)!.id as string
    say(child, { type: 'chunk', id, seq: 0, pcm: voiced() })
    await first
    await fail(child, id)
    return stream.next().then(() => { throw new Error('the sentence went on') }, (error: Error) => error)
  }
  const engine = localTtsModel('qwen3tts', '0.6b').label

  // The conversation shows this error on its error line, in the language of the interface.
  it.each([
    ['the worker exits', (child: Child) => { child.exitCode = 1; child.emit('exit', 1) }],
    ['the worker reports an error for the sentence', (child: Child, id: string) => say(child, { type: 'error', id, error: 'decoder failed' })]
  ])('ends it with an error the screen words in its own language when %s', async (_case, fail) => {
    const error = await failedAfterFirstPiece(fail)
    expect(readErrorText(error.message, 'ja-JP')).not.toBeNull()
    expect(error.name).not.toBe('AbortError')
  })

  it('ends it with an error of the app\'s own, not an English sentence as its detail, when the worker goes silent', async () => {
    vi.useFakeTimers()
    try {
      const stream = local.stream('qwen3tts', REQUEST)
      const first = stream.next()
      await vi.advanceTimersByTimeAsync(10)
      const child = children[0]
      const id = child.input.find((message) => message.text)!.id
      say(child, { type: 'chunk', id, seq: 0, pcm: voiced() })
      await first
      const rest = stream.next().then(() => { throw new Error('the sentence went on') }, (error: Error) => error)
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await rest).message).toBe(errorText('voice.speech.engineNoResponse', { engine }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends it with an error of the app\'s own when the worker reports an error without saying why', async () => {
    const error = await failedAfterFirstPiece((child, id) => say(child, { type: 'error', id }))
    expect(error.message).toBe(errorText('voice.speech.engineFailedWithoutReason', { engine }))
  })

  it('ends it as stopped, which is no failure, when the worker is stopped for another engine', async () => {
    const error = await failedAfterFirstPiece(() => local.stop())
    expect(error.name).toBe('AbortError')
  })
})

describe('Irodori-TTS service', () => {
  it('runs the worker on the model, its codec, every voice the app ships and the GPU the capabilities chose', async () => {
    await expect(local.ensureWorker('irodori')).resolves.toBe(true)
    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(path.basename(command)).toMatch(/^speech-worker(\.exe)?$/)
    expect(args.slice(0, 2).map((arg) => path.basename(arg))).toEqual([IRODORI_TTS_MODEL.model.file, IRODORI_TTS_MODEL.codec.file])
    const voices = args.flatMap((arg, index) => (args[index - 1] === '--voice' ? [arg] : []))
    expect(voices.map((voice) => voice.split('=')[0])).toEqual([...IRODORI_TTS_VOICE_IDS])
    for (const voice of voices) {
      const [name, file] = voice.split('=')
      expect(file).toBe(path.join('/app', 'resources', 'irodori-voices', `${name}.voice.gguf`))
    }
    expect(args.slice(-2)).toEqual(['--device', 'MTL0'])
  })

  it('replaces the Qwen3-TTS worker when Irodori-TTS is chosen, since one worker runs one model', async () => {
    await expect(local.ensureWorker('qwen3tts')).resolves.toBe(true)
    expect(local.available('irodori')).toBe(false)
    await expect(local.ensureWorker('irodori')).resolves.toBe(true)
    expect(children[0].kill).toHaveBeenCalled()
    expect(local.available('irodori')).toBe(true)
    expect(local.available('qwen3tts')).toBe(false)
  })

  it('lets a reading run as long as the model made it, since Irodori-TTS fixes the length before it speaks', async () => {
    const reading = collect(local.stream('irodori', { text: 'うん。', voice: 'calm-young-woman', language: 'ja' }))
    await settle()
    const child = children[0]
    const id = child.input.find((message) => message.text)!.id
    // 3.8 s, past the 1.5 s Qwen3-TTS is allowed for the same text.
    for (let seq = 0; seq < 8; seq++) say(child, { type: 'chunk', id, seq, pcm: voiced() })
    say(child, { type: 'end', id, samples: 0 })
    expect(await reading / RATE).toBeGreaterThan(3.5)
    expect(child.input).not.toContainEqual({ type: 'cancel', id })
  })
})

describe('preparing a local model', () => {
  /** The model files that are there, by name. */
  let installed: Set<string>
  /** Ends the download of the prepared model's files, which takes minutes in the app. */
  let finishDownload: () => void

  const install = (files: ReadonlyArray<{ file: string }>): void => {
    for (const { file } of files) installed.add(file)
  }

  beforeEach(() => {
    installed = new Set()
    vi.mocked(fs.existsSync).mockImplementation((file) => !String(file).endsWith('.gguf') || installed.has(path.basename(String(file))))
    mocks.downloadMissing.mockReset().mockImplementation((files: Array<{ file: { file: string } }>, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        finishDownload = () => {
          install(files.map((entry) => entry.file))
          resolve()
        }
      }))
  })

  it('starts the worker on the files it fetched while the settings still select that model', async () => {
    const preparation = local.prepare('qwen3tts', () => {})
    await settle()
    expect(mocks.spawn).not.toHaveBeenCalled()
    finishDownload()
    expect((await preparation).ok).toBe(true)
    expect(local.available('qwen3tts')).toBe(true)
  })

  it('leaves the worker of the engine chosen while the files downloaded running, and starts none of its own', async () => {
    install(localTtsModel('irodori', '0.6b').files)
    const preparation = local.prepare('qwen3tts', () => {})
    await settle()
    // The user picks Irodori-TTS on the voice page, and the change of the setting starts it.
    mocks.settings.ttsEngine = 'irodori'
    await expect(local.ensureWorker('irodori')).resolves.toBe(true)
    finishDownload()
    expect((await preparation).ok).toBe(true)
    expect(children).toHaveLength(1)
    expect(local.available('irodori')).toBe(true)
  })

  it('starts no worker when the user chose an engine that needs none while the files downloaded', async () => {
    const preparation = local.prepare('qwen3tts', () => {})
    await settle()
    mocks.settings.ttsEngine = 'voicevox'
    finishDownload()
    expect((await preparation).ok).toBe(true)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reports the files of a size the user turned away from as prepared rather than as a model that failed to start', async () => {
    const preparation = local.prepare('qwen3tts', () => {})
    await settle()
    mocks.settings.qwenTtsSize = '1.7b'
    finishDownload()
    expect((await preparation).ok).toBe(true)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('keeps the worker of the engine chosen while the files downloaded when the preparation is cancelled', async () => {
    install(localTtsModel('irodori', '0.6b').files)
    const preparation = local.prepare('qwen3tts', () => {})
    await settle()
    mocks.settings.ttsEngine = 'irodori'
    await local.ensureWorker('irodori')
    expect(local.cancelPreparation()).toBe(true)
    expect((await preparation).ok).toBe(false)
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(local.available('irodori')).toBe(true)
  })
})

describe('qwenTtsLanguage', () => {
  it('names the language of a locale by its language subtag, and knows which locales the model cannot speak', () => {
    expect(qwenTtsLanguage('ja-JP')).toBe('ja')
    expect(qwenTtsLanguage('pt-BR')).toBe('pt')
    expect(qwenTtsLanguage('es-419')).toBe('es')
    expect(qwenTtsLanguage('hi-IN')).toBeNull()
    expect(qwenTtsLanguage('id-ID')).toBeNull()
  })
})
