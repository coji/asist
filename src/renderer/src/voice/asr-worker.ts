import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline
} from '@huggingface/transformers'
import ortWasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

/**
 * Runs the Whisper pipeline of @huggingface/transformers inside a Web Worker so that transcription
 * never blocks the UI thread. It runs the fp16 weights on WebGPU where this machine's GPU runs an fp16
 * program, and the q8 weights on WASM everywhere else.
 */

function assertSameOriginRuntimeAsset(url: string): void {
  const asset = new URL(url, self.location.href)
  const worker = new URL(self.location.href)
  if (asset.origin !== worker.origin) {
    throw new Error(`ONNX Runtime asset must be bundled with ASIST: ${asset.origin}`)
  }
}

// Transformers.js defaults to jsDelivr for these runtime files. Keep the
// execution runtime in the signed application bundle so ASR startup does not
// depend on a mutable CDN (and continues to work offline after model download).
assertSameOriginRuntimeAsset(ortWasmFactoryUrl)
assertSameOriginRuntimeAsset(ortWasmBinaryUrl)
env.backends.onnx.wasm!.wasmPaths = {
  mjs: ortWasmFactoryUrl,
  wasm: ortWasmBinaryUrl
}

export interface AsrInitMessage {
  type: 'init'
  model: string
  /** An immutable Hugging Face commit SHA. A branch or tag name is not allowed. */
  revision: string
}

export interface AsrTranscribeMessage {
  type: 'transcribe'
  id: number
  audio: Float32Array
  /** The English name of the language in lower case, which is what the pipeline takes. */
  language: string
}

export type AsrRequest = AsrInitMessage | AsrTranscribeMessage

export type AsrResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }

let transcriber: AutomaticSpeechRecognitionPipeline | null = null

const post = (message: AsrResponse): void => self.postMessage(message)

/**
 * A compute program that doubles four fp16 values in a storage buffer, fp16 storage and arithmetic as the fp16
 * weights use them. An adapter can list shader-f16 and still fail to compile or run such a program.
 */
const FP16_PROGRAM = `enable f16;
@group(0) @binding(0) var<storage, read_write> values: array<f16, 4>;
@compute @workgroup_size(1)
fn main() {
  for (var i = 0u; i < 4u; i++) {
    values[i] = values[i] * 2.0h;
  }
}`
/** 1, 2, 3 and 4 in fp16, and what the program makes of them. */
const FP16_INPUT = new Uint16Array([0x3c00, 0x4000, 0x4200, 0x4400])
const FP16_DOUBLED = [0x4000, 0x4400, 0x4600, 0x4800]

/** WebGPU's GPUBufferUsage and GPUMapMode flags, which the DOM library of this TypeScript does not declare. */
const BUFFER_MAP_READ = 0x1
const BUFFER_COPY_SRC = 0x4
const BUFFER_COPY_DST = 0x8
const BUFFER_STORAGE = 0x80
const MAP_READ = 0x1

/** Whether the GPU compiles and runs FP16_PROGRAM and returns its result. */
async function runsFp16(adapter: GPUAdapter): Promise<boolean> {
  let device: GPUDevice | null = null
  try {
    device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] })
    device.pushErrorScope('validation')
    const program = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: FP16_PROGRAM }), entryPoint: 'main' }
    })
    const values = device.createBuffer({
      size: FP16_INPUT.byteLength,
      usage: BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST
    })
    const readBack = device.createBuffer({ size: FP16_INPUT.byteLength, usage: BUFFER_MAP_READ | BUFFER_COPY_DST })
    device.queue.writeBuffer(values, 0, FP16_INPUT)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(program)
    pass.setBindGroup(0, device.createBindGroup({ layout: program.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: values } }] }))
    pass.dispatchWorkgroups(1)
    pass.end()
    encoder.copyBufferToBuffer(values, 0, readBack, 0, FP16_INPUT.byteLength)
    device.queue.submit([encoder.finish()])
    await readBack.mapAsync(MAP_READ)
    const result = Array.from(new Uint16Array(readBack.getMappedRange()))
    readBack.unmap()
    const error = await device.popErrorScope()
    if (error) throw new Error(error.message)
    if (result.some((bits, i) => bits !== FP16_DOUBLED[i])) throw new Error(`wrong result ${result.join(',')}`)
    return true
  } catch (err) {
    console.warn('in-browser Whisper runs on WASM, as WebGPU did not run an fp16 program:', err)
    return false
  } finally {
    device?.destroy()
  }
}

/**
 * Chooses where the model runs before anything is fetched, from what this machine runs. transformers.js only
 * checks that the adapter lists shader-f16, and a GPU that fails the fp16 weights anyway, or a fall back to WASM
 * after a failed load, would cost a second fetch of the model, with no progress and inside the same time limit.
 */
async function chooseDevice(): Promise<{ device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'q8' }> {
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null
  const fp16 = adapter?.features.has('shader-f16') ? await runsFp16(adapter) : false
  return fp16 ? { device: 'webgpu', dtype: 'fp16' } : { device: 'wasm', dtype: 'q8' }
}

async function init(model: string, revision: string): Promise<void> {
  const { device, dtype } = await chooseDevice()
  transcriber = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    revision,
    progress_callback: (info: {
      status?: string
      file?: string
      loaded?: number
      total?: number
    }) => {
      // The per-file progress goes out untouched and AsrEngine adds it up. Several files
      // download at once, so passing each file's percentage straight through makes the
      // displayed number jump around.
      if (info.status === 'progress' && typeof info.loaded === 'number' && info.total) {
        post({ type: 'progress', file: info.file ?? '', loaded: info.loaded, total: info.total })
      }
    }
  })
  post({ type: 'ready', device })
}

async function transcribe(id: number, audio: Float32Array, language: string): Promise<void> {
  if (!transcriber) {
    post({ type: 'error', id, message: 'ASR engine not initialized' })
    return
  }
  const output = await transcriber(audio, { language, task: 'transcribe' })
  const text = (Array.isArray(output) ? output[0]?.text : output.text) ?? ''
  post({ type: 'result', id, text: text.trim() })
}

self.onmessage = (event: MessageEvent<AsrRequest>): void => {
  const message = event.data
  void (async () => {
    try {
      if (message.type === 'init') await init(message.model, message.revision)
      else if (message.type === 'transcribe') await transcribe(message.id, message.audio, message.language)
    } catch (err) {
      post({
        type: 'error',
        id: message.type === 'transcribe' ? message.id : undefined,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })()
}
