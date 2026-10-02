import { useState } from 'react'
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
import type { MessageKey, Translate } from '@shared/i18n'
import { credentialState, type ApiKeyState } from '@shared/ipc'
import { useToastStore } from '@/state/stores'
import type { SettingsContext } from '../context'
import { Btn, Chip, Group, Page, Row, type ChipTone } from '../primitives'
import { PrepLine } from '../preparation'
import { keyProviders, missingCredentialText } from '../pending'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/** A key this build cannot decrypt is named as on the API keys page, where it is entered again. */
const KEY_STATE_CHIP = {
  unreadable: { tone: 'warn', label: 'settingsIntegrations.apiKeys.unreadable' },
  missing: { tone: 'warn', label: 'settingsConversation.models.notSet' }
} as const satisfies Record<Exclude<ApiKeyState, 'verified' | 'saved'>, { tone: ChipTone; label: MessageKey }>

/**
 * The conversation page: the voice engine and the models that answer. A key that is missing for a
 * provider in use shows under the models, with the way to the API keys page; a key that works is not
 * repeated here.
 */
export function ConversationPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, save, refreshStatus, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [saving, setSaving] = useState(false)
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

  const missingKeys = status === null ? [] : keyProviders(settings).flatMap((provider) => {
    const state = credentialState(status, settings.openaiAuth, provider)
    return state === 'missing' || state === 'unreadable' ? [{ provider, state }] : []
  })

  return (
    <Page title={t('settingsConversation.title')} lead={t('settingsConversation.lead')}>
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
        {live && <LiveEngineRows engine={live} ctx={ctx} disabled={saving} />}
      </Group>

      <Group
        title={t('settingsConversation.models.title')}
        description={live ? t('settingsConversation.models.geminiLiveDescription') : t('settingsConversation.models.description')}
      >
        <Row label={t('settingsConversation.models.conversation')} hint={noteOf(t, conversation)}>
          <ModelPicker role="conversationModel" value={conversation} disabled={saving} onChange={(model) => change('conversationModel', model)} />
        </Row>
        {!live && (
          <Row label={t('settingsConversation.models.bridge')} hint={t('settingsConversation.models.bridgeHint')}>
            <ModelPicker role="bridgeModel" value={bridge} disabled={saving} onChange={(model) => change('bridgeModel', model)} />
          </Row>
        )}
        {missingKeys.map(({ provider, state }) => {
          return (
            <PrepLine
              key={provider}
              text={missingCredentialText(t, { provider, state }, settings, live)}
            >
              <Chip tone={KEY_STATE_CHIP[state].tone}>{t(KEY_STATE_CHIP[state].label)}</Chip>
              <Btn tone="primary" onClick={() => go('apiKeys')}>
                {t('settingsIntegrations.apiKeys.register')}
              </Btn>
            </PrepLine>
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
    </Page>
  )
}

const noteOf = (t: Translate, model: ConversationModel): string => {
  const known = catalogModelsOf(model.provider).find((candidate) => sameModel(candidate, model))
  return known ? t(known.note) : t('settingsConversation.models.unlisted', { id: model.id })
}

const engineHint = (t: Translate, engine: VoiceEngine): string =>
  engine === 'cascade' ? t('voiceEngines.cascade.hint') : t('voiceEngines.geminiLive.hint')

/** The rows of a live engine: its model and how long it waits before closing the session. Its voice is chosen on the voice page. */
function LiveEngineRows({ engine, ctx, disabled }: { engine: LiveEngine; ctx: SettingsContext; disabled: boolean }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const info = LIVE_ENGINE_INFO[engine]
  const current = settings.geminiLive
  const model = info.models.find((candidate) => candidate.id === current.model)
  return (
    <>
      <Row label={t('settingsConversation.live.model')} hint={model ? t(model.note) : t('settingsConversation.models.unlisted', { id: current.model })}>
        <select
          className="st-select"
          aria-label={t('settingsConversation.live.modelLabel', { engine: info.label })}
          value={current.model}
          disabled={disabled}
          onChange={(e) => set({ geminiLive: { ...current, model: e.target.value } })}
        >
          {info.models.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
          {!model && <option value={current.model}>{current.model}</option>}
        </select>
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
