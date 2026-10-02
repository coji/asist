import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { ASR_MODEL_SPECS, asrDownloadGb } from '@shared/asr-models'
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
  installed: { modelInstalled: true }
}))

vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({ app: { getPath: vi.fn(), on: vi.fn() } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/llama-asr', () => ({
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

const LARGE = ASR_MODEL_SPECS['qwen3-asr-1.7b']
const SMALL = ASR_MODEL_SPECS['qwen3-asr-0.6b']

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.asrModel = 'qwen3-asr-1.7b'
  mocks.installed = { modelInstalled: true }
})

describe('ASR service routing', () => {
  it('starts and transcribes through the selected model', async () => {
    const asr = await import('../src/main/services/asr')
    const samples = new Float32Array([0.1])
    mocks.localEnsure.mockResolvedValue(true)
    mocks.localTranscribe.mockResolvedValue('音声認識のテストです。')

    await expect(asr.ensureServer()).resolves.toBe(true)
    await expect(asr.transcribe(samples, 'request-1')).resolves.toBe('音声認識のテストです。')

    expect(mocks.localEnsure).toHaveBeenCalledWith(LARGE)
    expect(mocks.localTranscribe).toHaveBeenCalledWith(LARGE, samples, 'request-1')
  })

  it('stops the running server before starting the newly selected model', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    mocks.localEnsure.mockResolvedValue(true)

    await expect(asr.switchModel('qwen3-asr-1.7b')).resolves.toBe(true)
    expect(mocks.localEnsure).toHaveBeenCalledWith(SMALL)
    expect(mocks.localStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.localEnsure.mock.invocationCallOrder[0])
  })

  it('prepares nothing for a model id it does not know', async () => {
    const asr = await import('../src/main/services/asr')

    const result = await asr.prepareModel('no-such-model' as never, vi.fn())

    expect(result.ok).toBe(false)
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})

describe('Windows with a discrete GPU', () => {
  beforeEach(() => {
    setCapabilities(WINDOWS)
    mocks.settings.asrModel = 'auto'
  })
  afterEach(() => setCapabilities(MACOS))

  it('recommends Qwen3-ASR 1.7B for the 8 GB of the GPU, and counts the files it has to download', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.installed = { modelInstalled: false }
    expect(await asr.installationStatus()).toMatchObject({
      resolvedModel: 'qwen3-asr-1.7b',
      recommendedModel: 'qwen3-asr-1.7b',
      label: LARGE.label,
      totalMemoryGb: 8,
      downloadGb: asrDownloadGb(LARGE, false)
    })
    mocks.installed = { modelInstalled: true }
    expect((await asr.installationStatus())!.downloadGb).toBe(0)
  })

  it('prepares and starts the model auto stands for', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.localPrepare.mockResolvedValue({ ok: true, message: '' })
    mocks.localEnsure.mockResolvedValue(true)
    await asr.prepareModel('auto', vi.fn())
    await asr.ensureServer()
    expect(mocks.localPrepare.mock.calls[0][0]).toBe(LARGE)
    expect(mocks.localEnsure).toHaveBeenCalledWith(LARGE)
  })

  it('recommends Qwen3-ASR 0.6B on a 4 GB GPU, where 1.7B does not fit beside the desktop', async () => {
    setCapabilities(deriveCapabilities({
      platform: 'win32',
      arch: 'x64',
      totalMemoryBytes: 16 * 1024 ** 3,
      speechDevices: () => [{ name: 'Vulkan0', description: 'NVIDIA GeForce GTX 1650', kind: 'gpu', memoryTotal: 4 * 1024 ** 3 }],
      micCancelsEcho: () => false
    }))
    const asr = await import('../src/main/services/asr')
    expect(await asr.installationStatus()).toMatchObject({ resolvedModel: 'qwen3-asr-0.6b', label: SMALL.label, totalMemoryGb: 4 })
  })
})

describe('a machine without a GPU for the local speech recognition', () => {
  beforeEach(() => setCapabilities(WINDOWS_WITHOUT_GPU))
  afterEach(() => setCapabilities(MACOS))

  it('reports no model and never starts a server', async () => {
    const asr = await import('../src/main/services/asr')
    await expect(asr.installationStatus()).resolves.toBeNull()
    await expect(asr.ensureServer()).resolves.toBe(false)
    await expect(asr.available()).resolves.toBe(false)
    expect(mocks.localEnsure).not.toHaveBeenCalled()
  })

  it('refuses a transcription and a preparation with the reason', async () => {
    const asr = await import('../src/main/services/asr')
    await expect(asr.transcribe(new Float32Array([0.1]))).rejects.toThrow(errorText('speechRecognition.unavailable.noDiscreteGpu'))
    expect((await asr.prepareModel('auto', vi.fn())).ok).toBe(false)
    expect(mocks.localTranscribe).not.toHaveBeenCalled()
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})
