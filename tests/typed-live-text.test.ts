import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { LIVE_TEXT_MAX_LENGTH } from '@shared/voice-engine'

const mocks = vi.hoisted(() => ({
  turn: { setPhase: vi.fn() },
  feed: { append: vi.fn(() => 1) },
  toast: { push: vi.fn() }
}))

vi.mock('@/voice/VoiceController', () => ({
  voiceController: { current: 'off', msSinceBackchannel: Infinity, events: { on: vi.fn() } }
}))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { interrupt: vi.fn(), isPlaying: false } }))
vi.mock('@/voice/aizuchi-bank', () => ({ loadAizuchiBank: vi.fn(), pickAizuchi: vi.fn(() => null), pickListeningClip: vi.fn(() => null) }))
vi.mock('@/state/stores', () => ({
  useTurnStore: { getState: () => mocks.turn },
  useFeedStore: { getState: () => mocks.feed },
  useJobStore: { getState: () => ({}) },
  usePanelStore: { getState: () => ({ dismissLoadingOwnedBy: vi.fn() }) },
  useSettingsStore: { getState: () => ({ settings: { voiceEngine: 'gpt-live', uiLocale: 'ja-JP' } }) },
  useStatusStore: { getState: () => ({}) },
  useToastStore: { getState: () => mocks.toast }
}))

describe('typed text in live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { liveText: vi.fn(async () => {}) } })
  })

  it('refuses text over the limit with the reason, sending nothing and adding nothing to the feed', async () => {
    const { sendTypedMessage, typedTextFits } = await import('../src/renderer/src/conversation')
    const tooLong = 'あ'.repeat(LIVE_TEXT_MAX_LENGTH + 1)
    expect(typedTextFits(tooLong)).toBe(false)
    await sendTypedMessage(tooLong)
    expect(window.api.liveText).not.toHaveBeenCalled()
    expect(mocks.feed.append).not.toHaveBeenCalled()
    const t = createTranslator('ja-JP')
    expect(mocks.toast.push).toHaveBeenLastCalledWith(expect.objectContaining({ body: t('voice.live.textTooLong', { max: LIVE_TEXT_MAX_LENGTH }) }))
  })

  it('sends text at the limit whole', async () => {
    const { sendTypedMessage, typedTextFits } = await import('../src/renderer/src/conversation')
    const longest = 'あ'.repeat(LIVE_TEXT_MAX_LENGTH)
    expect(typedTextFits(longest)).toBe(true)
    await sendTypedMessage(longest)
    expect(window.api.liveText).toHaveBeenCalledWith(longest)
    expect(mocks.toast.push).not.toHaveBeenCalled()
  })
})
