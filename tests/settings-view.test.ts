// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, AppStatus, EmbeddingStatus, HotkeyStatus, MemoryOverview, PreparationProgress } from '@shared/ipc'
import { defaultPersona } from '@shared/persona'
import { CONVERSATION_LOCALES } from '@shared/conversation-locale'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { SETTINGS_PAGES } from '@shared/mini-apps'
import { THEMES } from '@shared/themes'
import { shortcutLabel } from '@shared/platform'
import { localDate, type UsageDay } from '@shared/api-usage'
import { defaultModelsFor } from '@shared/llm-catalog'
import { SettingsDialog } from '../src/renderer/src/ui/SettingsDialog'
import { useSettingsStore, useStatusStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { usePreparationStore } from '../src/renderer/src/state/preparation'
import { asrModelSpec, offeredAsrModels } from '@shared/asr-models'
import { CREDITS } from '@shared/credits'
import { IRODORI_TTS_VOICES } from '@shared/tts-models'
import { VOICE_SAMPLE_TEXT } from '@shared/voice-samples'
import { speechPlayer } from '../src/renderer/src/voice/SpeechPlayer'
import type { PlatformCapabilities } from '@shared/platform'
import type { AppUpdateState } from '@shared/app-update'
import { MACOS, WINDOWS, WINDOWS_WITHOUT_GPU, setCapabilities } from './helpers/platform'

// The voice modules build an AudioContext at import time, so they are replaced for a test that only renders the UI.
vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/voice/VoiceController', () => ({
  voiceController: { prepareLocalAsr: vi.fn(async () => {}), cancelLocalAsrPreparation: vi.fn() }
}))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { playClip: vi.fn() } }))

/** The settings dialog: the page list with its status, switching pages, the count of items that need setup, and saving. */

const settings = {
  onboardingVersion: 1,
  uiLocale: 'ja-JP',
  theme: 'future',
  conversationLocale: 'ja-JP',
  region: 'JP',
  conversationModel: { provider: 'openai', id: 'gpt-5.6-luna' },
  bridgeModel: { provider: 'anthropic', id: 'claude-haiku-4-5' },
  voiceEngine: 'cascade',
  geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' },
  liveIdleSeconds: 90,
  persona: null,
  conversationLocale: 'ja-JP',
  region: 'JP',
  conversationLogRetentionDays: 90,
  ttsEngine: 'system',
  qwenTtsSize: '0.6b',
  qwenTtsVoice: 'ono_anna',
  irodoriTtsVoice: 'calm-young-woman',
  voicevoxSpeaker: 1,
  aivisSpeaker: null,
  bargeIn: true,
  aizuchi: false,
  aizuchiRate: 0.85,
  bridgePhrase: true,
  listeningAizuchi: true,
  hangoverMs: 600,
  partialIntervalMs: 600,
  calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null },
  mail: { accounts: [], defaultAccountId: null },
  agentCwd: '/Users/demo',
  fileRoots: ['/Users/demo/Desktop'],
  agentEngine: 'codex',
  agentMode: 'auto',
  micAutoStart: false,
  localAsrEnabled: false,
  nativeMic: true,
  noiseSuppression: true,
  vapEnabled: false,
  memoryEmbeddingEnabled: false,
  asrModel: 'auto',
  globalHotkey: true,
  dockOrder: ['jobs', 'tasks', 'memory', 'calendar', 'settings']
} as unknown as AppSettings

const status: AppStatus = {
  sequence: 1,
  llm: true,
  conversationModel: { provider: 'openai', id: 'gpt-5.6-luna' },
  llmKeys: { anthropic: 'verified', openai: 'missing', google: 'missing', cerebras: 'saved' },
  tts: false,
  ttsStarting: false,
  ttsEngine: 'system',
  ttsLabel: 'macOS',
  asr: false,
  asrInstalled: false,
  agent: 'missing',
  agentEngine: 'codex',
  voiceEngine: 'cascade',
  live: 'off'
}

/** Whoever listens on main's progress channel now. */
const progressListeners = new Set<(p: PreparationProgress) => void>()

const embeddingReady: EmbeddingStatus = { runtimeInstalled: true, modelInstalled: true, running: false, enabled: false, converting: false, embedded: 3, total: 4, model: 'multilingual-e5-small' }

const api = {
  saveSettings: vi.fn(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch })),
  getStatus: vi.fn(async () => status),
  // Main answers with the status a test put in the store, since opening the dialog puts the answer back there.
  getSetupStatus: vi.fn(async () => ({
    services: useStatusStore.getState().status!,
    asr: {
      selectedModel: 'auto',
      resolvedModel: 'qwen3-asr-1.7b',
      recommendedModel: 'qwen3-asr-1.7b',
      label: 'Qwen3-ASR 1.7B',
      recommendationReason: '32GBメモリではQwen3-ASRを推奨します。',
      totalMemoryGb: 32,
      modelInstalled: false
    }
  })),
  recheckAgentCli: vi.fn(async () => {}),
  vapStatus: vi.fn(async () => ({ runtimeInstalled: false, modelsInstalled: false, running: false })),
  embeddingStatus: vi.fn(async (): Promise<EmbeddingStatus> => embeddingReady),
  aizuchiClassifierStatus: vi.fn(async () => ({ runtimeInstalled: true, modelInstalled: false, running: false })),
  calendarStatus: vi.fn(async () => ({ signIn: 'signedOut', calendars: [], account: null })),
  memoryOverview: vi.fn(async (): Promise<MemoryOverview> => ({ dir: '', units: 0, pages: 0, curatedThrough: null, pendingJobId: null, lastFailure: null, unavailableReason: null })),
  listSpeakers: vi.fn(async () => []),
  hotkeyStatus: vi.fn(async (): Promise<HotkeyStatus> => 'registered'),
  embeddingPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  prepareAsrModel: vi.fn(async (_model: string) => ({ ok: true, message: '' })),
  cancelAsrPreparation: vi.fn(async () => {}),
  vapPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  onSetupProgress: vi.fn((callback: (p: PreparationProgress) => void) => {
    progressListeners.add(callback)
    return () => void progressListeners.delete(callback)
  }),
  openExternal: vi.fn(async () => {}),
  appVersion: vi.fn(async () => '1.0.0'),
  appUpdateState: vi.fn(async (): Promise<AppUpdateState> => ({ phase: 'off' })),
  onAppUpdateChanged: vi.fn((_callback: (state: AppUpdateState) => void) => () => {}),
  folderChoose: vi.fn(async (_startAt?: string): Promise<string | null> => null),
  apiUsage: vi.fn(async (): Promise<UsageDay[]> => [
    {
      date: localDate(new Date()),
      items: [
        { kind: 'llm', purpose: 'conversation', provider: 'openai', model: 'gpt-5.6-luna', calls: 10, input: 1000, cacheRead: 9000, cacheCreation: 0, output: 500, webSearches: 0, costUsd: 1.2 },
        { kind: 'llm', purpose: 'bridge', provider: 'openai', model: 'my-own-model', calls: 4, input: 400, cacheRead: 0, cacheCreation: 0, output: 40, webSearches: 0, costUsd: null },
        { kind: 'agent', engine: 'claude', jobs: 1, costUsd: 0.3 }
      ]
    }
  ])
}
const t = createTranslator('ja-JP')
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  progressListeners.clear()
  api.embeddingStatus.mockReset().mockImplementation(async () => embeddingReady)
  api.embeddingPrepare.mockReset().mockImplementation(async () => ({ ok: true, message: '' }))
  useSettingsStore.setState({ settings })
  useStatusStore.setState({ status })
  useToastStore.setState({ toasts: [] })
  usePreparationStore.setState({ running: null, localAsr: null, message: '' })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'settings' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useSettingsStore.setState({ settings: null })
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(SettingsDialog, { open: true })))
  await act(async () => {})
  return container.querySelector<HTMLElement>('[aria-label="SETTINGS"]')!
}
const nav = (view: HTMLElement, page: string): HTMLButtonElement => view.querySelector<HTMLButtonElement>(`.st-nav[data-page="${page}"]`)!
/** Writes into a field the way a keystroke does. React tracks changes through its own value setter, so the native one writes the value. */
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
const leave = (field: HTMLElement): void => void field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
const title = (view: HTMLElement): string | null | undefined => view.querySelector('.st-page > header h2')?.textContent
const sub = (view: HTMLElement, page: string): Element | null => nav(view, page).querySelector('.st-nav-sub')
/** The rows of the overview's list of what is turned on and cannot work yet, by their name. */
const pendingLabels = (view: HTMLElement): Array<string | null | undefined> =>
  [...view.querySelectorAll('[data-pending] .st-row-label')].map((label) => label.textContent)

describe('settings dialog', () => {
  it('opens on the overview and lists the pages in order under their headings, each with its summary line', async () => {
    const view = await render()
    expect(title(view)).toBe(t('settings.pages.overview'))
    expect([...view.querySelectorAll('.st-nav-title')].map((el) => el.textContent)).toEqual(SETTINGS_PAGES.map((page) => t(`settings.pages.${page}`)))
    expect([...view.querySelectorAll('.st-nav-section')].map((el) => el.textContent)).toEqual([
      t('settings.sections.assistant'),
      t('settings.sections.features'),
      t('settings.sections.general')
    ])
    expect(sub(view, 'appearance')?.textContent).toBe(t('settingsAppearance.themes.future.name'))
    expect(sub(view, 'usage')?.textContent).toBe(t('settings.summary.usage', { amount: '$1.50' }))
    expect(sub(view, 'language')?.textContent).toBe(`日本語 · ${new Intl.DisplayNames(['ja-JP'], { type: 'region' }).of('JP')}`)
    expect(sub(view, 'connections')?.textContent).toBe(`${t('settings.summary.calendarOff')} · ${t('settings.summary.mailAccounts', { count: 0 })}`)
    expect(sub(view, 'apiKeys')?.textContent).toBe(t('settings.summary.apiKeys', { keys: 2, total: 4 }))
  })

  it('warns in the list only about what is turned on and cannot work, and counts on the overview the rows it lists', async () => {
    const view = await render()
    // The conversation model needs the OpenAI key, speech recognition is not downloaded and the Codex CLI is
    // missing. MaAI and the aizuchi classifier are not prepared either, but both are off.
    expect(pendingLabels(view)).toEqual([t('settingsModels.asr.title'), 'Agent', t('settingsConversation.models.apiKey', { provider: 'OpenAI' })])
    expect(sub(view, 'overview')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 3 }))
    const warned = [...view.querySelectorAll('.st-nav')].filter((entry) => entry.querySelector('.st-nav-sub[data-tone="warn"]')).map((entry) => entry.getAttribute('data-page'))
    expect(warned).toEqual(['overview', 'conversation', 'voice', 'agent', 'apiKeys'])
    expect(sub(view, 'voice')?.textContent).toBe(t('settings.summary.recognitionNotReady'))
    expect(sub(view, 'agent')?.textContent).toBe(t('settings.summary.agentMissing', { engine: 'Codex' }))

    // Turning the aizuchi on while its classifier is missing makes one more thing that cannot work.
    await act(async () => useSettingsStore.setState({ settings: { ...settings, aizuchi: true } }))
    expect(pendingLabels(view)).toContain(t('settingsVoice.response.aizuchi'))
    expect(sub(view, 'overview')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 4 }))
  })

  it('offers on the overview the features that are off, and leaves out the ones already on', async () => {
    const view = await render()
    const optional = (): Array<string | null | undefined> =>
      [...view.querySelectorAll(`[aria-label="${t('settingsOverview.optionalTitle')}"] .st-row-label`)].map((label) => label.textContent)
    expect(optional()).toEqual([t('settingsMemory.search.title'), t('settingsVoice.mic.turnTaking'), t('settingsModels.asr.browserWhisper')])
    await act(async () => useSettingsStore.setState({ settings: { ...settings, memoryEmbeddingEnabled: true, localAsrEnabled: true } }))
    expect(optional()).toEqual([t('settingsVoice.mic.turnTaking')])
  })

  it('opens the page of a step of the current setup when the step is pressed', async () => {
    const view = await render()
    const steps = [...view.querySelectorAll<HTMLButtonElement>('.st-flow-tile')]
    expect(steps.map((step) => step.getAttribute('data-page'))).toEqual(['voice', 'conversation', 'voice'])
    expect(steps.map((step) => step.querySelector('.st-chip')?.textContent)).toEqual([t('common.notReady'), t('settingsConversation.models.notSet'), t('common.ready')])
    await act(async () => steps[1].click())
    expect(title(view)).toBe(t('settingsConversation.title'))
    expect(nav(view, 'conversation').getAttribute('aria-pressed')).toBe('true')
  })

  it('writes a small cost the same way in the page list and on the costs page', async () => {
    const small: UsageDay[] = [{ date: localDate(new Date()), items: [{ kind: 'agent', engine: 'claude', jobs: 1, costUsd: 0.035 }] }]
    // The dialog reads the costs once for the page list and the costs page reads them once more.
    api.apiUsage.mockResolvedValueOnce(small).mockResolvedValueOnce(small)
    const view = await render()
    await act(async () => nav(view, 'usage').click())
    await act(async () => {})
    const total = view.querySelector('.st-usage-totals strong')?.textContent
    expect(total).toBe('$0.035')
    expect(nav(view, 'usage').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.usage', { amount: total! }))
  })

  it('shows the costs of the range, leaves an unpriced model out of the total, and says why Codex jobs are missing', async () => {
    const view = await render()
    await act(async () => nav(view, 'usage').click())
    await act(async () => {})
    const totals = [...view.querySelectorAll('.st-usage-totals strong')].map((el) => el.textContent)
    expect(totals).toEqual(['$1.50', '$1.50'])
    expect([...view.querySelectorAll('.st-usage-legend li')].map((el) => el.textContent)).toEqual([
      `${t('settingsUsage.kinds.llm')}$1.20`,
      `${t('settingsUsage.kinds.agent')}$0.30`
    ])
    const lines = [...view.querySelectorAll(`[aria-label="${t('settingsUsage.breakdownTitle')}"] .st-row`)]
    expect(lines.map((row) => row.querySelector('.st-row-label')?.textContent)).toEqual([
      `GPT-5.6 Luna · ${t('settingsUsage.purposes.conversation')}`,
      'Claude Code',
      `my-own-model · ${t('settingsUsage.purposes.bridge')}`,
      t('settingsUsage.codexNote')
    ])
    expect(lines[2].querySelector('.st-chip')?.textContent).toBe(t('settingsUsage.unpriced'))
  })

  it('prepares speech recognition from the row that chooses its model, and reads the status again once it is done', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-chip')?.textContent).toBe(t('common.notReady'))
    expect(listening.querySelector('.st-prepline-text')?.textContent).toBe(t('settingsModels.asr.notDownloaded', { model: 'Qwen3-ASR 1.7B' }))
    const reads = api.getSetupStatus.mock.calls.length
    await act(async () => listening.querySelector<HTMLButtonElement>('[data-prep="asr"]')!.click())
    expect(api.prepareAsrModel).toHaveBeenCalledWith('auto')
    expect(api.getSetupStatus.mock.calls.length).toBe(reads + 1)
  })

  it('says Whisper in the browser listens while the local model is missing, instead of saying the microphone cannot be used', async () => {
    useSettingsStore.setState({ settings: { ...settings, localAsrEnabled: true } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-prepline-text')?.textContent).toBe(t('settingsModels.asr.notDownloadedWhisper', { model: 'Qwen3-ASR 1.7B' }))
  })

  it('lets speech recognition that is ready be checked again from its row', async () => {
    useStatusStore.setState({ status: { ...status, asr: true } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-prepline')).toBeNull()
    const again = listening.querySelector<HTMLButtonElement>('[data-prep="asr"]')!
    expect(again.textContent).toBe(t('settingsModels.asr.checkAgain'))
    await act(async () => again.click())
    expect(api.prepareAsrModel).toHaveBeenCalledWith('auto')
  })

  it('offers no preparation of turn-taking before its state has been read', async () => {
    api.vapStatus.mockImplementationOnce(() => new Promise(() => {}))
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const row = [...view.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === t('settingsVoice.mic.turnTaking'))!
    expect(row.querySelector('[data-prep="vap"]')).toBeNull()
    expect(row.querySelector('.st-chip')?.textContent).toBe(t('settingsModels.checking'))
  })

  it('links a missing speech application on the overview to where it is downloaded', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'voicevox' } })
    const view = await render()
    const speech = view.querySelector('[data-pending="speech"]')!
    expect(speech.querySelector('.st-btn')?.textContent).toBe(t('settingsModels.speech.get', { engine: 'VOICEVOX' }))
    await act(async () => speech.querySelector<HTMLButtonElement>('.st-btn')!.click())
    expect(api.openExternal).toHaveBeenCalledWith('https://voicevox.hiroshiba.jp/')
  })

  it('turns turn-taking on once it has been prepared from its own row', async () => {
    api.vapStatus.mockResolvedValueOnce({ runtimeInstalled: false, modelsInstalled: false, running: false })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const row = [...view.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === t('settingsVoice.mic.turnTaking'))!
    expect(row.querySelector('[role="switch"]')).toBeNull()
    await act(async () => row.querySelector<HTMLButtonElement>('[data-prep="vap"]')!.click())
    expect(api.vapPrepare).toHaveBeenCalledTimes(1)
    expect(api.saveSettings).toHaveBeenCalledWith({ vapEnabled: true })
  })

  it.each([
    ['script-only', 'jobs.start.cliScriptOnly'],
    ['sandbox-not-set-up', 'jobs.start.cliSandboxNotSetUp']
  ] as const)('shows the agent CLI as main finds it when the dialog opens, telling a %s CLI apart from a missing one', async (agent, reason) => {
    const setupWithStoreStatus = api.getSetupStatus.getMockImplementation()!
    api.getSetupStatus.mockImplementationOnce(async () => ({ ...(await setupWithStoreStatus()), services: { ...status, agent } }))
    const view = await render()
    expect(useStatusStore.getState().status?.agent).toBe(agent)
    await act(async () => nav(view, 'agent').click())
    const engineRow = [...view.querySelectorAll('.st-row')].find((row) => row.querySelector('.st-row-label')?.textContent === t('settingsAgent.run.engine'))!
    expect(engineRow.querySelector('.st-chip')?.textContent).toBe(t('common.notReady'))
    expect(view.querySelector('.st-prepline-text')?.textContent).toBe(t(reason, { engine: 'codex' }))
  })

  it('saves the conversation language together with a speech engine that can read it, and the region on its own', async () => {
    // VOICEVOX reads Japanese only, so the engine has to move with the language.
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'voicevox' } })
    const view = await render()
    await act(async () => nav(view, 'language').click())
    const language = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsLanguage.conversation')}"]`)!
    expect(language.value).toBe('ja-JP')
    expect([...language.options].map((option) => option.value)).toEqual([...CONVERSATION_LOCALES])
    await act(async () => {
      language.value = 'fr-FR'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ conversationLocale: 'fr-FR', ttsEngine: 'system' })

    // The macOS voice reads every language, so a further change touches the language alone.
    await act(async () => {
      language.value = 'ko-KR'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ conversationLocale: 'ko-KR' })

    const region = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsLanguage.region')}"]`)!
    expect(region.value).toBe('JP')
    // The countries are named by Intl in the language of the interface, never written by hand.
    expect([...region.options].find((option) => option.value === 'FR')?.textContent).toBe(new Intl.DisplayNames(['ja-JP'], { type: 'region' }).of('FR'))
    await act(async () => {
      region.value = 'FR'
      region.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ region: 'FR' })
  })

  it('shows the conversation reasoning effort, saves a change to main, and drops it back to the default when the model changes', async () => {
    // Google accepts tools and a reasoning effort at the same time, so the effort is selectable for the conversation model.
    useSettingsStore.setState({ settings: { ...settings, conversationModel: { provider: 'google', id: 'gemini-3.8-flash' } } })
    const view = await render()
    await act(async () => nav(view, 'conversation').click())
    const effort = view.querySelector<HTMLSelectElement>('[aria-label="会話の思考の深さ"]')!
    expect(effort.value).toBe('low')
    expect([...effort.options].map((o) => o.value)).toEqual(['low', 'medium', 'high'])
    await act(async () => {
      effort.value = 'high'
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ conversationModel: { provider: 'google', id: 'gemini-3.8-flash', effort: 'high' } }))
    const model = view.querySelector<HTMLSelectElement>('[aria-label="会話のモデル"]')!
    await act(async () => {
      model.value = 'gemini-3.5-flash-lite'
      model.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ conversationModel: { provider: 'google', id: 'gemini-3.5-flash-lite' } }))
    // Haiku 4.5, the aizuchi model, does not accept a reasoning effort, so no selector is offered for it.
    expect(view.querySelector('[aria-label="つなぎの一言の思考の深さ"]')).toBeNull()
  })

  it('saves the theme chosen on the appearance page and marks it as the chosen one', async () => {
    const view = await render()
    await act(async () => nav(view, 'appearance').click())
    const tiles = [...view.querySelectorAll<HTMLButtonElement>('.st-theme')]
    expect(tiles.map((tile) => tile.querySelector('.st-theme-name')?.textContent)).toEqual(THEMES.map((theme) => t(`settingsAppearance.themes.${theme}.name`)))
    expect(tiles.map((tile) => tile.getAttribute('aria-checked'))).toEqual(THEMES.map((theme) => String(theme === 'future')))
    const other = THEMES.findIndex((theme) => theme !== 'future')
    await act(async () => tiles[other].click())
    expect(api.saveSettings).toHaveBeenCalledWith({ theme: THEMES[other] })
    expect(view.querySelector('.st-theme[aria-checked="true"] .st-theme-name')?.textContent).toBe(t(`settingsAppearance.themes.${THEMES[other]}.name`))
  })

  it.each(['ja-JP', 'en-US'] as const)('has a switch of its own for the bridge phrase in a %s conversation, which leaves the aizuchi as they are', async (conversationLocale) => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale, aizuchi: true, bridgePhrase: true } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const bridge = [...view.querySelectorAll('.st-row')].find((row) => row.querySelector('.st-row-label')?.textContent === t('settingsVoice.response.bridgePhrase'))
    const toggle = bridge?.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')

    await act(async () => toggle!.click())
    expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ bridgePhrase: false })
  })

  it('asks for the key of the bridge phrase model only while the bridge phrase is on', async () => {
    const openAiKey = t('settingsConversation.models.apiKey', { provider: 'OpenAI' })
    const inUse = (view: HTMLElement): string[] =>
      [...view.querySelectorAll('.st-key')].filter((row) => [...row.querySelectorAll('.st-chip')].some((chip) => chip.textContent === t('settingsIntegrations.apiKeys.inUse'))).map((row) => row.getAttribute('data-provider')!)
    // The conversation runs on Anthropic, whose key works; the bridge phrase model is OpenAI's, whose key is missing.
    const models = { conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' }, bridgeModel: { provider: 'openai', id: 'gpt-5.6-luna' } } as const
    useSettingsStore.setState({ settings: { ...settings, ...models, bridgePhrase: false } })
    const view = await render()
    expect(pendingLabels(view)).not.toContain(openAiKey)
    // The current configuration names no bridge phrase model either.
    expect(view.querySelector('.st-flow-tile[data-page="conversation"] .st-flow-sub')).toBeNull()
    await act(async () => nav(view, 'apiKeys').click())
    expect(inUse(view)).toEqual(['anthropic'])

    await act(async () => useSettingsStore.setState({ settings: { ...settings, ...models, bridgePhrase: true } }))
    expect(inUse(view)).toEqual(['anthropic', 'openai'])
    await act(async () => nav(view, 'overview').click())
    expect(pendingLabels(view)).toContain(openAiKey)
  })

  it('saves a switch change to main and opens the key field only when a key is being entered', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const mic = view.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsVoice.mic.title')}"] [role="switch"]`)!
    await act(async () => mic.click())
    expect(api.saveSettings).toHaveBeenCalledWith({ micAutoStart: true })

    await act(async () => nav(view, 'apiKeys').click())
    const keys = [...view.querySelectorAll('.st-key')].map((row) => [row.getAttribute('data-provider'), row.querySelector('.st-chip')?.textContent])
    expect(keys).toEqual([
      ['anthropic', t('settingsIntegrations.apiKeys.verified')],
      ['openai', t('settingsIntegrations.apiKeys.notSet')],
      ['google', t('settingsIntegrations.apiKeys.notSet')],
      ['cerebras', t('settingsIntegrations.apiKeys.saved')]
    ])
    expect(view.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull()
    await act(async () => view.querySelector<HTMLButtonElement>('.st-key[data-provider="openai"] .st-btn')!.click())
    expect(view.querySelector('input[aria-label="OPENAI_API_KEY"]')).not.toBeNull()
  })

  it('shows a saved key this build cannot decrypt as such wherever a key appears, and asks for it again', async () => {
    useStatusStore.setState({ status: { ...status, llmKeys: { ...status.llmKeys, google: 'unreadable', cerebras: 'unreadable' } } })
    useSettingsStore.setState({ settings: { ...settings, ...defaultModelsFor('google'), voiceEngine: 'gemini-live' } })
    const view = await render()
    expect(sub(view, 'apiKeys')?.textContent).toBe(t('settings.summary.apiKeys', { keys: 1, total: 4 }))
    // Gemini Live and the conversation model both need the Google key, which the conversation page names once.
    await act(async () => nav(view, 'conversation').click())
    const lines = [...view.querySelectorAll('.st-prepline')]
    expect(lines.map((line) => [line.querySelector('.st-chip')?.textContent, line.querySelector('.st-prepline-text')?.textContent])).toEqual([
      [t('settingsIntegrations.apiKeys.unreadable'), t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'Google' })]
    ])
    await act(async () => lines[0].querySelector<HTMLButtonElement>('.st-btn')!.click())
    expect(title(view)).toBe(t('settings.pages.apiKeys'))
    const row = view.querySelector('.st-key[data-provider="google"]')!
    expect(row.querySelector('.st-chip')?.textContent).toBe(t('settingsIntegrations.apiKeys.unreadable'))
    expect(row.querySelector('.st-btn')?.textContent).toBe(t('settingsIntegrations.apiKeys.register'))
  })

  it.each([
    // A setup finished for text alone saves the engine that reads nothing, which is no missing speech.
    ['none', [t('settingsModels.asr.title')]],
    // A setup finished with a live engine leaves the default engine, which was never installed.
    ['voicevox', [t('settingsModels.asr.title'), t('settingsModels.speech.title')]]
  ] as const)(
    'lists on the overview what the cascade engine lacks once it is chosen after a live engine, with the speech engine %s',
    async (ttsEngine, lacking) => {
      const liveSettings = { ...settings, voiceEngine: 'gemini-live', ttsEngine } as AppSettings
      useSettingsStore.setState({ settings: liveSettings })
      useStatusStore.setState({ status: { ...status, llmKeys: { ...status.llmKeys, openai: 'verified', google: 'verified' }, agent: 'found', tts: false } })
      api.saveSettings.mockImplementationOnce(async (patch: Partial<AppSettings>) => ({ ...liveSettings, ...patch }))
      const view = await render()
      expect(pendingLabels(view)).toEqual([])

      await act(async () => nav(view, 'conversation').click())
      const engine = view.querySelector<HTMLSelectElement>(`select[aria-label="${t('settingsConversation.engine.selectLabel')}"]`)!
      await act(async () => {
        engine.value = 'cascade'
        engine.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await act(async () => {})
      expect(api.saveSettings).toHaveBeenLastCalledWith({ voiceEngine: 'cascade' })
      expect(sub(view, 'voice')?.getAttribute('data-tone')).toBe('warn')
      await act(async () => nav(view, 'overview').click())
      const voice = [t('settingsModels.asr.title'), t('settingsModels.speech.title')]
      expect(pendingLabels(view).filter((label) => voice.includes(label!))).toEqual(lacking)
    }
  )

  it('counts the cascade engine as able to listen through Whisper in the browser, which the microphone falls back to without the local model', async () => {
    useSettingsStore.setState({ settings: { ...settings, localAsrEnabled: true } })
    const view = await render()
    expect(pendingLabels(view)).not.toContain(t('settingsModels.asr.title'))
    expect(view.querySelector('.st-flow-tile[data-page="voice"] .st-chip')?.textContent).toBe(t('common.ready'))
    // The macOS voice needs nothing prepared, so the voice page's entry names the engine without a warning.
    expect(sub(view, 'voice')?.textContent).toBe(t('settings.summary.voiceBackchannelOff', { engine: t('settings.ttsEngine.system.macos') }))
    expect(sub(view, 'voice')?.getAttribute('data-tone')).toBeNull()
  })

  it('reports a status check that fails instead of keeping the last status without a word', async () => {
    api.getStatus.mockRejectedValueOnce(new Error('api-keys.json is damaged'))
    await useStatusStore.getState().refresh()
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error', title: t('app.status.checkFailed'), body: 'api-keys.json is damaged' }])
  })

  it('keeps the status main read last, in whichever order a push and the answer to a read reach the page', async () => {
    // Main pushes a status it read after it began answering a read, and the answer arrives last.
    let answer!: (read: AppStatus) => void
    api.getStatus.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const refreshing = useStatusStore.getState().refresh()
    useStatusStore.getState().apply({ ...status, sequence: 3, tts: true })
    answer({ ...status, sequence: 2, tts: false })
    await refreshing
    expect(useStatusStore.getState().status).toMatchObject({ sequence: 3, tts: true })

    // Main answers a read just after it pushed a status read before it, and the answer overtakes the push.
    api.getStatus.mockResolvedValueOnce({ ...status, sequence: 5, tts: false })
    await useStatusStore.getState().refresh()
    useStatusStore.getState().apply({ ...status, sequence: 4, tts: true })
    expect(useStatusStore.getState().status).toMatchObject({ sequence: 5, tts: false })
  })

  it('says in the page list that the costs could not be read, instead of leaving the line empty', async () => {
    api.apiUsage.mockRejectedValueOnce(new Error('usage.jsonl is damaged'))
    const view = await render()
    expect(sub(view, 'usage')?.textContent).toBe(t('settingsModels.checkFailed'))
    expect(sub(view, 'usage')?.getAttribute('data-tone')).toBe('warn')
  })

  it('gives on the about page the reason main could not tell the version or the state of the update', async () => {
    api.appVersion.mockRejectedValueOnce(new Error('the version could not be read'))
    api.appUpdateState.mockRejectedValueOnce(new Error('the updater is not ready'))
    const view = await render()
    await act(async () => nav(view, 'about').click())
    await act(async () => {})
    const row = (label: string): Element | undefined =>
      [...view.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === label)
    const shown = (one: Element | undefined): Array<string | null | undefined> => [one?.querySelector('.st-chip')?.textContent, one?.querySelector('.st-row-hint')?.textContent]
    expect(shown(row(t('settingsAbout.version')))).toEqual([t('settingsModels.checkFailed'), 'the version could not be read'])
    expect(shown(row(t('settingsAbout.update.label')))).toEqual([t('settingsModels.checkFailed'), 'the updater is not ready'])
  })
})

describe('settings fields that are saved once the user leaves them', () => {
  it('keeps every key typed into the working folder while main has not answered, and saves the folder once the field is left', async () => {
    // Main answers a save a moment later, and the settings on screen change only then.
    const answers: Array<() => void> = []
    api.saveSettings.mockImplementationOnce((patch) => new Promise((resolve) => answers.push(() => resolve({ ...settings, ...patch }))))
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const folder = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsAgent.workspace.parentLabel')}"]`)!
    expect(folder.value).toBe('/Users/demo')
    await act(async () => type(folder, '/Users/demo/a'))
    await act(async () => type(folder, '/Users/demo/ab'))
    expect(folder.value).toBe('/Users/demo/ab')
    expect(api.saveSettings).not.toHaveBeenCalled()

    await act(async () => leave(folder))
    expect(api.saveSettings.mock.calls).toEqual([[{ agentCwd: '/Users/demo/ab' }]])
    expect(folder.value).toBe('/Users/demo/ab')
    await act(async () => answers.splice(0).forEach((answer) => answer()))
    expect(folder.value).toBe('/Users/demo/ab')
    // The folder has been saved once, and the page going away does not save it again.
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
  })

  it('saves a typed folder when the page goes away while the field still has focus, as when Escape closes the settings', async () => {
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const folder = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsAgent.workspace.parentLabel')}"]`)!
    folder.focus()
    await act(async () => type(folder, '/Users/demo/projects'))
    expect(api.saveSettings).not.toHaveBeenCalled()
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings.mock.calls).toEqual([[{ agentCwd: '/Users/demo/projects' }]])
  })

  it('saves the working folder without the spaces a paste leaves around it, which would name another folder', async () => {
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const folder = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsAgent.workspace.parentLabel')}"]`)!
    await act(async () => type(folder, ' /Users/demo/projects '))
    await act(async () => leave(folder))
    expect(api.saveSettings.mock.calls).toEqual([[{ agentCwd: '/Users/demo/projects' }]])
  })

  it('saves an edited persona when the page goes away while the field still has focus, as when Escape closes the settings', async () => {
    const view = await render()
    await act(async () => nav(view, 'persona').click())
    const persona = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    persona.focus()
    await act(async () => type(persona, '名前は ミナ。短く答える。'))
    expect(api.saveSettings).not.toHaveBeenCalled()
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings.mock.calls).toEqual([[{ persona: '名前は ミナ。短く答える。' }]])
  })

  it('keeps an edited persona whose save failed in the field, marked as not saved, instead of putting the saved one back', async () => {
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    const view = await render()
    await act(async () => nav(view, 'persona').click())
    const persona = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    persona.focus()
    await act(async () => type(persona, '名前は ミナ。'))
    await act(async () => leave(persona))
    expect(api.saveSettings.mock.calls).toEqual([[{ persona: '名前は ミナ。' }]])
    expect(persona.value).toBe('名前は ミナ。')
    expect(persona.getAttribute('aria-invalid')).toBe('true')
  })

  it('drops a persona whose save failed when it is reset to the default, and saves it no more once the settings close', async () => {
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    const view = await render()
    await act(async () => nav(view, 'persona').click())
    const persona = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    persona.focus()
    await act(async () => type(persona, '名前は ミナ。'))
    await act(async () => leave(persona))
    const reset = [...view.querySelectorAll<HTMLButtonElement>('.st-btn')].find((button) => button.textContent === t('settingsPersona.text.reset'))!
    await act(async () => reset.click())
    expect(persona.value).toBe(defaultPersona('ja-JP'))
    expect(persona.getAttribute('aria-invalid')).toBe('false')
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings.mock.calls).toEqual([[{ persona: '名前は ミナ。' }], [{ persona: null }]])
  })

  it('shows the default persona in the conversation language, and in the new one once the Language page changes it', async () => {
    const view = await render()
    const personaField = (): HTMLTextAreaElement => view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    await act(async () => nav(view, 'persona').click())
    expect(personaField().value).toBe(defaultPersona('ja-JP'))
    await act(async () => nav(view, 'language').click())
    const language = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsLanguage.conversation')}"]`)!
    await act(async () => {
      language.value = 'en-US'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => nav(view, 'persona').click())
    expect(personaField().value).toBe(defaultPersona('en-US'))
    expect(view.querySelector('.st-row-label')?.textContent).toBe(t('settingsPersona.state.default'))
    expect(api.saveSettings.mock.calls).toEqual([[{ conversationLocale: 'en-US' }]])
  })

  it('makes the persona the default again when its text is typed back to the default of the conversation language', async () => {
    useSettingsStore.setState({ settings: { ...settings, persona: '名前は ミナ。' } })
    const view = await render()
    await act(async () => nav(view, 'persona').click())
    const persona = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    expect(view.querySelector('.st-row-label')?.textContent).toBe(t('settingsPersona.state.edited'))
    await act(async () => type(persona, defaultPersona('ja-JP')))
    expect(view.querySelector('.st-row-label')?.textContent).toBe(t('settingsPersona.state.default'))
    await act(async () => leave(persona))
    expect(api.saveSettings.mock.calls).toEqual([[{ persona: null }]])
  })

  it('keeps the default of another language as a persona the user wrote, which stays as it is in the field', async () => {
    const view = await render()
    await act(async () => nav(view, 'persona').click())
    const persona = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsPersona.text.label')}"]`)!
    await act(async () => type(persona, defaultPersona('en-US')))
    await act(async () => leave(persona))
    expect(api.saveSettings.mock.calls).toEqual([[{ persona: defaultPersona('en-US') }]])
    expect(persona.value).toBe(defaultPersona('en-US'))
    expect(view.querySelector('.st-row-label')?.textContent).toBe(t('settingsPersona.state.edited'))
  })

  it('does not leave the working folder on the Enter that confirms an IME conversion', async () => {
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const folder = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsAgent.workspace.parentLabel')}"]`)!
    folder.focus()
    await act(async () => type(folder, '/Users/demo/しごと'))
    await act(async () => void folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    expect(document.activeElement).toBe(folder)
    expect(api.saveSettings).not.toHaveBeenCalled()
    await act(async () => void folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(api.saveSettings.mock.calls).toEqual([[{ agentCwd: '/Users/demo/しごと' }]])
  })

  it('keeps a second edit of the days made while main has not answered the save of the first', async () => {
    const answers: Array<() => void> = []
    const later = (patch: Partial<AppSettings>): Promise<AppSettings> => new Promise((resolve) => answers.push(() => resolve({ ...settings, ...patch })))
    api.saveSettings.mockImplementationOnce(later).mockImplementationOnce(later)
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMemory.log.retentionLabel')}"]`)!
    days.focus()
    await act(async () => type(days, '3'))
    await act(async () => leave(days))
    days.focus()
    await act(async () => type(days, '30'))
    // Main answers the save of 3 while 30 is being typed.
    await act(async () => answers.shift()!())
    expect(days.value).toBe('30')
    await act(async () => leave(days))
    expect(api.saveSettings.mock.calls).toEqual([[{ conversationLogRetentionDays: 3 }], [{ conversationLogRetentionDays: 30 }]])
    await act(async () => answers.shift()!())
    expect(days.value).toBe('30')
  })

  it('adds a chosen folder to the folders typed in the field and opens the folder dialog at the typed folder, before main has answered their saves', async () => {
    api.saveSettings.mockImplementation(() => new Promise(() => {}))
    try {
      const view = await render()
      await act(async () => nav(view, 'agent').click())
      const button = (key: Parameters<typeof t>[0]): HTMLButtonElement => [...view.querySelectorAll<HTMLButtonElement>('.st-btn')].find((b) => b.textContent === t(key))!
      const roots = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsAgent.roots.title')}"]`)!
      roots.focus()
      await act(async () => type(roots, '/Users/demo/Desktop\n/Users/demo/Documents'))
      api.folderChoose.mockResolvedValueOnce('/Users/demo/Pictures')
      // Pressing a button takes the focus from the field before the click.
      await act(async () => leave(roots))
      await act(async () => button('settingsAgent.roots.add').click())
      expect(api.saveSettings.mock.calls).toEqual([
        [{ fileRoots: ['/Users/demo/Desktop', '/Users/demo/Documents'] }],
        [{ fileRoots: ['/Users/demo/Desktop', '/Users/demo/Documents', '/Users/demo/Pictures'] }]
      ])

      const folder = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsAgent.workspace.parentLabel')}"]`)!
      folder.focus()
      await act(async () => type(folder, '/Users/demo/projects'))
      await act(async () => leave(folder))
      await act(async () => button('settingsAgent.workspace.choose').click())
      expect(api.folderChoose).toHaveBeenLastCalledWith('/Users/demo/projects')
    } finally {
      api.saveSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch }))
    }
  })

  it('keeps a value whose save failed in the field, marked as not saved, and saves it again when the field is left again', async () => {
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMemory.log.retentionLabel')}"]`)!
    const hint = (): string | null | undefined => days.closest('.st-row')?.querySelector('.st-row-hint')?.textContent
    days.focus()
    await act(async () => type(days, '30'))
    await act(async () => leave(days))
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([t('settings.saveFailed')])
    expect(days.value).toBe('30')
    expect(days.getAttribute('aria-invalid')).toBe('true')
    expect(hint()).toBe(t('settings.fieldNotSaved'))

    days.focus()
    await act(async () => leave(days))
    expect(api.saveSettings.mock.calls).toEqual([[{ conversationLogRetentionDays: 30 }], [{ conversationLogRetentionDays: 30 }]])
    expect(days.value).toBe('30')
    expect(days.getAttribute('aria-invalid')).toBe('false')
    expect(hint()).toBe(t('settingsMemory.log.retentionHint'))
  })

  it('lets a text whose save failed give way to folders saved after it, and never writes it back over them', async () => {
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const roots = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsAgent.roots.title')}"]`)!
    roots.focus()
    await act(async () => type(roots, '/Users/demo/Desktop\n/Users/demo/Documents'))
    await act(async () => leave(roots))
    expect(roots.getAttribute('aria-invalid')).toBe('true')

    // "Add folder" saves the list with the folder chosen, which main accepts this time.
    api.folderChoose.mockResolvedValueOnce('/Users/demo/Pictures')
    const add = [...view.querySelectorAll<HTMLButtonElement>('.st-btn')].find((b) => b.textContent === t('settingsAgent.roots.add'))!
    await act(async () => add.click())
    const saved = ['/Users/demo/Desktop', '/Users/demo/Documents', '/Users/demo/Pictures']
    expect(roots.value).toBe(saved.join('\n'))
    expect(roots.getAttribute('aria-invalid')).toBe('false')

    // Closing the settings, and leaving the field before that, save nothing more.
    await act(async () => leave(roots))
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings.mock.calls.at(-1)).toEqual([{ fileRoots: saved }])
  })

  it('drops a day count that is not one when the page goes away, as it does when the field is left', async () => {
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMemory.log.retentionLabel')}"]`)!
    days.focus()
    await act(async () => type(days, '0'))
    await act(async () => root.render(React.createElement('div')))
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('lets a second readable folder be typed on a new line, and saves the list without blank lines once the field is left', async () => {
    const view = await render()
    await act(async () => nav(view, 'agent').click())
    const roots = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('settingsAgent.roots.title')}"]`)!
    expect(roots.value).toBe('/Users/demo/Desktop')
    await act(async () => type(roots, '/Users/demo/Desktop\n'))
    expect(roots.value).toBe('/Users/demo/Desktop\n')
    await act(async () => type(roots, '/Users/demo/Desktop\n\n /Users/demo/Documents \n'))
    expect(api.saveSettings).not.toHaveBeenCalled()

    await act(async () => leave(roots))
    expect(api.saveSettings.mock.calls).toEqual([[{ fileRoots: ['/Users/demo/Desktop', '/Users/demo/Documents'] }]])
    expect(roots.value).toBe('/Users/demo/Desktop\n/Users/demo/Documents')
  })

  it('saves the days conversation logs are kept only once the field is left, and puts the saved days back for a field left empty', async () => {
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMemory.log.retentionLabel')}"]`)!
    expect(days.value).toBe('90')
    days.focus()
    // Two Backspaces, then 3 and 0. Main deletes the logs older than the saved days at the change of day,
    // so a value on the way, such as 9, must never be saved.
    for (const value of ['9', '', '3', '30']) await act(async () => type(days, value))
    expect(api.saveSettings).not.toHaveBeenCalled()
    await act(async () => void days.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(api.saveSettings.mock.calls).toEqual([[{ conversationLogRetentionDays: 30 }]])

    await act(async () => type(days, ''))
    expect(days.value).toBe('')
    await act(async () => leave(days))
    expect(days.value).toBe('30')
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
  })
})

describe('settings dialog while a model is prepared or memories are converted', () => {
  const prepButton = (view: HTMLElement, target: string): HTMLButtonElement => view.querySelector<HTMLButtonElement>(`[data-prep="${target}"]`)!
  /** The progress bars on screen, each with the heading of the group it is under and its value. */
  const bars = (view: HTMLElement): Array<Array<string | null | undefined>> =>
    [...view.querySelectorAll('[role="progressbar"]')].map((bar) => [bar.closest('.st-group')?.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')])
  const progress = (event: PreparationProgress): void => progressListeners.forEach((listener) => listener(event))

  it('shows the download progress under the item being prepared and nowhere else, and keeps the others waiting', async () => {
    api.embeddingStatus.mockImplementation(async () => ({ ...embeddingReady, runtimeInstalled: false, modelInstalled: false, embedded: 0, total: 45 }))
    let finish!: (result: { ok: boolean; message: string }) => void
    api.embeddingPrepare.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = await render()

    await act(async () => prepButton(view, 'embedding').click())
    await act(async () => progress({ target: 'embedding', status: 'downloading', pct: 40, downloadedMb: 54, totalMb: 135 }))
    expect(bars(view)).toEqual([[t('settingsOverview.optionalTitle'), '40']])
    expect(prepButton(view, 'embedding').textContent).toBe(t('common.preparing'))
    // Only one preparation runs at a time, so the other items wait until this one ends.
    expect(prepButton(view, 'asr').textContent).toBe(t('settingsModels.prepare'))
    expect(prepButton(view, 'asr').disabled).toBe(true)

    await act(async () => finish({ ok: true, message: '' }))
    expect(api.saveSettings).toHaveBeenCalledWith({ memoryEmbeddingEnabled: true })
    expect(view.querySelector('[role="progressbar"]')).toBeNull()
    expect(prepButton(view, 'asr').disabled).toBe(false)
  })

  it('shows under the item being prepared only the progress main reports for that item', async () => {
    api.embeddingStatus.mockImplementation(async () => ({ ...embeddingReady, runtimeInstalled: false, modelInstalled: false, embedded: 0, total: 45 }))
    api.embeddingPrepare.mockImplementation(() => new Promise(() => {}))
    const view = await render()
    await act(async () => prepButton(view, 'embedding').click())
    // Another screen, such as the first-run setup, prepares speech recognition on the same channel.
    await act(async () => progress({ target: 'asr', status: 'downloading', pct: 70, downloadedMb: 1400, totalMb: 2000 }))
    await act(async () => progress({ target: 'asr', status: 'done', pct: 100, downloadedMb: 2000, totalMb: 2000, message: 'Qwen3-ASR' }))
    expect(bars(view)).toEqual([[t('settingsOverview.optionalTitle'), '0']])
    expect(view.querySelector('.st-notice')).toBeNull()
  })

  it('still shows a preparation that goes on after the settings are closed, with its progress, and starts no second one once they are opened again', async () => {
    let finish!: (result: { ok: boolean; message: string }) => void
    api.prepareAsrModel.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = await render()
    await act(async () => prepButton(view, 'asr').click())
    // Escape or the dock closes the settings while main is still downloading, and the user opens them again.
    await act(async () => root.render(React.createElement('div')))
    const reopened = await render()
    await act(async () => progress({ target: 'asr', status: 'downloading', pct: 40, downloadedMb: 800, totalMb: 2000 }))
    expect(prepButton(reopened, 'asr').textContent).toBe(t('common.preparing'))
    expect(bars(reopened)).toEqual([[t('settingsOverview.todoTitle'), '40']])
    expect(prepButton(reopened, 'vap').disabled).toBe(true)
    await act(async () => prepButton(reopened, 'vap').click())
    expect(api.vapPrepare).not.toHaveBeenCalled()
    await act(async () => finish({ ok: true, message: '' }))
  })

  it('shows how a preparation ended while the settings were closed once they are opened again, until they close', async () => {
    const close = (): Promise<void> =>
      act(async () => {
        await useViewStore.getState().closeApp()
        root.render(React.createElement('div'))
      })
    // The app renders under StrictMode in development, which mounts each effect twice.
    const open = async (): Promise<HTMLElement> => {
      await act(async () => {
        await useViewStore.getState().openApp({ app: 'settings' })
        root.render(React.createElement(React.StrictMode, null, React.createElement(SettingsDialog, { open: true })))
      })
      await act(async () => {})
      return container.querySelector<HTMLElement>('[aria-label="SETTINGS"]')!
    }
    let finish!: (result: { ok: boolean; message: string }) => void
    api.vapPrepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = await open()
    await act(async () => prepButton(view, 'vap').click())
    await close()
    await act(async () => finish({ ok: false, message: 'disk full' }))

    const reopened = await open()
    expect(reopened.querySelector('.st-notice')?.textContent).toBe('disk full')
    expect(prepButton(reopened, 'vap').disabled).toBe(false)
    await close()
    expect((await open()).querySelector('.st-notice')).toBeNull()
  })

  it('reads what is installed again when a preparation started before the settings were opened again ends', async () => {
    let finish!: (result: { ok: boolean; message: string }) => void
    api.vapPrepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = await render()
    await act(async () => prepButton(view, 'vap').click())
    await act(async () => root.render(React.createElement('div')))
    const reopened = await render()
    await act(async () => nav(reopened, 'voice').click())
    api.vapStatus.mockResolvedValueOnce({ runtimeInstalled: true, modelsInstalled: true, running: false })
    await act(async () => finish({ ok: true, message: '' }))
    await act(async () => {})
    expect(api.saveSettings).toHaveBeenCalledWith({ vapEnabled: true })
    const row = [...reopened.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === t('settingsVoice.mic.turnTaking'))!
    expect(row.querySelector('[data-prep="vap"]')).toBeNull()
    expect(row.querySelector('[role="switch"]')).not.toBeNull()
  })

  it('reports the last failed curation on the memory page as a warning with its reason, until a curation is under way', async () => {
    const failed: MemoryOverview = {
      dir: '', units: 3, pages: 1, curatedThrough: '2026-09-10', pendingJobId: null,
      lastFailure: { at: new Date(2026, 8, 12, 0, 1).getTime(), message: 'merge conflict' }, unavailableReason: null
    }
    api.memoryOverview.mockResolvedValueOnce(failed)
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    await act(async () => {})
    const statusRow = (): Element =>
      [...view.querySelectorAll('.st-row')].find((el) => el.querySelector('.st-row-label')?.textContent === t('settingsMemory.curation.status'))!
    expect(statusRow().querySelector('.st-chip')?.textContent).toBe(t('settingsMemory.curation.failedChip'))
    expect(statusRow().querySelector('.st-chip')?.getAttribute('data-tone')).toBe('warn')
    expect(statusRow().querySelector('.st-row-hint')?.textContent).toContain('merge conflict')

    api.memoryOverview.mockResolvedValueOnce({ ...failed, pendingJobId: 'job-2' })
    await act(async () => nav(view, 'conversation').click())
    await act(async () => nav(view, 'memory').click())
    await act(async () => {})
    expect(statusRow().querySelector('.st-chip')?.textContent).toBe(t('settingsMemory.curation.waiting'))
    expect(statusRow().querySelector('.st-row-hint')?.textContent).toBe(t('settingsMemory.curation.pending'))
  })

  it('gives the reason on the memory page when main cannot read the curation state, instead of saying the curation has not run yet', async () => {
    const details = 'jobs: Unrecognized key'
    api.memoryOverview.mockRejectedValueOnce(
      new Error(errorText('memory.errors.stateFileInvalid', { file: '/userData/memory-curation.json', details }))
    )
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    await act(async () => {})
    const statusRow = [...view.querySelectorAll('.st-row')].find(
      (el) => el.querySelector('.st-row-label')?.textContent === t('settingsMemory.curation.status')
    )!
    expect(statusRow.querySelector('.st-chip')?.textContent).toBe(t('settingsMemory.curation.unavailable'))
    expect(statusRow.querySelector('.st-chip')?.getAttribute('data-tone')).toBe('warn')
    expect(statusRow.querySelector('.st-row-hint')?.textContent).toBe(
      t('memory.errors.stateFileInvalid', { file: '/userData/memory-curation.json', details })
    )
  })

  it('says the curation state is being checked, and offers no curation, until main has answered', async () => {
    let answer!: (overview: MemoryOverview) => void
    api.memoryOverview.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const view = await render()
    await act(async () => nav(view, 'memory').click())
    const statusRow = (): Element =>
      [...view.querySelectorAll('.st-row')].find((el) => el.querySelector('.st-row-label')?.textContent === t('settingsMemory.curation.status'))!
    const curate = (): HTMLButtonElement => [...view.querySelectorAll<HTMLButtonElement>('.st-btn')].find((b) => b.textContent === t('settingsMemory.curation.start'))!
    expect(statusRow().querySelector('.st-chip')?.textContent).toBe(t('settingsMemory.curation.checking'))
    expect(statusRow().querySelector('.st-row-hint')?.textContent).toBe(t('settingsMemory.curation.checkingState'))
    expect(curate().disabled).toBe(true)

    await act(async () => answer({ dir: '', units: 0, pages: 0, curatedThrough: null, pendingJobId: null, lastFailure: null, unavailableReason: null }))
    expect(statusRow().querySelector('.st-chip')?.textContent).toBe(t('settingsMemory.curation.notRun'))
    expect(statusRow().querySelector('.st-row-hint')?.textContent).toBe(t('settingsMemory.curation.neverRun'))
    expect(curate().disabled).toBe(false)
  })

  it('keeps each line of a reason that spans several lines on a line of its own', async () => {
    const style = document.head.appendChild(document.createElement('style'))
    style.textContent = readFileSync(path.join(__dirname, '../src/renderer/src/assets/settings.css'), 'utf8')
    try {
      const details = 'jobs: Unrecognized key\nthrough: Invalid date'
      api.memoryOverview.mockRejectedValueOnce(
        new Error(errorText('memory.errors.stateFileInvalid', { file: '/userData/memory-curation.json', details }))
      )
      const view = await render()
      await act(async () => nav(view, 'memory').click())
      await act(async () => {})
      const hint = [...view.querySelectorAll('.st-row')]
        .find((el) => el.querySelector('.st-row-label')?.textContent === t('settingsMemory.curation.status'))!
        .querySelector<HTMLElement>('.st-row-hint')!
      expect(hint.textContent).toContain('jobs: Unrecognized key\nthrough: Invalid date')
      expect(['pre', 'pre-wrap', 'pre-line', 'break-spaces']).toContain(getComputedStyle(hint).whiteSpace)
    } finally {
      style.remove()
    }
  })

  it('reads the conversion count again after semantic search is turned on, until the conversion ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const statuses: EmbeddingStatus[] = [
        { ...embeddingReady, embedded: 0, total: 45 },
        { ...embeddingReady, running: true, enabled: true, converting: true, embedded: 0, total: 45 },
        { ...embeddingReady, running: true, enabled: true, converting: true, embedded: 20, total: 45 },
        { ...embeddingReady, running: true, enabled: true, converting: false, embedded: 45, total: 45 }
      ]
      api.embeddingStatus.mockImplementation(async () => statuses.length > 1 ? statuses.shift()! : statuses[0])
      const view = await render()
      await act(async () => nav(view, 'memory').click())
      const hint = (): string | null | undefined => view.querySelector('.st-row-hint')?.textContent
      expect(hint()).toBe(t('settingsMemory.search.converted', { embedded: 0, total: 45 }))

      await act(async () => view.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
      await act(async () => {})
      expect(api.saveSettings).toHaveBeenCalledWith({ memoryEmbeddingEnabled: true })
      expect(hint()).toBe(t('settingsMemory.search.converting', { embedded: 0, total: 45 }))

      await act(async () => vi.advanceTimersByTime(1_000))
      expect(hint()).toBe(t('settingsMemory.search.converting', { embedded: 20, total: 45 }))
      await act(async () => vi.advanceTimersByTime(1_000))
      expect(hint()).toBe(t('settingsMemory.search.convertedRunning', { embedded: 45, total: 45 }))

      const reads = api.embeddingStatus.mock.calls.length
      await act(async () => vi.advanceTimersByTime(5_000))
      expect(api.embeddingStatus.mock.calls.length).toBe(reads)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The interface stays Japanese in these tests while the conversation is held in another language, so
 * what disappears from the pages follows the conversation language and nothing else.
 */
describe('settings dialog with the conversation held in another language', () => {
  const rowLabels = (view: HTMLElement): Array<string | null> =>
    [...view.querySelectorAll('.st-row-label')].map((el) => el.textContent)
  const engineSelect = (view: HTMLElement): HTMLSelectElement =>
    view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!
  const engineOptions = (view: HTMLElement): string[] =>
    [...engineSelect(view).options].map((option) => option.value)

  it('offers only the engines that can speak the language and leaves out the backchannel and turn-taking rows', async () => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'en-US' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())

    expect(engineOptions(view)).toEqual(['qwen3tts', 'system', 'none'])
    const labels = rowLabels(view)
    expect(labels).toContain(t('settingsVoice.response.bargeIn'))
    expect(labels).not.toContain(t('settingsVoice.response.aizuchi'))
    expect(labels).not.toContain(t('settingsVoice.response.listeningAizuchi'))
    expect(labels).not.toContain(t('settingsVoice.response.aizuchiRate'))
    expect(labels).not.toContain(t('settingsVoice.mic.turnTaking'))
    // The fixed hangover decides the end of an utterance on its own, so its row stays.
    expect(labels).toContain(t('settingsVoice.mic.hangover'))
  })

  it('leaves the macOS voice as the only engine for a language Qwen3-TTS cannot read', async () => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'hi-IN' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(engineOptions(view)).toEqual(['system', 'none'])
  })

  it('renders the page with no engine selected when the saved one cannot speak the language', async () => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'en-US', ttsEngine: 'voicevox' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())

    expect(title(view)).toBe('声')
    // VOICEVOX is not among them, so the select shows no selection until the user picks an engine.
    expect(engineOptions(view)).toEqual(['qwen3tts', 'system', 'none'])
    // The speaker belongs to an engine this conversation cannot use, so it is neither shown nor fetched.
    expect(rowLabels(view)).not.toContain(t('settingsVoice.speech.speaker'))
    expect(api.listSpeakers).not.toHaveBeenCalled()
    // Opening the page changes nothing the user saved: the engine comes back when Japanese does.
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('offers no MaAI and counts no backchannel classifier, even with the aizuchi left on', async () => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'en-US', aizuchi: true, vapEnabled: true } })
    const view = await render()
    expect(pendingLabels(view)).toEqual([t('settingsModels.asr.title'), 'Agent', t('settingsConversation.models.apiKey', { provider: 'OpenAI' })])
    const optional = [...view.querySelectorAll(`[aria-label="${t('settingsOverview.optionalTitle')}"] .st-row-label`)].map((label) => label.textContent)
    expect(optional).not.toContain(t('settingsVoice.mic.turnTaking'))
  })
})

describe('settings dialog on Windows with a discrete GPU', () => {
  const macSetup = api.getSetupStatus.getMockImplementation()!
  const label = asrModelSpec('qwen3-asr-1.7b').label
  const hint = (view: HTMLElement, rowLabel: string): string | null | undefined =>
    [...view.querySelectorAll('.st-row')].find((row) => row.querySelector('.st-row-label')?.textContent === rowLabel)?.querySelector('.st-row-hint')?.textContent

  beforeEach(() => {
    setCapabilities(WINDOWS)
    // As main reports it on an 8 GB RTX 2080 with nothing downloaded yet.
    api.getSetupStatus.mockImplementation(async () => ({
      ...(await macSetup()),
      asr: { selectedModel: 'auto', resolvedModel: 'qwen3-asr-1.7b', recommendedModel: 'qwen3-asr-1.7b', label, totalMemoryGb: 8, modelInstalled: false, downloadGb: 2.52 }
    }) as never)
  })
  afterEach(() => {
    setCapabilities(MACOS)
    api.getSetupStatus.mockImplementation(macSetup)
  })

  it('offers the Qwen3-ASR models on the voice page, explained by the GPU memory', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const select = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.recognition.modelLabel')}"]`)!
    expect([...select.options].map((option) => option.textContent)).toEqual([
      t('settingsVoice.recognition.automatic.vulkan'),
      label,
      asrModelSpec('qwen3-asr-0.6b').label
    ])
    expect(hint(view, t('settingsVoice.recognition.model'))).toBe(
      t('settingsVoice.recognition.modelHint', { memoryGb: 8, model: label, reason: t('speechRecognition.recommendation.vulkan.larger', { memoryGb: 8 }) })
    )
  })

  it('offers to download the speech recognition on the voice page, under its model', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-prepline-text')?.textContent).toBe(t('settingsModels.asr.notDownloaded', { model: label }))
    expect(listening.querySelector('[data-prep="asr"]')?.textContent).toBe(t('settingsModels.prepare'))
  })
})

describe('the state of the speech models while the settings are open', () => {
  it('shows speech recognition as ready once main pushes that it answers, without the settings being opened again', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-prepline')).not.toBeNull()
    await act(async () => useStatusStore.setState({ status: { ...status, asr: true } }))
    expect(listening.querySelector('.st-chip')?.textContent).toBe(t('common.ready'))
    expect(listening.querySelector('.st-prepline')).toBeNull()
  })

  it('reads what is installed again when the Qwen3-TTS size changes, whose files may not be there', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const reads = api.getSetupStatus.mock.calls.length
    const select = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.model')}"]`)!
    await act(async () => {
      select.value = '1.7b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.getSetupStatus.mock.calls.length).toBe(reads + 1)
  })

  it('asks main to look for the agent CLI again when the settings open, and not when a speech model changes', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts' } })
    const view = await render()
    expect(api.recheckAgentCli).toHaveBeenCalledOnce()
    await act(async () => nav(view, 'voice').click())
    const reads = api.getSetupStatus.mock.calls.length
    const select = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.model')}"]`)!
    await act(async () => {
      select.value = '1.7b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.getSetupStatus.mock.calls.length).toBe(reads + 1)
    expect(api.recheckAgentCli).toHaveBeenCalledOnce()
  })

  it('shows a prepared local engine that is still loading as starting, without offering to download its model', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'irodori' } })
    useStatusStore.setState({ status: { ...status, ttsEngine: 'irodori', ttsStarting: true } })
    const view = await render()
    // The engine is not among the things that cannot work, beside the three this fixture lacks.
    expect(pendingLabels(view)).toEqual([t('settingsModels.asr.title'), 'Agent', t('settingsConversation.models.apiKey', { provider: 'OpenAI' })])
    await act(async () => nav(view, 'voice').click())
    const speech = view.querySelector(`[aria-label="${t('settingsVoice.speech.title')}"]`)!
    expect(speech.querySelector('.st-chip')?.textContent).toBe(t('settingsModels.starting'))
    expect(speech.querySelector('.st-prepline')).toBeNull()
    await act(async () => useStatusStore.setState({ status: { ...status, ttsEngine: 'irodori', tts: true } }))
    expect(speech.querySelector('.st-chip')).toBeNull()
    await act(async () => useStatusStore.setState({ status: { ...status, ttsEngine: 'irodori' } }))
    expect(speech.querySelector('.st-prepline-text')?.textContent).toBe(t('settingsModels.speech.localModel', { model: 'Irodori-TTS', sizeGb: '1.9' }))
  })
})

describe('choosing the voice of a local engine by listening', () => {
  const card = (view: HTMLElement, name: string): HTMLElement =>
    [...view.querySelectorAll<HTMLElement>('.st-voice')].find((one) => one.querySelector('.st-voice-name')?.textContent === name)!
  afterEach(() => vi.unstubAllGlobals())

  it('lists Irodori-TTS first for a Japanese conversation and saves the voice whose card is chosen', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'irodori' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const engines = [...view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!.options].map((option) => option.value)
    expect(engines).toEqual(['irodori', 'qwen3tts', 'voicevox', 'aivisspeech', 'system', 'none'])
    const voices = view.querySelector(`[role="radiogroup"][aria-label="${t('settingsVoice.speech.voice')}"]`)!
    expect([...voices.querySelectorAll('[role="radio"]')].map((radio) => [radio.querySelector('.st-voice-name')?.textContent, radio.getAttribute('aria-checked')])).toEqual(
      IRODORI_TTS_VOICES.map((voice) => [t(voice.label), String(voice.id === 'calm-young-woman')])
    )
    await act(async () => card(view, t('settingsVoice.speech.irodoriVoices.softYoungWoman')).querySelector<HTMLButtonElement>('[role="radio"]')!.click())
    expect(api.saveSettings).toHaveBeenCalledWith({ irodoriTtsVoice: 'soft-young-woman' })
  })

  it('plays the sample of a Qwen3-TTS voice read in the conversation language, and leaves the chosen voice as it is', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      return new Response(new Uint8Array([1, 2, 3]))
    })
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'en-US', ttsEngine: 'qwen3tts' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(card(view, 'Ryan').querySelector('.st-voice-detail')?.textContent).toBe(
      t('settingsVoice.speech.maleSpeaker', { language: new Intl.DisplayNames(['ja-JP'], { type: 'language' }).of('en') })
    )
    api.saveSettings.mockClear()
    await act(async () => card(view, 'Ryan').querySelector<HTMLButtonElement>('.st-voice-play')!.click())
    expect(fetched).toEqual([expect.stringMatching(/\/tts-voices\/qwen3tts\/en\/ryan\.mp3$/)])
    expect(vi.mocked(speechPlayer.playClip)).toHaveBeenLastCalledWith(btoa('\x01\x02\x03'), VOICE_SAMPLE_TEXT.en, { role: 'preview' })
    expect(api.saveSettings).not.toHaveBeenCalled()
  })
})

describe('the size of Qwen3-TTS on the voice page', () => {
  const sizeSelect = (view: HTMLElement): HTMLSelectElement | null => view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.model')}"]`)
  const openVoicePage = async (): Promise<HTMLElement> => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    return view
  }
  afterEach(() => setCapabilities(MACOS))

  it('offers 1.7B beside 0.6B on a Mac with 32 GB and saves the chosen size', async () => {
    const view = await openVoicePage()
    const select = sizeSelect(view)!
    expect([...select.options].map((option) => option.value)).toEqual(['0.6b', '1.7b'])
    await act(async () => {
      select.value = '1.7b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ qwenTtsSize: '1.7b' }))
  })

  it('offers no choice on an 8 GB GPU, where only 0.6B fits beside the speech recognition', async () => {
    setCapabilities(WINDOWS)
    const view = await openVoicePage()
    expect(sizeSelect(view)).toBeNull()
  })

  it('keeps a saved 1.7B that an 8 GB GPU does not offer in the list, so that 0.6B can be picked in its place', async () => {
    setCapabilities(WINDOWS)
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts', qwenTtsSize: '1.7b' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const select = sizeSelect(view)!
    expect(select.value).toBe('1.7b')
    expect([...select.options].map((option) => option.value)).toEqual(['0.6b', '1.7b'])
  })
})

describe('settings dialog on a machine without the local models, the native microphone or a calendar', () => {
  const macSetup = api.getSetupStatus.getMockImplementation()!
  const rowLabels = (view: HTMLElement): Array<string | null> => [...view.querySelectorAll('.st-row-label')].map((el) => el.textContent)
  const hint = (view: HTMLElement, label: string): string | null | undefined =>
    [...view.querySelectorAll('.st-row')].find((row) => row.querySelector('.st-row-label')?.textContent === label)?.querySelector('.st-row-hint')?.textContent

  beforeEach(() => {
    setCapabilities(WINDOWS_WITHOUT_GPU)
    // As in main, a machine without a runtime for the local speech recognition reports none.
    api.getSetupStatus.mockImplementation(async () => ({ ...(await macSetup()), asr: null }) as never)
  })
  afterEach(() => {
    setCapabilities(MACOS)
    api.getSetupStatus.mockImplementation(macSetup)
  })

  it('gives the reason in place of the recognition model, leaves out echo cancellation, noise suppression and the local engines, and keeps MaAI on the voice page', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const engines = [...view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!.options].map((option) => option.value)
    expect(engines).not.toContain('qwen3tts')
    expect(engines).not.toContain('irodori')
    expect(hint(view, t('settingsVoice.recognition.model'))).toBe(t('speechRecognition.unavailable.noDiscreteGpu'))
    expect(view.querySelector(`[aria-label="${t('settingsVoice.recognition.modelLabel')}"]`)).toBeNull()
    const labels = rowLabels(view)
    expect(labels).not.toContain(t('settingsVoice.mic.echoCancellation'))
    expect(labels).not.toContain(t('settingsVoice.mic.noiseSuppression'))
    expect(labels).toContain(t('settingsVoice.mic.turnTaking'))
    expect(hint(view, t('settingsVoice.mic.hotkey'))).toBe(t('settingsVoice.mic.hotkeyHint', { hotkey: shortcutLabel(WINDOWS_WITHOUT_GPU.os, WINDOWS_WITHOUT_GPU.hotkey) }))
  })

  it('says on the voice page and the overview that the GPU could not be checked when listing the devices failed', async () => {
    const key = 'speechRecognition.unavailable.gpuCheckFailed'
    setCapabilities({ ...WINDOWS_WITHOUT_GPU, localSpeech: { backend: null, reason: 'gpu-check-failed' } })
    const view = await render()
    expect(view.querySelector('[data-pending="browserWhisper"] .st-row-hint')?.textContent).toBe(t(key))
    await act(async () => nav(view, 'voice').click())
    expect(hint(view, t('settingsVoice.recognition.model'))).toBe(t(key))
  })

  it('offers Whisper in the browser as the speech recognition to prepare, and counts it like the rest', async () => {
    const view = await render()
    expect(pendingLabels(view)).toEqual([t('settingsModels.asr.browserWhisper'), 'Agent', t('settingsConversation.models.apiKey', { provider: 'OpenAI' })])
    expect(sub(view, 'overview')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 3 }))
    // Whisper is the speech recognition itself here, so it is not offered again as a feature to add.
    const optional = [...view.querySelectorAll(`[aria-label="${t('settingsOverview.optionalTitle')}"] .st-row-label`)].map((label) => label.textContent)
    expect(optional).not.toContain(t('settingsModels.asr.browserWhisper'))
  })

  it('counts speech recognition as prepared once Whisper in the browser is', async () => {
    useSettingsStore.setState({ settings: { ...settings, localAsrEnabled: true } })
    const view = await render()
    expect(pendingLabels(view)).toEqual(['Agent', t('settingsConversation.models.apiKey', { provider: 'OpenAI' })])
    expect(view.querySelector('.st-flow-tile[data-page="voice"] .st-chip')?.textContent).toBe(t('common.ready'))
  })

  it('shows Qwen3-TTS left in the settings as an engine this machine cannot run, never as something to prepare', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts', localAsrEnabled: true } })
    const view = await render()
    const reason = t('voice.speech.cannotRunHere', { engine: 'Qwen3-TTS' })
    expect(sub(view, 'voice')?.textContent).toBe(reason)
    expect(sub(view, 'voice')?.getAttribute('data-tone')).toBe('warn')
    const speech = view.querySelector('[data-pending="speech"]')!
    expect(speech.querySelector('.st-row-hint')?.textContent).toBe(reason)
    expect(speech.querySelector('[data-prep]')).toBeNull()

    await act(async () => nav(view, 'voice').click())
    expect(hint(view, t('settingsVoice.speech.engine'))).toBe(reason)
    expect([...view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!.options].map((option) => option.value)).not.toContain('qwen3tts')
  })

  it('offers the aizuchi that open a turn and the memory search, whose workers run on the CPU here too', async () => {
    useSettingsStore.setState({ settings: { ...settings, aizuchi: true, localAsrEnabled: true } })
    const view = await render()
    expect(nav(view, 'voice').querySelector('.st-nav-sub')?.textContent).toBe(
      t('settings.summary.voiceBackchannelOn', { engine: t('settings.ttsEngine.system.windows') })
    )
    expect(nav(view, 'memory').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.memorySemanticOff'))
    await act(async () => nav(view, 'voice').click())
    const labels = rowLabels(view)
    expect(labels).toContain(t('settingsVoice.response.aizuchi'))
    expect(labels).toContain(t('settingsVoice.response.aizuchiRate'))
    expect(labels).toContain(t('settingsVoice.response.listeningAizuchi'))
    await act(async () => nav(view, 'memory').click())
    expect(rowLabels(view)).toContain(t('settingsMemory.search.use'))
  })

  it('folds away nothing under a live engine, whose only details belong to the native microphone this machine lacks', async () => {
    useSettingsStore.setState({ settings: { ...settings, voiceEngine: 'gemini-live' } })
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(view.querySelector('.st-advanced')).toBeNull()
  })

  it('has the calendar on the calendar and mail page and in its summary, as a Mac does', async () => {
    const view = await render()
    expect(nav(view, 'connections').querySelector('.st-nav-title')?.textContent).toBe(t('settings.pages.connections'))
    expect(sub(view, 'connections')?.textContent).toBe(`${t('settings.summary.calendarOff')} · ${t('settings.summary.mailAccounts', { count: 0 })}`)
    await act(async () => nav(view, 'connections').click())
    expect(view.querySelector(`[aria-label="${t('settingsCalendar.title')}"]`)).not.toBeNull()
  })
})

describe('the global hotkey on the voice page', () => {
  it('says so when the OS refuses the keys, in the way this OS writes them', async () => {
    api.hotkeyStatus.mockResolvedValueOnce('failed')
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    await act(async () => {})
    const row = [...view.querySelectorAll('.st-row')].find((el) => el.querySelector('.st-row-label')?.textContent === t('settingsVoice.mic.hotkey'))
    expect(row?.querySelector('.st-row-hint')?.textContent).toBe(t('settingsVoice.mic.hotkeyFailed', { hotkey: '⌥Space' }))
  })

  it('gives the reason main could not tell the state of the keys', async () => {
    api.hotkeyStatus.mockRejectedValueOnce(new Error('settings.json is damaged'))
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    await act(async () => {})
    const row = [...view.querySelectorAll('.st-row')].find((el) => el.querySelector('.st-row-label')?.textContent === t('settingsVoice.mic.hotkey'))
    expect(row?.querySelector('.st-row-hint')?.textContent).toBe('settings.json is damaged')
  })
})

describe('settings dialog when main fails to report what is installed', () => {
  const row = (view: HTMLElement, label: string): Element =>
    [...view.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === label)!
  const hint = (one: Element): string | null | undefined => one.querySelector('.st-row-hint')?.textContent
  const chip = (one: Element): string | null | undefined => one.querySelector('.st-chip')?.textContent

  it('gives on the voice page the reason the recognition model and turn-taking could not be checked, instead of checking them for ever', async () => {
    api.getSetupStatus.mockRejectedValueOnce(new Error('the GPU could not be listed'))
    api.vapStatus.mockRejectedValueOnce(new Error('the MaAI environment is damaged'))
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(hint(row(view, t('settingsVoice.recognition.model')))).toBe('the GPU could not be listed')
    const turnTaking = row(view, t('settingsVoice.mic.turnTaking'))
    expect(chip(turnTaking)).toBe(t('settingsModels.checkFailed'))
    expect(hint(turnTaking)).toBe('the MaAI environment is damaged')
    expect(turnTaking.querySelector('[data-prep="vap"]')).toBeNull()
  })

  it('gives on the overview the reason semantic search could not be checked, and offers no preparation of it', async () => {
    api.embeddingStatus.mockRejectedValueOnce(new Error('the embedding environment is damaged'))
    const view = await render()
    const search = row(view, t('settingsMemory.search.title'))
    expect(chip(search)).toBe(t('settingsModels.checkFailed'))
    expect(hint(search)).toBe('the embedding environment is damaged')
    expect(search.querySelector('[data-prep="embedding"]')).toBeNull()
  })

  it('lists on the overview the features turned on whose state could not be checked, each with its reason, and counts them in the page list', async () => {
    useSettingsStore.setState({ settings: { ...settings, vapEnabled: true, aizuchi: true, memoryEmbeddingEnabled: true } })
    api.vapStatus.mockRejectedValueOnce(new Error('the MaAI environment is damaged'))
    api.aizuchiClassifierStatus.mockRejectedValueOnce(new Error('the classifier environment is damaged'))
    api.embeddingStatus.mockRejectedValueOnce(new Error('the embedding environment is damaged'))
    const view = await render()
    const kinds = [...view.querySelectorAll('[data-pending]')].map((one) => one.getAttribute('data-pending'))
    expect(kinds).toEqual(expect.arrayContaining(['turnTaking', 'aizuchi', 'semanticSearch']))
    const todo = (kind: string): Element => view.querySelector(`[data-pending="${kind}"]`)!
    expect([todo('turnTaking'), todo('aizuchi'), todo('semanticSearch')].map((one) => [hint(one), chip(one)])).toEqual([
      ['the MaAI environment is damaged', t('settingsModels.checkFailed')],
      ['the classifier environment is damaged', t('settingsModels.checkFailed')],
      ['the embedding environment is damaged', t('settingsModels.checkFailed')]
    ])
    expect(sub(view, 'voice')?.getAttribute('data-tone')).toBe('warn')
    expect(sub(view, 'memory')?.getAttribute('data-tone')).toBe('warn')
  })

  it('gives the reason the aizuchi classifier could not be checked under the aizuchi that are turned on', async () => {
    useSettingsStore.setState({ settings: { ...settings, aizuchi: true } })
    api.aizuchiClassifierStatus.mockRejectedValueOnce(new Error('the classifier environment is damaged'))
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(hint(row(view, t('settingsVoice.response.aizuchi')))).toBe('the classifier environment is damaged')
  })
})

describe('the models the about page credits', () => {
  const row = (view: HTMLElement, label: string): Element | undefined =>
    [...view.querySelectorAll('.st-row')].find((one) => one.querySelector('.st-row-label')?.textContent === label)
  const about = async (capabilities: PlatformCapabilities): Promise<HTMLElement> => {
    setCapabilities(capabilities)
    const view = await render()
    await act(async () => nav(view, 'about').click())
    return view
  }

  afterEach(() => setCapabilities(MACOS))

  it.each([
    ['a Mac', MACOS],
    ['Windows with a discrete GPU', WINDOWS]
  ] as const)('credits on %s the speech recognition models it runs, linked to their GGUF', async (_machine, capabilities) => {
    const view = await about(capabilities)
    for (const id of offeredAsrModels()) {
      const spec = asrModelSpec(id)
      const credit = row(view, `${spec.label} (GGUF)`)
      expect(credit?.querySelector('.st-row-hint')?.textContent).toBe(t('settingsAbout.use.asr'))
      expect(credit?.querySelector('a')?.getAttribute('href')).toBe(`https://huggingface.co/${spec.model.repo}`)
    }
  })

  it('credits no local speech recognition model on Windows without a GPU, and still the Whisper that runs in the window', async () => {
    const view = await about(WINDOWS_WITHOUT_GPU)
    for (const id of offeredAsrModels()) expect(row(view, `${asrModelSpec(id).label} (GGUF)`)).toBeUndefined()
    const whisperInWindow = CREDITS.find((credit) => credit.id === 'asrWhisperOnnx')!
    expect(row(view, whisperInWindow.name)?.querySelector('.st-row-hint')?.textContent).toBe(t('settingsAbout.use.asrWhisperOnnx'))
  })
})
