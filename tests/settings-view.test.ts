// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, AppStatus, EmbeddingStatus, HotkeyStatus, MemoryOverview, SetupProgress } from '@shared/ipc'
import { defaultPersona } from '@shared/persona'
import { CONVERSATION_LOCALES } from '@shared/conversation-locale'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { SETTINGS_PAGES } from '@shared/mini-apps'
import { THEMES } from '@shared/themes'
import { hotkeyLabel } from '@shared/platform'
import { localDate, type UsageDay } from '@shared/api-usage'
import { SettingsDialog } from '../src/renderer/src/ui/SettingsDialog'
import { useSettingsStore, useStatusStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

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
  gptLive: { model: 'gpt-live-1', voice: 'marin' },
  geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' },
  liveIdleSeconds: 90,
  persona: defaultPersona('ja-JP'),
  conversationLocale: 'ja-JP',
  region: 'JP',
  conversationLogRetentionDays: 90,
  ttsEngine: 'system',
  voicevoxSpeaker: 1,
  aivisSpeaker: null,
  bargeIn: true,
  aizuchi: false,
  aizuchiRate: 0.85,
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
  llm: true,
  conversationModel: { provider: 'openai', id: 'gpt-5.6-luna' },
  llmKeys: { anthropic: 'verified', openai: 'missing', google: 'missing', cerebras: 'saved' },
  tts: false,
  ttsEngine: 'system',
  ttsLabel: 'macOS',
  asr: false,
  agent: false,
  agentEngine: 'codex',
  voiceEngine: 'cascade',
  live: 'off'
}

const embeddingReady: EmbeddingStatus = { runtimeInstalled: true, modelInstalled: true, running: false, enabled: false, converting: false, embedded: 3, total: 4, model: 'multilingual-e5-small' }

const api = {
  saveSettings: vi.fn(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch })),
  getStatus: vi.fn(async () => status),
  getSetupStatus: vi.fn(async () => ({
    services: status,
    asr: {
      selectedModel: 'auto',
      resolvedModel: 'qwen3-asr-1.7b-mlx',
      recommendedModel: 'qwen3-asr-1.7b-mlx',
      label: 'Qwen3-ASR 1.7B 8-bit MLX',
      recommendationReason: '32GBメモリではQwen3-ASRを推奨します。',
      totalMemoryGb: 32,
      runtimeInstalled: false,
      modelInstalled: false,
      ready: false
    }
  })),
  vapStatus: vi.fn(async () => ({ runtimeInstalled: false, modelsInstalled: false, running: false })),
  embeddingStatus: vi.fn(async (): Promise<EmbeddingStatus> => embeddingReady),
  aizuchiClassifierStatus: vi.fn(async () => ({ runtimeInstalled: true, modelInstalled: false, running: false })),
  calendarStatus: vi.fn(async () => ({ authorization: 'notDetermined', calendars: [] })),
  memoryOverview: vi.fn(async (): Promise<MemoryOverview> => ({ dir: '', units: 0, pages: 0, curatedThrough: null, pendingJobId: null, lastFailure: null, unavailableReason: null })),
  listSpeakers: vi.fn(async () => []),
  hotkeyStatus: vi.fn(async (): Promise<HotkeyStatus> => 'registered'),
  embeddingPrepare: vi.fn(async () => ({ ok: true, message: '' })),
  onSetupProgress: vi.fn((_callback: (p: SetupProgress) => void) => () => {}),
  openExternal: vi.fn(async () => {}),
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
  api.embeddingStatus.mockReset().mockImplementation(async () => embeddingReady)
  api.embeddingPrepare.mockReset().mockImplementation(async () => ({ ok: true, message: '' }))
  useSettingsStore.setState({ settings })
  useStatusStore.setState({ status })
  useToastStore.setState({ toasts: [] })
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

describe('settings dialog', () => {
  it('lists the pages in order, each with its summary line, and the count of items that still need setup', async () => {
    const view = await render()
    expect([...view.querySelectorAll('.st-nav-title')].map((el) => el.textContent)).toEqual(SETTINGS_PAGES.map((page) => t(`settings.pages.${page}`)))
    expect(nav(view, 'appearance').querySelector('.st-nav-sub')?.textContent).toBe(t('settingsAppearance.themes.future.name'))
    expect(nav(view, 'usage').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.usage', { amount: '$1.50' }))
    expect(nav(view, 'conversation').querySelector('.st-nav-sub')?.textContent).toBe('OpenAI · GPT-5.6 Luna')
    expect(nav(view, 'agent').querySelector('.st-nav-sub')?.textContent).toBe('Codex · Approve for me')
    expect(nav(view, 'integrations').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.integrationsCalendarOff', { keys: 2, total: 4 }))
    // Speech recognition, the Agent CLI, MaAI and the aizuchi classifier still need setup. TTS is not counted
    // because it runs on macOS, and semantic search is ready.
    const setup = nav(view, 'models').querySelector('.st-nav-sub')
    expect(setup?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 4 }))
    expect(setup?.getAttribute('data-tone')).toBe('warn')
    expect(title(view)).toBe(t('settingsConversation.title'))
    expect(view.querySelector('.st-page .st-chip')?.textContent).toBe(t('settingsIntegrations.apiKeys.notSet'))
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

  it('moves from the voice page to the models page, which shows the state of each component', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    expect(title(view)).toBe('声')
    const listening = view.querySelector(`[aria-label="${t('settingsVoice.recognition.title')}"]`)!
    expect(listening.querySelector('.st-chip')?.textContent).toBe(t('common.notReady'))
    await act(async () => listening.querySelector<HTMLButtonElement>('.st-link')!.click())
    expect(title(view)).toBe(t('settingsModels.title'))
    const cards = [...view.querySelectorAll('.st-prep-card')].map((card) => [card.getAttribute('aria-label'), card.getAttribute('data-state')])
    expect(cards).toEqual([
      [t('settingsModels.asr.title'), 'missing'],
      [t('settingsModels.speech.title'), 'ready'],
      [t('settingsModels.agent.title'), 'missing'],
      [t('settingsModels.turnTaking.title'), 'missing'],
      [t('settingsModels.backchannel.title'), 'missing'],
      [t('settingsModels.semanticSearch.title'), 'ready']
    ])
    expect(nav(view, 'models').getAttribute('aria-pressed')).toBe('true')
  })

  it('saves the conversation language together with a speech engine that can read it, and the region on its own', async () => {
    // VOICEVOX reads Japanese only, so the engine has to move with the language.
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'voicevox' } })
    const view = await render()
    const language = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsConversation.language.conversation')}"]`)!
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

    const region = view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsConversation.language.region')}"]`)!
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

  it('saves a switch change to main and opens the key field only when a key is being entered', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const mic = view.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsVoice.mic.title')}"] [role="switch"]`)!
    await act(async () => mic.click())
    expect(api.saveSettings).toHaveBeenCalledWith({ micAutoStart: true })

    await act(async () => nav(view, 'integrations').click())
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
    useStatusStore.setState({ status: { ...status, llmKeys: { ...status.llmKeys, openai: 'unreadable', cerebras: 'unreadable' } } })
    useSettingsStore.setState({ settings: { ...settings, voiceEngine: 'gpt-live' } })
    const view = await render()
    expect(nav(view, 'integrations').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.integrationsCalendarOff', { keys: 1, total: 4 }))
    // The conversation model's row and the GPT-Live row both show the OpenAI key.
    const keyRows = [...view.querySelectorAll('.st-row')].filter(
      (row) => row.querySelector('.st-row-label')?.textContent === t('settingsConversation.models.apiKey', { provider: 'OpenAI' })
    )
    expect(keyRows.map((row) => [row.querySelector('.st-chip')?.textContent, row.querySelector('.st-row-hint')?.textContent])).toEqual([
      [t('settingsIntegrations.apiKeys.unreadable'), t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'OpenAI' })],
      [t('settingsIntegrations.apiKeys.unreadable'), t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'OpenAI' })]
    ])
    await act(async () => nav(view, 'integrations').click())
    const row = view.querySelector('.st-key[data-provider="openai"]')!
    expect(row.querySelector('.st-chip')?.textContent).toBe(t('settingsIntegrations.apiKeys.unreadable'))
    expect(row.querySelector('.st-btn')?.textContent).toBe(t('settingsIntegrations.apiKeys.register'))
  })

  it('reports a status check that fails instead of keeping the last status without a word', async () => {
    api.getStatus.mockRejectedValueOnce(new Error('api-keys.json is damaged'))
    await useStatusStore.getState().refresh()
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error', title: t('app.status.checkFailed'), body: 'api-keys.json is damaged' }])
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
    await act(async () => nav(view, 'conversation').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsConversation.log.retentionLabel')}"]`)!
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
    await act(async () => nav(view, 'conversation').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsConversation.log.retentionLabel')}"]`)!
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
    expect(hint()).toBe(t('settingsConversation.log.retentionHint'))
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
    await act(async () => nav(view, 'conversation').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsConversation.log.retentionLabel')}"]`)!
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
    await act(async () => nav(view, 'conversation').click())
    const days = view.querySelector<HTMLInputElement>(`[aria-label="${t('settingsConversation.log.retentionLabel')}"]`)!
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
  const card = (view: HTMLElement, key: Parameters<typeof t>[0]): HTMLElement => view.querySelector<HTMLElement>(`.st-prep-card[aria-label="${t(key)}"]`)!

  it('shows the download progress on the card being prepared and on no other card', async () => {
    api.embeddingStatus.mockImplementation(async () => ({ ...embeddingReady, runtimeInstalled: false, modelInstalled: false, embedded: 0, total: 45 }))
    let finish!: (result: { ok: boolean; message: string }) => void
    api.embeddingPrepare.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = await render()
    const emit = api.onSetupProgress.mock.calls[0][0]
    await act(async () => nav(view, 'models').click())

    await act(async () => card(view, 'settingsModels.semanticSearch.title').querySelector<HTMLButtonElement>('.st-btn')!.click())
    await act(async () => emit({ status: 'downloading', pct: 40, downloadedMb: 54, totalMb: 135 }))
    const bars = [...view.querySelectorAll('[role="progressbar"]')].map((bar) => [bar.closest('.st-prep-card')?.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')])
    expect(bars).toEqual([[t('settingsModels.semanticSearch.title'), '40']])
    const asrButton = card(view, 'settingsModels.asr.title').querySelector<HTMLButtonElement>('.st-btn')!
    expect(asrButton.textContent).toBe(t('settingsModels.prepare'))
    // Only one preparation runs at a time, so the other items wait until this one ends.
    expect(asrButton.disabled).toBe(true)
    expect(card(view, 'settingsModels.semanticSearch.title').querySelector('.st-btn')?.textContent).toBe(t('common.preparing'))

    await act(async () => finish({ ok: true, message: '' }))
    expect(api.saveSettings).toHaveBeenCalledWith({ memoryEmbeddingEnabled: true })
    expect(view.querySelector('[role="progressbar"]')).toBeNull()
    expect(asrButton.disabled).toBe(false)
  })

  it('ignores progress that arrives while nothing on this screen is being prepared', async () => {
    const view = await render()
    const emit = api.onSetupProgress.mock.calls[0][0]
    await act(async () => nav(view, 'models').click())
    await act(async () => emit({ status: 'downloading', pct: 10, downloadedMb: 1, totalMb: 10 }))
    expect(view.querySelector('[role="progressbar"]')).toBeNull()
    expect(card(view, 'settingsModels.asr.title').querySelector<HTMLButtonElement>('.st-btn')!.disabled).toBe(false)
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

  it('shows no card for MaAI or the backchannel classifier and counts neither as needing preparation', async () => {
    useSettingsStore.setState({ settings: { ...settings, conversationLocale: 'en-US' } })
    const view = await render()
    await act(async () => nav(view, 'models').click())

    expect([...view.querySelectorAll('.st-prep-card')].map((card) => card.getAttribute('aria-label'))).toEqual([
      t('settingsModels.asr.title'),
      t('settingsModels.speech.title'),
      t('settingsModels.agent.title'),
      t('settingsModels.semanticSearch.title')
    ])
    // Only speech recognition and the Agent CLI are left to prepare.
    expect(nav(view, 'models').querySelector('.st-nav-sub')?.textContent).toBe(
      t('settings.summary.modelsNotPrepared', { count: 2 })
    )
    expect(nav(view, 'voice').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.ttsEngine.system.macos'))
  })
})

describe('settings dialog on a machine without the local models, the Python workers, the native microphone or a calendar', () => {
  const macSetup = api.getSetupStatus.getMockImplementation()!
  const rowLabels = (view: HTMLElement): Array<string | null> => [...view.querySelectorAll('.st-row-label')].map((el) => el.textContent)
  const hint = (view: HTMLElement, label: string): string | null | undefined =>
    [...view.querySelectorAll('.st-row')].find((row) => row.querySelector('.st-row-label')?.textContent === label)?.querySelector('.st-row-hint')?.textContent

  beforeEach(() => {
    setCapabilities(WINDOWS)
    // As in main, a machine without a runtime for the local speech recognition reports none.
    api.getSetupStatus.mockImplementation(async () => ({ ...(await macSetup()), asr: null }) as never)
  })
  afterEach(() => {
    setCapabilities(MACOS)
    api.getSetupStatus.mockImplementation(macSetup)
  })

  it('gives the reason in place of the recognition model and leaves out echo cancellation, noise suppression, MaAI and Qwen3-TTS on the voice page', async () => {
    const view = await render()
    await act(async () => nav(view, 'voice').click())
    const engines = [...view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!.options].map((option) => option.value)
    expect(engines).not.toContain('qwen3tts')
    expect(hint(view, t('settingsVoice.recognition.model'))).toBe(t('speechRecognition.unavailable.unsupportedOs'))
    expect(view.querySelector(`[aria-label="${t('settingsVoice.recognition.modelLabel')}"]`)).toBeNull()
    const labels = rowLabels(view)
    expect(labels).not.toContain(t('settingsVoice.mic.echoCancellation'))
    expect(labels).not.toContain(t('settingsVoice.mic.noiseSuppression'))
    expect(labels).not.toContain(t('settingsVoice.mic.turnTaking'))
    expect(hint(view, t('settingsVoice.mic.hotkey'))).toBe(t('settingsVoice.mic.hotkeyHint', { hotkey: hotkeyLabel(WINDOWS) }))
  })

  it('prepares nothing the machine cannot run, and counts only what it can', async () => {
    const view = await render()
    // Of what this machine runs, the Agent CLI and speech recognition, here Whisper in the browser, are missing.
    expect(nav(view, 'models').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 2 }))
    await act(async () => nav(view, 'models').click())
    const cards = [...view.querySelectorAll('.st-prep-card')]
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([t('settingsModels.asr.title'), t('settingsModels.speech.title'), t('settingsModels.agent.title')])
    expect(cards.map((card) => card.getAttribute('data-state'))).toEqual(['missing', 'ready', 'missing'])
    expect(cards[0].querySelector('p')?.textContent).toBe(t('speechRecognition.unavailable.unsupportedOs'))
    expect(cards[0].textContent).not.toContain(t('settingsModels.asr.chooseModel'))
  })

  it('counts speech recognition as prepared once Whisper in the browser is, as its card shows', async () => {
    useSettingsStore.setState({ settings: { ...settings, localAsrEnabled: true } })
    const view = await render()
    expect(nav(view, 'models').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 1 }))
    await act(async () => nav(view, 'models').click())
    expect(view.querySelector(`.st-prep-card[aria-label="${t('settingsModels.asr.title')}"]`)?.getAttribute('data-state')).toBe('ready')
  })

  it('shows Qwen3-TTS left in the settings as an engine this machine cannot run, never as something to prepare', async () => {
    useSettingsStore.setState({ settings: { ...settings, ttsEngine: 'qwen3tts' } })
    const view = await render()
    const reason = t('voice.speech.cannotRunHere', { engine: 'Qwen3-TTS' })
    expect(nav(view, 'models').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.modelsNotPrepared', { count: 2 }))
    expect(nav(view, 'voice').querySelector('.st-nav-sub')?.textContent).toBe(reason)
    expect(nav(view, 'voice').querySelector('.st-nav-sub')?.getAttribute('data-tone')).toBe('warn')

    await act(async () => nav(view, 'models').click())
    const card = view.querySelector(`.st-prep-card[aria-label="${t('settingsModels.speech.title')}"]`)!
    expect(card.querySelector('p')?.textContent).toBe(reason)
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).not.toContain(t('settingsModels.prepare'))

    await act(async () => nav(view, 'voice').click())
    expect(hint(view, t('settingsVoice.speech.engine'))).toBe(reason)
    expect([...view.querySelector<HTMLSelectElement>(`[aria-label="${t('settingsVoice.speech.engineLabel')}"]`)!.options].map((option) => option.value)).not.toContain('qwen3tts')
  })

  it('offers no aizuchi to open a turn without its classifier, keeps the ones while the user speaks, and names the curation for the memory', async () => {
    useSettingsStore.setState({ settings: { ...settings, aizuchi: true } })
    const view = await render()
    expect(nav(view, 'voice').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.ttsEngine.system.windows'))
    expect(nav(view, 'memory').querySelector('.st-nav-sub')?.textContent).toBe(t('settingsMemory.curation.title'))
    await act(async () => nav(view, 'voice').click())
    const labels = rowLabels(view)
    expect(labels).not.toContain(t('settingsVoice.response.aizuchi'))
    expect(labels).not.toContain(t('settingsVoice.response.aizuchiRate'))
    expect(labels).toContain(t('settingsVoice.response.listeningAizuchi'))
  })

  it('leaves the calendar out of the integrations and of their summary', async () => {
    const view = await render()
    expect(nav(view, 'integrations').querySelector('.st-nav-sub')?.textContent).toBe(t('settings.summary.integrationsKeys', { keys: 2, total: 4 }))
    await act(async () => nav(view, 'integrations').click())
    expect(view.querySelector(`[aria-label="${t('settingsCalendar.title')}"]`)).toBeNull()
    expect(api.calendarStatus).not.toHaveBeenCalled()
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
})
