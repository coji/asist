import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { ASR_MODEL_NAMES, asrModelSpec } from '@shared/asr-models'
import { nvidiaGpuSupport } from '@shared/nvidia-gpu'
import { deriveCapabilities } from '@shared/platform'
import { MACOS, WINDOWS, WINDOWS_WITHOUT_GPU, setCapabilities } from './helpers/platform'

const mocks = vi.hoisted(() => ({
  settings: { asrModel: 'qwen3-asr-1.7b', uiLocale: 'ja-JP' },
  localAvailable: vi.fn(),
  localEnsure: vi.fn(),
  localTranscribe: vi.fn(),
  localPartial: vi.fn(),
  localStop: vi.fn(),
  localPrepare: vi.fn(),
  installed: { runtimeInstalled: true, modelInstalled: true }
}))

vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({ app: { getPath: vi.fn(), on: vi.fn() } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/local-asr', () => ({
  available: mocks.localAvailable,
  ensureServer: mocks.localEnsure,
  transcribe: mocks.localTranscribe,
  transcribePartial: mocks.localPartial,
  cancelTranscription: vi.fn(() => false),
  stop: mocks.localStop,
  prepare: mocks.localPrepare,
  cancelPreparation: vi.fn(),
  installationStatus: vi.fn(() => mocks.installed)
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.asrModel = 'qwen3-asr-1.7b'
  mocks.installed = { runtimeInstalled: true, modelInstalled: true }
})

describe('ASR service routing', () => {
  it('starts and transcribes through the selected local model', async () => {
    const asr = await import('../src/main/services/asr')
    const samples = new Float32Array([0.1])
    mocks.localEnsure.mockResolvedValue(true)
    mocks.localTranscribe.mockResolvedValue('音声認識のテストです。')

    await expect(asr.ensureServer()).resolves.toBe(true)
    await expect(asr.transcribe(samples, 'request-1')).resolves.toBe('音声認識のテストです。')

    expect(mocks.localEnsure).toHaveBeenCalledWith(asrModelSpec('mlx', 'qwen3-asr-1.7b'))
    expect(mocks.localTranscribe).toHaveBeenCalledWith(asrModelSpec('mlx', 'qwen3-asr-1.7b'), samples, 'request-1')
  })

  it('stops the running worker before starting the newly selected model', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.settings.asrModel = 'whisper-large-v3-turbo'
    mocks.localEnsure.mockResolvedValue(true)

    await expect(asr.switchModel()).resolves.toBe(true)

    expect(mocks.localEnsure).toHaveBeenCalledWith(asrModelSpec('mlx', 'whisper-large-v3-turbo'))
    expect(mocks.localStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.localEnsure.mock.invocationCallOrder[0])
  })

  it('prepares nothing for a model id it does not know', async () => {
    const asr = await import('../src/main/services/asr')

    const result = await asr.prepareModel('no-such-model' as never, vi.fn())

    expect(result.ok).toBe(false)
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})

describe('a selected model the runtime does not offer', () => {
  beforeEach(() => {
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
  })

  it('is reported under its own name as not ready rather than replaced by another model', async () => {
    const asr = await import('../src/main/services/asr')
    const status = await asr.installationStatus()
    expect(status).toMatchObject({ selectedModel: 'qwen3-asr-0.6b', resolvedModel: 'qwen3-asr-0.6b', label: ASR_MODEL_NAMES['qwen3-asr-0.6b'], ready: false })
    await expect(asr.ensureServer()).resolves.toBe(false)
    await expect(asr.available()).resolves.toBe(false)
    expect(mocks.localEnsure).not.toHaveBeenCalled()
  })

  it('refuses a transcription and a preparation, asking for another model', async () => {
    const asr = await import('../src/main/services/asr')
    await expect(asr.transcribe(new Float32Array([0.1]))).rejects.toThrow(errorText('speechRecognition.errors.unknownModel'))
    expect((await asr.prepareModel('qwen3-asr-0.6b', vi.fn())).ok).toBe(false)
    expect(mocks.localTranscribe).not.toHaveBeenCalled()
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })

  it('resolves auto to a model the runtime offers', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.localPrepare.mockResolvedValue({ ok: true, message: '' })
    await asr.prepareModel('auto', vi.fn())
    expect(mocks.localPrepare).toHaveBeenCalledWith(asrModelSpec('mlx', 'qwen3-asr-1.7b'), expect.any(Function))
  })
})

describe('Windows with an NVIDIA GPU the CUDA runtime runs on', () => {
  beforeEach(() => {
    setCapabilities(WINDOWS)
    mocks.settings.asrModel = 'auto'
  })
  afterEach(() => setCapabilities(MACOS))

  it('recommends Qwen3-ASR 1.7B on CUDA for the 8 GB of the GPU, and counts the torch environment and the model it has to download', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.installed = { runtimeInstalled: false, modelInstalled: false }
    const status = await asr.installationStatus()
    expect(status).toMatchObject({
      resolvedModel: 'qwen3-asr-1.7b',
      recommendedModel: 'qwen3-asr-1.7b',
      label: asrModelSpec('cuda', 'qwen3-asr-1.7b')!.label,
      totalMemoryGb: 8
    })
    expect(status!.downloadGb).toBeCloseTo(6.13)
    mocks.installed = { runtimeInstalled: true, modelInstalled: false }
    expect((await asr.installationStatus())!.downloadGb).toBeCloseTo(asrModelSpec('cuda', 'qwen3-asr-1.7b')!.downloadGb)
    mocks.installed = { runtimeInstalled: true, modelInstalled: true }
    expect((await asr.installationStatus())!.downloadGb).toBe(0)
  })

  it('prepares and starts the CUDA build of the model auto stands for', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.localPrepare.mockResolvedValue({ ok: true, message: '' })
    mocks.localEnsure.mockResolvedValue(true)
    await asr.prepareModel('auto', vi.fn())
    await asr.ensureServer()
    expect(mocks.localPrepare).toHaveBeenCalledWith(asrModelSpec('cuda', 'qwen3-asr-1.7b'), expect.any(Function))
    expect(mocks.localEnsure).toHaveBeenCalledWith(asrModelSpec('cuda', 'qwen3-asr-1.7b'))
  })

  it('recommends Qwen3-ASR 0.6B on a 4 GB GPU, where 1.7B does not fit', async () => {
    setCapabilities(deriveCapabilities({
      platform: 'win32',
      arch: 'x64',
      totalMemoryBytes: 16 * 1024 ** 3,
      nvidiaGpu: () => nvidiaGpuSupport('NVIDIA GeForce GTX 1650, 4096, 581.57, 7.5')
    }))
    const asr = await import('../src/main/services/asr')
    expect(await asr.installationStatus()).toMatchObject({ resolvedModel: 'qwen3-asr-0.6b', label: asrModelSpec('cuda', 'qwen3-asr-0.6b')!.label, totalMemoryGb: 4 })
  })

  it('reports Whisper brought from a Mac under its own name, and never prepares it on CUDA', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.settings.asrModel = 'whisper-large-v3-turbo'
    expect(await asr.installationStatus()).toMatchObject({ resolvedModel: 'whisper-large-v3-turbo', label: ASR_MODEL_NAMES['whisper-large-v3-turbo'], downloadGb: 0, ready: false })
    expect((await asr.prepareModel('whisper-large-v3-turbo', vi.fn())).ok).toBe(false)
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})

describe('a machine without a runtime for the local speech recognition', () => {
  beforeEach(() => setCapabilities(WINDOWS_WITHOUT_GPU))
  afterEach(() => setCapabilities(MACOS))

  it('reports no model and never starts a worker', async () => {
    const asr = await import('../src/main/services/asr')
    await expect(asr.installationStatus()).resolves.toBeNull()
    await expect(asr.ensureServer()).resolves.toBe(false)
    await expect(asr.available()).resolves.toBe(false)
    expect(mocks.localEnsure).not.toHaveBeenCalled()
  })

  it('refuses a transcription and a preparation with the reason', async () => {
    const asr = await import('../src/main/services/asr')
    await expect(asr.transcribe(new Float32Array([0.1]))).rejects.toThrow(errorText('speechRecognition.unavailable.noNvidiaGpu'))
    expect((await asr.prepareModel('auto', vi.fn())).ok).toBe(false)
    expect(mocks.localTranscribe).not.toHaveBeenCalled()
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})
