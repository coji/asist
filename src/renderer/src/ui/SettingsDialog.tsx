import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Brain,
  CalendarDays,
  ChartColumn,
  Info,
  KeyRound,
  Languages,
  LayoutDashboard,
  MessageSquare,
  Mic,
  Palette,
  UserRound,
  X,
  type LucideIcon
} from 'lucide-react'
import { keyReadable, type AizuchiClassifierStatus, type EmbeddingStatus, type SetupStatus, type VapStatus } from '@shared/ipc'
import { LLM_PROVIDERS, modelLabel } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { isDefaultPersona } from '@shared/persona'
import { UI_LOCALE_NAMES } from '@shared/i18n'
import { conversationFeatures } from '@shared/conversation-locale'
import { voiceController } from '@/voice/VoiceController'
import { useSettingsStore, useStatusStore, useToastStore } from '@/state/stores'
import { useMiniApp, useViewStore } from '@/state/view'
import { useFormatLocale, useT, useUiLocale } from '@/i18n'
import { localDate } from '@shared/api-usage'
import { usageReport } from '@shared/usage-report'
import { connectionsTitle, ttsEngineLabel, type Preparation, type PreparationTarget, type SettingsContext, type SettingsPage } from './settings/context'
import { pendingItems, type Pending } from './settings/pending'
import { ConversationPage } from './settings/pages/ConversationPage'
import { PersonaPage } from './settings/pages/PersonaPage'
import { VoicePage } from './settings/pages/VoicePage'
import { AppearancePage } from './settings/pages/AppearancePage'
import { MemoryPage } from './settings/pages/MemoryPage'
import { AgentPage } from './settings/pages/AgentPage'
import { ApiKeysPage } from './settings/pages/ApiKeysPage'
import { ConnectionsPage } from './settings/pages/ConnectionsPage'
import { LanguagePage } from './settings/pages/LanguagePage'
import { OverviewPage } from './settings/pages/OverviewPage'
import { AboutPage } from './settings/pages/AboutPage'
import { UsagePage } from './settings/pages/UsagePage'
import { usdFormatter } from './settings/usage-format'
import { displayError } from '@/display-error'
import { platformCapabilities } from '@/platform'
import { AGENT_MODE_NAME } from '@shared/agent-cli'

/**
 * The settings screen, with the list of pages on the left and the chosen page on the right. It opens on
 * the overview, and the other pages follow under three headings. Saving, reloading the status and the
 * progress of a model preparation belong here and reach the pages as a SettingsContext.
 */

const ICONS: Record<SettingsPage, LucideIcon> = {
  overview: LayoutDashboard,
  conversation: MessageSquare,
  voice: Mic,
  persona: UserRound,
  memory: Brain,
  agent: Bot,
  connections: CalendarDays,
  language: Languages,
  appearance: Palette,
  apiKeys: KeyRound,
  usage: ChartColumn,
  about: Info
}

const SECTIONS: Array<{ title: 'assistant' | 'features' | 'general' | null; pages: SettingsPage[] }> = [
  { title: null, pages: ['overview'] },
  { title: 'assistant', pages: ['conversation', 'voice', 'persona'] },
  { title: 'features', pages: ['memory', 'agent', 'connections'] },
  { title: 'general', pages: ['language', 'appearance', 'apiKeys', 'usage', 'about'] }
]

const IDLE: Preparation = { busy: false, target: null, progress: null, message: '', localAsr: null }
/** How often the memory page reads the count again while memories are being converted. */
const EMBEDDING_POLL_MS = 1_000

/** App passes `open`, so the dialog keeps drawing through the closing animation even after the store says it is closed. */
export function SettingsDialog({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const update = useViewStore((s) => s.update)
  const { page } = useMiniApp('settings')
  const setPage = (next: SettingsPage): void => update('settings', { page: next })
  const { settings, save } = useSettingsStore()
  const refreshStatus = useStatusStore((s) => s.refresh)
  const status = useStatusStore((s) => s.status)
  const applyStatus = useStatusStore((s) => s.apply)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [prep, setPrep] = useState<Preparation>(IDLE)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [vap, setVap] = useState<VapStatus | null>(null)
  const [embedding, setEmbedding] = useState<EmbeddingStatus | null>(null)
  const [aizuchiClassifier, setAizuchiClassifier] = useState<AizuchiClassifierStatus | null>(null)
  const [last30, setLast30] = useState<number | null>(null)
  const formatLocale = useFormatLocale()
  const uiLocale = useUiLocale()
  const mainRef = useRef<HTMLDivElement>(null)

  // A new page starts at the top, because the same frame is reused and keeps the scroll position of
  // the page before it.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [page])

  useEffect(
    () =>
      window.api.onSetupProgress((p) => {
        // The first-run setup sends its progress on the same channel, and none of it belongs to an item here.
        setPrep((current) => {
          if (current.target === null) return current
          return p.status === 'downloading' ? { ...current, progress: p } : { ...current, progress: null, message: p.message ?? current.message }
        })
      }),
    []
  )

  const refreshSetup = async (): Promise<void> => {
    const next = await window.api.getSetupStatus()
    setSetup(next)
    applyStatus(next.services)
  }
  const refreshEmbedding = async (): Promise<void> => setEmbedding(await window.api.embeddingStatus())
  // What is installed and recommended follows the models the settings name, so it is read again whenever
  // one of them changes, from whichever page changed it.
  useEffect(() => {
    if (!open) return
    void refreshSetup().catch(() => setSetup(null))
  }, [open, settings?.asrModel, settings?.ttsEngine, settings?.qwenTtsSize])
  useEffect(() => {
    if (!open) return
    void window.api.vapStatus().then(setVap).catch(() => setVap(null))
    void window.api.embeddingStatus().then(setEmbedding).catch(() => setEmbedding(null))
    void window.api.aizuchiClassifierStatus().then(setAizuchiClassifier).catch(() => setAizuchiClassifier(null))
    void window.api
      .apiUsage()
      .then((days) => setLast30(usageReport(days, localDate(new Date()), 30, 'kind').totalUsd))
      .catch(() => setLast30(null))
  }, [open])

  // The main process converts the memories in the background after semantic search is turned on or
  // prepared, and says nothing when it finishes, so the count is read again until the conversion ends.
  const converting = open && embedding?.converting === true
  useEffect(() => {
    if (!converting) return
    const timer = setTimeout(() => void refreshEmbedding().catch(() => setEmbedding(null)), EMBEDDING_POLL_MS)
    return () => clearTimeout(timer)
  }, [converting, embedding])

  if (!settings) return <></>

  const set = (patch: Parameters<typeof save>[0]): Promise<boolean> =>
    save(patch).then(
      () => {
        void refreshStatus()
        // Turning semantic search on starts the conversion of the memories in the main process.
        if ('memoryEmbeddingEnabled' in patch) void refreshEmbedding().catch(() => setEmbedding(null))
        return true
      },
      (err: unknown) => {
        toast({ kind: 'error', title: t('settings.saveFailed'), body: displayError(err) })
        return false
      }
    )

  /** Runs a preparation that downloads something. Only one runs at a time, and its message appears on the models page. */
  const runPreparation = async (
    target: PreparationTarget,
    operation: () => Promise<{ ok: boolean; message: string }>,
    after?: (ok: boolean) => Promise<void> | void
  ): Promise<void> => {
    if (prep.busy) return
    setPrep({ ...IDLE, busy: true, target, progress: { status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0 } })
    try {
      const result = await operation()
      setPrep((current) => ({ ...current, message: result.message }))
      await after?.(result.ok)
    } catch (error) {
      setPrep((current) => ({ ...current, message: displayError(error) }))
    } finally {
      setPrep((current) => ({ ...current, busy: false, target: null, progress: null }))
    }
  }
  const prepare: SettingsContext['prepare'] = {
    asr: () =>
      void runPreparation(
        'asr',
        () => window.api.prepareAsrModel(settings.asrModel),
        async () => {
          await refreshStatus()
          await refreshSetup()
        }
      ),
    cancelAsr: () => void window.api.cancelAsrPreparation(),
    localAsr: () => {
      if (prep.localAsr !== null) return
      setPrep((current) => ({ ...current, message: '', localAsr: 0 }))
      void voiceController
        .prepareLocalAsr(({ progress }) => setPrep((current) => ({ ...current, localAsr: progress })))
        .then(() => save({ localAsrEnabled: true }))
        .then(() => refreshStatus())
        .then(() => setPrep((current) => ({ ...current, message: t('settings.localAsrPrepared') })))
        .catch((err: unknown) => setPrep((current) => ({ ...current, message: displayError(err) })))
        .finally(() => setPrep((current) => ({ ...current, localAsr: null })))
    },
    cancelLocalAsr: () => voiceController.cancelLocalAsrPreparation(),
    tts: () =>
      void runPreparation(
        'tts',
        () => window.api.prepareTtsModel(),
        async () => {
          await refreshStatus()
          await refreshSetup()
        }
      ),
    vap: () =>
      void runPreparation(
        'vap',
        () => window.api.vapPrepare(),
        async (ok) => {
          setVap(await window.api.vapStatus())
          if (ok) set({ vapEnabled: true })
        }
      ),
    embedding: () =>
      void runPreparation(
        'embedding',
        () => window.api.embeddingPrepare(),
        async (ok) => {
          // The setting is saved before the count is read, so that the status already reports the
          // conversion the save starts.
          if (ok) await save({ memoryEmbeddingEnabled: true })
          await refreshEmbedding()
        }
      ),
    aizuchiClassifier: () =>
      void runPreparation(
        'aizuchiClassifier',
        () => window.api.aizuchiClassifierPrepare(),
        async (ok) => {
          if (ok) set({ aizuchi: true })
          setAizuchiClassifier(await window.api.aizuchiClassifierStatus())
        }
      )
  }

  const { calendar, localSpeech } = platformCapabilities()
  const pending = pendingItems({ settings, status, vap, embedding, aizuchiClassifier, localSpeech })
  const ctx: SettingsContext = { settings, status, setup, vap, embedding, aizuchiClassifier, prep, pending, set, save, refreshStatus, refreshSetup, go: setPage, prepare }

  // The one-line note beside each entry in the list on the left, which tells the gist without opening
  // the page. It warns only about what is in use and cannot work yet; a feature left off is no warning.
  const features = conversationFeatures(settings.conversationLocale)
  const live = isLiveEngine(settings.voiceEngine) ? settings.voiceEngine : null
  const has = (...kinds: Array<Pending['kind']>): boolean => pending.some((item) => kinds.includes(item.kind))
  const speechCannotRun = pending.some((item) => item.kind === 'speech' && item.reason === 'cannotRun')
  const keys = LLM_PROVIDERS.filter((provider) => status !== null && keyReadable(status.llmKeys[provider])).length
  const agentEngine = settings.agentEngine === 'codex' ? 'Codex' : 'Claude Code'
  const formatUsd = usdFormatter(formatLocale)
  const regionName = new Intl.DisplayNames([uiLocale], { type: 'region' }).of(settings.region) ?? settings.region
  const subs: Record<SettingsPage, { text: string; tone?: 'warn' }> = {
    overview: pending.length > 0 ? { text: t('settings.summary.modelsNotPrepared', { count: pending.length }), tone: 'warn' } : { text: t('settings.summary.modelsAllPrepared') },
    conversation: has('key')
      ? { text: t('settingsConversation.models.notSet'), tone: 'warn' }
      : {
          text: !live
            ? modelLabel(settings.conversationModel)
            : live === 'gpt-live'
              ? t('settings.summary.conversationLive', { engine: LIVE_ENGINE_INFO[live].label, model: modelLabel(settings.conversationModel) })
              : t('settings.summary.conversationLiveOnly', { engine: LIVE_ENGINE_INFO[live].label })
        },
    voice: live
      ? { text: t('settings.summary.voiceLive', { engine: LIVE_ENGINE_INFO[live].label }) }
      : has('recognition', 'browserWhisper')
        ? { text: t('settings.summary.recognitionNotReady'), tone: 'warn' }
        : speechCannotRun
          ? { text: t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, settings.ttsEngine) }), tone: 'warn' }
          : {
              text: !features.aizuchi
                ? ttsEngineLabel(t, settings.ttsEngine)
                : t(settings.aizuchi ? 'settings.summary.voiceBackchannelOn' : 'settings.summary.voiceBackchannelOff', { engine: ttsEngineLabel(t, settings.ttsEngine) }),
              tone: has('speech', 'aizuchi', 'turnTaking') ? 'warn' : undefined
            },
    persona: {
      text: isDefaultPersona(settings.persona)
        ? t('settings.summary.personaDefault')
        : settings.persona.trim()
          ? t('settings.summary.personaEdited')
          : t('settings.summary.personaEmpty')
    },
    memory: {
      text: t(settings.memoryEmbeddingEnabled ? 'settings.summary.memorySemanticOn' : 'settings.summary.memorySemanticOff'),
      tone: has('semanticSearch') ? 'warn' : undefined
    },
    agent: has('agent') ? { text: t('settings.summary.agentMissing', { engine: agentEngine }), tone: 'warn' } : { text: `${agentEngine} · ${AGENT_MODE_NAME[settings.agentEngine][settings.agentMode]}` },
    connections: {
      text: [
        ...(calendar === null ? [] : [t(settings.calendar.enabled ? 'settings.summary.calendarOn' : 'settings.summary.calendarOff')]),
        t('settings.summary.mailAccounts', { count: settings.mail.accounts.length })
      ].join(' · ')
    },
    language: { text: `${UI_LOCALE_NAMES[settings.conversationLocale]} · ${regionName}` },
    appearance: { text: t(`settingsAppearance.themes.${settings.theme}.name`) },
    apiKeys: { text: t('settings.summary.apiKeys', { keys, total: LLM_PROVIDERS.length }), tone: has('key') ? 'warn' : undefined },
    usage: { text: last30 === null ? '' : t('settings.summary.usage', { amount: formatUsd(last30) }) },
    about: { text: t('settings.summary.about') }
  }
  const title = (id: SettingsPage): string => (id === 'connections' ? connectionsTitle(t, calendar) : t(`settings.pages.${id}`))

  const body: Record<SettingsPage, React.JSX.Element> = {
    overview: <OverviewPage ctx={ctx} />,
    conversation: <ConversationPage ctx={ctx} />,
    voice: <VoicePage ctx={ctx} />,
    persona: <PersonaPage ctx={ctx} />,
    memory: <MemoryPage ctx={ctx} />,
    agent: <AgentPage ctx={ctx} />,
    connections: <ConnectionsPage ctx={ctx} />,
    language: <LanguagePage ctx={ctx} />,
    appearance: <AppearancePage ctx={ctx} />,
    apiKeys: <ApiKeysPage ctx={ctx} />,
    usage: <UsagePage ctx={ctx} />,
    about: <AboutPage />
  }
  const navEntry = (id: SettingsPage): React.JSX.Element => {
    const Icon = ICONS[id]
    return (
      <button key={id} type="button" className="st-nav" data-page={id} aria-pressed={page === id} onClick={() => setPage(id)}>
        <Icon size={18} />
        <span className="st-nav-title">{title(id)}</span>
        <span className="st-nav-sub" data-tone={subs[id].tone}>
          {subs[id].text}
        </span>
      </button>
    )
  }
  const notice = prep.message && (
    <p className="st-notice" role="status">
      {prep.message}
    </p>
  )

  return (
    <section className="builtin-focus glass st-focus" aria-label="SETTINGS">
      <header>
        <h2>SETTINGS</h2>
        <div className="st-header-actions">
          <button onClick={closeApp}>
            {t('common.backToConversation')} <X size={16} />
          </button>
        </div>
      </header>
      <div className="st-root">
        <nav className="st-side" aria-label={t('settings.pageList')}>
          {SECTIONS.map((section) => (
            <div key={section.title ?? 'overview'} className="st-nav-group">
              {section.title && <h3 className="st-nav-section">{t(`settings.sections.${section.title}`)}</h3>}
              {section.pages.map(navEntry)}
            </div>
          ))}
        </nav>
        <div className="st-main" ref={mainRef}>
          {notice}
          {body[page]}
        </div>
      </div>
    </section>
  )
}
