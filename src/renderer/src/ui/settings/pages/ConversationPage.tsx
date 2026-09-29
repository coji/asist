import { APP_LOG_RETENTION_DAYS } from '@shared/app-log'
import { useState } from 'react'
import { Play } from 'lucide-react'
import { speechPlayer } from '@/voice/SpeechPlayer'
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_INFO,
  catalogModelsOf,
  defaultModelsFor,
  effortFor,
  effortOptions,
  type Effort,
  modelLabel,
  sameModel,
  type ConversationModel,
  type LlmProvider
} from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, VOICE_ENGINES, isLiveEngine, voiceEngineLabel, type LiveEngine, type VoiceEngine } from '@shared/voice-engine'
import { CONVERSATION_LOCALES, REGIONS, ttsEngineSpeaks, type ConversationLocale } from '@shared/conversation-locale'
import { UI_LOCALE_NAMES, type MessageKey, type Translate } from '@shared/i18n'
import { keyReadable, type ApiKeyState } from '@shared/ipc'
import { useToastStore } from '@/state/stores'
import { cascadeListeningReady, speechReadiness, ttsEngineLabel, type SettingsContext, type SpeechReadiness } from '../context'
import { useFieldDraft } from '../field-draft'
import { Btn, Chip, Group, Link, NotSavedHint, Page, Row, type ChipTone } from '../primitives'
import { displayError } from '@/display-error'
import { useT, useUiLocale } from '@/i18n'
import { personaStateKey } from '../persona-state'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/** A key this build cannot decrypt is named as on the integrations page, where it is entered again. */
const KEY_STATE_CHIP = {
  verified: { tone: 'ok', label: 'settingsConversation.models.verified' },
  saved: { tone: 'cyan', label: 'settingsConversation.models.saved' },
  unreadable: { tone: 'warn', label: 'settingsIntegrations.apiKeys.unreadable' },
  missing: { tone: 'warn', label: 'settingsConversation.models.notSet' }
} as const satisfies Record<ApiKeyState, { tone: ChipTone; label: MessageKey }>

/** The conversation page: the voice engine, the conversation and bridge phrase models, a link to the persona, and the conversation log. */
export function ConversationPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, set, save, refreshStatus, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [saving, setSaving] = useState(false)
  const retention = useFieldDraft(settings.conversationLogRetentionDays, {
    format: String,
    parse: (text) => {
      const days = Number(text)
      return Number.isInteger(days) && days >= 1 ? days : null
    },
    save: (conversationLogRetentionDays) => set({ conversationLogRetentionDays })
  })
  const conversation = settings.conversationModel
  const bridge = settings.bridgeModel
  const conversationInfo = LLM_PROVIDER_INFO[conversation.provider]
  const engine = settings.voiceEngine
  const live = isLiveEngine(engine) ? engine : null

  const changeEngine = (next: VoiceEngine): void => {
    setSaving(true)
    void save({ voiceEngine: next })
      .then(() => refreshStatus())
      .then(() => toast({ kind: 'ok', title: t('settingsConversation.engine.changed', { engine: voiceEngineLabel(t, next) }) }))
      .catch((err: unknown) => toast({ kind: 'error', title: t('settingsConversation.engine.changeFailed'), body: displayError(err) }))
      .finally(() => setSaving(false))
  }

  const change = (field: 'conversationModel' | 'bridgeModel', model: ConversationModel): void => {
    setSaving(true)
    // When the conversation provider changes, the bridge look-ahead moves to that provider's light
    // model as well. Leaving them apart would demand two keys, and a missing key on either side
    // keeps a conversation from starting. The look-ahead can still be chosen on its own afterwards.
    const follow = field === 'conversationModel' && model.provider !== conversation.provider ? defaultModelsFor(model.provider).bridgeModel : null
    void save(follow ? { conversationModel: model, bridgeModel: follow } : { [field]: model })
      .then(() => refreshStatus())
      .then(() =>
        toast({
          kind: 'ok',
          title: follow
            ? t('settingsConversation.models.bothChanged', { model: modelLabel(model), bridge: modelLabel(follow) })
            : t(`settingsConversation.models.${field}Changed`, { model: modelLabel(model) })
        })
      )
      .catch((err: unknown) => toast({ kind: 'error', title: t(`settingsConversation.models.${field}ChangeFailed`), body: displayError(err) }))
      .finally(() => setSaving(false))
  }

  // The key status gets one row per provider in use, which is a single row when both models share
  // the same provider.
  const providers = [...new Set([conversation.provider, bridge.provider])]
  const personaLine = settings.persona.trim().split('\n')[0] ?? ''

  return (
    <Page title={t('settingsConversation.title')} lead={t('settingsConversation.lead')}>
      <LanguageRows ctx={ctx} disabled={saving} />

      <Group title={t('settingsConversation.engine.title')} description={t('settingsConversation.engine.description')}>
        <Row label={t('settingsConversation.engine.label')} hint={engineHint(t, engine)}>
          <select
            className="st-select"
            aria-label={t('settingsConversation.engine.selectLabel')}
            value={engine}
            disabled={saving}
            onChange={(e) => changeEngine(e.target.value as VoiceEngine)}
          >
            {VOICE_ENGINES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {voiceEngineLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Row>
        {live ? <LiveEngineRows engine={live} ctx={ctx} disabled={saving} /> : <CascadeEngineRows ctx={ctx} />}
      </Group>

      <Group
        title={t('settingsConversation.models.title')}
        description={live === 'gemini-live' ? t('settingsConversation.models.geminiLiveDescription') : t('settingsConversation.models.description')}
      >
        <Row
          label={live === 'gpt-live' ? t('settingsConversation.models.conversationForGptLive') : t('settingsConversation.models.conversation')}
          hint={noteOf(t, conversation)}
        >
          <ModelPicker role="conversationModel" value={conversation} disabled={saving} onChange={(model) => change('conversationModel', model)} />
        </Row>
        {!live && (
          <Row label={t('settingsConversation.models.bridge')} hint={t('settingsConversation.models.bridgeHint')}>
            <ModelPicker role="bridgeModel" value={bridge} disabled={saving} onChange={(model) => change('bridgeModel', model)} />
          </Row>
        )}
        {providers.map((provider) => {
          const info = LLM_PROVIDER_INFO[provider]
          const state = status?.llmKeys[provider] ?? 'missing'
          return (
            <Row
              key={provider}
              label={t('settingsConversation.models.apiKey', { provider: info.label })}
              hint={
                state === 'verified'
                  ? t('settingsConversation.models.keyVerified', { envKey: info.envKey })
                  : state === 'saved'
                    ? t('settingsConversation.models.keySaved', { envKey: info.envKey })
                    : state === 'unreadable'
                      ? t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: info.label })
                      : t('settingsConversation.models.keyMissing', { envKey: info.envKey })
              }
            >
              <Chip tone={KEY_STATE_CHIP[state].tone}>{t(KEY_STATE_CHIP[state].label)}</Chip>
              <Link onClick={() => go('integrations')}>{t('settingsConversation.models.openIntegrations')}</Link>
            </Row>
          )
        })}
        <Row
          label={t('settingsConversation.models.webSearch')}
          hint={
            conversationInfo.webSearch
              ? t('settingsConversation.models.webSearchAvailable', { provider: conversationInfo.label })
              : t('settingsConversation.models.webSearchUnavailable', { provider: conversationInfo.label })
          }
        >
          <Chip tone={conversationInfo.webSearch ? 'ok' : 'dim'}>
            {conversationInfo.webSearch ? t('settingsConversation.models.available') : t('settingsConversation.models.unavailable')}
          </Chip>
        </Row>
      </Group>

      <Group title={t('settingsConversation.persona.title')} description={t('settingsConversation.persona.description')}>
        <Row label={t(personaStateKey(settings.persona))} hint={personaLine}>
          <Btn onClick={() => go('persona')}>{t('settingsConversation.persona.edit')}</Btn>
        </Row>
      </Group>

      <Group title={t('settingsConversation.log.title')} description={t('settingsConversation.log.description')}>
        <Row label={t('settingsConversation.log.retention')} hint={retention.failed ? <NotSavedHint /> : t('settingsConversation.log.retentionHint')}>
          <input
            type="number"
            min={1}
            className="st-input is-mono"
            style={{ width: 88 }}
            aria-label={t('settingsConversation.log.retentionLabel')}
            {...retention.props}
          />
        </Row>
      </Group>

      <Group title={t('settingsConversation.appLog.title')} description={t('settingsConversation.appLog.description', { days: APP_LOG_RETENTION_DAYS })}>
        <Row label={t('settingsConversation.appLog.folder')} hint={t(osMessageKey('settingsConversation.appLog.folderHint', platformCapabilities().os))}>
          <Btn onClick={() => void window.api.logsOpenFolder()}>{t(osMessageKey('settingsConversation.appLog.open', platformCapabilities().os))}</Btn>
        </Row>
      </Group>
    </Page>
  )
}

/**
 * The language the conversation is held in and the region its weather, news and formats come from.
 * They are two rows rather than one, because someone living in Japan may talk in English and still
 * want the weather of Japan. The language of the interface is a third choice, in the dialog's header.
 */
function LanguageRows({ ctx, disabled }: { ctx: SettingsContext; disabled: boolean }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const uiLocale = useUiLocale()
  const names = new Intl.DisplayNames([uiLocale], { type: 'region' })
  const regions = [...new Set([...REGIONS, settings.region])]
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLocale))

  const changeLocale = (locale: ConversationLocale): void => {
    // An engine that cannot read the new language aloud would leave the conversation silent, so it
    // moves to the macOS voice in the same save.
    const engine = ttsEngineSpeaks(locale, settings.ttsEngine) ? {} : { ttsEngine: 'system' as const }
    set({ conversationLocale: locale, ...engine })
  }

  return (
    <Group title={t('settingsConversation.language.title')} description={t('settingsConversation.language.description')}>
      <Row label={t('settingsConversation.language.conversation')} hint={t('settingsConversation.language.conversationHint')}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.language.conversation')}
          value={settings.conversationLocale}
          disabled={disabled}
          onChange={(e) => changeLocale(e.target.value as ConversationLocale)}
        >
          {CONVERSATION_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {UI_LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('settingsConversation.language.region')} hint={t('settingsConversation.language.regionHint')}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.language.region')}
          value={settings.region}
          disabled={disabled}
          onChange={(e) => set({ region: e.target.value })}
        >
          {regions.map((region) => (
            <option key={region.code} value={region.code}>
              {region.name}
            </option>
          ))}
        </select>
      </Row>
    </Group>
  )
}

/**
 * The voice samples for the live engines. They are mp3 files bundled by scripts/gen-live-voices.mjs,
 * which has each provider's TTS read the same sentence, so listening to one needs neither the API
 * nor a key. Adding a voice means generating them again with that script.
 */
const VOICE_SAMPLES = import.meta.glob<string>('../../../assets/live-voices/*/*.mp3', { eager: true, query: '?url', import: 'default' })
// The sentence the bundled samples read, so it describes the audio rather than the interface.
const SAMPLE_TEXT = 'こんにちは。声のテストです。今日はいい天気ですね。'

function voiceSampleUrl(engine: LiveEngine, voice: string): string | null {
  const suffix = `/${engine}/${voice}.mp3`
  const entry = Object.entries(VOICE_SAMPLES).find(([file]) => file.endsWith(suffix))
  return entry ? entry[1] : null
}

/** Plays a bundled mp3 through the speech playback queue, where decodeAudioData handles it just as it does WAV. */
async function playVoiceSample(url: string): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  speechPlayer.playClip(btoa(binary), SAMPLE_TEXT, { role: 'preview' })
}

const noteOf = (t: Translate, model: ConversationModel): string => {
  const known = catalogModelsOf(model.provider).find((candidate) => sameModel(candidate, model))
  return known ? t(known.note) : t('settingsConversation.models.unlisted', { id: model.id })
}

const engineHint = (t: Translate, engine: VoiceEngine): string =>
  engine === 'cascade' ? t('voiceEngines.cascade.hint') : engine === 'gpt-live' ? t('voiceEngines.gptLive.hint') : t('voiceEngines.geminiLive.hint')

/** The chip of each state of the speech on the conversation page. The one of a missing engine is chosen by the engine. */
const SPEECH_CHIP = {
  ready: { tone: 'ok', label: 'common.ready' },
  off: { tone: 'dim', label: 'common.off' },
  cannotRun: { tone: 'warn', label: 'common.notReady' },
  checking: { tone: 'dim', label: 'settingsModels.checking' }
} as const satisfies Record<Exclude<SpeechReadiness, 'missing'>, { tone: ChipTone; label: MessageKey }>

/**
 * The rows of the cascade engine: whether the speech recognition and the speech engine it relies on are
 * ready, and where each is prepared. A setup finished with a live engine or for text alone skips preparing
 * both, so a switch to this engine shows here what is still missing.
 */
function CascadeEngineRows({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, go } = ctx
  const t = useT()
  const { os, localSpeech } = platformCapabilities()
  const listening = cascadeListeningReady(settings, status, localSpeech)
  const engine = settings.ttsEngine
  const speech = speechReadiness(engine, status, localSpeech)
  const engineName = ttsEngineLabel(t, engine)
  const speechChip =
    speech === 'missing'
      ? { tone: 'warn' as const, label: engine === 'qwen3tts' ? ('common.notReady' as const) : ('common.notFound' as const) }
      : SPEECH_CHIP[speech]
  const speechHint =
    speech === 'off'
      ? t('settingsModels.speech.none')
      : speech === 'cannotRun'
        ? t('voice.speech.cannotRunHere', { engine: engineName })
        : speech === 'missing'
          ? engine === 'qwen3tts'
            ? t(osMessageKey('settingsVoice.speech.qwenNotPrepared', os))
            : t(osMessageKey('settingsVoice.speech.engineMissing', os), { engine: engineName })
          : engineName
  return (
    <>
      <Row label={t('settingsModels.asr.title')} hint={listening === false ? t('settingsConversation.engine.recognitionNotReady') : undefined}>
        <Chip tone={listening === null ? 'dim' : listening ? 'ok' : 'warn'}>
          {t(listening === null ? 'settingsModels.checking' : listening ? 'common.ready' : 'common.notReady')}
        </Chip>
        {listening === false && <Link onClick={() => go('models')}>{t('common.openModels')}</Link>}
      </Row>
      <Row label={t('settingsModels.speech.title')} hint={speechHint}>
        <Chip tone={speechChip.tone}>{t(speechChip.label)}</Chip>
        {speech === 'missing' ? (
          <Link onClick={() => go('models')}>{t('common.openModels')}</Link>
        ) : (
          (speech === 'off' || speech === 'cannotRun') && <Link onClick={() => go('voice')}>{t('settingsModels.speech.chooseEngine')}</Link>
        )}
      </Row>
    </>
  )
}

/** The rows of a live engine: its model and voice, how long it waits before closing the session, and the state of the key. */
function LiveEngineRows({ engine, ctx, disabled }: { engine: LiveEngine; ctx: SettingsContext; disabled: boolean }): React.JSX.Element {
  const { settings, status, set, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const info = LIVE_ENGINE_INFO[engine]
  const field = engine === 'gpt-live' ? 'gptLive' : 'geminiLive'
  const current = settings[field]
  const keyState = status?.llmKeys[info.provider] ?? 'missing'
  const saved = keyReadable(keyState)
  const model = info.models.find((candidate) => candidate.id === current.model)
  const listedVoice = info.voices.some((voice) => voice.id === current.voice)
  return (
    <>
      <Row label={t('settingsConversation.live.model')} hint={model ? t(model.note) : t('settingsConversation.models.unlisted', { id: current.model })}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.live.modelLabel', { engine: info.label })}
          value={current.model}
          disabled={disabled}
          onChange={(e) => set({ [field]: { ...current, model: e.target.value } })}
        >
          {info.models.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
          {!model && <option value={current.model}>{current.model}</option>}
        </select>
      </Row>
      <Row label={t('settingsConversation.live.voice')} hint={t('settingsConversation.live.voiceHint')}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.live.voiceLabel', { engine: info.label })}
          value={current.voice}
          disabled={disabled}
          onChange={(e) => set({ [field]: { ...current, voice: e.target.value } })}
        >
          {info.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.note ? t('settingsConversation.live.voiceOption', { id: voice.id, note: t(voice.note) }) : voice.id}
            </option>
          ))}
          {!listedVoice && <option value={current.voice}>{current.voice}</option>}
        </select>
        <Btn
          tone="quiet"
          disabled={voiceSampleUrl(engine, current.voice) === null}
          title={voiceSampleUrl(engine, current.voice) === null ? t('settingsConversation.live.noSample') : undefined}
          onClick={() => {
            const url = voiceSampleUrl(engine, current.voice)
            if (!url) return
            void playVoiceSample(url).catch((err: unknown) =>
              toast({ kind: 'error', title: t('common.playSampleFailed'), body: displayError(err) })
            )
          }}
        >
          <Play size={12} />
          {t('common.playSample')}
        </Btn>
      </Row>
      <Row label={t('settingsConversation.live.idle')} hint={t('settingsConversation.live.idleHint')}>
        <input
          type="range"
          aria-label={t('settingsConversation.live.idleLabel')}
          min={10}
          max={600}
          step={10}
          value={settings.liveIdleSeconds}
          onChange={(e) => set({ liveIdleSeconds: Number(e.target.value) })}
        />
        <span className="st-value">{t('settingsConversation.live.seconds', { count: settings.liveIdleSeconds })}</span>
      </Row>
      <Row
        label={t('settingsConversation.models.apiKey', { provider: LLM_PROVIDER_INFO[info.provider].label })}
        hint={
          saved
            ? t('settingsConversation.models.keySaved', { envKey: LLM_PROVIDER_INFO[info.provider].envKey })
            : keyState === 'unreadable'
              ? t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: LLM_PROVIDER_INFO[info.provider].label })
              : t('settingsConversation.live.keyMissing', { envKey: LLM_PROVIDER_INFO[info.provider].envKey })
        }
      >
        <Chip tone={saved ? 'ok' : 'warn'}>{t(saved ? 'settingsConversation.models.saved' : KEY_STATE_CHIP[keyState].label)}</Chip>
        <Link onClick={() => go('integrations')}>{t('settingsConversation.models.openIntegrations')}</Link>
      </Row>
    </>
  )
}

/**
 * A choice of provider and model in two steps, plus the depth of thinking for the models that accept
 * it. Changing the provider picks that provider's default model, the standard one for conversation
 * and the light one for the bridge look-ahead. Changing the model resets the depth to its default,
 * because the steps mean different things from one model to the next.
 */
function ModelPicker({
  role,
  value,
  disabled,
  onChange
}: {
  /** Which default model a change of provider picks: the standard one for conversation, the light one for the look-ahead. */
  role: 'conversationModel' | 'bridgeModel'
  value: ConversationModel
  disabled: boolean
  onChange: (model: ConversationModel) => void
}): React.JSX.Element {
  const t = useT()
  const models = catalogModelsOf(value.provider)
  const listed = models.some((model) => sameModel(model, value))
  const efforts = effortOptions(value)
  return (
    <>
      <select
        className="st-select"
        aria-label={t(`settingsConversation.models.${role}.provider`)}
        value={value.provider}
        disabled={disabled}
        onChange={(e) => {
          onChange(defaultModelsFor(e.target.value as LlmProvider)[role])
        }}
      >
        {LLM_PROVIDERS.map((provider) => (
          <option key={provider} value={provider}>
            {LLM_PROVIDER_INFO[provider].label}
          </option>
        ))}
      </select>
      <select
        className="st-select"
        aria-label={t(`settingsConversation.models.${role}.model`)}
        value={value.id}
        disabled={disabled}
        onChange={(e) => onChange({ provider: value.provider, id: e.target.value })}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
        {!listed && <option value={value.id}>{value.id}</option>}
      </select>
      {efforts.length > 0 && (
        <select
          className="st-select"
          aria-label={t(`settingsConversation.models.${role}.effort`)}
          value={effortFor(value) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ provider: value.provider, id: value.id, effort: e.target.value as Effort })}
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {t(`llmModels.effort.${effort}`)}
            </option>
          ))}
        </select>
      )}
    </>
  )
}
