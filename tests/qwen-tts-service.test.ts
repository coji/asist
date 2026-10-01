import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QWEN_TTS_CODEC, QWEN_TTS_MODELS, qwenTtsLanguage } from '@shared/tts-models'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), settings: { qwenTtsSize: '0.6b' as '0.6b' | '1.7b' } }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
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
let qwen: typeof import('../src/main/services/qwen-tts')

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
  qwen = await import('../src/main/services/qwen-tts')
})
afterEach(() => {
  qwen.stop()
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
    const stream = qwen.stream(REQUEST)
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
    const stream = qwen.stream(REQUEST, controller.signal)
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
    const stream = qwen.stream(REQUEST)
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
    const one = collect(qwen.stream(REQUEST))
    const two = collect(qwen.stream({ ...REQUEST, text: '次の文。' }))
    await settle()
    children[0].exitCode = 1
    children[0].emit('exit', 1)
    await expect(one).rejects.toThrow('exited')
    await expect(two).rejects.toThrow('exited')

    const again = qwen.stream(REQUEST)
    const first = again.next()
    await settle()
    expect(children).toHaveLength(2)
    const id = children[1].input.find((message) => message.text)!.id
    say(children[1], { type: 'chunk', id, seq: 0, pcm: voiced() })
    expect((await first).done).toBe(false)
  })

  it('reports the worker\'s error for one request and keeps serving the others', async () => {
    const failing = collect(qwen.stream(REQUEST))
    const healthy = collect(qwen.stream({ ...REQUEST, text: '次の文。' }))
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
    const wav = qwen.synthesizeWav({ ...REQUEST, text: 'うん。' })
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
    const reading = collect(qwen.stream({ ...REQUEST, text }))
    await settle()
    const child = children[0]
    const first = child.input.find((message) => message.text === text)!.id
    // 6.2 s: a reading measured at 5.9 s lost its last digit to an allowance counted by characters alone.
    for (let seq = 0; seq < 13; seq++) say(child, { type: 'chunk', id: first, seq, pcm: voiced() })
    say(child, { type: 'end', id: first, samples: 0 })
    expect(await reading / RATE).toBeGreaterThan(6.2)
    expect(child.input).not.toContainEqual({ type: 'cancel', id: first })

    const rambling = collect(qwen.stream({ ...REQUEST, text }))
    await settle()
    const second = child.input.filter((message) => message.text === text)[1].id
    for (let seq = 0; seq < 40; seq++) say(child, { type: 'chunk', id: second, seq, pcm: voiced() })
    expect(await rambling / RATE).toBeLessThan(8)
    expect(child.input).toContainEqual({ type: 'cancel', id: second })
  })

  it('gives up on a clip the model never reads plausibly instead of caching a bad one', async () => {
    const wav = qwen.synthesizeWav({ ...REQUEST, text: 'うん。' })
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
    await expect(collect(qwen.stream(REQUEST))).rejects.toThrow('not installed')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('runs the worker on the talker of the size the setting names, the shared codec and the GPU the capabilities chose', async () => {
    await expect(qwen.ensureWorker()).resolves.toBe(true)
    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(path.basename(command)).toMatch(/^speech-worker(\.exe)?$/)
    expect(args.map((arg) => (arg.endsWith('.gguf') ? path.basename(arg) : arg))).toEqual([
      QWEN_TTS_MODELS['0.6b'].talker.file, QWEN_TTS_CODEC.file, '--device', 'MTL0'
    ])
  })

  it('starts the worker again on the other talker when the size changes', async () => {
    await expect(qwen.ensureWorker()).resolves.toBe(true)
    mocks.settings.qwenTtsSize = '1.7b'
    expect(qwen.available()).toBe(false)
    await expect(qwen.ensureWorker()).resolves.toBe(true)
    expect(children[0].kill).toHaveBeenCalled()
    expect(path.basename((mocks.spawn.mock.calls[1] as [string, string[]])[1][0])).toBe(QWEN_TTS_MODELS['1.7b'].talker.file)
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
