import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { AsrEngine } from '../src/renderer/src/voice/AsrEngine'
import type { AsrRequest, AsrResponse } from '../src/renderer/src/voice/asr-worker'

class FakeWorker {
  onmessage: ((event: MessageEvent<AsrResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: AsrRequest[] = []
  terminated = false

  postMessage(message: AsrRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  message(message: AsrResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<AsrResponse>)
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

const asWorker = (worker: FakeWorker): Worker => worker as unknown as Worker

afterEach(() => {
  vi.useRealTimers()
})

describe('AsrEngine', () => {
  it('shares concurrent initialization and reports progress to every caller', async () => {
    const worker = new FakeWorker()
    const factory = vi.fn(() => asWorker(worker))
    const engine = new AsrEngine({ workerFactory: factory })
    const firstProgress: number[] = []
    const secondProgress: number[] = []

    const first = engine.init(({ progress }) => firstProgress.push(progress))
    const second = engine.init(({ progress }) => secondProgress.push(progress))

    expect(second).toBe(first)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(worker.posted).toEqual([
      {
        type: 'init',
        model: 'onnx-community/whisper-small',
        revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732'
      }
    ])

    worker.message({ type: 'progress', file: 'model.onnx', loaded: 25, total: 100 })
    worker.message({ type: 'ready', device: 'wasm' })

    await expect(first).resolves.toBe('wasm')
    expect(firstProgress).toEqual([25])
    expect(secondProgress).toEqual([25])
  })

  it('tears down a failed init and can initialize a fresh worker', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const engine = new AsrEngine({
      workerFactory: () => asWorker(workers.shift()!)
    })

    const failedWorker = workers[0]
    const failed = engine.init()
    failedWorker.message({ type: 'error', message: 'model load failed' })
    await expect(failed).rejects.toThrow('model load failed')
    expect(failedWorker.terminated).toBe(true)

    const freshWorker = workers[0]
    const retried = engine.init()
    freshWorker.message({ type: 'ready', device: 'webgpu' })
    await expect(retried).resolves.toBe('webgpu')
  })

  it('reports a model that fails to load as its own error, with the library\'s message as the detail', async () => {
    const worker = new FakeWorker()
    const engine = new AsrEngine({ workerFactory: () => asWorker(worker) })

    const failed = engine.init()
    worker.message({ type: 'error', message: 'no available backend found. ERR: [webgpu] Error: Failed to compile shader' })

    await expect(failed).rejects.toThrow(
      errorText('speechRecognition.errors.modelLoadFailed', {
        detail: 'no available backend found. ERR: [webgpu] Error: Failed to compile shader'
      })
    )
  })

  it('times out a hung initialization and can initialize a fresh worker', async () => {
    vi.useFakeTimers()
    const firstWorker = new FakeWorker()
    const secondWorker = new FakeWorker()
    const workers = [firstWorker, secondWorker]
    const engine = new AsrEngine({
      workerFactory: () => asWorker(workers.shift()!),
      initTimeoutMs: 100
    })

    const hung = engine.init()
    const rejected = expect(hung).rejects.toThrow(errorText('speechRecognition.errors.initTimeout', { ms: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(firstWorker.terminated).toBe(true)

    const retried = engine.init()
    secondWorker.message({ type: 'ready', device: 'wasm' })
    await expect(retried).resolves.toBe('wasm')
  })

  it('sends the language of each transcription to the worker', async () => {
    const worker = new FakeWorker()
    const engine = new AsrEngine({ workerFactory: () => asWorker(worker) })
    const initialized = engine.init()
    worker.message({ type: 'ready', device: 'wasm' })
    await initialized

    const transcription = engine.transcribe(new Float32Array([0.1]), 'german')
    expect(worker.posted.at(-1)).toMatchObject({ type: 'transcribe', language: 'german' })
    worker.message({ type: 'result', id: 1, text: 'Guten Tag' })
    await expect(transcription).resolves.toBe('Guten Tag')
  })

  it('rejects every pending transcription on worker crash and can reinitialize', async () => {
    const firstWorker = new FakeWorker()
    const secondWorker = new FakeWorker()
    const workers = [firstWorker, secondWorker]
    const engine = new AsrEngine({
      workerFactory: () => asWorker(workers.shift()!)
    })

    const initialized = engine.init()
    firstWorker.message({ type: 'ready', device: 'wasm' })
    await initialized
    const first = engine.transcribe(new Float32Array([0.1]), 'japanese')
    const second = engine.transcribe(new Float32Array([0.2]), 'japanese')

    firstWorker.crash('worker crashed')

    await expect(first).rejects.toThrow('worker crashed')
    await expect(second).rejects.toThrow('worker crashed')
    expect(firstWorker.terminated).toBe(true)

    const reinitialized = engine.init()
    secondWorker.message({ type: 'ready', device: 'wasm' })
    await expect(reinitialized).resolves.toBe('wasm')
  })

  it('times out a hung transcription and resets the worker', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const engine = new AsrEngine({
      workerFactory: () => asWorker(worker),
      transcribeTimeoutMs: 100
    })
    const initialized = engine.init()
    worker.message({ type: 'ready', device: 'wasm' })
    await initialized

    const transcription = engine.transcribe(new Float32Array([0.1]), 'japanese')
    const rejected = expect(transcription).rejects.toThrow(errorText('speechRecognition.errors.transcribeTimeout', { ms: 100 }))
    await vi.advanceTimersByTimeAsync(100)

    await rejected
    expect(worker.terminated).toBe(true)
  })

  it('rejects pending work when disposed and ignores late worker messages', async () => {
    const worker = new FakeWorker()
    const engine = new AsrEngine({ workerFactory: () => asWorker(worker) })
    const initialized = engine.init()
    worker.message({ type: 'ready', device: 'wasm' })
    await initialized
    const transcription = engine.transcribe(new Float32Array([0.1]), 'japanese')

    engine.dispose()
    worker.message({ type: 'result', id: 1, text: 'late' })

    await expect(transcription).rejects.toThrow('disposed')
    expect(worker.terminated).toBe(true)
  })

  it('settles a successful transcription exactly once', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const engine = new AsrEngine({
      workerFactory: () => asWorker(worker),
      transcribeTimeoutMs: 100
    })
    const initialized = engine.init()
    worker.message({ type: 'ready', device: 'wasm' })
    await initialized
    const transcription = engine.transcribe(new Float32Array([0.1]), 'japanese')

    worker.message({ type: 'result', id: 1, text: 'こんにちは' })
    await expect(transcription).resolves.toBe('こんにちは')
    await vi.advanceTimersByTimeAsync(100)

    expect(worker.terminated).toBe(false)
  })
})
