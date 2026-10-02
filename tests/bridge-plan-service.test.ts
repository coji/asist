import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quickJson: vi.fn(),
  available: vi.fn(async () => true),
  synthesize: vi.fn(async () => ({ audio: 'YQ==', phonemes: null })),
  ttsEngine: 'aivisspeech',
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US'
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../src/main/services/llm', () => ({ quickJson: mocks.quickJson }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ ttsEngine: mocks.ttsEngine, aivisSpeaker: 1, conversationLocale: mocks.conversationLocale })
}))
vi.mock('../src/main/services/tts', () => ({
  available: mocks.available,
  resolveVoice: async () => ({ engine: 'aivisspeech', speaker: 1 }),
  synthesize: mocks.synthesize
}))

describe('bridge-plan', () => {
  it('validates the output of the fast model and throws when it does not have the expected shape', async () => {
    const { plan } = await import('../src/main/services/bridge-plan')
    mocks.quickJson.mockResolvedValueOnce({ bridge: '京都の天気ですね。' })
    await expect(plan({ text: '京都の天気', lastAssistantText: '' })).resolves.toEqual({ bridge: '京都の天気ですね。' })
    const [, user] = mocks.quickJson.mock.calls[0] as [string, string]
    expect(user).toContain('京都の天気')
    mocks.quickJson.mockResolvedValueOnce({ intent: 'maybe' })
    await expect(plan({ text: '京都の天気', lastAssistantText: '' })).rejects.toThrow()
  })

  it('puts only the end of a long previous line in the prompt, never half a character', async () => {
    const { plan } = await import('../src/main/services/bridge-plan')
    // An emoji is two UTF-16 units. Of these two alignments, a cut counted in units splits one of them
    // wherever it falls, and a strict JSON parser refuses the lone half (Anthropic answers 400).
    for (const line of ['😀'.repeat(50_000), `${'😀'.repeat(50_000)}あ`]) {
      mocks.quickJson.mockResolvedValueOnce({ bridge: '' })
      await plan({ text: '明日の天気は', lastAssistantText: line })
      const [, user] = mocks.quickJson.mock.calls.at(-1) as [string, string]
      expect(user.isWellFormed()).toBe(true)
      expect(user).toContain(line.slice(-5))
      expect(user.length).toBeLessThan(line.length)
    }
  })

  it('strips quotation marks and whitespace from the bridge and rejects a bridge that is too long', async () => {
    const { parseBridgePlan } = await import('../src/main/services/bridge-plan')
    expect(parseBridgePlan('ja-JP', { bridge: '「徹夜か早起きか、ですよね。」' })).toEqual({ bridge: '徹夜か早起きか、ですよね。' })
    expect(parseBridgePlan('ja-JP', { bridge: '' })).toEqual({ bridge: '' })
    expect(() => parseBridgePlan('ja-JP', { bridge: 'あ'.repeat(21) })).toThrow()
    expect(() => parseBridgePlan('ja-JP', {})).toThrow()
  })

  it('measures the bridge without the brackets it is wrapped in, since they are not spoken', async () => {
    const { parseBridgePlan } = await import('../src/main/services/bridge-plan')
    const line = 'あ'.repeat(20)
    expect(parseBridgePlan('ja-JP', { bridge: `「${line}」` })).toEqual({ bridge: line })
    expect(() => parseBridgePlan('ja-JP', { bridge: `「${line}あ」` })).toThrow()
  })

  it('caps the bridge in words outside Japanese, where the same number of characters would run far longer', async () => {
    const { parseBridgePlan } = await import('../src/main/services/bridge-plan')
    // Twenty-one Japanese characters are too long; the same length in English words is not.
    expect(parseBridgePlan('en-US', { bridge: '"Stay up or get up early, then."' })).toEqual({
      bridge: 'Stay up or get up early, then.'
    })
    expect(() => parseBridgePlan('en-US', { bridge: 'one two three four five six seven eight nine' })).toThrow()
  })

  it('synthesizes the bridge with the same leading silence as an aizuchi, and returns it without audio when TTS is unavailable', async () => {
    const { bridge } = await import('../src/main/services/bridge-plan')
    await expect(bridge('会議の件ですね。')).resolves.toEqual({ text: '会議の件ですね。', audio: 'YQ==' })
    const prosody = mocks.synthesize.mock.calls[0][2] as { prePhonemeLength?: number }
    expect(prosody.prePhonemeLength).toBe(0)
    mocks.available.mockResolvedValueOnce(false)
    await expect(bridge('会議の件ですね。')).resolves.toEqual({ text: '会議の件ですね。', audio: null })
  })
})
