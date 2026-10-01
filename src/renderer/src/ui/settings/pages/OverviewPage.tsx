import type { ReactNode } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { HoloSwitch } from '@/components/ui/switch'
import { LLM_PROVIDER_INFO, modelName } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { conversationFeatures } from '@shared/conversation-locale'
import { keyReadable } from '@shared/ipc'
import { AGENT_CLI_UNAVAILABLE_TEXT } from '@shared/agent-cli'
import { LOCAL_SPEECH_UNAVAILABLE_TEXT } from '@shared/platform'
import { isLocalTtsEngine } from '@shared/tts-models'
import { osMessageKey } from '@shared/i18n/os-message'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { AGENT_INSTALL_GUIDE, TTS_SITE, cascadeListeningReady, isExternalTts, speechReadiness, ttsEngineLabel, type SettingsContext, type SettingsPage } from '../context'
import { Btn, Chip, Group, Page, Row, type ChipTone } from '../primitives'
import { PrepProgress, PrepareButton, WhisperControl } from '../preparation'
import type { Pending } from '../pending'

/** One step of the conversation as it runs now: listening, answering or reading aloud. */
interface Step {
  page: SettingsPage
  title: string
  value: string
  sub?: string
  chip: { tone: ChipTone; label: string }
}

/**
 * The first page of the settings: the current setup as the path one utterance takes, what is turned on
 * but not working yet, and the features that can still be added.
 */
export function OverviewPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, setup, vap, embedding, pending: todo, prepare, set, go } = ctx
  const t = useT()
  const { localSpeech, os } = platformCapabilities()
  const features = conversationFeatures(settings.conversationLocale)
  const live = isLiveEngine(settings.voiceEngine) ? settings.voiceEngine : null
  const liveSettings = live ? settings[live === 'gpt-live' ? 'gptLive' : 'geminiLive'] : null
  const conversation = settings.conversationModel
  const listening = cascadeListeningReady(settings, status, localSpeech)
  const speech = speechReadiness(settings.ttsEngine, status, localSpeech)
  const vapReady = vap?.runtimeInstalled === true && vap.modelsInstalled
  const embeddingReady = embedding?.runtimeInstalled === true && embedding.modelInstalled
  const ready = { tone: 'ok', label: t('common.ready') } as const
  const notReady = { tone: 'warn', label: t('common.notReady') } as const
  const checking = { tone: 'dim', label: t('settingsModels.checking') } as const
  const starting = { tone: 'dim', label: t('settingsModels.starting') } as const
  const keyOf = (provider: keyof typeof LLM_PROVIDER_INFO): Step['chip'] =>
    status === null ? checking : keyReadable(status.llmKeys[provider]) ? ready : { tone: 'warn', label: t('settingsConversation.models.notSet') }

  const steps: Step[] = live
    ? [
        {
          page: 'conversation',
          title: LIVE_ENGINE_INFO[live].label,
          value: LIVE_ENGINE_INFO[live].models.find((model) => model.id === liveSettings!.model)?.label ?? liveSettings!.model,
          sub: liveSettings!.voice,
          chip: keyOf(LIVE_ENGINE_INFO[live].provider)
        }
      ]
    : [
        {
          page: 'voice',
          title: t('settingsModels.asr.title'),
          // What listens now: the local model once it answers, and Whisper in the browser in its place until then.
          value:
            localSpeech.backend !== null && (status?.asr === true || !settings.localAsrEnabled)
              ? (setup?.asr?.label ?? '…')
              : t('settingsModels.asr.browserWhisper'),
          chip: listening === null ? checking : listening ? ready : notReady
        },
        {
          page: 'conversation',
          title: t('settings.pages.conversation'),
          value: modelName(conversation),
          sub: t('settingsOverview.bridge', { model: modelName(settings.bridgeModel) }),
          chip: keyOf(conversation.provider)
        },
        {
          page: 'voice',
          title: t('settingsModels.speech.title'),
          value: ttsEngineLabel(t, settings.ttsEngine),
          chip: speech === 'ready' ? ready : speech === 'off' ? { tone: 'dim', label: t('common.off') } : speech === 'checking' ? checking : speech === 'starting' ? starting : notReady
        }
      ]

  /** One row of what is turned on and cannot work yet, with the one step that fixes it. */
  const todoRow = (item: Pending): { label: string; hint: string; action: ReactNode; progress?: ReactNode } => {
    switch (item.kind) {
      case 'recognition':
        return {
          label: t('settingsModels.asr.title'),
          hint: t('settingsModels.asr.notDownloaded', { model: setup?.asr?.label ?? '' }),
          action: <PrepareButton ctx={ctx} target="asr" onClick={prepare.asr} onCancel={prepare.cancelAsr} />,
          progress: <PrepProgress ctx={ctx} target="asr" />
        }
      case 'browserWhisper':
        return {
          label: t('settingsModels.asr.browserWhisper'),
          hint: localSpeech.backend === null ? t(LOCAL_SPEECH_UNAVAILABLE_TEXT[localSpeech.reason]) : '',
          action: <WhisperControl ctx={ctx} />
        }
      case 'speech': {
        const engine = settings.ttsEngine
        return {
          label: t('settingsModels.speech.title'),
          hint:
            item.reason === 'cannotRun'
              ? t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, settings.ttsEngine) })
              : t(osMessageKey(isLocalTtsEngine(settings.ttsEngine) ? 'settingsVoice.speech.modelNotPrepared' : 'settingsVoice.speech.engineMissing', os), {
                  engine: ttsEngineLabel(t, settings.ttsEngine)
                }),
          action:
            item.reason === 'missing' && isLocalTtsEngine(engine) ? (
              <PrepareButton ctx={ctx} target="tts" onClick={prepare.tts} />
            ) : item.reason === 'missing' && isExternalTts(engine) ? (
              <Btn onClick={() => void window.api.openExternal(TTS_SITE[engine])}>
                <ExternalLink size={12} />
                {t('settingsModels.speech.get', { engine: ttsEngineLabel(t, engine) })}
              </Btn>
            ) : (
              <Btn onClick={() => go('voice')}>{t('settingsModels.speech.chooseEngine')}</Btn>
            ),
          progress: <PrepProgress ctx={ctx} target="tts" />
        }
      }
      case 'aizuchi':
        return {
          label: t('settingsVoice.response.aizuchi'),
          hint: t('settingsModels.backchannel.notPrepared'),
          action: <PrepareButton ctx={ctx} target="aizuchiClassifier" onClick={prepare.aizuchiClassifier} />,
          progress: <PrepProgress ctx={ctx} target="aizuchiClassifier" />
        }
      case 'turnTaking':
        return {
          label: t('settingsVoice.mic.turnTaking'),
          hint: t('settingsModels.turnTaking.hint'),
          action: <PrepareButton ctx={ctx} target="vap" onClick={prepare.vap} />,
          progress: <PrepProgress ctx={ctx} target="vap" />
        }
      case 'semanticSearch':
        return {
          label: t('settingsMemory.search.title'),
          hint: t('settingsMemory.search.notPrepared'),
          action: <PrepareButton ctx={ctx} target="embedding" onClick={prepare.embedding} />,
          progress: <PrepProgress ctx={ctx} target="embedding" />
        }
      case 'agent':
        return {
          label: 'Agent',
          hint:
            status && status.agent !== 'found'
              ? t(status.agent === 'missing' ? 'settingsAgent.run.engineMissing' : AGENT_CLI_UNAVAILABLE_TEXT[status.agent], { engine: status.agentEngine })
              : '',
          action: (
            <Btn onClick={() => void window.api.openExternal(AGENT_INSTALL_GUIDE[settings.agentEngine])}>
              <ExternalLink size={12} />
              {t('settingsModels.agent.install')}
            </Btn>
          )
        }
      case 'key': {
        const info = LLM_PROVIDER_INFO[item.provider]
        return {
          label: t('settingsConversation.models.apiKey', { provider: info.label }),
          hint:
            item.state === 'unreadable'
              ? t('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: info.label })
              : live && LIVE_ENGINE_INFO[live].provider === item.provider
                ? t('settingsConversation.live.keyMissing', { envKey: info.envKey })
                : t('settingsConversation.models.keyMissing', { envKey: info.envKey }),
          action: <Btn onClick={() => go('apiKeys')}>{t('settingsIntegrations.apiKeys.register')}</Btn>
        }
      }
    }
  }
  // The features that are off, which the conversation works without. Whisper in the browser is a fallback
  // here; where no local model runs it is the speech recognition itself and appears among the pending.
  const optional = [
    ...(settings.memoryEmbeddingEnabled ? [] : ['semanticSearch' as const]),
    ...(!live && features.maai && !settings.vapEnabled ? ['turnTaking' as const] : []),
    ...(!live && localSpeech.backend !== null && !settings.localAsrEnabled ? ['browserWhisper' as const] : [])
  ]

  return (
    <Page title={t('settings.pages.overview')} lead={t('settingsOverview.lead')}>
      <Group title={t('settingsOverview.flowTitle')}>
        <div className="st-flow">
          {steps.map((step, index) => (
            <div key={step.title} className="st-flow-step">
              {index > 0 && <ArrowRight size={16} className="st-flow-arrow" aria-hidden />}
              <button type="button" className="st-flow-tile" data-page={step.page} onClick={() => go(step.page)}>
                <span className="st-flow-title">{step.title}</span>
                <span className="st-flow-value">{step.value}</span>
                {step.sub && <span className="st-flow-sub">{step.sub}</span>}
                <Chip tone={step.chip.tone}>{step.chip.label}</Chip>
              </button>
            </div>
          ))}
        </div>
      </Group>

      <Group title={t('settingsOverview.todoTitle')} description={todo.length > 0 ? t('settingsOverview.todoDescription') : undefined}>
        {todo.length === 0 ? (
          <Row label={t('settingsOverview.todoNone')} />
        ) : (
          todo.map((item) => {
            const row = todoRow(item)
            return (
              <div key={item.kind === 'key' ? `key-${item.provider}` : item.kind} data-pending={item.kind}>
                <Row label={row.label} hint={row.hint}>
                  {row.action}
                </Row>
                {row.progress}
              </div>
            )
          })
        )}
      </Group>

      {optional.length > 0 && (
        <Group title={t('settingsOverview.optionalTitle')} description={t('settingsOverview.optionalDescription')}>
          {optional.includes('semanticSearch') && (
            <>
              <Row label={t('settingsMemory.search.title')} hint={t('settingsModels.semanticSearch.hint')}>
                {embedding === null ? (
                  <Chip>{t('settingsModels.checking')}</Chip>
                ) : embeddingReady ? (
                  <HoloSwitch checked={false} onCheckedChange={(v) => set({ memoryEmbeddingEnabled: v })} />
                ) : (
                  <PrepareButton ctx={ctx} target="embedding" onClick={prepare.embedding} label={t('settingsModels.prepareAndTurnOn')} />
                )}
              </Row>
              <PrepProgress ctx={ctx} target="embedding" />
            </>
          )}
          {optional.includes('turnTaking') && (
            <>
              <Row label={t('settingsVoice.mic.turnTaking')} hint={t('settingsModels.turnTaking.hint')}>
                {vap === null ? (
                  <Chip>{t('settingsModels.checking')}</Chip>
                ) : vapReady ? (
                  <HoloSwitch checked={false} onCheckedChange={(v) => set({ vapEnabled: v })} />
                ) : (
                  <PrepareButton ctx={ctx} target="vap" onClick={prepare.vap} label={t('settingsModels.prepareAndTurnOn')} />
                )}
              </Row>
              <PrepProgress ctx={ctx} target="vap" />
            </>
          )}
          {optional.includes('browserWhisper') && (
            <Row label={t('settingsModels.asr.browserWhisper')} hint={t('settingsVoice.recognition.browserWhisperOff')}>
              <WhisperControl ctx={ctx} />
            </Row>
          )}
        </Group>
      )}
    </Page>
  )
}

