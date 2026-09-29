import { useEffect, useRef, useState } from 'react'
import { Bot, Brain, Cable, ChartColumn, Info, MessageSquare, Mic, Palette, UserRound, Wrench, X, type LucideIcon } from 'lucide-react'
import { keyReadable, type AizuchiClassifierStatus, type EmbeddingStatus, type SetupStatus, type VapStatus } from '@shared/ipc'
import { LLM_PROVIDERS, modelLabel } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { isDefaultPersona } from '@shared/persona'
import { UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from '@shared/i18n'
import { conversationFeatures } from '@shared/conversation-locale'
import { voiceController } from '@/voice/VoiceController'
import { useSettingsStore, useStatusStore, useToastStore } from '@/state/stores'
import { useMiniApp, useViewStore } from '@/state/view'
import { useFormatLocale, useT } from '@/i18n'
import { localDate } from '@shared/api-usage'
import { usageReport } from '@shared/usage-report'
import { speechRecognitionReady, ttsEngineLabel, ttsNeedsPreparation, type Preparation, type PreparationTarget, type SettingsContext, type SettingsPage } from './settings/context'
import { ConversationPage } from './settings/pages/ConversationPage'
import { PersonaPage } from './settings/pages/PersonaPage'
import { VoicePage } from './settings/pages/VoicePage'
import { AppearancePage } from './settings/pages/AppearancePage'
import { MemoryPage } from './settings/pages/MemoryPage'
import { AgentPage } from './settings/pages/AgentPage'
import { IntegrationsPage } from './settings/pages/IntegrationsPage'
import { ModelsPage } from './settings/pages/ModelsPage'
import { AboutPage } from './settings/pages/AboutPage'
import { UsagePage } from './settings/pages/UsagePage'
import { usdFormatter } from './settings/usage-format'
import { displayError } from '@/display-error'
import { platformCapabilities } from '@/platform'
import { ttsEngineRuns } from '@shared/tts-models'
import { AGENT_MODE_NAME } from '@shared/agent-cli'

/**
 * The settings screen, with the list of topics on the left and the page of the chosen topic on the
 * right. Saving, reloading the status and the progress of a model preparation belong here and reach
 * the pages as a SettingsContext.
 */

const PAGES: Array<{ id: SettingsPage; icon: LucideIcon }> = [
  { id: 'conversation', icon: MessageSquare },
  { id: 'persona', icon: UserRound },
  { id: 'voice', icon: Mic },
  { id: 'appearance', icon: Palette },
  { id: 'memory', icon: Brain },
  { id: 'agent', icon: Bot },
  { id: 'integrations', icon: Cable },
  { id: 'models', icon: Wrench },
  { id: 'usage', icon: ChartColumn },
  { id: 'about', icon: Info }
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
  useEffect(() => {
    if (!open) return
    void refreshSetup().catch(() => setSetup(null))
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

  const ctx: SettingsContext = { settings, status, setup, vap, embedding, aizuchiClassifier, prep, set, save, refreshStatus, refreshSetup, go: setPage, prepare }

  // The one-line note beside each entry in the list on the left, which tells the gist and what still
  // needs preparing without opening the page. Speech can only be missing when a separate engine is
  // selected, since the macOS speech synthesis needs no preparation.
  const features = conversationFeatures(settings.conversationLocale)
  const { calendar, localSpeech } = platformCapabilities()
  const engineRuns = ttsEngineRuns(settings.ttsEngine, localSpeech)
  const missing = [
    speechRecognitionReady(settings, setup, localSpeech) === false,
    status !== null && engineRuns && ttsNeedsPreparation(settings.ttsEngine) && !status.tts,
    status !== null && status.agent !== 'found',
    features.maai && vap !== null && !(vap.runtimeInstalled && vap.modelsInstalled),
    embedding !== null && !(embedding.runtimeInstalled && embedding.modelInstalled),
    features.aizuchi &&
      aizuchiClassifier !== null &&
      !(aizuchiClassifier.runtimeInstalled && aizuchiClassifier.modelInstalled)
  ].filter(Boolean).length
  const keys = LLM_PROVIDERS.filter((provider) => status !== null && keyReadable(status.llmKeys[provider])).length
  const live = isLiveEngine(settings.voiceEngine) ? settings.voiceEngine : null
  const agentEngine = settings.agentEngine === 'codex' ? 'Codex' : 'Claude Code'
  const keyCounts = { keys, total: LLM_PROVIDERS.length }
  const formatUsd = usdFormatter(formatLocale)
  const subs: Record<SettingsPage, { text: string; tone?: 'warn' }> = {
    conversation: {
      text: !live
        ? modelLabel(settings.conversationModel)
        : live === 'gpt-live'
          ? t('settings.summary.conversationLive', { engine: LIVE_ENGINE_INFO[live].label, model: modelLabel(settings.conversationModel) })
          : t('settings.summary.conversationLiveOnly', { engine: LIVE_ENGINE_INFO[live].label })
    },
    persona: {
      text: isDefaultPersona(settings.persona)
        ? t('settings.summary.personaDefault')
        : settings.persona.trim()
          ? t('settings.summary.personaEdited')
          : t('settings.summary.personaEmpty')
    },
    // A saved engine this machine cannot run is not something to prepare; the voice page is where it is chosen again.
    voice: live
      ? { text: t('settings.summary.voiceLive', { engine: LIVE_ENGINE_INFO[live].label }) }
      : !engineRuns
        ? { text: t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, settings.ttsEngine) }), tone: 'warn' }
        : {
            text: !features.aizuchi
              ? ttsEngineLabel(t, settings.ttsEngine)
              : t(settings.aizuchi ? 'settings.summary.voiceBackchannelOn' : 'settings.summary.voiceBackchannelOff', {
                  engine: ttsEngineLabel(t, settings.ttsEngine)
                })
          },
    appearance: { text: t(`settingsAppearance.themes.${settings.theme}.name`) },
    memory: { text: t(settings.memoryEmbeddingEnabled ? 'settings.summary.memorySemanticOn' : 'settings.summary.memorySemanticOff') },
    agent: { text: `${agentEngine} · ${AGENT_MODE_NAME[settings.agentEngine][settings.agentMode]}` },
    integrations: {
      text: calendar === null
        ? t('settings.summary.integrationsKeys', keyCounts)
        : t(settings.calendar.enabled ? 'settings.summary.integrationsCalendarOn' : 'settings.summary.integrationsCalendarOff', keyCounts)
    },
    models:
      missing > 0
        ? { text: t('settings.summary.modelsNotPrepared', { count: missing }), tone: 'warn' }
        : { text: t('settings.summary.modelsAllPrepared') },
    usage: { text: last30 === null ? '' : t('settings.summary.usage', { amount: formatUsd(last30) }) },
    about: { text: t('settings.summary.about') }
  }

  const body: Record<SettingsPage, React.JSX.Element> = {
    conversation: <ConversationPage ctx={ctx} />,
    persona: <PersonaPage ctx={ctx} />,
    voice: <VoicePage ctx={ctx} />,
    appearance: <AppearancePage ctx={ctx} />,
    memory: <MemoryPage ctx={ctx} />,
    agent: <AgentPage ctx={ctx} />,
    integrations: <IntegrationsPage ctx={ctx} />,
    models: <ModelsPage ctx={ctx} />,
    usage: <UsagePage ctx={ctx} />,
    about: <AboutPage />
  }

  return (
    <section className="builtin-focus glass st-focus" aria-label="SETTINGS">
      <header>
        <h2>SETTINGS</h2>
        <div className="st-header-actions">
          <select
            className="st-select"
            aria-label={t('settings.language')}
            value={settings.uiLocale}
            onChange={(event) => set({ uiLocale: event.target.value as UiLocale })}
          >
            {UI_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {UI_LOCALE_NAMES[locale]}
              </option>
            ))}
          </select>
          <button onClick={closeApp}>
            {t('common.backToConversation')} <X size={16} />
          </button>
        </div>
      </header>
      <div className="st-root">
        <nav className="st-side" aria-label={t('settings.pageList')}>
          {PAGES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`st-nav${id === 'models' ? ' is-setup' : ''}`}
              data-page={id}
              aria-pressed={page === id}
              onClick={() => setPage(id)}
            >
              <Icon size={18} />
              <span className="st-nav-title">{t(`settings.pages.${id}`)}</span>
              <span className="st-nav-sub" data-tone={subs[id].tone}>
                {subs[id].text}
              </span>
            </button>
          ))}
        </nav>
        <div className="st-main" ref={mainRef}>
          {body[page]}
        </div>
      </div>
    </section>
  )
}
