import { ExternalLink } from 'lucide-react'
import { useFormatLocale, useT } from '@/i18n'
import { asrRecommendationReason } from '../asr-recommendation'
import { progressLabel } from '../progress-label'
import type { ReactNode } from 'react'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO, PROVIDER_DEFAULT_MODELS, modelName, type LlmProvider } from '@shared/llm-catalog'
import type { SetupProgress, SetupStatus, TtsEngine } from '@shared/ipc'
import { asrModelChoices, type AsrModel } from '@shared/asr-models'
import { isLocalTtsEngine, localTtsModel, localTtsSizeGb, type QwenTtsSize } from '@shared/tts-models'
import { ttsEngineSpeaks, type ConversationLocale } from '@shared/conversation-locale'
import { UI_LOCALE_NAMES } from '@shared/i18n'
import { LOCAL_SPEECH_UNAVAILABLE_TEXT, type PlatformCapabilities } from '@shared/platform'
import { Advanced, Btn, Chip, Progress, type ChipTone } from '../settings/primitives'
import { ttsEngineLabel } from '../settings/context'
import type { ExtraModel } from './extras'
import { useSystemVoice } from './system-voice'
import { ApiKeyField } from './api-key-field'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * The contents of each first-run setup screen. State and saving belong to SetupWizard, so this file
 * only draws the values it is handed. A state such as available, preparing or not prepared is never
 * written after the heading; it is shown as a chip at the right edge.
 */

/**
 * How the user talks: by voice through this computer's recognition and speech, by voice with a live
 * engine that listens and speaks itself, by typing and hearing the reply, or in text only.
 */
export type SpeakingMode = 'voice' | 'live' | 'type-and-listen' | 'text-only'
/** How speech is recognized: 'server' is the model on this Mac, 'local' is Whisper inside the browser. */
export type ListeningChoice = 'server' | 'local'

export function Option({
  active,
  title,
  detail,
  chip,
  onClick,
  children
}: {
  active: boolean
  title: string
  detail: string
  chip?: { tone: ChipTone; label: string }
  onClick: () => void
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="su-option" data-active={active || undefined}>
      <button type="button" className="su-option-head" aria-pressed={active} onClick={onClick}>
        <span className="su-radio" aria-hidden />
        <span className="su-option-text">
          <span className="su-option-title">{title}</span>
          <span className="su-option-detail">{detail}</span>
        </span>
        {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </button>
      {active && children && <div className="su-option-body">{children}</div>}
    </div>
  )
}

export function ModelStep({
  provider,
  onProvider,
  verified,
  keyConfigured,
  apiKey,
  onApiKey,
  busy,
  onVerify,
  onRecheck,
  onChatgpt,
  chatgptSigningIn,
  onCancelChatgpt
}: {
  provider: LlmProvider
  onProvider: (provider: LlmProvider) => void
  /** The conversation model and the bridge phrase model could be fetched with the chosen provider's key. */
  verified: boolean
  /** The key is stored but has not been confirmed yet, for instance because the request failed. */
  keyConfigured: boolean
  apiKey: string
  onApiKey: (value: string) => void
  busy: boolean
  onVerify: () => void
  onRecheck: () => void
  /** Signs in with ChatGPT in place of an API key, offered for OpenAI alone. */
  onChatgpt: () => void
  /** A ChatGPT sign-in waits for the browser, which the user may have closed, so it can be stopped. */
  chatgptSigningIn: boolean
  onCancelChatgpt: () => void
}): React.JSX.Element {
  const t = useT()
  const info = LLM_PROVIDER_INFO[provider]
  return (
    <div className="su-stack">
      <div className="su-providers" role="radiogroup" aria-label={t('setup.model.providerGroup')}>
        {LLM_PROVIDERS.map((id) => {
          const models = PROVIDER_DEFAULT_MODELS[id]
          const conversation = modelName({ provider: id, id: models.conversation })
          const bridge = modelName({ provider: id, id: models.bridge })
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={provider === id}
              className="su-provider"
              data-provider={id}
              disabled={busy || verified}
              onClick={() => onProvider(id)}
            >
              <span className="su-provider-name">{LLM_PROVIDER_INFO[id].label}</span>
              <span className="su-provider-models">{conversation === bridge ? conversation : t('setup.model.modelPair', { conversation, bridge })}</span>
            </button>
          )
        })}
      </div>
      {verified ? (
        <div className="su-result" data-tone="ok">
          <Chip tone="ok">{t('setup.model.verified')}</Chip>
          <span>{t('setup.model.verifiedNote', { provider: info.label })}</span>
        </div>
      ) : (
        <>
          {provider === 'openai' && (
            <div className="su-field">
              {chatgptSigningIn ? (
                <div className="su-inline">
                  <Chip tone="cyan">{t('settingsIntegrations.chatgpt.signingIn')}</Chip>
                  <Btn tone="quiet" onClick={onCancelChatgpt}>
                    {t('settingsIntegrations.chatgpt.cancelSignIn')}
                  </Btn>
                </div>
              ) : (
                <Btn tone="primary" disabled={busy} onClick={onChatgpt}>
                  {t('settingsIntegrations.chatgpt.signIn')}
                </Btn>
              )}
              <p className="su-hint">{t('settingsIntegrations.chatgpt.hint')}</p>
            </div>
          )}
          <ApiKeyField
            provider={provider}
            keyConfigured={keyConfigured}
            apiKey={apiKey}
            onApiKey={onApiKey}
            busy={busy}
            onVerify={onVerify}
            onRecheck={onRecheck}
          />
        </>
      )}
    </div>
  )
}

export function SpeakingStep({
  mode,
  onMode,
  liveKey
}: {
  mode: SpeakingMode | null
  onMode: (mode: SpeakingMode) => void
  /** The key of the live engine, shown inside the live option once it is chosen. */
  liveKey: ReactNode
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="su-stack">
      <Option active={mode === 'voice'} title={t('setup.speaking.voice.title')} detail={t('setup.speaking.voice.detail')} onClick={() => onMode('voice')} />
      <Option active={mode === 'live'} title={t('setup.speaking.live.title')} detail={t('setup.speaking.live.detail')} onClick={() => onMode('live')}>
        {liveKey}
      </Option>
      <Option
        active={mode === 'type-and-listen'}
        title={t('setup.speaking.typeAndListen.title')}
        detail={t('setup.speaking.typeAndListen.detail')}
        onClick={() => onMode('type-and-listen')}
      />
      <Option active={mode === 'text-only'} title={t('setup.speaking.textOnly.title')} detail={t('setup.speaking.textOnly.detail')} onClick={() => onMode('text-only')} />
      <p className="su-hint">{t('setup.speaking.changeLater')}</p>
    </div>
  )
}

export function ListeningStep({
  localSpeech,
  choice,
  onChoice,
  setup,
  asrModel,
  onAsrModel,
  download,
  downloadBusy,
  downloadMessage,
  onPrepareServer,
  onCancelServer,
  localReady,
  localProgress,
  onPrepareLocal,
  onCancelLocal
}: {
  /** Where this machine cannot run the model, its reason stands in place of that choice. */
  localSpeech: PlatformCapabilities['localSpeech']
  choice: ListeningChoice | null
  onChoice: (choice: ListeningChoice) => void
  setup: SetupStatus | null
  asrModel: AsrModel
  onAsrModel: (model: AsrModel) => void
  download: SetupProgress | null
  downloadBusy: boolean
  downloadMessage: string
  onPrepareServer: () => void
  onCancelServer: () => void
  localReady: boolean
  localProgress: number | null
  onPrepareLocal: () => void
  onCancelLocal: () => void
}): React.JSX.Element {
  const t = useT()
  const formatLocale = useFormatLocale()
  const asr = setup?.asr ?? null
  const serverReady = setup?.services.asr === true
  const serverChip = serverReady
    ? { tone: 'ok' as const, label: t('common.ready') }
    : downloadBusy
      ? { tone: 'cyan' as const, label: t('common.preparing') }
      : { tone: 'warn' as const, label: t('common.notReady') }
  const localChip = localReady
    ? { tone: 'ok' as const, label: t('common.ready') }
    : localProgress !== null
      ? { tone: 'cyan' as const, label: t('common.preparing') }
      : { tone: 'warn' as const, label: t('common.notReady') }
  return (
    <div className="su-stack">
      {localSpeech.backend === null ? (
        <p className="su-hint">{t(LOCAL_SPEECH_UNAVAILABLE_TEXT[localSpeech.reason])}</p>
      ) : (
        <Option
          active={choice === 'server'}
          title={t('setup.listening.recommended', { model: asr?.label ?? t('setup.listening.unknownModel') })}
          detail={asr ? asrRecommendationReason(t, localSpeech.backend, asr) : t(`setup.listening.unknownReason.${localSpeech.backend}`)}
          chip={serverChip}
          onClick={() => onChoice('server')}
        >
          {!serverReady &&
            (downloadBusy ? (
              <div className="su-inline">
                <div className="su-grow">
                  <Progress percent={download?.pct ?? 0} label={download ? progressLabel(download) : undefined} />
                </div>
                <Btn tone="quiet" onClick={onCancelServer}>
                  {t('common.stop')}
                </Btn>
              </div>
            ) : (
              <div className="su-inline">
                <Btn tone="primary" onClick={onPrepareServer}>
                  {asr?.modelInstalled ? t('setup.listening.startModel') : t('setup.listening.prepareModel')}
                </Btn>
                {asr && asr.downloadGb > 0 && (
                  <span className="su-hint">
                    {t('setup.listening.downloadNote', { sizeGb: new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 }).format(asr.downloadGb) })}
                  </span>
                )}
              </div>
            ))}
          {downloadMessage && <p className="su-hint">{downloadMessage}</p>}
          <Advanced title={t('setup.listening.details.title')} note={t('setup.listening.details.note')}>
            <div className="su-details">
              <select className="st-select" value={asrModel} disabled={downloadBusy} onChange={(event) => onAsrModel(event.target.value as AsrModel)}>
                <option value="auto">{t(`setup.listening.automaticModel.${localSpeech.backend}`)}</option>
                {asrModelChoices().map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <dl>
                <div>
                  <dt>{t(`setup.listening.details.memory.${localSpeech.backend}`)}</dt>
                  <dd>{asr?.totalMemoryGb ?? '—'} GB</dd>
                </div>
                <div>
                  <dt>{t('setup.listening.details.modelFiles')}</dt>
                  <dd>{asr?.modelInstalled ? t('setup.listening.details.modelDownloaded') : t('setup.listening.details.modelMissing')}</dd>
                </div>
              </dl>
            </div>
          </Advanced>
        </Option>
      )}
      <Option
        active={choice === 'local'}
        title={t('setup.listening.local.title')}
        detail={t('setup.listening.local.detail')}
        chip={localChip}
        onClick={() => onChoice('local')}
      >
        {!localReady &&
          (localProgress === null ? (
            <Btn tone="primary" onClick={onPrepareLocal}>
              {t('setup.listening.prepareModel')}
            </Btn>
          ) : (
            <div className="su-inline">
              <div className="su-grow">
                <Progress percent={localProgress} label={`${Math.round(localProgress)}%`} />
              </div>
              <Btn tone="quiet" onClick={onCancelLocal}>
                {t('common.stop')}
              </Btn>
            </div>
          ))}
      </Option>
    </div>
  )
}

export type MicState = 'unknown' | 'checking' | 'granted' | 'denied'

/** The engines the setup offers, which is every engine except turning the speech off. */
type OfferedTtsEngine = Exclude<TtsEngine, 'none'>

/**
 * The engines that read the replies aloud. VOICEVOX and AivisSpeech are separate applications, and
 * ASIST starts them in the background when they sit in the Applications folder; when they do not,
 * the user is asked to install them from the official site. Irodori-TTS and Qwen3-TTS are models ASIST
 * downloads and runs itself on the GPU, offered only where the GPU has the memory for one beside the
 * speech recognition. The local engines come first, since one of them is what a language starts with
 * where they run.
 */
const TTS_ENGINES: Array<{ id: OfferedTtsEngine; site?: string }> = [
  { id: 'irodori' },
  { id: 'qwen3tts' },
  { id: 'system' },
  { id: 'voicevox', site: 'https://voicevox.hiroshiba.jp/' },
  { id: 'aivisspeech', site: 'https://aivis-project.com/' }
]

export function TtsStep({
  locale,
  ttsReady,
  ttsEngine,
  onTtsEngine,
  ttsChecking,
  ttsDownload,
  localTtsOffered,
  qwenTtsSize,
  onRecheckTts,
  onPrepareTts,
  onCancelPrepareTts,
  onTestTts
}: {
  /** The language of the conversation, which decides the engines that can read it aloud. */
  locale: ConversationLocale
  ttsReady: boolean
  ttsEngine: TtsEngine
  onTtsEngine: (engine: TtsEngine) => void
  /** True from the moment the engine is verified or its model is prepared until the result comes back. */
  ttsChecking: boolean
  /** The latest progress of the preparation of a local engine while it runs. */
  ttsDownload: SetupProgress | null
  /** The local engines are offered where the machine has the memory for one, or where one is already chosen on a machine that runs it. */
  localTtsOffered: boolean
  /** The size of Qwen3-TTS the settings name, whose files the description counts. */
  qwenTtsSize: QwenTtsSize
  onRecheckTts: () => void
  onPrepareTts: () => void
  onCancelPrepareTts: () => void
  onTestTts: () => void
}): React.JSX.Element {
  const t = useT()
  const formatLocale = useFormatLocale()
  const { os } = platformCapabilities()
  const systemVoice = useSystemVoice(locale)
  return (
    <div className="su-stack">
      <section className="su-group" aria-label={t('setup.tts.groupLabel')}>
        {TTS_ENGINES.filter((engine) => ttsEngineSpeaks(locale, engine.id) && (!isLocalTtsEngine(engine.id) || localTtsOffered)).map((engine) => {
          const active = ttsEngine === engine.id
          const ready = active && ttsReady
          const title = ttsEngineLabel(t, engine.id)
          return (
            <Option
              key={engine.id}
              active={active}
              title={title}
              detail={
                isLocalTtsEngine(engine.id)
                  ? t(`setup.tts.engines.${engine.id}.detail`, {
                      sizeGb: new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 }).format(localTtsSizeGb(localTtsModel(engine.id, qwenTtsSize)))
                    })
                  : t(osMessageKey(`setup.tts.engines.${engine.id}.detail`, os))
              }
              chip={
                !active
                  ? undefined
                  : ready
                    ? { tone: 'ok', label: t('common.ready') }
                    : ttsChecking
                      ? { tone: 'cyan', label: isLocalTtsEngine(engine.id) ? t('common.preparing') : t('setup.verifying') }
                      : { tone: 'warn', label: isLocalTtsEngine(engine.id) ? t('common.notReady') : t('setup.tts.notConnected') }
              }
              onClick={() => onTtsEngine(engine.id)}
            >
              {engine.id === 'system' && systemVoice === 'missing' && <p className="su-warn">{t(osMessageKey('setup.tts.systemVoiceMissing', os), { language: UI_LOCALE_NAMES[locale] })}</p>}
              {ready ? (
                <div className="su-inline">
                  <Btn tone="quiet" onClick={onTestTts}>
                    {t('common.playSample')}
                  </Btn>
                </div>
              ) : isLocalTtsEngine(engine.id) ? (
                <div className="su-inline">
                  {ttsChecking ? (
                    <>
                      <div className="su-grow">
                        <Progress percent={ttsDownload?.pct ?? 0} label={ttsDownload ? progressLabel(ttsDownload) : t('common.preparing')} />
                      </div>
                      <Btn tone="quiet" onClick={onCancelPrepareTts}>
                        {t('common.stop')}
                      </Btn>
                    </>
                  ) : (
                    <Btn tone="primary" onClick={onPrepareTts}>
                      {t('setup.tts.prepareModel')}
                    </Btn>
                  )}
                </div>
              ) : (
                engine.site && (
                  <>
                    <ol className="su-howto">
                      <li>{t(osMessageKey('setup.tts.howtoInstall', os), { engine: title })}</li>
                      <li>{t('setup.tts.howtoVerify', { engine: title })}</li>
                    </ol>
                    <div className="su-inline">
                      <Btn tone="primary" onClick={() => void window.api.openExternal(engine.site!)}>
                        {t('setup.tts.officialSite', { engine: title })}
              <ExternalLink size={12} aria-hidden />
                      </Btn>
                      <Btn tone="quiet" disabled={ttsChecking} onClick={onRecheckTts}>
                        {ttsChecking ? t('setup.tts.verifyingButton') : t('setup.tts.verify')}
                      </Btn>
                    </div>
                  </>
                )
              )}
            </Option>
          )
        })}
      </section>
    </div>
  )
}

export function MicStep({
  mic,
  onCheckMic,
  onOpenMicSettings,
  onSwitchToTyping,
  autoMic,
  onAutoMic
}: {
  mic: MicState
  onCheckMic: () => void
  onOpenMicSettings: () => void
  onSwitchToTyping: () => void
  autoMic: boolean
  onAutoMic: (value: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const { os } = platformCapabilities()
  return (
    <div className="su-stack">
      <section className="su-panel">
        <header>
          <div>
            <p>{mic === 'granted' ? t('setup.mic.granted') : mic === 'denied' ? t(osMessageKey('setup.mic.denied', os)) : t('setup.mic.unchecked')}</p>
          </div>
          <Chip tone={mic === 'granted' ? 'ok' : mic === 'denied' ? 'warn' : mic === 'checking' ? 'cyan' : 'dim'}>
            {mic === 'granted' ? t('setup.mic.working') : mic === 'denied' ? t('setup.mic.notAllowed') : mic === 'checking' ? t('setup.verifying') : t('setup.mic.notChecked')}
          </Chip>
        </header>
        <div className="su-inline">
          <Btn tone={mic === 'granted' ? 'quiet' : 'primary'} disabled={mic === 'checking'} onClick={onCheckMic}>
            {mic === 'granted' || mic === 'denied' ? t('setup.mic.checkAgain') : t('setup.mic.check')}
          </Btn>
          {mic === 'denied' && (
            <>
              <Btn tone="quiet" onClick={onOpenMicSettings}>
                {t(osMessageKey('setup.mic.openSettings', os))}
              </Btn>
              <Btn tone="quiet" onClick={onSwitchToTyping}>
                {t('setup.mic.switchToTyping')}
              </Btn>
            </>
          )}
        </div>
        {mic === 'granted' && (
          <label className="su-check">
            <input type="checkbox" checked={autoMic} onChange={(event) => onAutoMic(event.target.checked)} />
            {t('setup.mic.autoStart')}
          </label>
        )}
      </section>
    </div>
  )
}

const EXTRA_CHIP_TONE: Record<ExtraModel['state'], ChipTone> = {
  waiting: 'dim',
  preparing: 'cyan',
  ready: 'ok',
  failed: 'warn',
  skipped: 'dim'
}

/** The extra preparations, which begin on their own once the screen is reached and let the wizard move on when all of them are done. */
export function ExtrasStep({
  extras,
  onRetry,
  onSkip
}: {
  extras: ExtraModel[]
  onRetry: (id: ExtraModel['id']) => void
  onSkip: (id: ExtraModel['id']) => void
}): React.JSX.Element {
  const t = useT()
  const chipLabel = (model: ExtraModel): string => {
    if (model.state === 'preparing') return t('setup.extras.preparingPercent', { percent: Math.round(model.percent) })
    if (model.state === 'waiting') return t('setup.extras.waiting')
    if (model.state === 'ready') return t('common.ready')
    if (model.state === 'failed') return t('setup.extras.failed')
    return t('setup.extras.skipped')
  }
  return (
    <div className="su-stack">
      <ul className="su-extras">
        {extras.map((model) => (
          <li key={model.id} data-state={model.state}>
            <div className="su-extra-head">
              <div className="su-extra-text">
                <span className="su-extra-name">
                  {t(`setup.extras.models.${model.id}.label`)}
                  <small>{t('setup.extras.size', { sizeMb: model.sizeMb })}</small>
                </span>
              </div>
              <Chip tone={EXTRA_CHIP_TONE[model.state]}>{chipLabel(model)}</Chip>
            </div>
            <dl className="su-extra-about">
              <div>
                <dt>{t('setup.extras.aboutKind')}</dt>
                <dd>
                  {t(`setup.extras.models.${model.id}.kind`)}
                  <button type="button" className="su-link" onClick={() => void window.api.openExternal(model.link)}>
                    {t('setup.extras.source')}
              <ExternalLink size={12} aria-hidden />
                  </button>
                </dd>
              </div>
              <div>
                <dt>{t('setup.extras.aboutPurpose')}</dt>
                <dd>{t(`setup.extras.models.${model.id}.purpose`)}</dd>
              </div>
            </dl>
            {model.state === 'preparing' && <Progress percent={model.percent} />}
            {model.state === 'failed' && (
              <>
                {model.message && <p className="su-warn">{model.message}</p>}
                <div className="su-inline">
                  <Btn tone="primary" onClick={() => onRetry(model.id)}>
                    {t('setup.extras.retry')}
                  </Btn>
                  <Btn tone="quiet" onClick={() => onSkip(model.id)}>
                    {t('setup.extras.skip')}
                  </Btn>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="su-hint">{t('setup.extras.laterNote')}</p>
    </div>
  )
}

export function SummaryStep({
  rows,
  optional
}: {
  rows: Array<{ label: string; value: string }>
  optional: Array<{ label: string; value: string; where: string }>
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="su-stack">
      <dl className="su-summary">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <section className="su-panel">
        <header>
          <div>
            <h3>{t('setup.summary.optionalTitle')}</h3>
            <p>{t('setup.summary.optionalLead')}</p>
          </div>
        </header>
        <dl className="su-summary is-quiet">
          {optional.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                {row.value}
                <small>{row.where}</small>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
