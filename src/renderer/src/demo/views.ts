import type { CalendarStatus } from '@shared/calendar'
import type { PreparationProgress, RendererApi } from '@shared/ipc'
import type { SettingsPage } from '@shared/mini-apps'
import type { LocalTtsEngine } from '@shared/tts-models'
import { dayKey } from '@shared/calendar-layout'
import { errorText } from '@shared/i18n/error-text'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { useConfirmStore } from '@/state/confirm'
import type { ScreenName } from './screens'
import { prepareSetupDemo } from './setup-demo'
import { DEMO_NOTES } from './fixtures/notes'
import { DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGES } from './fixtures/mail'
import { DEMO_CALENDAR_STATUS } from './fixtures/calendar'

/**
 * How the demo opens each screen and state. The names and how they appear in the list live in
 * screens.ts, and the entry point (index.tsx) looks them up here by name. Writing the links out
 * separately does not work: after a screen was renamed from diary to memory, the list still held the old
 * name and opening it failed.
 *
 * - prepare: replaces parts of the mock API before the app is rendered, as the first-run setup, the boot
 *   screen and the boot failure need.
 * - open: drives the stores to show a screen or a sheet.
 * - say: the utterances sent in order at startup.
 */
export interface DemoView {
  prepare?: (api: RendererApi) => void
  open?: () => void
  say?: string[]
}

const view = (): ReturnType<typeof useViewStore.getState> => useViewStore.getState()
const settingsPage = (page: SettingsPage): DemoView => ({ open: () => view().openApp({ app: 'settings', page }) })

/** The voice page with a local engine whose model is prepared, where its voices are chosen by listening. */
const localTtsVoices = (engine: LocalTtsEngine): DemoView => ({
  ...settingsPage('voice'),
  prepare: (api) => {
    void api.saveSettings({ ttsEngine: engine })
    const getStatus = api.getStatus
    api.getStatus = async () => ({ ...(await getStatus()), tts: true, ttsEngine: engine })
  }
})

/**
 * The calendar and mail page without a Google sign-in, or holding a sign-in another build saved. Signing
 * in from the page succeeds at once, and signing out goes back to the page without an account.
 */
const googleSignedOutSettings = (signIn: 'signedOut' | 'unreadable'): DemoView => ({
  prepare: (api) => {
    const signedOut: CalendarStatus = { signIn: 'signedOut', calendars: [], account: null }
    let status: CalendarStatus = { ...signedOut, signIn }
    api.calendarStatus = async () => status
    api.calendarRequestAccess = async () => (status = DEMO_CALENDAR_STATUS)
    api.calendarSignOut = async () => (status = signedOut)
    void api.saveSettings({ calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null } })
  },
  open: () => view().openApp({ app: 'settings', page: 'connections' })
})

/**
 * Semantic search on the memory page while its model downloads. The download stops at 40% and never
 * finishes, so the progress stays on the screen.
 */
const semanticSearchPreparing: DemoView = {
  prepare: (api) => {
    const notInstalled = api.embeddingStatus
    api.embeddingStatus = async () => ({ ...(await notInstalled()), runtimeInstalled: false, modelInstalled: false })
    let listener: ((progress: PreparationProgress) => void) | null = null
    api.onSetupProgress = (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    }
    api.embeddingPrepare = () => {
      setTimeout(() => listener?.({ target: 'embedding', status: 'downloading', pct: 40, downloadedMb: 54, totalMb: 135 }), 100)
      return new Promise(() => {})
    }
  },
  open: () => {
    view().openApp({ app: 'settings', page: 'memory' })
    clickWhenReady('[data-prep="embedding"]')
  }
}

/**
 * The settings when main cannot say what is installed, as when the folder of the models cannot be read.
 * Each row that waits on it says the check failed and gives the reason; the aizuchi are on so that the
 * classifier's row shows it too.
 */
const statusesUnreadable = (page: SettingsPage): DemoView => ({
  ...settingsPage(page),
  prepare: (api) => {
    const fail = (): Promise<never> => Promise.reject(new Error("EACCES: permission denied, scandir '/Users/demo/Library/Application Support/ASIST/models'"))
    api.getSetupStatus = fail
    api.vapStatus = fail
    api.embeddingStatus = fail
    api.aizuchiClassifierStatus = fail
    api.hotkeyStatus = fail
    void api.saveSettings({ aizuchi: true })
  }
})

/** The memory page right after semantic search is turned on: each reading of the count finds five more memories converted, up to 45. */
const memoriesConverting: DemoView = {
  prepare: (api) => {
    void api.saveSettings({ memoryEmbeddingEnabled: true })
    let embedded = 0
    api.embeddingStatus = async () => {
      const status = { runtimeInstalled: true, modelInstalled: true, running: true, enabled: true, converting: embedded < 45, embedded, total: 45, model: 'multilingual-e5-small' }
      embedded = Math.min(45, embedded + 5)
      return status
    }
  },
  ...settingsPage('memory')
}

/** The week view on the day of an event with its details open, as open_app places it from the conversation. */
async function openCalendarEvent(title: string): Promise<void> {
  const from = new Date()
  const events = await window.api.calendarEvents({ start: from.toISOString(), end: new Date(from.getTime() + 30 * 86_400_000).toISOString() })
  const event = events.find((candidate) => candidate.title === title)
  if (!event) throw new Error(`demo: 予定 ${title} が見つかりません`)
  view().openApp({ app: 'calendar', view: 'week', date: dayKey(new Date(event.start)), eventId: event.id })
}

let toastTimer: ReturnType<typeof setInterval> | undefined

/** A toast disappears after five seconds, so they are pushed again while someone is looking at them. */
function showToasts(): void {
  const push = (): void => {
    const toasts = useToastStore.getState()
    toasts.push({ kind: 'ok', title: translate('voice.services.title'), body: [translate('voice.services.recognitionBack'), translate('voice.services.speechBack')].join(' · ') })
    toasts.push({ kind: 'info', title: translate('voice.engineChanged.title'), body: translate('voice.engineChanged.body') })
    toasts.push({ kind: 'error', title: translate('conversation.sendFailed'), body: translate('conversation.reply.network') })
    // A long error, which the toast cuts at two lines until the pointer rests on it.
    const unreadable = errorText('settings.errors.readFailed', {
      file: '/Users/demo/Library/Application Support/ASIST/settings.json',
      message: errorText('app.storage.versionTooNew', { file: 'settings.json', version: 9, supported: 4 })
    })
    toasts.push({ kind: 'error', title: translate('app.status.checkFailed'), body: displayError(new Error(unreadable)) })
  }
  // Opened again after a change of language, the next push is already in that language.
  if (toastTimer) return
  push()
  toastTimer = setInterval(push, 5000)
}

export const DEMO_VIEWS: Record<ScreenName, DemoView> = {
  conversation: {},
  'conversation/cards': { say: ['長野県の今日の天気を教えて', 'ドル円のレートを教えて'] },
  calendar: { open: () => view().openApp({ app: 'calendar' }) },
  settings: { open: () => view().openApp({ app: 'settings' }) },
  jobs: { open: () => view().openApp({ app: 'jobs' }) },
  tasks: { open: () => view().openApp({ app: 'tasks' }) },
  mail: { open: () => view().openApp({ app: 'mail' }) },
  memory: { open: () => view().openApp({ app: 'memory' }) },
  notes: { open: () => view().openApp({ app: 'notes' }) },
  'notes/note': { open: () => view().openApp({ app: 'notes', noteId: DEMO_NOTES[2].id }) },
  'mail/message': { open: () => view().openApp({ app: 'mail', messageId: DEMO_MAIL_MESSAGES[0].id }) },
  'mail/draft-started': { open: () => view().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[2].id }) },
  'calendar/event': { open: () => void openCalendarEvent('リリース判定') },

  'settings/conversation': settingsPage('conversation'),
  'settings/voice': settingsPage('voice'),
  'settings/voice/irodori': localTtsVoices('irodori'),
  'settings/voice/qwen3tts': localTtsVoices('qwen3tts'),
  'settings/persona': settingsPage('persona'),
  'settings/memory': settingsPage('memory'),
  'settings/agent': settingsPage('agent'),
  'settings/connections': settingsPage('connections'),
  'settings/connections/google-signed-out': googleSignedOutSettings('signedOut'),
  'settings/connections/google-unreadable': googleSignedOutSettings('unreadable'),
  'settings/language': settingsPage('language'),
  'settings/appearance': settingsPage('appearance'),
  'settings/api-keys': settingsPage('apiKeys'),
  'settings/usage': settingsPage('usage'),
  'settings/about': settingsPage('about'),
  'settings/memory/preparing': semanticSearchPreparing,
  'settings/memory/converting': memoriesConverting,
  'settings/check-failed': statusesUnreadable('overview'),
  'settings/voice/check-failed': statusesUnreadable('voice'),

  setup: { prepare: (api) => prepareSetupDemo(api, 'fresh') },
  'setup/key-failed': { prepare: (api) => prepareSetupDemo(api, 'key-failed') },
  'setup/mic-denied': { prepare: (api) => prepareSetupDemo(api, 'mic-denied') },
  'setup/tts-missing': { prepare: (api) => prepareSetupDemo(api, 'tts-missing') },
  'setup/live-key-failed': { prepare: (api) => prepareSetupDemo(api, 'live-key-failed') },
  // Someone who finished the setup before the notice of the risks existed sees it once at launch.
  safety: { prepare: (api) => void api.saveSettings({ safetyNoticeVersion: 0 }) },
  boot: {
    // While the status request never resolves, the app stays on the boot screen.
    prepare: (api) => {
      api.getStatus = () => new Promise(() => {})
    }
  },
  'boot/error': {
    prepare: (api) => {
      api.getStatus = async () => {
        throw new Error(errorText('app.startup.envUnreadable', { file: '/Users/demo/src/asist/.env', detail: 'EACCES: permission denied' }))
      }
    }
  },
  confirm: {
    open: () =>
      useConfirmStore.getState().open({
        id: 'demo-confirm',
        title: translate('mail.confirm.title'),
        message: translate('mail.confirm.message'),
        detail: [
          translate('mail.confirm.send', { label: '仕事', email: 'me@example.com' }),
          translate('mail.confirm.to', { addresses: '田中 一郎 <tanaka@example.com>' }),
          translate('mail.confirm.subject', { subject: '来週の打合せについて' }),
          translate('mail.confirm.body', { body: '火曜の14時でお願いします。場所は前回と同じ会議室で大丈夫です。' })
        ].join('\n\n'),
        confirmLabel: translate('mail.confirm.action.send'),
        destructive: false,
        holdsConversation: true
      })
  },
  toasts: { open: showToasts }
}

/** Waits until the element is rendered and then presses it, to reach a state inside a screen such as one page of the settings. */
export function clickWhenReady(selector: string): void {
  const started = Date.now()
  const timer = setInterval(() => {
    const target = document.querySelector<HTMLElement>(selector)
    if (target) {
      clearInterval(timer)
      target.click()
    } else if (Date.now() - started > 10_000) {
      clearInterval(timer)
      throw new Error(`demo: ${selector} が見つかりません`)
    }
  }, 50)
}
