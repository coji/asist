import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { HoloSwitch } from '@/components/ui/switch'
import { speechRecognitionReady, ttsEngineLabel, isExternalTts, ttsNeedsPreparation, type PreparationTarget, type SettingsContext } from '../context'
import { Btn, Chip, Link, Page, Progress } from '../primitives'
import { progressLabel } from '../../progress-label'
import { conversationFeatures } from '@shared/conversation-locale'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { SPEECH_RUNTIME_UNAVAILABLE_TEXT } from '@shared/platform'
import { AGENT_CLI_UNAVAILABLE_TEXT } from '@shared/agent-cli'
import { ttsEngineRuns } from '@shared/tts-models'
import { osMessageKey } from '@shared/i18n/os-message'

/**
 * The models page, where the models and their runtimes are prepared. It is kept apart from the
 * everyday settings and gives each component its own state and controls. Only one preparation that
 * downloads something runs at a time.
 */
export function ModelsPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, setup, vap, embedding, aizuchiClassifier, prep, prepare, set, go } = ctx
  const t = useT()
  const { speechRuntime, os } = platformCapabilities()
  const asr = setup?.asr ?? null
  const asrReady = asr?.ready === true
  const vapReady = vap?.runtimeInstalled === true && vap.modelsInstalled
  const embeddingReady = embedding?.runtimeInstalled === true && embedding.modelInstalled
  const classifierReady = aizuchiClassifier?.runtimeInstalled === true && aizuchiClassifier.modelInstalled
  // Turn taking and the backchannel classifier are trained on Japanese, so in another conversation
  // language there is nothing to prepare and no card for them.
  const features = conversationFeatures(settings.conversationLocale)
  const engine = settings.ttsEngine
  const ttsSite = engine === 'aivisspeech' ? 'https://aivis-project.com/' : 'https://voicevox.hiroshiba.jp/'
  const percent = prep.progress?.pct ?? 0
  const preparing = (target: PreparationTarget): boolean => prep.busy && prep.target === target
  // Every item waits while one is prepared, but only the item being prepared says so and shows the progress.
  const prepareButton = (target: PreparationTarget, onClick: () => void): React.JSX.Element => (
    <>
      <Btn tone="primary" disabled={prep.busy} onClick={onClick}>
        {preparing(target) ? t('common.preparing') : t('settingsModels.prepare')}
      </Btn>
      {preparing(target) && prep.progress && <Progress percent={percent} label={progressLabel(prep.progress)} />}
    </>
  )
  const asrDescription =
    speechRuntime.kind === null
      ? t(SPEECH_RUNTIME_UNAVAILABLE_TEXT[speechRuntime.reason])
      : !asr
        ? t('settingsModels.asr.checking')
        : t(
            !asr.runtimeInstalled && !asr.modelInstalled
              ? 'settingsModels.asr.needsRuntimeAndModel'
              : !asr.runtimeInstalled
                ? 'settingsModels.asr.needsRuntime'
                : !asr.modelInstalled
                  ? 'settingsModels.asr.needsModel'
                  : 'settingsModels.asr.model',
            { memoryGb: asr.totalMemoryGb, model: asr.label }
          )
  const recognitionReady = speechRecognitionReady(settings, setup, speechRuntime)
  const asrState = recognitionReady === null ? 'unknown' : recognitionReady ? 'ready' : 'missing'
  const engineRuns = ttsEngineRuns(engine, speechRuntime)

  return (
    <Page title={t('settingsModels.title')} lead={t('settingsModels.lead')}>
      {prep.message && (
        <p className="st-notice" role="status">
          {prep.message}
        </p>
      )}
      <div className="st-prep">
        <Card
          title={t('settingsModels.asr.title')}
          state={asrState}
          stateLabel={asrState === 'unknown' ? t('settingsModels.checking') : asrState === 'ready' ? t('common.ready') : t('common.notReady')}
          description={asrDescription}
        >
          {speechRuntime.kind !== null && (
            <>
              <Btn tone="primary" disabled={prep.busy} onClick={prepare.asr}>
                {preparing('asr')
                  ? t('common.preparing')
                  : asrReady
                    ? t('settingsModels.asr.checkAgain')
                    : t('settingsModels.prepare')}
              </Btn>
              {preparing('asr') && (
                <Btn tone="quiet" onClick={prepare.cancelAsr}>
                  {t('common.stop')}
                </Btn>
              )}
              <Link onClick={() => go('voice')}>{t('settingsModels.asr.chooseModel')}</Link>
              {preparing('asr') && prep.progress && <Progress percent={percent} label={progressLabel(prep.progress)} />}
            </>
          )}
          <div className="st-row" style={{ margin: 0, padding: '10px 0 0', width: '100%' }}>
            <div className="st-row-text">
              <span className="st-row-label">{t('settingsModels.asr.browserWhisper')}</span>
              <span className="st-row-hint">{t('settingsModels.asr.browserWhisperHint')}</span>
            </div>
            <div className="st-row-control">
              {settings.localAsrEnabled ? (
                <>
                  <Chip tone="ok">{t('common.ready')}</Chip>
                  <HoloSwitch checked onCheckedChange={(value) => set({ localAsrEnabled: value })} aria-label={t('settingsModels.asr.browserWhisper')} />
                </>
              ) : prep.localAsr !== null ? (
                <>
                  <span className="st-progress-label">{Math.round(prep.localAsr)}%</span>
                  <Btn tone="quiet" onClick={prepare.cancelLocalAsr}>
                    {t('common.stop')}
                  </Btn>
                </>
              ) : (
                <Btn tone="quiet" onClick={prepare.localAsr}>
                  {t('settingsModels.prepare')}
                </Btn>
              )}
            </div>
          </div>
        </Card>

        <Card
          title={t('settingsModels.speech.title')}
          state={!engineRuns ? 'unknown' : !ttsNeedsPreparation(engine) ? 'ready' : status ? (status.tts ? 'ready' : 'missing') : 'unknown'}
          stateLabel={
            !engineRuns
              ? t('settingsModels.speech.cannotRun')
              : !ttsNeedsPreparation(engine)
                ? t('settingsModels.speech.noPreparation')
                : status
                  ? status.tts
                    ? t('settingsModels.speech.running')
                    : engine === 'qwen3tts'
                      ? t('common.notReady')
                      : t('common.notFound')
                  : t('settingsModels.checking')
          }
          description={
            !engineRuns
              ? t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, engine) })
              : engine === 'none'
                ? t('settingsModels.speech.none')
                : engine === 'system'
                  ? t('settingsModels.speech.system')
                  : engine === 'qwen3tts'
                    ? t(setup && !setup.qwenTts.recommended ? 'settingsModels.speech.qwenTooLittleMemory' : 'settingsModels.speech.qwen', {
                        model: setup?.qwenTts.label ?? 'Qwen3-TTS'
                      })
                    : t(osMessageKey('settingsModels.speech.external', os), { engine: ttsEngineLabel(t, engine) })
          }
        >
          {engineRuns && engine === 'qwen3tts' && !status?.tts && prepareButton('tts', prepare.tts)}
          {isExternalTts(engine) && (
            <Btn onClick={() => void window.api.openExternal(ttsSite)}>
              <ExternalLink size={12} />
              {t('settingsModels.speech.get', { engine: ttsEngineLabel(t, engine) })}
            </Btn>
          )}
          <Link onClick={() => go('voice')}>{t('settingsModels.speech.chooseEngine')}</Link>
        </Card>

        <Card
          title={t('settingsModels.agent.title')}
          state={status ? (status.agent === 'found' ? 'ready' : 'missing') : 'unknown'}
          stateLabel={
            status
              ? t(status.agent === 'found' ? 'settingsModels.agent.detected' : status.agent === 'missing' ? 'common.notFound' : 'common.notReady')
              : t('settingsModels.checking')
          }
          description={
            status && status.agent !== 'found' && status.agent !== 'missing'
              ? t(AGENT_CLI_UNAVAILABLE_TEXT[status.agent], { engine: status.agentEngine })
              : t('settingsModels.agent.description', { engine: settings.agentEngine === 'codex' ? 'Codex' : 'Claude Code' })
          }
        >
          <Btn
            onClick={() =>
              void window.api.openExternal(
                settings.agentEngine === 'codex' ? 'https://developers.openai.com/codex/cli' : 'https://docs.claude.com/en/docs/claude-code'
              )
            }
          >
            <ExternalLink size={12} />
            {t('settingsModels.agent.install')}
          </Btn>
          <Link onClick={() => go('agent')}>{t('settingsModels.agent.chooseEngine')}</Link>
        </Card>

        {features.maai && (
          <Card
            title={t('settingsModels.turnTaking.title')}
            state={vap ? (vapReady ? 'ready' : 'missing') : 'unknown'}
            stateLabel={vap ? (vapReady ? t('common.ready') : t('common.notReady')) : t('settingsModels.checking')}
            description={t('settingsModels.turnTaking.description')}
          >
            {vapReady ? (
              <Link onClick={() => go('voice')}>{t('settingsModels.turnTaking.enable')}</Link>
            ) : (
              prepareButton('vap', prepare.vap)
            )}
          </Card>
        )}

        {features.aizuchi && (
          <Card
            title={t('settingsModels.backchannel.title')}
            state={aizuchiClassifier ? (classifierReady ? 'ready' : 'missing') : 'unknown'}
            stateLabel={aizuchiClassifier ? (classifierReady ? t('common.ready') : t('common.notReady')) : t('settingsModels.checking')}
            description={t('settingsModels.backchannel.description')}
          >
            {classifierReady ? (
              <Link onClick={() => go('voice')}>{t('settingsModels.backchannel.enable')}</Link>
            ) : (
              prepareButton('aizuchiClassifier', prepare.aizuchiClassifier)
            )}
          </Card>
        )}

        <Card
          title={t('settingsModels.semanticSearch.title')}
          state={embedding ? (embeddingReady ? 'ready' : 'missing') : 'unknown'}
          stateLabel={embedding ? (embeddingReady ? t('common.ready') : t('common.notReady')) : t('settingsModels.checking')}
          description={t('settingsModels.semanticSearch.description')}
        >
          {embeddingReady ? (
            <Link onClick={() => go('memory')}>{t('settingsModels.semanticSearch.enable')}</Link>
          ) : (
            prepareButton('embedding', prepare.embedding)
          )}
        </Card>
      </div>
    </Page>
  )
}

function Card({
  title,
  state,
  stateLabel,
  description,
  children
}: {
  title: string
  state: 'ready' | 'missing' | 'unknown'
  stateLabel: string
  description: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="st-prep-card" data-state={state} aria-label={title}>
      <header>
        <h3>{title}</h3>
        <Chip tone={state === 'ready' ? 'ok' : state === 'missing' ? 'warn' : 'dim'}>{stateLabel}</Chip>
      </header>
      <p>{description}</p>
      <div className="st-prep-actions">{children}</div>
    </section>
  )
}
