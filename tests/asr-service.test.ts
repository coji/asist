import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

const mocks = vi.hoisted(() => ({
  settings: { asrModel: 'qwen3-asr-1.7b-mlx', uiLocale: 'ja-JP' },
  localAvailable: vi.fn(),
  localEnsure: vi.fn(),
  localTranscribe: vi.fn(),
  localPartial: vi.fn(),
  localStop: vi.fn(),
  localPrepare: vi.fn()
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
  installationStatus: vi.fn(() => ({ runtimeInstalled: true, modelInstalled: true }))
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.asrModel = 'qwen3-asr-1.7b-mlx'
})

describe('ASR service routing', () => {
  it('starts and transcribes through the selected local model', async () => {
    const asr = await import('../src/main/services/asr')
    const samples = new Float32Array([0.1])
    mocks.localEnsure.mockResolvedValue(true)
    mocks.localTranscribe.mockResolvedValue('音声認識のテストです。')

    await expect(asr.ensureServer()).resolves.toBe(true)
    await expect(asr.transcribe(samples, 'request-1')).resolves.toBe('音声認識のテストです。')

    expect(mocks.localEnsure).toHaveBeenCalledWith('qwen3-asr-1.7b-mlx')
    expect(mocks.localTranscribe).toHaveBeenCalledWith('qwen3-asr-1.7b-mlx', samples, 'request-1')
  })

  it('stops the running worker before starting the newly selected model', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.settings.asrModel = 'whisper-large-v3-turbo-mlx'
    mocks.localEnsure.mockResolvedValue(true)

    await expect(asr.switchModel()).resolves.toBe(true)

    expect(mocks.localEnsure).toHaveBeenCalledWith('whisper-large-v3-turbo-mlx')
    expect(mocks.localStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.localEnsure.mock.invocationCallOrder[0])
  })

  it('prepares nothing for a model id it does not know', async () => {
    const asr = await import('../src/main/services/asr')

    const result = await asr.prepareModel('no-such-model' as never, vi.fn())

    expect(result.ok).toBe(false)
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})

describe('a machine without a runtime for the local speech recognition', () => {
  beforeEach(() => setCapabilities(WINDOWS))
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
    await expect(asr.transcribe(new Float32Array([0.1]))).rejects.toThrow(errorText('speechRecognition.unavailable.unsupportedOs'))
    expect((await asr.prepareModel('auto', vi.fn())).ok).toBe(false)
    expect(mocks.localTranscribe).not.toHaveBeenCalled()
    expect(mocks.localPrepare).not.toHaveBeenCalled()
  })
})
