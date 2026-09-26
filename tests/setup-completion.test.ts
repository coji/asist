import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'

const t = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({
  settings: {
    safetyNoticeVersion: 1,
    ttsEngine: 'system',
    conversationModel: { provider: 'anthropic', id: 'claude-main' },
    bridgeModel: { provider: 'anthropic', id: 'claude-fast' }
  },
  saveSettings: vi.fn(),
  validateConfiguration: vi.fn(),
  configuredModels: vi.fn(() => [
    { label: t('llmModels.targets.conversationModel'), provider: 'anthropic', id: 'claude-main' },
    { label: t('llmModels.targets.bridgeModel'), provider: 'anthropic', id: 'claude-fast' }
  ]),
  asrAvailable: vi.fn(),
  asrEnsure: vi.fn(),
  ttsEnsure: vi.fn(),
  ttsAvailable: vi.fn(),
  engineLabel: vi.fn(() => 'macOS voice'),
  windows: false
}))

vi.mock('../src/main/services/settings', () => ({
  getSettings: () => mocks.settings,
  saveSettings: mocks.saveSettings
}))
vi.mock('../src/main/services/llm', () => ({
  validateConfiguration: mocks.validateConfiguration,
  configuredModels: mocks.configuredModels
}))
vi.mock('../src/main/services/asr', () => ({
  available: mocks.asrAvailable,
  ensureServer: mocks.asrEnsure
}))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('../src/main/services/tts', () => ({
  ensureEngine: mocks.ttsEnsure,
  available: mocks.ttsAvailable,
  engineLabel: mocks.engineLabel
}))

const previousKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.settings.ttsEngine = 'system'
  mocks.windows = false
  mocks.settings.safetyNoticeVersion = 1
  mocks.validateConfiguration.mockResolvedValue(undefined)
  mocks.asrAvailable.mockResolvedValue(false)
  mocks.asrEnsure.mockResolvedValue(true)
  mocks.ttsEnsure.mockResolvedValue(undefined)
  mocks.ttsAvailable.mockResolvedValue(true)
  mocks.saveSettings.mockImplementation((patch) => ({ ...mocks.settings, ...patch }))
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

afterEach(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousKey
})

describe('completeSetup', () => {
  it('neither validates nor persists while the risks have not been acknowledged', async () => {
    mocks.settings.safetyNoticeVersion = 0
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({ voiceMode: 'text', microphoneVerified: false, localAsrVerified: false, systemTtsVerified: true, micAutoStart: false })
    ).rejects.toThrow(errorText('setup.completion.safetyNotAcknowledged'))

    expect(mocks.validateConfiguration).not.toHaveBeenCalled()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('neither validates nor persists when the renderer has not verified the chosen ASR', async () => {
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({
        voiceMode: 'local',
        microphoneVerified: true,
        localAsrVerified: false,
        systemTtsVerified: true,
        micAutoStart: true
      })
    ).rejects.toThrow(errorText('setup.completion.localAsrNotReady'))

    expect(mocks.validateConfiguration).not.toHaveBeenCalled()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('does not save the onboarding state when the final API model validation fails', async () => {
    mocks.validateConfiguration.mockRejectedValue(new Error('model unavailable'))
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({
        voiceMode: 'text',
        microphoneVerified: false,
        localAsrVerified: false,
        systemTtsVerified: true,
        micAutoStart: true
      })
    ).rejects.toThrow('model unavailable')

    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('tries to restart the chosen server ASR when it is down and saves nothing when that fails', async () => {
    mocks.asrEnsure.mockResolvedValue(false)
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({
        voiceMode: 'server',
        microphoneVerified: true,
        localAsrVerified: false,
        systemTtsVerified: true,
        micAutoStart: true
      })
    ).rejects.toThrow(errorText('setup.completion.asrUnavailable'))

    expect(mocks.asrEnsure).toHaveBeenCalled()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('saves the completion once, and only after the API, the chosen ASR and TTS have all succeeded', async () => {
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({
        voiceMode: 'server',
        microphoneVerified: true,
        localAsrVerified: false,
        systemTtsVerified: true,
        micAutoStart: true
      })
    ).resolves.toMatchObject({ onboardingVersion: 1 })

    expect(mocks.validateConfiguration).toHaveBeenCalledWith(mocks.configuredModels.mock.results[0].value)
    expect(mocks.ttsAvailable).toHaveBeenCalledTimes(1)
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1)
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      onboardingVersion: 1,
      localAsrEnabled: false,
      micAutoStart: true
    })
  })

  it('does not auto-start the microphone in text-only mode', async () => {
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await completeSetup({
      voiceMode: 'text',
      microphoneVerified: false,
      localAsrVerified: false,
      systemTtsVerified: true,
      micAutoStart: true
    })

    expect(mocks.asrAvailable).not.toHaveBeenCalled()
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ localAsrEnabled: false, micAutoStart: false })
    )
  })

  it('neither starts nor checks a TTS engine when the user asked for nothing to be read aloud', async () => {
    mocks.settings.ttsEngine = 'none'
    mocks.ttsAvailable.mockResolvedValue(false)
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({ voiceMode: 'text', microphoneVerified: false, localAsrVerified: false, systemTtsVerified: true, micAutoStart: false })
    ).resolves.toMatchObject({ onboardingVersion: 1 })
    expect(mocks.ttsEnsure).not.toHaveBeenCalled()
  })

  it('does not complete when TTS is in use but the engine cannot be reached', async () => {
    mocks.settings.ttsEngine = 'voicevox'
    mocks.ttsAvailable.mockResolvedValue(false)
    const { completeSetup } = await import('../src/main/services/setup-completion')

    await expect(
      completeSetup({ voiceMode: 'text', microphoneVerified: false, localAsrVerified: false, systemTtsVerified: true, micAutoStart: false })
    ).rejects.toThrow(errorText('setup.completion.ttsUnavailable', { engine: 'macOS voice' }))
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('names the voice of the OS it runs on when that voice was not verified', async () => {
    const { completeSetup } = await import('../src/main/services/setup-completion')
    const request = { voiceMode: 'text', microphoneVerified: false, localAsrVerified: false, systemTtsVerified: false, micAutoStart: false }

    mocks.windows = true
    await expect(completeSetup(request)).rejects.toThrow(errorText('setup.completion.systemTtsUnavailable.windows'))
    mocks.windows = false
    await expect(completeSetup(request)).rejects.toThrow(errorText('setup.completion.systemTtsUnavailable.macos'))
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })
})
