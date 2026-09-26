import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({ directory: '', spawn: vi.fn(), systemLanguages: ['ja-JP'] }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => mocks.directory, on: vi.fn(),
  getPreferredSystemLanguages: () => mocks.systemLanguages
} }))

const MODEL = 'qwen3-asr-1.7b-mlx' as const
const OTHER_MODEL = 'whisper-large-v3-turbo-mlx' as const
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function fakeChild() {
  const input: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null as number | null, kill: vi.fn(), input
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => input.push(String(data)))
  return child
}
let children: ReturnType<typeof fakeChild>[] = []
type Mlx = typeof import('../src/main/services/mlx-asr')
let mlx: Mlx
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ASIST_MLX_PYTHON', '/unused/python')
  mocks.systemLanguages = ['ja-JP']
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-mlx-service-'))
  // Only the presence of the worker and the model is faked; the WAV files are really written to and removed from a temporary directory.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  children = []
  mocks.spawn.mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    return child
  })
  mlx = await import('../src/main/services/mlx-asr')
})
afterEach(() => {
  mlx.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const child of children) {
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
  }
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

async function ready(model: typeof MODEL | typeof OTHER_MODEL = MODEL) {
  const starting = mlx.ensureServer(model)
  const child = children.at(-1)!
  child.stdout.write('ASIST_JSON:{"type":"ready"}\n')
  await vi.advanceTimersByTimeAsync(100)
  expect(await starting).toBe(true)
  return child
}
function observe(promise: Promise<string>) {
  return promise.then(text => ({ text, error: undefined }), (error: Error) => ({ text: undefined, error }))
}
function wavFiles(): string[] {
  try {
    return fs.readdirSync(path.join(mocks.directory, 'asr-temp'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('MLX transcription lifecycle', () => {
  it('starts the worker with Python in UTF-8 mode, so that the transcript it prints is UTF-8 on Windows too', async () => {
    await ready()
    expect(mocks.spawn.mock.calls.at(-1)![2].env).toMatchObject({ PYTHONUTF8: '1' })
  })

  it('accepts cancellation while the worker is loading without dispatching the request', async () => {
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'loading'))
    expect(mlx.cancelTranscription('loading')).toBe(true)
    expect((await response).error?.name).toBe('AbortError')
    children[0].stdout.write('ASIST_JSON:{"type":"ready"}\n')
    await vi.advanceTimersByTimeAsync(100)
    expect(children[0].input).toEqual([])
    expect(wavFiles()).toEqual([])
  })

  it.each(['mkdir', 'writeFile'] as const)('cancels during %s and cleans any late file', async (stage) => {
    const child = await ready()
    const held = deferred()
    const original = fs.promises[stage].bind(fs.promises)
    const operation = vi.spyOn(fs.promises, stage).mockImplementationOnce((async (...args: unknown[]) => {
      await held.promise
      return (original as (...values: unknown[]) => Promise<unknown>)(...args)
    }) as never)
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), stage))
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
    expect(mlx.cancelTranscription(stage)).toBe(true)
    expect((await response).error?.name).toBe('AbortError')
    held.resolve()
    await operation.mock.results[0].value
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
    expect(child.input).toEqual([])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each(['switch', 'restart'] as const)('does not send old prepared audio to a replacement worker after %s', async (action) => {
    const oldChild = await ready()
    const held = deferred()
    const writeFile = fs.promises.writeFile.bind(fs.promises)
    const writing = vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args) => {
      await held.promise
      return writeFile(...args)
    })
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'old'))
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce())
    if (action === 'restart') mlx.stop()
    const replacement = await ready(action === 'switch' ? OTHER_MODEL : MODEL)
    held.resolve()
    await writing.mock.results[0].value
    const result = await response
    expect(result.error?.name).toBe('AbortError')
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
    expect(oldChild.input).toEqual([])
    expect(replacement.input).toEqual([])
    expect(replacement.kill).not.toHaveBeenCalled()
  })

  it('ignores readiness and fatal messages from a replaced worker', async () => {
    const oldStart = mlx.ensureServer(MODEL)
    const oldChild = children[0]
    mlx.stop()
    const nextStart = mlx.ensureServer(MODEL)
    const nextChild = children[1]
    oldChild.stdout.write('ASIST_JSON:{"type":"ready"}\n')
    expect(await mlx.available(MODEL)).toBe(false)
    oldChild.stdout.write('ASIST_JSON:{"type":"fatal","error":"old failure"}\n')
    nextChild.stdout.write('ASIST_JSON:{"type":"ready"}\n')
    await vi.advanceTimersByTimeAsync(100)
    expect(await oldStart).toBe(false)
    expect(await nextStart).toBe(true)
    expect(nextChild.kill).not.toHaveBeenCalled()
  })

  it('returns successful output and removes its WAV after the worker result', async () => {
    const child = await ready()
    const response = mlx.transcribe(MODEL, new Float32Array([0.2, -0.2]), 'complete')
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    const request = JSON.parse(child.input[0]) as { id: string; wavPath: string; language: string }
    expect(fs.readFileSync(request.wavPath).toString('ascii', 0, 4)).toBe('RIFF')
    expect(request.language).toBe('Japanese')
    child.stdout.write('ASIST_JSON:{"type":"result","id":"complete","text":"認識しました"}\n')
    expect(await response).toBe('認識しました')
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
  })

  it('sends the conversation language in the form each model takes', async () => {
    mocks.systemLanguages = ['de-DE']
    const qwen = await ready(MODEL)
    const german = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'qwen-de'))
    await vi.waitFor(() => expect(qwen.input).toHaveLength(1))
    expect(JSON.parse(qwen.input[0]).language).toBe('German')

    const whisper = await ready(OTHER_MODEL)
    const second = observe(mlx.transcribe(OTHER_MODEL, new Float32Array([0.2]), 'whisper-de'))
    await vi.waitFor(() => expect(whisper.input).toHaveLength(1))
    expect(JSON.parse(whisper.input[0]).language).toBe('de')
    mlx.stop()
    expect((await german).error?.name).toBe('AbortError')
    expect((await second).error?.name).toBe('AbortError')
  })

  it('stops sent inference on cancellation and releases its file', async () => {
    const child = await ready()
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'sent'))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    expect(mlx.cancelTranscription('sent')).toBe(true)
    expect((await response).error?.name).toBe('AbortError')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
    expect(mlx.cancelTranscription('sent')).toBe(false)
  })

  it('times out sent inference and can start a new worker afterward', async () => {
    const child = await ready()
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'timeout'))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await response).error?.name).toBe('TimeoutError')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(await ready()).not.toBe(child)
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
  })

  it('keeps the worker and the final transcription queued behind a partial that runs past its wait', async () => {
    const child = await ready()
    const partial = mlx.transcribePartial(MODEL, new Float32Array(16_000 * 5))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    const final = observe(mlx.transcribe(MODEL, new Float32Array(16_000 * 8), 'final'))
    await vi.waitFor(() => expect(child.input).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await partial).toBe('')

    const partialId = JSON.parse(child.input[0]).id as string
    child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'result', id: partialId, text: '途中' })}\n`)
    child.stdout.write('ASIST_JSON:{"type":"result","id":"final","text":"最後まで話しました"}\n')
    expect(await final).toEqual({ text: '最後まで話しました', error: undefined })
    expect(child.kill).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(wavFiles()).toEqual([]))
  })

  it('sends no further partial while the worker still computes one its caller stopped waiting for', async () => {
    const child = await ready()
    const first = mlx.transcribePartial(MODEL, new Float32Array([0.2]))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await first).toBe('')
    expect(await mlx.transcribePartial(MODEL, new Float32Array([0.2]))).toBe('')
    expect(child.input).toHaveLength(1)

    child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'result', id: JSON.parse(child.input[0]).id, text: '遅れた' })}\n`)
    await vi.advanceTimersByTimeAsync(10)
    const next = mlx.transcribePartial(MODEL, new Float32Array([0.2]))
    await vi.waitFor(() => expect(child.input).toHaveLength(2))
    child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'result', id: JSON.parse(child.input[1]).id, text: '次の途中' })}\n`)
    expect(await next).toBe('次の途中')
  })

  it('reports unavailable installation without leaving a cancellable request', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'unavailable'))
    expect((await response).error?.message).toBe(errorText('speechRecognition.errors.mlxNotReady'))
    expect(mlx.cancelTranscription('unavailable')).toBe(false)
    expect(wavFiles()).toEqual([])
  })

  it('removes the recordings an earlier run left behind, and refuses while a transcription still uses its file', async () => {
    const folder = path.join(mocks.directory, 'asr-temp')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'left-by-a-crash.wav'), 'RIFF')
    mlx.clearTemporaryAudio()
    expect(wavFiles()).toEqual([])

    const child = await ready()
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'in-use'))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    expect(() => mlx.clearTemporaryAudio()).toThrow()
    expect(wavFiles()).toHaveLength(1)
    child.stdout.write('ASIST_JSON:{"type":"result","id":"in-use","text":"残っています"}\n')
    expect((await response).text).toBe('残っています')
  })

  it('fails the requests of a worker whose input pipe breaks, and stops it without an uncaught error', async () => {
    const child = await ready()
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'broken-pipe'))
    await vi.waitFor(() => expect(child.input).toHaveLength(1))
    const uncaught: Error[] = []
    const onUncaught = (error: Error): void => { uncaught.push(error) }
    process.prependListener('uncaughtException', onUncaught)
    try {
      child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      expect((await response).error?.message).toBe('write EPIPE')
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(child.kill).toHaveBeenCalled()
    expect(await mlx.available(MODEL)).toBe(false)
  })
})

describe('starting the MLX worker from a preparation and from elsewhere at once', () => {
  it('lets a start from the watchdog wait for the worker a preparation is loading', async () => {
    const preparing = mlx.prepare(MODEL, () => {})
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const revived = mlx.ensureServer(MODEL)
    children[0].stdout.write('ASIST_JSON:{"type":"ready"}\n')
    expect(await revived).toBe(true)
    expect((await preparing).ok).toBe(true)
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('lets a preparation wait for the worker a transcription is already loading', async () => {
    const response = observe(mlx.transcribe(MODEL, new Float32Array([0.2]), 'while-loading'))
    expect(children).toHaveLength(1)
    const preparing = mlx.prepare(MODEL, () => {})
    await vi.advanceTimersByTimeAsync(10)
    children[0].stdout.write('ASIST_JSON:{"type":"ready"}\n')
    expect((await preparing).ok).toBe(true)
    await vi.waitFor(() => expect(children[0].input).toHaveLength(1))
    children[0].stdout.write('ASIST_JSON:{"type":"result","id":"while-loading","text":"聞こえました"}\n')
    expect((await response).text).toBe('聞こえました')
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
  })
})
