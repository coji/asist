import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsrRequest, AsrResponse } from '../src/renderer/src/voice/asr-worker'

const pipeline = vi.hoisted(() => vi.fn())
vi.mock('@huggingface/transformers', () => ({ env: { backends: { onnx: { wasm: {} } } }, pipeline }))
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url', () => ({ default: '/assets/ort.mjs' }))
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url', () => ({ default: '/assets/ort.wasm' }))

interface LoadOptions {
  device: string
  dtype: string
  progress_callback?: (info: { status: string; file: string; loaded: number; total: number }) => void
}

/** The worker's global scope: the module answers through postMessage and takes requests through onmessage. */
const scope = {
  location: { href: 'http://localhost/assets/asr-worker.js' },
  posted: [] as AsrResponse[],
  postMessage(message: AsrResponse): void {
    scope.posted.push(message)
  },
  onmessage: null as ((event: MessageEvent<AsrRequest>) => void) | null
}

/**
 * The machine's GPU: none, one whose adapter lacks shader-f16, one that runs fp16, or one whose adapter lists
 * shader-f16 but that cannot compile an fp16 program.
 */
type Gpu = 'none' | 'no shader-f16' | 'runs fp16' | 'fails fp16'
let gpu: Gpu = 'none'
let webGpuSessionFails = false

/** A buffer of 16-bit values, which is how the worker reads and writes fp16. */
class FakeBuffer {
  readonly values: Uint16Array
  constructor(size: number) {
    this.values = new Uint16Array(size / 2)
  }
  async mapAsync(): Promise<void> {}
  getMappedRange(): ArrayBuffer {
    return this.values.buffer
  }
  unmap(): void {}
}

/** A device that runs any program as one that doubles each fp16 value in place, which adds one to its exponent. */
function fakeDevice(): unknown {
  let bound: FakeBuffer | null = null
  return {
    queue: {
      writeBuffer: (buffer: FakeBuffer, _offset: number, data: Uint16Array) => buffer.values.set(data),
      submit: () => {}
    },
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    createShaderModule: () => ({}),
    createComputePipelineAsync: async () => {
      if (gpu === 'fails fp16') throw new Error('Invalid ShaderModule: f16 is not supported')
      return { getBindGroupLayout: () => ({}) }
    },
    createBuffer: ({ size }: { size: number }) => new FakeBuffer(size),
    createBindGroup: ({ entries }: { entries: Array<{ resource: { buffer: FakeBuffer } }> }) => {
      bound = entries[0].resource.buffer
      return {}
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: () => bound!.values.forEach((bits, i) => (bound!.values[i] = bits + 0x0400)),
        end: () => {}
      }),
      copyBufferToBuffer: (from: FakeBuffer, _a: number, to: FakeBuffer) => to.values.set(from.values),
      finish: () => ({})
    }),
    destroy: () => {}
  }
}

const adapter = (): unknown =>
  gpu === 'none'
    ? null
    : {
        features: new Set(gpu === 'no shader-f16' ? [] : ['shader-f16']),
        requestDevice: async () => fakeDevice()
      }

/**
 * Loads as transformers.js does: the configuration first, then the check that the adapter lists shader-f16,
 * which throws before the weights are fetched, then the weights, and the session that runs them.
 */
async function load(_task: string, _model: string, options: LoadOptions): Promise<unknown> {
  const progress = options.progress_callback ?? ((): void => {})
  progress({ status: 'progress', file: 'config.json', loaded: 2_000, total: 2_000 })
  if (options.device === 'webgpu' && options.dtype === 'fp16' && (gpu === 'none' || gpu === 'no shader-f16')) {
    throw new Error('The device (webgpu) does not support fp16.')
  }
  const weights = options.dtype === 'fp16' ? 'onnx/encoder_model_fp16.onnx' : 'onnx/encoder_model_quantized.onnx'
  progress({ status: 'progress', file: weights, loaded: 40_000_000, total: 90_000_000 })
  progress({ status: 'progress', file: weights, loaded: 90_000_000, total: 90_000_000 })
  if (options.device === 'webgpu' && (gpu === 'fails fp16' || webGpuSessionFails)) {
    throw new Error('no available backend found. ERR: [webgpu] Error: Failed to compile shader')
  }
  return vi.fn()
}

async function initialize(): Promise<AsrResponse> {
  scope.onmessage?.({ data: { type: 'init', model: 'onnx-community/whisper-small', revision: 'abc' } } as MessageEvent<AsrRequest>)
  await vi.waitFor(() => expect(scope.posted.some((m) => m.type === 'ready' || m.type === 'error')).toBe(true))
  return scope.posted.find((m) => m.type === 'ready' || m.type === 'error')!
}

const weightProgress = (): AsrResponse[] =>
  scope.posted.filter((m) => m.type === 'progress' && m.file.startsWith('onnx/'))

beforeEach(async () => {
  vi.resetModules()
  pipeline.mockReset()
  pipeline.mockImplementation(load)
  scope.posted = []
  scope.onmessage = null
  gpu = 'none'
  webGpuSessionFails = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('self', scope)
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter() } })
  await import('../src/renderer/src/voice/asr-worker')
})

describe('asr-worker loading the model', () => {
  it('fetches the weights once, with their progress, where the adapter lacks shader-f16', async () => {
    gpu = 'no shader-f16'

    expect(await initialize()).toEqual({ type: 'ready', device: 'wasm' })
    expect(weightProgress().length).toBeGreaterThan(0)
    expect(pipeline).toHaveBeenCalledOnce()
  })

  it('fetches the weights once, with their progress, where there is no WebGPU adapter', async () => {
    gpu = 'none'

    expect(await initialize()).toEqual({ type: 'ready', device: 'wasm' })
    expect(weightProgress().length).toBeGreaterThan(0)
    expect(pipeline).toHaveBeenCalledOnce()
  })

  it('runs the fp16 weights on WebGPU where the GPU runs an fp16 program', async () => {
    gpu = 'runs fp16'

    expect(await initialize()).toEqual({ type: 'ready', device: 'webgpu' })
    expect(pipeline.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'fp16' })
  })

  it('loads the q8 weights on WASM where the adapter lists shader-f16 but the GPU cannot run an fp16 program', async () => {
    gpu = 'fails fp16'

    expect(await initialize()).toEqual({ type: 'ready', device: 'wasm' })
    expect(pipeline).toHaveBeenCalledOnce()
    expect(pipeline.mock.calls[0][2]).toMatchObject({ device: 'wasm', dtype: 'q8' })
  })

  it('reports a WebGPU load that fails instead of fetching the model again for WASM', async () => {
    gpu = 'runs fp16'
    webGpuSessionFails = true

    expect(await initialize()).toMatchObject({ type: 'error' })
    expect(pipeline).toHaveBeenCalledOnce()
  })
})
