import { useEffect, useRef, useState } from 'react'
import { LLM_PROVIDER_INFO, defaultModelsFor, modelLabel, sameModel, type LlmProvider } from '@shared/llm-catalog'
import { keyReadable, type SetupProgress, type SetupStatus, type SetupVoiceMode } from '@shared/ipc'
import type { AsrModel } from '@shared/asr-models'
import { errorText } from '@shared/i18n/error-text'
import { qwenTtsRuns, ttsEngineRuns } from '@shared/tts-models'
import { defaultRegion, ttsEngineSpeaks, type ConversationLocale } from '@shared/conversation-locale'
import { UI_LOCALE_NAMES } from '@shared/i18n'
import { useSettingsStore, useStatusStore } from '@/state/stores'
import { startMicAtLaunch } from '@/conversation'
import { voiceController } from '@/voice/VoiceController'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { microphoneCaptureErrorMessage, verifyMicrophoneCapture } from '@/voice/microphone-access'
import { Btn } from './settings/primitives'
import { useExtraModels } from './setup/extras'
import { LanguageStep } from './setup/language'
import { SafetyStep } from './setup/safety'
import { ExtrasStep, ListeningStep, MicStep, ModelStep, SpeakingStep, SummaryStep, TtsStep, type ListeningChoice, type MicState, type SpeakingMode } from './setup/steps'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import type { MessageKey } from '@shared/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { LIVE_ENGINE_INFO, type LiveEngine } from '@shared/voice-engine'
import { LiveEngineChoice } from './setup/live'

/**
 * The first-run setup. It completes only once every requirement has actually been verified, and it
 * skips the screens that the chosen way of talking does not need. The box keeps a fixed size so that
 * the heading and the buttons stay in place when the screen changes.
 */

const STEPS = ['language', 'safety', 'model', 'speaking', 'listening', 'tts', 'mic', 'extras', 'summary'] as const
type StepId = (typeof STEPS)[number]

/** The way of talking is named in the same words on its own screen and in the summary. */
const SPEAKING_TITLE = {
  voice: 'setup.speaking.voice.title',
  live: 'setup.speaking.live.title',
  'type-and-listen': 'setup.speaking.typeAndListen.title',
  'text-only': 'setup.speaking.textOnly.title'
} as const satisfies Record<SpeakingMode, MessageKey>


export function SetupWizard(): React.JSX.Element | null {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const saveSettings = useSettingsStore((state) => state.save)
  const applyStatus = useStatusStore((state) => state.apply)
  const [step, setStep] = useState<StepId>('language')
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [provider, setProvider] = useState<LlmProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [apiBusy, setApiBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<SpeakingMode | null>(null)
  const [live, setLive] = useState<LiveEngine | null>(null)
  const [liveKey, setLiveKey] = useState('')
  const [listening, setListening] = useState<ListeningChoice | null>(null)
  const [localReady, setLocalReady] = useState(false)
  const [localProgress, setLocalProgress] = useState<number | null>(null)
  const [download, setDownload] = useState<SetupProgress | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadMessage, setDownloadMessage] = useState('')
  const [mic, setMic] = useState<MicState>('unknown')
  const [autoMic, setAutoMic] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [ttsChecking, setTtsChecking] = useState(false)
  const [ttsDownload, setTtsDownload] = useState<SetupProgress | null>(null)
  const refreshGeneration = useRef(0)
  // There is a single progress channel, and the extra preparations report on it too, so progress is
  // accepted only while the listening step is on screen.
  const stepRef = useRef<StepId>('language')
  stepRef.current = step
  const locale = settings?.conversationLocale ?? 'ja-JP'
  const extras = useExtraModels(step === 'extras', mode, locale)
  const capabilities = platformCapabilities()

  const refresh = async (): Promise<SetupStatus | null> => {
    const generation = ++refreshGeneration.current
    let next: SetupStatus
    try {
      next = await window.api.getSetupStatus()
    } catch (err) {
      // A failure from an older check must not roll a later success back into an error.
      if (generation !== refreshGeneration.current) return null
      throw err
    }
    if (generation !== refreshGeneration.current) return null
    setSetup(next)
    applyStatus(next.services)
    return next
  }
  useEffect(() => {
    if (!settings || settings.onboardingVersion >= 1) return
    setAutoMic(settings.micAutoStart)
    setProvider(settings.conversationModel.provider)
    void refresh()
      .then((current) => {
        if (current?.services.asr) setListening('server')
        else if (settings.localAsrEnabled) setListening('local')
      })
      .catch((err: unknown) => setError(displayError(err)))
    return window.api.onSetupProgress((progress) => {
      if (stepRef.current === 'tts') setTtsDownload(progress.status === 'downloading' ? progress : null)
      if (stepRef.current !== 'listening') return
      if (progress.status === 'downloading') {
        setDownloadBusy(true)
        setDownload(progress)
      } else {
        setDownloadBusy(false)
        setDownload(null)
      }
      if (progress.message) setDownloadMessage(progress.message)
    })
    // The initialization runs on the first render only, so a later settings update does not roll
    // the choices back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.onboardingVersion])

  if (!settings || settings.onboardingVersion >= 1) return null

  const defaults = defaultModelsFor(provider)
  const modelsMatch = sameModel(settings.conversationModel, defaults.conversationModel) && sameModel(settings.bridgeModel, defaults.bridgeModel)
  const modelReady = setup?.services.llm === true && modelsMatch
  // A saved key this build cannot decrypt is asked for again rather than offered for another check.
  const keyConfigured = keyReadable(setup?.services.llmKeys[provider] ?? 'missing')
  const serverReady = setup?.services.asr === true
  const listeningReady = (listening === 'server' && serverReady) || (listening === 'local' && localReady)
  const ttsReady = setup?.services.tts === true
  const liveProvider = live ? LIVE_ENGINE_INFO[live].provider : null
  const liveKeyState = liveProvider ? (setup?.services.llmKeys[liveProvider] ?? 'missing') : 'missing'
  const liveKeyVerified = liveKeyState === 'verified'

  const needed = (id: StepId, way: SpeakingMode | null = mode): boolean => {
    // Before the way of talking is chosen, every screen counts as needed.
    if (id === 'listening') return way === null || way === 'voice'
    if (id === 'tts') return way !== 'text-only' && way !== 'live'
    if (id === 'mic') return way === null || way === 'voice' || way === 'live'
    return true
  }
  const ready: Record<StepId, boolean> = {
    // A fresh installation already carries the language of the system, so this screen opens on an answer.
    language: true,
    safety: settings.safetyNoticeVersion >= 1,
    model: modelReady,
    speaking: mode !== null && (mode !== 'live' || liveKeyVerified),
    listening: listeningReady,
    tts: ttsReady,
    mic: mic === 'granted',
    extras: extras.settled,
    summary: true
  }
  const index = STEPS.indexOf(step)
  const move = (direction: 1 | -1, from = index): void => {
    setError('')
    for (let i = from + direction; i >= 0 && i < STEPS.length; i += direction) {
      if (needed(STEPS[i])) {
        setStep(STEPS[i])
        return
      }
    }
  }

  /**
   * Saves the one language choice: the interface, the conversation and the region move together, and
   * the speech engine moves with them when the chosen one cannot read the new language aloud.
   */
  const chooseLocale = (next: ConversationLocale): void => {
    setError('')
    const engine = ttsEngineSpeaks(next, settings.ttsEngine) ? {} : { ttsEngine: 'system' as const }
    void saveSettings({ uiLocale: next, conversationLocale: next, region: defaultRegion(next), ...engine })
      .then(() => refresh())
      .catch((err: unknown) => setError(displayError(err)))
  }

  /** Verifies and saves the key, and sets the conversation model and the bridge phrase model to the provider's default pair. */
  const verifyKey = async (useSavedKey: boolean): Promise<void> => {
    if (apiBusy || (!useSavedKey && !apiKey.trim())) return
    setApiBusy(true)
    setError('')
    try {
      if (!useSavedKey) applyStatus(await window.api.saveApiKey(provider, apiKey))
      // Before it saves, main checks that this pair can really be fetched with the provider's key.
      if (!modelsMatch) await saveSettings(defaults)
      setApiKey('')
      await refresh()
    } catch (err) {
      setError(displayError(err))
    } finally {
      setApiBusy(false)
    }
  }

  /**
   * Chooses a way of talking. A live engine starts on the one whose provider the model step verified,
   * so that its key is not asked for twice.
   */
  const chooseMode = (next: SpeakingMode): void => {
    setError('')
    setMode(next)
    if (next === 'live' && !live) setLive(provider === 'openai' ? 'gpt-live' : provider === 'google' ? 'gemini-live' : null)
  }

  /**
   * Chooses a live engine. Main marks a key verified only in its memory, so a key saved in an earlier
   * session or set in the environment reads as saved until it is checked, and it is checked here at once
   * rather than asked for again.
   */
  const chooseLive = (next: LiveEngine): void => {
    setLive(next)
    setLiveKey('')
    setError('')
    const nextProvider = LIVE_ENGINE_INFO[next].provider
    if (setup?.services.llmKeys[nextProvider] === 'saved') void verifyLiveKey(nextProvider, null)
  }

  /**
   * Verifies the key of the live engine's provider, which the conversation model may not use: the typed
   * key, which is saved once it works, or with null the key main already holds.
   */
  const verifyLiveKey = async (keyProvider: LlmProvider, key: string | null): Promise<void> => {
    if (apiBusy || (key !== null && !key.trim())) return
    setApiBusy(true)
    setError('')
    try {
      applyStatus(key === null ? await window.api.verifySavedApiKey(keyProvider) : await window.api.saveApiKey(keyProvider, key))
      setLiveKey('')
      await refresh()
    } catch (err) {
      setError(displayError(err))
    } finally {
      setApiBusy(false)
    }
  }

  const prepareServer = async (): Promise<void> => {
    if (downloadBusy) return
    setError('')
    setDownloadMessage('')
    setDownloadBusy(true)
    setDownload({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0 })
    try {
      const result = await window.api.prepareAsrModel(settings.asrModel)
      setDownloadMessage(result.message)
      for (let attempt = 0; attempt < 12; attempt++) {
        const current = await refresh()
        if (current?.services.asr || !result.ok) break
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    } catch (err) {
      setError(displayError(err))
    } finally {
      setDownloadBusy(false)
      setDownload(null)
    }
  }

  const prepareLocal = async (): Promise<void> => {
    setError('')
    setLocalProgress(0)
    try {
      await voiceController.prepareLocalAsr(({ progress }) => setLocalProgress(progress))
      setLocalReady(true)
      setLocalProgress(100)
      await saveSettings({ localAsrEnabled: true })
    } catch (err) {
      setLocalReady(false)
      setLocalProgress(null)
      setError(displayError(err))
    }
  }

  const checkMic = async (): Promise<void> => {
    if (mic === 'checking') return
    setError('')
    setMic('checking')
    try {
      if (!(await window.api.requestMicPermission())) {
        setMic('denied')
        return
      }
      // The TCC result from Electron main does not prove that capture really works, so setup may
      // finish only after a verification stream has been opened and all of its tracks stopped.
      await verifyMicrophoneCapture()
      setMic('granted')
    } catch (err) {
      setMic('denied')
      setError(microphoneCaptureErrorMessage(err))
    }
  }

  /** Checks whether the installed VOICEVOX or AivisSpeech can be reached, and shows the reason when it cannot. */
  const verifyTts = async (): Promise<void> => {
    if (ttsChecking) return
    setTtsChecking(true)
    setError('')
    try {
      const status = await window.api.ttsVerify()
      await refresh()
      if (!status.tts) setError(t(osMessageKey('setup.tts.connectFailed', capabilities.os), { engine: status.ttsLabel }))
    } catch (err) {
      setError(displayError(err))
    } finally {
      setTtsChecking(false)
    }
  }

  /** Downloads the Qwen3-TTS model and starts it. */
  const prepareTts = async (): Promise<void> => {
    if (ttsChecking) return
    setTtsChecking(true)
    setError('')
    try {
      const result = await window.api.prepareTtsModel()
      await refresh()
      if (!result.ok) setError(result.message)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setTtsChecking(false)
      setTtsDownload(null)
    }
  }

  const finish = async (): Promise<void> => {
    if (finishing || !mode) return
    setFinishing(true)
    setError('')
    try {
      const voiceMode: SetupVoiceMode = mode === 'voice' && listening ? listening : mode === 'live' && live ? live : 'text'
      // Text-only use turns the TTS engine off, so a reply is neither synthesized nor played and
      // appears as text alone.
      if (mode === 'text-only' && settings.ttsEngine !== 'none') await saveSettings({ ttsEngine: 'none' })
      if (mode === 'voice' || mode === 'live') await verifyMicrophoneCapture()
      if (voiceMode === 'local') {
        await voiceController.prepareLocalAsr(({ progress }) => setLocalProgress(progress))
        setLocalReady(true)
        setLocalProgress(100)
      }
      const systemTtsVerified =
        mode === 'text-only' ||
        mode === 'live' ||
        settings.ttsEngine !== 'system' ||
        (typeof window.speechSynthesis?.speak === 'function' && typeof window.SpeechSynthesisUtterance === 'function')
      if (!systemTtsVerified) throw new Error(errorText(osMessageKey('voice.speech.systemUnavailable', capabilities.os)))

      const completed = await window.api.completeSetup({
        voiceMode,
        micAutoStart: autoMic,
        microphoneVerified: true,
        localAsrVerified: true,
        systemTtsVerified
      })
      useSettingsStore.setState({ settings: completed })
      startMicAtLaunch()
    } catch (err) {
      setError(displayError(err))
      await refresh().catch(() => null)
    } finally {
      setFinishing(false)
    }
  }

  const services = setup?.services
  /** What the user has to do in order to move on, shown as a single line to the left of the buttons. */
  const nextAction = ((): string => {
    if (step === 'language') return t('setup.guide.language.chosen', { language: UI_LOCALE_NAMES[locale] })
    if (step === 'safety') return ready.safety ? t('setup.guide.safety.done') : t('setup.guide.safety.tick')
    if (step === 'model') {
      if (modelReady) return t('setup.guide.model.verified')
      if (apiBusy) return t('setup.guide.model.verifying')
      return apiKey.trim() ? t('setup.guide.model.pressVerify') : t('setup.guide.model.enterKey', { provider: LLM_PROVIDER_INFO[provider].label })
    }
    if (step === 'speaking') {
      if (!mode) return t('setup.guide.speaking.choose')
      if (mode !== 'live' || liveKeyVerified) return t('setup.guide.speaking.chosen')
      if (!live || !liveProvider) return t('setup.guide.speaking.chooseLive')
      if (apiBusy) return t('setup.guide.model.verifying')
      return liveKey.trim()
        ? t('setup.guide.model.pressVerify')
        : t('setup.guide.speaking.enterLiveKey', { engine: LIVE_ENGINE_INFO[live].label, provider: LLM_PROVIDER_INFO[liveProvider].label })
    }
    if (step === 'listening') {
      if (listeningReady) return t('setup.guide.listening.ready')
      if (!listening) return t('setup.guide.listening.choose')
      return downloadBusy || localProgress !== null ? t('setup.guide.wait') : t('setup.guide.listening.prepare')
    }
    if (step === 'tts') {
      if (ttsReady) return t('setup.guide.tts.ready')
      // A saved engine this machine cannot run is offered by no choice on the screen, so it is chosen again.
      if (!ttsEngineRuns(settings.ttsEngine, capabilities.localSpeech)) return t('setup.guide.tts.choose')
      if (settings.ttsEngine === 'qwen3tts') return ttsChecking ? ttsDownload?.message || t('common.preparing') : t(osMessageKey('setup.guide.tts.prepareOrSystem', capabilities.os))
      return ttsChecking ? t('setup.guide.tts.verifying') : t(osMessageKey('setup.guide.tts.notConnected', capabilities.os), { engine: services?.ttsLabel ?? t('setup.steps.tts.title') })
    }
    if (step === 'mic') {
      if (mic === 'granted') return t('setup.guide.mic.ready')
      if (mic === 'checking') return t('setup.guide.mic.checking')
      if (mic === 'denied') return t(osMessageKey('setup.guide.mic.denied', capabilities.os))
      return t('setup.guide.mic.check')
    }
    if (step === 'extras') {
      if (extras.settled) return t('setup.guide.extras.done')
      return extras.models.some((model) => model.state === 'failed') ? t('setup.guide.extras.failed') : t('setup.guide.wait')
    }
    return t('setup.guide.summary')
  })()

  return (
    <div className="su-backdrop">
      <section className="glass su-dialog" aria-labelledby="su-title">
        <header className="su-head">
          <div className="su-kicker">{t('setup.kicker')}</div>
          <ol className="su-steps">
            {STEPS.map((id, i) => (
              <li key={id} data-state={!needed(id) ? 'skipped' : id === step ? 'current' : i < index ? 'done' : 'todo'}>
                <span>{i + 1}</span>
                {t(`setup.steps.${id}.label`)}
              </li>
            ))}
          </ol>
          <h1 id="su-title">{t(`setup.steps.${step}.title`)}</h1>
          <p>{t(step === 'mic' ? osMessageKey('setup.steps.mic.lead', capabilities.os) : `setup.steps.${step}.lead`)}</p>
        </header>

        <div className="su-body" data-step={step}>
          {step === 'language' && <LanguageStep locale={locale} onLocale={chooseLocale} />}
          {step === 'safety' && (
            <SafetyStep
              uiLocale={settings.uiLocale}
              acknowledged={ready.safety}
              onAcknowledged={(acknowledged) => {
                setError('')
                void saveSettings({ safetyNoticeVersion: acknowledged ? 1 : 0 }).catch((err: unknown) => setError(displayError(err)))
              }}
            />
          )}
          {step === 'model' && (
            <ModelStep
              provider={provider}
              onProvider={(next) => {
                setProvider(next)
                setApiKey('')
                setError('')
              }}
              verified={modelReady}
              keyConfigured={keyConfigured}
              apiKey={apiKey}
              onApiKey={setApiKey}
              busy={apiBusy}
              onVerify={() => void verifyKey(false)}
              onRecheck={() => void verifyKey(true)}
            />
          )}
          {step === 'speaking' && (
            <SpeakingStep
              mode={mode}
              onMode={chooseMode}
              liveChoice={
                <LiveEngineChoice
                  engine={live}
                  onEngine={chooseLive}
                  keyVerified={liveKeyVerified}
                  keyConfigured={keyReadable(liveKeyState)}
                  apiKey={liveKey}
                  onApiKey={setLiveKey}
                  busy={apiBusy}
                  onVerify={() => {
                    if (liveProvider) void verifyLiveKey(liveProvider, liveKey)
                  }}
                  onRecheck={() => {
                    if (liveProvider) void verifyLiveKey(liveProvider, null)
                  }}
                />
              }
            />
          )}
          {step === 'listening' && (
            <ListeningStep
              localSpeech={capabilities.localSpeech}
              choice={listening}
              onChoice={setListening}
              setup={setup}
              asrModel={settings.asrModel}
              onAsrModel={(asrModel: AsrModel) => {
                setDownloadMessage('')
                void saveSettings({ asrModel })
                  .then(() => refresh())
                  .catch((err: unknown) => setError(displayError(err)))
              }}
              download={download}
              downloadBusy={downloadBusy}
              downloadMessage={downloadMessage}
              onPrepareServer={() => void prepareServer()}
              onCancelServer={() => void window.api.cancelAsrPreparation()}
              localReady={localReady}
              localProgress={localProgress}
              onPrepareLocal={() => void prepareLocal()}
              onCancelLocal={() => voiceController.cancelLocalAsrPreparation()}
            />
          )}
          {step === 'tts' && (
            <TtsStep
              locale={locale}
              ttsReady={ttsReady}
              ttsEngine={settings.ttsEngine}
              onTtsEngine={(ttsEngine) => {
                setError('')
                void saveSettings({ ttsEngine })
                  .then(() => refresh())
                  .catch((err: unknown) => setError(displayError(err)))
              }}
              ttsChecking={ttsChecking}
              ttsDownload={ttsDownload}
              qwenTtsOffered={qwenTtsRuns(capabilities.localSpeech) && (setup?.qwenTts.recommended === true || settings.ttsEngine === 'qwen3tts')}
              qwenTtsSize={settings.qwenTtsSize}
              onRecheckTts={() => void verifyTts()}
              onPrepareTts={() => void prepareTts()}
              onCancelPrepareTts={() => void window.api.cancelTtsPreparation()}
              onTestTts={() => void window.api.ttsTest().then((segment) => speechPlayer.playClip(segment.audio, segment.text, { role: 'preview' }))}
            />
          )}
          {step === 'mic' && (
            <MicStep
              mic={mic}
              onCheckMic={() => void checkMic()}
              onOpenMicSettings={() => void window.api.micOpenPrivacy()}
              onSwitchToTyping={() => {
                setMode('type-and-listen')
                setError('')
                // The first screen still to be done may come before this one: a live engine skipped the
                // reading screen, which typing needs.
                setStep(STEPS.find((id) => needed(id, 'type-and-listen') && !ready[id]) ?? 'summary')
              }}
              autoMic={autoMic}
              onAutoMic={setAutoMic}
            />
          )}
          {step === 'extras' && <ExtrasStep extras={extras.models} onRetry={extras.retry} onSkip={extras.skip} />}
          {step === 'summary' && mode && (
            <SummaryStep
              rows={[
                { label: t('setup.summary.language'), value: UI_LOCALE_NAMES[locale] },
                // As on the settings screen, Gemini Live decides by itself and no live engine speaks a bridge phrase.
                ...(mode === 'live' && live === 'gemini-live' ? [] : [{ label: t('setup.summary.conversationModel'), value: modelLabel(settings.conversationModel) }]),
                ...(mode === 'live' ? [] : [{ label: t('setup.summary.bridgeModel'), value: modelLabel(settings.bridgeModel) }]),
                { label: t('setup.summary.speaking'), value: t(SPEAKING_TITLE[mode]) },
                ...(mode === 'live' && live
                  ? [{ label: t('setup.summary.liveEngine'), value: t('setup.summary.liveEngineValue', { engine: LIVE_ENGINE_INFO[live].label, voice: settings[live === 'gpt-live' ? 'gptLive' : 'geminiLive'].voice }) }]
                  : []),
                ...(mode === 'voice'
                  ? [{ label: t('setup.summary.listening'), value: listening === 'local' ? t('setup.listening.local.title') : (setup?.asr?.label ?? '') }]
                  : []),
                ...(mode === 'live' ? [] : [{ label: t('setup.summary.tts'), value: mode === 'text-only' ? t('setup.summary.ttsUnused') : (services?.ttsLabel ?? '') }]),
                ...(mode === 'voice' || mode === 'live' ? [{ label: t('setup.summary.mic'), value: autoMic ? t('setup.summary.micAtLaunch') : t('setup.summary.micManual') }] : [])
              ]}
              optional={[
                {
                  label: t('setup.summary.agent'),
                  value: services?.agent === 'found'
                    ? t('setup.summary.agentAvailable', { engine: services.agentEngine })
                    : t('setup.summary.agentMissing', { engine: services?.agentEngine ?? '' }),
                  where: t('setup.summary.agentWhere')
                },
                ...(capabilities.calendar !== null
                  ? [
                      {
                        label: t('setup.summary.calendar'),
                        value: t(capabilities.calendar === 'google' ? 'setup.summary.calendarValueGoogle' : 'setup.summary.calendarValue'),
                        where: t('setup.summary.connectionsWhere')
                      }
                    ]
                  : []),
                {
                  label: t('setup.summary.mail'),
                  value: t('setup.summary.mailValue'),
                  where: t(capabilities.calendar === null ? 'setup.summary.mailWhere' : 'setup.summary.connectionsWhere')
                }
              ]}
            />
          )}
          {error && (
            <div className="su-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="su-foot">
          <Btn tone="quiet" disabled={index === 0 || finishing} onClick={() => move(-1)}>
            {t('setup.back')}
          </Btn>
          <p className="su-next" aria-live="polite">
            {nextAction}
          </p>
          {step === 'summary' ? (
            <Btn tone="primary" disabled={finishing} onClick={() => void finish()}>
              {finishing ? t('common.saving') : t('setup.start')}
            </Btn>
          ) : (
            <Btn tone="primary" disabled={!ready[step]} onClick={() => move(1)}>
              {t('setup.next')}
            </Btn>
          )}
        </footer>
      </section>
    </div>
  )
}
