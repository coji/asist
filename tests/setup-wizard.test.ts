// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, AppStatus, PreparationProgress, SetupStatus } from '@shared/ipc'
import { createTranslator, type Translate, type UiLocale } from '@shared/i18n'
import { SetupWizard } from '../src/renderer/src/ui/SetupWizard'
import { useSettingsStore, useStatusStore } from '../src/renderer/src/state/stores'
import { voiceController } from '../src/renderer/src/voice/VoiceController'
import { liveVoice } from '../src/renderer/src/voice/LiveVoice'
import { asrDownloadGb, asrModelSpec, recommendAsrModel } from '@shared/asr-models'
import { isLiveEngine } from '@shared/voice-engine'
import { defaultPersona } from '@shared/persona'
import { MACOS, WINDOWS, WINDOWS_WITHOUT_GPU, platformCapabilities, setCapabilities } from './helpers/platform'

// The voice modules build an AudioContext at import time, so they are replaced for a test that only renders the UI.
vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/voice/VoiceController', () => ({
  voiceController: { prepareLocalAsr: vi.fn(async () => 'ok'), cancelLocalAsrPreparation: vi.fn(), enable: vi.fn() }
}))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { playClip: vi.fn() } }))
vi.mock('@/voice/LiveVoice', () => ({ liveVoice: { enable: vi.fn(), current: 'off' } }))
vi.mock('@/voice/microphone-access', () => ({ verifyMicrophoneCapture: vi.fn(async () => {}), microphoneCaptureErrorMessage: (err: unknown) => String(err) }))

/** First-run setup: the provider choice decides the pair of models, the voice mode skips steps, and what completion hands to main. */

let settings: AppSettings
let status: AppStatus
const ja = createTranslator('ja-JP')
const verifiedKeys = new Set<string>()
let progressListener: (progress: PreparationProgress) => void = () => {}

/**
 * The local speech recognition as main reports it before anything is downloaded: none on a machine without
 * a GPU for it, and otherwise the model it recommends for the memory it has.
 */
const asrStatus = (): SetupStatus['asr'] => {
  const { localSpeech } = platformCapabilities()
  if (localSpeech.backend === null) return null
  const { recommendedModel } = recommendAsrModel(localSpeech.backend, localSpeech.memoryGb)
  const spec = asrModelSpec(recommendedModel)
  return {
    selectedModel: 'auto',
    resolvedModel: recommendedModel,
    recommendedModel,
    label: spec.label,
    totalMemoryGb: localSpeech.memoryGb,
    modelInstalled: false,
    downloadGb: asrDownloadGb(spec, false),
    ready: false
  }
}

const setupStatus = (): SetupStatus =>
  ({
    services: status,
    asr: asrStatus()
  }) as SetupStatus

const api = {
  getSetupStatus: vi.fn(async () => setupStatus()),
  saveApiKey: vi.fn(async (provider: string) => {
    verifiedKeys.add(provider)
    status = { ...status, llmKeys: { ...status.llmKeys, [provider]: 'verified' } }
    return status
  }),
  // As in main, the key already held for the provider is checked against the API and then reads as verified.
  verifySavedApiKey: vi.fn(async (provider: string) => {
    status = { ...status, llmKeys: { ...status.llmKeys, [provider]: 'verified' } }
    return status
  }),
  saveSettings: vi.fn(async (patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch }
    if (patch.conversationModel) status = { ...status, llm: verifiedKeys.has(patch.conversationModel.provider) }
    // As in main, the macOS speech synthesis is available without any preparation, while a separate
    // engine counts as unavailable until it answers.
    if (patch.ttsEngine) status = { ...status, ttsEngine: patch.ttsEngine, tts: patch.ttsEngine === 'system' }
    return settings
  }),
  // As in main, the microphone at launch is kept only for a way of talking that listens, and a live
  // engine handed over as the voice mode becomes the voice engine.
  completeSetup: vi.fn(async (request: { voiceMode: string; micAutoStart: boolean }) => ({
    ...settings,
    onboardingVersion: 1,
    voiceEngine: isLiveEngine(request.voiceMode) ? request.voiceMode : 'cascade',
    micAutoStart: request.voiceMode !== 'text' && request.micAutoStart
  })),
  onSetupProgress: vi.fn((listener: (progress: PreparationProgress) => void) => {
    progressListener = listener
    return () => {}
  }),
  prepareTtsModel: vi.fn(() => new Promise<{ ok: boolean; message: string }>(() => {})),
  cancelTtsPreparation: vi.fn(async () => true),
  embeddingStatus: vi.fn(async () => ({ runtimeInstalled: true, modelInstalled: true, running: false, enabled: false, embedded: 0, total: 0, model: 'multilingual-e5-small' })),
  embeddingPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  aizuchiClassifierStatus: vi.fn(async () => ({ runtimeInstalled: true, modelInstalled: true, running: false })),
  aizuchiClassifierPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  vapStatus: vi.fn(async () => ({ runtimeInstalled: true, modelsInstalled: true, running: false })),
  vapPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  vapStop: vi.fn(async () => {}),
  ttsTest: vi.fn(async () => ({ audio: new ArrayBuffer(0), text: '' })),
  requestMicPermission: vi.fn(async () => true),
  openExternal: vi.fn(async () => {})
}

let container: HTMLDivElement
let root: Root

const flush = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(text))
  if (!found) throw new Error(`ボタンがありません: ${text}`)
  return found
}
const press = async (text: string): Promise<void> => {
  await act(async () => button(text).click())
  await flush()
}
const optionTitles = (): string[] => [...container.querySelectorAll('.su-option-title')].map((el) => el.textContent ?? '')
const extraNames = (): string[] => [...container.querySelectorAll('.su-extra-name')].map((el) => el.firstChild?.textContent ?? '')
/** Chooses a language on the first screen. The rest of the setup is shown and configured in it. */
const chooseLanguage = async (locale: UiLocale): Promise<void> => {
  await act(async () => container.querySelector<HTMLButtonElement>(`.su-language[data-locale="${locale}"]`)!.click())
  await flush()
}
/** Ticks the box under the risks, which the next button of that screen waits for. */
const tickRisks = async (): Promise<void> => {
  await act(async () => container.querySelector<HTMLInputElement>('.su-ack input')!.click())
  await flush()
}
/** Leaves the language screen and acknowledges the risks, which brings the model screen up. */
const toModel = async (t: Translate): Promise<void> => {
  await press(t('setup.next'))
  await tickRisks()
  await press(t('setup.next'))
}
/** Types a key on the model screen and verifies it, which every later screen depends on. */
const verifyKey = async (t: Translate): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>('#su-key')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  api.saveApiKey.mockImplementationOnce(async (provider: string) => {
    verifiedKeys.add(provider)
    status = { ...status, llm: true, llmKeys: { ...status.llmKeys, anthropic: 'verified' } }
    return status
  })
  await press(t('setup.model.verifyAndSave'))
}
const stepStates = (): Record<string, string | undefined> =>
  Object.fromEntries([...container.querySelectorAll<HTMLElement>('.su-steps li')].map((li) => [li.textContent?.replace(/^\d/, '') ?? '', li.dataset.state]))

beforeEach(async () => {
  verifiedKeys.clear()
  settings = {
    onboardingVersion: 0,
    safetyNoticeVersion: 0,
    uiLocale: 'ja-JP',
    conversationLocale: 'ja-JP',
    region: 'JP',
    conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
    bridgeModel: { provider: 'anthropic', id: 'claude-haiku-4-5' },
    ttsEngine: 'voicevox',
    qwenTtsSize: '0.6b',
    asrModel: 'auto',
    micAutoStart: false,
    localAsrEnabled: false,
    geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' }
  } as unknown as AppSettings
  status = {
    llm: false,
    conversationModel: settings.conversationModel,
    llmKeys: { anthropic: 'missing', openai: 'missing', google: 'missing', cerebras: 'missing' },
    tts: false,
    ttsStarting: false,
    ttsEngine: 'voicevox',
    ttsLabel: 'VOICEVOX',
    asr: false,
    asrInstalled: false,
    agent: 'missing',
    agentEngine: 'codex',
    voiceEngine: 'cascade',
    live: 'off'
  }
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  vi.mocked(voiceController.enable).mockClear()
  vi.mocked(liveVoice.enable).mockClear()
  useSettingsStore.setState({ settings })
  useStatusStore.setState({ status })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

/** Mounts the wizard. A test that needs another starting state changes `settings` or `status` first. */
const render = async (): Promise<void> => {
  useSettingsStore.setState({ settings })
  useStatusStore.setState({ status })
  await act(async () => root.render(React.createElement(SetupWizard)))
  await flush()
}

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('first-run setup', () => {
  it('opens on the language screen and saves the interface language, the conversation language and the region in one choice', async () => {
    await render()
    expect(container.querySelector('h1')?.textContent).toBe(createTranslator('ja-JP')('setup.steps.language.title'))
    await chooseLanguage('en-US')
    // The speech engine moves to the one the language starts with: Qwen3-TTS for English on this 32 GB Mac.
    expect(api.saveSettings).toHaveBeenCalledWith({ uiLocale: 'en-US', conversationLocale: 'en-US', region: 'US', ttsEngine: 'qwen3tts' })
    expect(container.querySelector('h1')?.textContent).toBe(createTranslator('en-US')('setup.steps.language.title'))

    await chooseLanguage('ja-JP')
    expect(api.saveSettings).toHaveBeenLastCalledWith({ uiLocale: 'ja-JP', conversationLocale: 'ja-JP', region: 'JP', ttsEngine: 'irodori' })

    // Choosing the same language again leaves an engine picked since then as it is.
    await chooseLanguage('ja-JP')
    expect(api.saveSettings).toHaveBeenLastCalledWith({ uiLocale: 'ja-JP', conversationLocale: 'ja-JP', region: 'JP' })
  })

  it('gives the conversation the persona of the chosen language, which main wrote in the language of the system', async () => {
    settings = { ...settings, uiLocale: 'en-US', conversationLocale: 'en-US', region: 'US', persona: defaultPersona('en-US') }
    await render()
    await chooseLanguage('ja-JP')
    expect(settings).toMatchObject({ conversationLocale: 'ja-JP', persona: defaultPersona('ja-JP') })
    await chooseLanguage('de-DE')
    expect(settings).toMatchObject({ conversationLocale: 'de-DE', persona: defaultPersona('de-DE') })
  })

  it('leaves a persona the user wrote as it is when the language changes', async () => {
    settings = { ...settings, persona: '名前は ミナ。短く答える。' }
    await render()
    await chooseLanguage('en-US')
    expect(settings).toMatchObject({ conversationLocale: 'en-US', persona: '名前は ミナ。短く答える。' })
  })

  it('keeps the next button of the risks disabled until the box is ticked, and saves the acknowledgement', async () => {
    await render()
    await press(ja('setup.next'))
    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.safety.title'))
    expect(button(ja('setup.next')).disabled).toBe(true)

    await tickRisks()
    expect(api.saveSettings).toHaveBeenLastCalledWith({ safetyNoticeVersion: 1 })
    expect(button(ja('setup.next')).disabled).toBe(false)

    // Clearing the box withdraws the acknowledgement, and the step waits again.
    await tickRisks()
    expect(api.saveSettings).toHaveBeenLastCalledWith({ safetyNoticeVersion: 0 })
    expect(button(ja('setup.next')).disabled).toBe(true)
  })

  it('offers Irodori-TTS first, VOICEVOX, AivisSpeech, the backchannel classifier and MaAI for a Japanese conversation', async () => {
    status = { ...status, asr: true }
    await render()
    const t = createTranslator('ja-JP')
    await toModel(t)
    await verifyKey(t)
    await press(t('setup.next'))
    await press(t('setup.speaking.voice.title'))
    await press(t('setup.next'))
    await press(t('setup.next'))
    expect(optionTitles()).toEqual(['Irodori-TTS', 'Qwen3-TTS', t('settings.ttsEngine.system.macos'), 'VOICEVOX', 'AivisSpeech'])

    // VOICEVOX is not running in this test, so the macOS voice carries the walk to the last screens.
    await press(t('settings.ttsEngine.system.macos'))
    await press(t('setup.next'))
    await press(t('setup.mic.check'))
    await press(t('setup.next'))
    expect(extraNames()).toEqual([t('setup.extras.models.embedding.label'), t('setup.extras.models.modernbert.label'), t('setup.extras.models.maai.label')])
  })

  it('prepares MaAI with the other extras but leaves it off, while the semantic search it prepared is turned on', async () => {
    status = { ...status, asr: true }
    await render()
    const t = createTranslator('ja-JP')
    await toModel(t)
    await verifyKey(t)
    await press(t('setup.next'))
    await press(t('setup.speaking.voice.title'))
    await press(t('setup.next'))
    await press(t('setup.next'))
    await press(t('settings.ttsEngine.system.macos'))
    await press(t('setup.next'))
    await press(t('setup.mic.check'))
    await press(t('setup.next'))
    // The next button opens once every extra has been prepared and, where it applies, turned on.
    await vi.waitFor(() => expect(button(t('setup.next')).disabled).toBe(false))
    expect(api.vapStatus).toHaveBeenCalled()
    expect(api.saveSettings).toHaveBeenCalledWith({ memoryEmbeddingEnabled: true })
    expect(api.saveSettings.mock.calls.some(([patch]) => 'vapEnabled' in patch)).toBe(false)
  })

  it('unloads the MaAI worker its preparation loaded to check, since the setup leaves MaAI off', async () => {
    status = { ...status, asr: true }
    api.vapStatus.mockResolvedValueOnce({ runtimeInstalled: false, modelsInstalled: false, running: false })
    await render()
    const t = createTranslator('ja-JP')
    await toModel(t)
    await verifyKey(t)
    await press(t('setup.next'))
    await press(t('setup.speaking.voice.title'))
    await press(t('setup.next'))
    await press(t('setup.next'))
    await press(t('settings.ttsEngine.system.macos'))
    await press(t('setup.next'))
    await press(t('setup.mic.check'))
    await press(t('setup.next'))
    await vi.waitFor(() => expect(button(t('setup.next')).disabled).toBe(false))
    expect(api.vapPrepare).toHaveBeenCalled()
    expect(api.vapStop).toHaveBeenCalled()
    expect(api.vapStop.mock.invocationCallOrder[0]).toBeGreaterThan(api.vapPrepare.mock.invocationCallOrder[0])
  })

  it('offers Qwen3-TTS and the macOS voice and prepares only the search model when the conversation is not in Japanese', async () => {
    status = { ...status, asr: true }
    await render()
    const t = createTranslator('en-US')
    await chooseLanguage('en-US')
    await toModel(t)
    await verifyKey(t)
    await press(t('setup.next'))
    await press(t('setup.speaking.voice.title'))
    await press(t('setup.next'))
    await press(t('setup.next'))
    expect(optionTitles()).toEqual(['Qwen3-TTS', t('settings.ttsEngine.system.macos')])

    await press(t('settings.ttsEngine.system.macos'))
    await press(t('setup.next'))
    await press(t('setup.mic.check'))
    await press(t('setup.next'))
    expect(extraNames()).toEqual([t('setup.extras.models.embedding.label')])
    await press(t('setup.next'))
    expect([...container.querySelectorAll('.su-summary dd')][0]?.textContent).toBe('English')
  })

  it('derives the conversation and aizuchi models from the key of a provider other than Anthropic and enables the next step', async () => {
    await render()
    await toModel(ja)
    expect(button(ja('setup.next')).disabled).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('.su-provider[data-provider="openai"]')!.click())
    const input = container.querySelector<HTMLInputElement>('#su-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press(ja('setup.model.verifyAndSave'))

    expect(api.saveApiKey).toHaveBeenCalledWith('openai', 'sk-test')
    expect(api.saveSettings).toHaveBeenCalledWith({
      conversationModel: { provider: 'openai', id: 'gpt-5.6-terra' },
      bridgeModel: { provider: 'openai', id: 'gpt-5.6-luna' }
    })
    expect(button(ja('setup.next')).disabled).toBe(false)
  })

  it('skips the listening, reading and microphone steps in text-only mode and completes with TTS turned off', async () => {
    await render()
    await toModel(ja)
    const input = container.querySelector<HTMLInputElement>('#su-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // The pair of models already matches Anthropic, so verifying the key only refreshes the status before moving on.
    api.saveApiKey.mockImplementationOnce(async (provider: string) => {
      verifiedKeys.add(provider)
      status = { ...status, llm: true, llmKeys: { ...status.llmKeys, anthropic: 'verified' } }
      return status
    })
    await press(ja('setup.model.verifyAndSave'))
    await press(ja('setup.next'))
    await press(ja('setup.speaking.textOnly.title'))
    expect(stepStates()).toMatchObject({ [ja('setup.steps.listening.label')]: 'skipped', [ja('setup.steps.tts.label')]: 'skipped', [ja('setup.steps.mic.label')]: 'skipped' })

    await press(ja('setup.next'))
    // The remaining setup starts by itself when the step opens and blocks the next button until it finishes; in
    // text-only mode the only item is the semantic search over memory.
    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.extras.title'))
    await flush()
    expect(api.embeddingStatus).toHaveBeenCalled()
    expect(container.querySelectorAll('.su-extras li')).toHaveLength(1)
    expect(button(ja('setup.next')).disabled).toBe(false)

    await press(ja('setup.next'))
    await press(ja('setup.start'))
    expect(api.saveSettings).toHaveBeenCalledWith({ ttsEngine: 'none' })
    expect(api.completeSetup).toHaveBeenCalledWith(expect.objectContaining({ voiceMode: 'text', micAutoStart: false }))
  })

  it('shows how much of the Qwen3-TTS model has arrived while it is prepared on the reading step', async () => {
    status = { ...status, asr: true }
    await render()
    const t = createTranslator('ja-JP')
    await toModel(t)
    await verifyKey(t)
    await press(t('setup.next'))
    await press(t('setup.speaking.voice.title'))
    await press(t('setup.next'))
    await press(t('setup.next'))
    await press('Qwen3-TTS')
    await press(t('setup.tts.prepareModel'))
    await act(async () => progressListener({ target: 'tts', status: 'downloading', pct: 29, downloadedMb: 576.3, totalMb: 1974, message: 'Qwen3-TTS' }))
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('29')
    expect(container.querySelector('.st-progress-label')?.textContent).toContain('576.3 / 1974 MB')
  })

  it('says why the sample of the chosen speech engine could not be played', async () => {
    status = { ...status, asr: true, tts: true }
    api.ttsTest.mockRejectedValueOnce(new Error('the speech engine did not answer'))
    await render()
    await toModel(ja)
    await verifyKey(ja)
    await press(ja('setup.next'))
    await press(ja('setup.speaking.voice.title'))
    await press(ja('setup.next'))
    await press(ja('setup.next'))
    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.tts.title'))
    await press(ja('common.playSample'))
    expect(container.querySelector('.su-error')?.textContent).toBe('the speech engine did not answer')
  })

  it('turns the microphone on at the end of a voice setup through the gate every other switch uses, for the engine the setup saved', async () => {
    // An engine left from before is replaced by the way of talking chosen here.
    settings = { ...settings, voiceEngine: 'gemini-live' } as AppSettings
    status = { ...status, asr: true, tts: true }
    await render()
    await toModel(ja)
    await verifyKey(ja)
    await press(ja('setup.next'))
    await press(ja('setup.speaking.voice.title'))
    await press(ja('setup.next'))
    await press(ja('setup.next'))
    await press(ja('setup.next'))
    await press(ja('setup.mic.check'))
    await act(async () => container.querySelector<HTMLInputElement>('.su-check input')!.click())
    await press(ja('setup.next'))
    await flush()
    await press(ja('setup.next'))
    await press(ja('setup.start'))

    expect(api.completeSetup).toHaveBeenCalledWith(expect.objectContaining({ voiceMode: 'server', micAutoStart: true }))
    expect(voiceController.enable).toHaveBeenCalledOnce()
    expect(liveVoice.enable).not.toHaveBeenCalled()
  })
})

describe('first-run setup with a live engine', () => {
  const live = ja('setup.speaking.live.title')
  const typeKey = async (value: string): Promise<void> => {
    const input = container.querySelector<HTMLInputElement>('#su-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  /** Verifies the Anthropic key on the model screen and opens the speaking screen. */
  const toSpeaking = async (): Promise<void> => {
    await render()
    await toModel(ja)
    await verifyKey(ja)
    await press(ja('setup.next'))
  }
  /** Walks from the speaking screen through the microphone and the extras to the summary. */
  const toSummary = async (): Promise<void> => {
    await press(ja('setup.next'))
    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.mic.title'))
    await press(ja('setup.mic.check'))
    await act(async () => container.querySelector<HTMLInputElement>('.su-check input')!.click())
    await press(ja('setup.next'))
    await flush()
    await press(ja('setup.next'))
  }

  it('skips listening and reading but keeps the microphone', async () => {
    await toSpeaking()
    await press(live)
    expect(stepStates()).toMatchObject({
      [ja('setup.steps.listening.label')]: 'skipped',
      [ja('setup.steps.tts.label')]: 'skipped',
      [ja('setup.steps.mic.label')]: 'todo'
    })
  })

  it('keeps the next button disabled until the key of Gemini Live is verified', async () => {
    await toSpeaking()
    await press(live)
    // The model screen verified Anthropic, which Gemini Live does not run on.
    expect(button(ja('setup.next')).disabled).toBe(true)
    await typeKey('AIza-live')
    await press(ja('setup.model.verifyAndSave'))

    expect(api.saveApiKey).toHaveBeenLastCalledWith('google', 'AIza-live')
    expect(button(ja('setup.next')).disabled).toBe(false)
  })

  it('keeps the next button disabled when the key is refused', async () => {
    await toSpeaking()
    await press(live)
    api.saveApiKey.mockRejectedValueOnce(new Error('unauthenticated'))
    await typeKey('AIza-refused')
    await press(ja('setup.model.verifyAndSave'))

    expect(container.querySelector('.su-error')?.textContent).toContain('unauthenticated')
    expect(button(ja('setup.next')).disabled).toBe(true)
  })

  it('asks for no key when the model screen verified the Google key', async () => {
    await render()
    await toModel(ja)
    await act(async () => container.querySelector<HTMLButtonElement>('.su-provider[data-provider="google"]')!.click())
    await typeKey('AIza-test')
    await press(ja('setup.model.verifyAndSave'))
    await press(ja('setup.next'))
    await press(live)

    expect(container.querySelector('#su-key')).toBeNull()
    expect(button(ja('setup.next')).disabled).toBe(false)
  })

  it('checks a key saved in an earlier session when the live way is chosen, instead of asking for it again', async () => {
    status = { ...status, llmKeys: { ...status.llmKeys, google: 'saved' } }
    await toSpeaking()
    await press(live)
    await flush()

    expect(api.verifySavedApiKey).toHaveBeenCalledWith('google')
    expect(api.saveApiKey).not.toHaveBeenCalledWith('google', expect.anything())
    expect(container.querySelector('#su-key')).toBeNull()
    expect(button(ja('setup.next')).disabled).toBe(false)
  })

  it('lets a key set in the environment be verified again after a failed check, since a typed key cannot replace it', async () => {
    status = { ...status, llmKeys: { ...status.llmKeys, google: 'saved' } }
    api.verifySavedApiKey.mockRejectedValueOnce(new Error('offline'))
    await toSpeaking()
    await press(live)
    await flush()
    expect(container.querySelector('.su-warn')?.textContent).toBe(ja('setup.model.savedKeyFailed'))
    expect(button(ja('setup.next')).disabled).toBe(true)

    // Main refuses to save a typed key while the environment holds one, so the recheck is the way on.
    await press(ja('setup.model.verifySavedKey'))
    expect(api.verifySavedApiKey).toHaveBeenCalledTimes(2)
    expect(api.verifySavedApiKey).toHaveBeenLastCalledWith('google')
    expect(button(ja('setup.next')).disabled).toBe(false)
  })

  it('opens the reading step, which the live engine skipped, when the microphone is refused and the user switches to typing', async () => {
    api.requestMicPermission.mockResolvedValueOnce(false)
    await toSpeaking()
    await press(live)
    await typeKey('AIza-live')
    await press(ja('setup.model.verifyAndSave'))
    await press(ja('setup.next'))
    await press(ja('setup.mic.check'))
    await press(ja('setup.mic.switchToTyping'))

    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.tts.title'))
    expect(stepStates()).toMatchObject({ [ja('setup.steps.tts.label')]: 'current', [ja('setup.steps.mic.label')]: 'skipped' })
  })

  it('finishes with Gemini Live as the voice engine, prepares no recognition model and turns the microphone on through it', async () => {
    settings = { ...settings, geminiLive: { model: 'gemini-3.8-live', voice: 'Leda' } } as AppSettings
    vi.mocked(voiceController.prepareLocalAsr).mockClear()
    await toSpeaking()
    await press(live)
    await typeKey('AIza-live')
    await press(ja('setup.model.verifyAndSave'))
    await toSummary()
    // The summary names the voice the settings hold, which the settings screen may have changed before.
    expect(container.querySelector('.su-summary')?.textContent).toContain(ja('setup.summary.liveEngineValue', { engine: 'Gemini Live', voice: 'Leda' }))
    await press(ja('setup.start'))

    expect(api.completeSetup).toHaveBeenCalledWith({
      voiceMode: 'gemini-live',
      micAutoStart: true,
      microphoneVerified: true,
      localAsrVerified: true,
      systemTtsVerified: true
    })
    expect(useSettingsStore.getState().settings?.voiceEngine).toBe('gemini-live')
    expect(voiceController.prepareLocalAsr).not.toHaveBeenCalled()
    expect(liveVoice.enable).toHaveBeenCalledOnce()
    expect(voiceController.enable).not.toHaveBeenCalled()
  })
})

describe('first-run setup on Windows with an NVIDIA GPU', () => {
  beforeEach(() => setCapabilities(WINDOWS))
  afterEach(() => setCapabilities(MACOS))

  it('offers Qwen3-ASR with the reason from the GPU memory and the size of what it downloads', async () => {
    await render()
    await toModel(ja)
    await verifyKey(ja)
    await press(ja('setup.next'))
    await press(ja('setup.speaking.voice.title'))
    await press(ja('setup.next'))
    const label = asrModelSpec('qwen3-asr-1.7b').label
    expect(optionTitles()).toEqual([ja('setup.listening.recommended', { model: label }), ja('setup.listening.local.title')])
    await press(ja('setup.listening.recommended', { model: label }))
    const body = container.querySelector('.su-body')!.textContent
    expect(body).toContain(ja('speechRecognition.recommendation.vulkan.larger', { memoryGb: 8 }))
    const sizeGb = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(asrDownloadGb(asrModelSpec('qwen3-asr-1.7b'), false))
    expect(body).toContain(ja('setup.listening.downloadNote', { sizeGb }))
    expect(container.querySelector('.su-details dt')?.textContent).toBe(ja('setup.listening.details.memory.vulkan'))
    expect([...container.querySelectorAll('.su-details option')].map((option) => option.textContent)).toEqual([
      ja('setup.listening.automaticModel.vulkan'),
      label,
      asrModelSpec('qwen3-asr-0.6b').label
    ])
  })
})

describe('first-run setup on a machine without the local models', () => {
  beforeEach(() => setCapabilities(WINDOWS_WITHOUT_GPU))
  afterEach(() => setCapabilities(MACOS))

  it('gives the reason in place of the local speech recognition, offers no Qwen3-TTS, and offers the extras and the calendar', async () => {
    // Qwen3-TTS left in the settings is still not offered on a machine that cannot run it.
    settings = { ...settings, ttsEngine: 'qwen3tts' } as AppSettings
    await render()
    await toModel(ja)
    await verifyKey(ja)
    await press(ja('setup.next'))
    await press(ja('setup.speaking.voice.title'))
    await press(ja('setup.next'))
    expect(optionTitles()).toEqual([ja('setup.listening.local.title')])
    expect(container.querySelector('.su-body')?.textContent).toContain(ja('speechRecognition.unavailable.noDiscreteGpu'))

    await press(ja('setup.listening.local.title'))
    await press(ja('setup.listening.prepareModel'))
    await press(ja('setup.next'))
    expect(optionTitles()).toEqual([ja('settings.ttsEngine.system.windows'), 'VOICEVOX', 'AivisSpeech'])
    // The saved engine is none of the choices, so the step asks for one rather than for a preparation.
    expect(container.querySelector('.su-next')?.textContent).toBe(ja('setup.guide.tts.choose'))
    expect(container.textContent).not.toContain(ja('setup.tts.prepareModel'))

    await press(ja('settings.ttsEngine.system.windows'))
    await press(ja('setup.next'))
    await press(ja('setup.mic.check'))
    await press(ja('setup.next'))
    expect(extraNames()).toEqual([ja('setup.extras.models.embedding.label'), ja('setup.extras.models.modernbert.label'), ja('setup.extras.models.maai.label')])
    await press(ja('setup.next'))
    expect(container.querySelector('h1')?.textContent).toBe(ja('setup.steps.summary.title'))
    expect(container.querySelector('.su-summary.is-quiet')?.textContent).toContain(ja('setup.summary.calendarValue'))
  })
})
