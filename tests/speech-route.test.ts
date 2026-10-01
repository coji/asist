import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ settings: { ttsEngine: 'voicevox' }, synthesize: vi.fn() }))

vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/tts', () => ({
  synthesizeSentence: mocks.synthesize,
  nextRequest: (waiting: readonly string[]) => ({ text: waiting[0], count: 1 })
}))
vi.mock('../src/main/services/store', () => ({ dataPath: (name: string) => `/tmp/asist-test/${name}` }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.settings.ttsEngine = 'voicevox'
})

describe('speech route selection', () => {
  it('neither synthesizes the sentence nor emits a segment when reading aloud is off, so the reply arrives as text only', async () => {
    mocks.settings.ttsEngine = 'none'
    const { currentSpeechRoute } = await import('../src/main/services/brain/session')
    const emit = vi.fn()
    const sink = currentSpeechRoute().open({ turnId: 1, signal: new AbortController().signal, emit, locale: 'ja-JP' })
    sink.push('こんにちは。')
    await sink.drain()
    expect(mocks.synthesize).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('synthesizes the sentence and emits a segment when TTS is in use', async () => {
    mocks.synthesize.mockResolvedValue({ kind: 'whole', audio: 'AAAA', phonemes: null })
    const { currentSpeechRoute } = await import('../src/main/services/brain/session')
    const emit = vi.fn()
    const sink = currentSpeechRoute().open({ turnId: 1, signal: new AbortController().signal, emit, locale: 'ja-JP' })
    sink.push('こんにちは。')
    await sink.drain()
    expect(mocks.synthesize).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'segment' }))
  })
})
