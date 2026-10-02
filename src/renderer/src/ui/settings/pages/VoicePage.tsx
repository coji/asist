import { useEffect, useState } from 'react'
import { ExternalLink, Play } from 'lucide-react'
import type { HotkeyStatus, TtsEngine } from '@shared/ipc'
import { asrModelChoices, type AsrModel } from '@shared/asr-models'
import { HoloSwitch } from '@/components/ui/switch'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { useToastStore } from '@/state/stores'
import { IRODORI_TTS_VOICES, QWEN_TTS_MODELS, QWEN_TTS_SIZES, QWEN_TTS_VOICES, isLocalTtsEngine, localTtsModel, localTtsSizeGb, offeredQwenTtsSizes, recommendLocalTts, ttsEngineRuns, type IrodoriTtsVoice, type QwenTtsSize, type QwenTtsVoice } from '@shared/tts-models'
import { LOCAL_SPEECH_UNAVAILABLE_TEXT, shortcutLabel } from '@shared/platform'
import { conversationFeatures, languageOf, ttsEngineSpeaks } from '@shared/conversation-locale'
import { TTS_SITE, ttsEngineLabel, isExternalTts, readFailure, readStatus, speechReadiness, statusOf, type SettingsContext, type StatusRead } from '../context'
import { useSpeakerOptions } from '../speaker-options'
import { Advanced, Btn, Chip, Group, Page, Row } from '../primitives'
import { PrepLine, PrepProgress, PrepareButton, UnreadChip, WhisperControl } from '../preparation'
import { VoicePicker, liveVoiceSample, localVoiceSample, playVoiceSample } from '../voice-picker'
import { LIVE_ENGINE_INFO, isLiveEngine, type LiveEngine } from '@shared/voice-engine'
import { displayError } from '@/display-error'
import { useFormatLocale, useT, useUiLocale } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { asrRecommendationReason } from '../../asr-recommendation'
import { osMessageKey } from '@shared/i18n/os-message'

/** The global hotkey, labelled as this OS writes it, with the OS's refusal in place of the hint. */
function HotkeyRow({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const [status, setStatus] = useState<StatusRead<HotkeyStatus>>(null)
  // The main process registers the hotkey again before the saved settings come back, so reading the
  // status after each change of the switch gives the outcome of that registration.
  useEffect(() => {
    void readStatus(() => window.api.hotkeyStatus(), setStatus)
  }, [settings.globalHotkey])
  const { os, hotkey: accelerator } = platformCapabilities()
  const hotkey = shortcutLabel(os, accelerator)
  return (
    <Row
      label={t('settingsVoice.mic.hotkey')}
      hint={readFailure(status) ?? (statusOf(status) === 'failed' ? t('settingsVoice.mic.hotkeyFailed', { hotkey }) : t('settingsVoice.mic.hotkeyHint', { hotkey }))}
    >
      <HoloSwitch checked={settings.globalHotkey} onCheckedChange={(v) => set({ globalHotkey: v })} />
    </Row>
  )
}

/** The voice of a live engine, chosen from the provider's voices with a bundled sample of each. */
function LiveVoiceRow({ engine, ctx }: { engine: LiveEngine; ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const info = LIVE_ENGINE_INFO[engine]
  const current = settings.geminiLive
  const listedVoice = info.voices.some((voice) => voice.id === current.voice)
  const sample = liveVoiceSample(engine, current.voice)
  return (
    <Row label={t('settingsConversation.live.voice')} hint={t('settingsConversation.live.voiceHint')}>
      <select
        className="st-select"
        aria-label={t('settingsConversation.live.voiceLabel', { engine: info.label })}
        value={current.voice}
        onChange={(e) => set({ geminiLive: { ...current, voice: e.target.value } })}
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
        disabled={sample === null}
        title={sample === null ? t('settingsConversation.live.noSample') : undefined}
        onClick={() => {
          if (!sample) return
          void playVoiceSample(sample).catch((err: unknown) => toast({ kind: 'error', title: t('common.playSampleFailed'), body: displayError(err) }))
        }}
      >
        <Play size={12} />
        {t('common.playSample')}
      </Btn>
    </Row>
  )
}

/** The microphone: starting it on launch, the hotkey, and the rarely touched details folded away. */
function MicGroup({ ctx, live }: { ctx: SettingsContext; live: LiveEngine | null }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const capabilities = platformCapabilities()
  return (
    <Group title={t('settingsVoice.mic.title')}>
      <Row label={t('settingsVoice.mic.autoStart')} hint={live ? t('settingsVoice.live.micAutoStartHint', { engine: LIVE_ENGINE_INFO[live].label }) : undefined}>
        <HoloSwitch checked={settings.micAutoStart} onCheckedChange={(v) => set({ micAutoStart: v })} />
      </Row>
      <HotkeyRow ctx={ctx} />
      {/* A live engine keeps only the two switches of the native microphone, so without it there is nothing to fold away. */}
      {(!live || capabilities.nativeMic) && (
        <Advanced title={t('settingsVoice.mic.advanced')} note={t('settingsVoice.mic.advancedNote')}>
          {!live && (
            <>
              <Row label={t('settingsVoice.mic.hangover')} hint={t('settingsVoice.mic.hangoverHint')}>
                <input
                  type="range"
                  aria-label={t('settingsVoice.mic.hangover')}
                  min={200}
                  max={900}
                  step={50}
                  value={settings.hangoverMs}
                  onChange={(e) => set({ hangoverMs: Number(e.target.value) })}
                />
                <span className="st-value">{settings.hangoverMs}ms</span>
              </Row>
              <Row label={t('settingsVoice.mic.partialInterval')} hint={t('settingsVoice.mic.partialIntervalHint')}>
                <input
                  type="range"
                  aria-label={t('settingsVoice.mic.partialInterval')}
                  min={0}
                  max={1500}
                  step={100}
                  value={settings.partialIntervalMs}
                  onChange={(e) => set({ partialIntervalMs: Number(e.target.value) })}
                />
                <span className="st-value">{settings.partialIntervalMs === 0 ? t('common.off') : `${settings.partialIntervalMs}ms`}</span>
              </Row>
            </>
          )}
          {/* DeepFilterNet runs on the frames of the native microphone alone, so both switches go with it. */}
          {capabilities.nativeMic && (
            <>
              <Row label={t('settingsVoice.mic.echoCancellation')} hint={t('settingsVoice.mic.echoCancellationHint')}>
                <HoloSwitch checked={settings.nativeMic} onCheckedChange={(v) => set({ nativeMic: v })} />
              </Row>
              <Row label={t('settingsVoice.mic.noiseSuppression')} hint={t('settingsVoice.mic.noiseSuppressionHint')}>
                <HoloSwitch checked={settings.noiseSuppression} onCheckedChange={(v) => set({ noiseSuppression: v })} />
              </Row>
            </>
          )}
        </Advanced>
      )}
    </Group>
  )
}

/**
 * The voice page: how ASIST listens, how it reads aloud, how it responds, and the microphone. What a
 * choice needs downloaded is prepared under the row that chose it.
 */
export function VoicePage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, setup, vap, aizuchiClassifier, prepare, set, save, refreshStatus } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const formatLocale = useFormatLocale()
  const languageName = new Intl.DisplayNames([useUiLocale()], { type: 'language' })
  const engine = settings.ttsEngine
  const sampleLanguage = languageOf(settings.conversationLocale)
  const features = conversationFeatures(settings.conversationLocale)
  const capabilities = platformCapabilities()
  const localSpeech = capabilities.localSpeech
  // The engines this machine runs that can read the conversation language. A saved engine that is not
  // among them, which a change of language or settings brought from another machine leaves behind,
  // shows as no selection until one is picked.
  const engines = (['irodori', 'qwen3tts', 'voicevox', 'aivisspeech', 'system', 'none'] as const).filter(
    (option) => ttsEngineSpeaks(settings.conversationLocale, option) && ttsEngineRuns(option, localSpeech)
  )
  const engineUsable = (engines as readonly TtsEngine[]).includes(engine)
  const speakers = useSpeakerOptions(engineUsable, engine)
  // The size is chosen where the memory holds more than one. A saved size this machine does not offer,
  // which settings brought from a larger machine leave behind, stays in the list because it is the one
  // that runs, until a smaller one is picked.
  const offeredSizes = offeredQwenTtsSizes(localSpeech)
  const qwenTtsSizes = QWEN_TTS_SIZES.filter((size) => offeredSizes.includes(size) || size === settings.qwenTtsSize)
  const asrReady = status?.asr === true
  const asrChoices = localSpeech.backend === null ? [] : asrModelChoices()
  const asrModel = statusOf(setup)?.asr ?? null
  const vapRead = statusOf(vap)
  const classifier = statusOf(aizuchiClassifier)
  const vapReady = vapRead?.runtimeInstalled === true && vapRead.modelsInstalled
  const classifierReady = classifier?.runtimeInstalled === true && classifier.modelInstalled
  const readiness = engineUsable ? speechReadiness(engine, status, localSpeech) : null
  const ttsMissing = readiness === 'missing'
  const preview = (
    <Btn
      tone="quiet"
      onClick={() =>
        void window.api
          .ttsTest()
          .then((seg) => speechPlayer.playClip(seg.audio, seg.text, { role: 'preview' }))
          .catch((err: unknown) => toast({ kind: 'error', title: t('common.playSampleFailed'), body: displayError(err) }))
      }
    >
      <Play size={12} />
      {t('common.playSample')}
    </Btn>
  )
  const live = isLiveEngine(settings.voiceEngine) ? settings.voiceEngine : null

  if (live) {
    return (
      <Page title={t('settingsVoice.title')} lead={t('settingsVoice.live.lead', { engine: LIVE_ENGINE_INFO[live].label })}>
        <Group title={LIVE_ENGINE_INFO[live].label}>
          <LiveVoiceRow engine={live} ctx={ctx} />
        </Group>
        <MicGroup ctx={ctx} live={live} />
      </Page>
    )
  }

  return (
    <Page title={t('settingsVoice.title')} lead={t('settingsVoice.lead')}>
      <Group title={t('settingsVoice.recognition.title')} description={t('settingsVoice.recognition.description')}>
        {localSpeech.backend === null ? (
          <Row label={t('settingsVoice.recognition.model')} hint={t(LOCAL_SPEECH_UNAVAILABLE_TEXT[localSpeech.reason])} />
        ) : (
          <>
            <Row
              label={t('settingsVoice.recognition.model')}
              hint={
                asrModel
                  ? t('settingsVoice.recognition.modelHint', { memoryGb: asrModel.totalMemoryGb, model: asrModel.label, reason: asrRecommendationReason(t, localSpeech.backend, asrModel) })
                  : (readFailure(setup) ?? t('settingsVoice.recognition.checking'))
              }
            >
              <Chip tone={asrReady ? 'ok' : 'warn'}>{asrReady ? t('common.ready') : t('common.notReady')}</Chip>
              {asrReady && <PrepareButton ctx={ctx} target="asr" onClick={prepare.asr} tone="quiet" label={t('settingsModels.asr.checkAgain')} />}
              <select
                className="st-select"
                aria-label={t('settingsVoice.recognition.modelLabel')}
                value={settings.asrModel}
                onChange={(event) => {
                  const asrModel = event.target.value as AsrModel
                  void save({ asrModel })
                    .then(() => refreshStatus())
                    .catch((err: unknown) => toast({ kind: 'error', title: t('settingsVoice.recognition.changeFailed'), body: displayError(err) }))
                }}
              >
                <option value="auto">{t(`settingsVoice.recognition.automatic.${localSpeech.backend}`)}</option>
                {asrChoices.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Row>
            {asrReady && <PrepProgress ctx={ctx} target="asr" />}
            {!asrReady && asrModel && (
              <PrepLine
                text={t(settings.localAsrEnabled ? 'settingsModels.asr.notDownloadedWhisper' : 'settingsModels.asr.notDownloaded', { model: asrModel.label })}
                progress={<PrepProgress ctx={ctx} target="asr" />}
              >
                <PrepareButton ctx={ctx} target="asr" onClick={prepare.asr} onCancel={prepare.cancelAsr} />
              </PrepLine>
            )}
          </>
        )}
        <Row
          label={t('settingsVoice.recognition.browserWhisper')}
          hint={settings.localAsrEnabled ? t('settingsVoice.recognition.browserWhisperOn') : t('settingsVoice.recognition.browserWhisperOff')}
        >
          <WhisperControl ctx={ctx} />
        </Row>
      </Group>

      <Group title={t('settingsVoice.speech.title')} description={t(osMessageKey('settingsVoice.speech.description', capabilities.os))}>
        <Row label={t('settingsVoice.speech.engine')} hint={!ttsEngineRuns(engine, localSpeech) ? t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, engine) }) : undefined}>
          {readiness === 'starting' && <Chip>{t('settingsModels.starting')}</Chip>}
          {ttsMissing && <Chip tone="warn">{isLocalTtsEngine(engine) ? t('common.notReady') : t('common.notFound')}</Chip>}
          <select
            className="st-select"
            aria-label={t('settingsVoice.speech.engineLabel')}
            value={engineUsable ? engine : ''}
            onChange={(e) => set({ ttsEngine: e.target.value as TtsEngine })}
          >
            {engines.map((option) => (
              <option key={option} value={option}>
                {option === 'irodori' || option === 'qwen3tts' || option === 'none' ? t(`settingsVoice.speech.engines.${option}`) : ttsEngineLabel(t, option)}
              </option>
            ))}
          </select>
        </Row>
        {ttsMissing && isLocalTtsEngine(engine) && (
          <PrepLine
            text={t(!recommendLocalTts(localSpeech) ? osMessageKey('settingsModels.speech.localModelTooLittleMemory', capabilities.os) : 'settingsModels.speech.localModel', {
              model: localTtsModel(engine, settings.qwenTtsSize).label,
              sizeGb: new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 }).format(localTtsSizeGb(localTtsModel(engine, settings.qwenTtsSize)))
            })}
            progress={<PrepProgress ctx={ctx} target="tts" />}
          >
            <PrepareButton ctx={ctx} target="tts" onClick={prepare.tts} />
          </PrepLine>
        )}
        {ttsMissing && isExternalTts(engine) && (
          <PrepLine text={t(osMessageKey('settingsVoice.speech.engineMissing', capabilities.os), { engine: ttsEngineLabel(t, engine) })}>
            <Btn onClick={() => void window.api.openExternal(TTS_SITE[engine])}>
              <ExternalLink size={12} />
              {t('settingsModels.speech.get', { engine: ttsEngineLabel(t, engine) })}
            </Btn>
          </PrepLine>
        )}
        {engineUsable && isExternalTts(engine) && (
          <Row
            label={t('settingsVoice.speech.speaker')}
            hint={
              speakers.status === 'error'
                ? speakers.error
                : speakers.status === 'loading'
                  ? t('settingsVoice.speech.speakersLoading')
                  : speakers.options.length === 0
                    ? t('settingsVoice.speech.noSpeakers')
                    : undefined
            }
          >
            <select
              className="st-select"
              aria-label={t('settingsVoice.speech.speaker')}
              style={{ maxWidth: 220 }}
              disabled={speakers.status !== 'ready' || speakers.options.length === 0}
              value={engine === 'voicevox' ? settings.voicevoxSpeaker : (settings.aivisSpeaker ?? '')}
              onChange={(e) =>
                set(
                  engine === 'voicevox'
                    ? { voicevoxSpeaker: Number(e.target.value) }
                    : { aivisSpeaker: e.target.value === '' ? null : Number(e.target.value) }
                )
              }
            >
              {engine === 'aivisspeech' && <option value="">{t('settingsVoice.speech.automaticSpeaker')}</option>}
              {speakers.options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {preview}
          </Row>
        )}
        {engineUsable && engine === 'irodori' && (
          <Row label={t('settingsVoice.speech.voice')} wide>
            <VoicePicker
              label={t('settingsVoice.speech.voice')}
              voices={IRODORI_TTS_VOICES.map((voice) => ({ id: voice.id, name: t(voice.label), sample: localVoiceSample('irodori', voice.id, sampleLanguage) }))}
              selected={settings.irodoriTtsVoice}
              onSelect={(id) => set({ irodoriTtsVoice: id as IrodoriTtsVoice })}
            />
          </Row>
        )}
        {engineUsable && engine === 'qwen3tts' && qwenTtsSizes.length > 1 && (
          <Row label={t('settingsVoice.speech.model')} hint={t('settingsVoice.speech.modelHint')}>
            <select
              className="st-select"
              aria-label={t('settingsVoice.speech.model')}
              value={settings.qwenTtsSize}
              onChange={(e) => set({ qwenTtsSize: e.target.value as QwenTtsSize })}
            >
              {qwenTtsSizes.map((size) => (
                <option key={size} value={size}>
                  {QWEN_TTS_MODELS[size].label}
                </option>
              ))}
            </select>
          </Row>
        )}
        {engineUsable && engine === 'qwen3tts' && (
          <Row label={t('settingsVoice.speech.voice')} hint={t('settingsVoice.speech.voiceHint')} wide>
            <VoicePicker
              label={t('settingsVoice.speech.voice')}
              voices={QWEN_TTS_VOICES.map((voice) => ({
                id: voice.id,
                name: voice.name,
                detail: t(voice.gender === 'female' ? 'settingsVoice.speech.femaleSpeaker' : 'settingsVoice.speech.maleSpeaker', { language: languageName.of(voice.native) ?? voice.native }),
                sample: localVoiceSample('qwen3tts', voice.id, sampleLanguage)
              }))}
              selected={settings.qwenTtsVoice}
              onSelect={(id) => set({ qwenTtsVoice: id as QwenTtsVoice })}
            />
          </Row>
        )}
      </Group>

      <Group title={t('settingsVoice.response.title')}>
        <Row label={t('settingsVoice.response.bargeIn')} hint={t('settingsVoice.response.bargeInHint')}>
          <HoloSwitch checked={settings.bargeIn} onCheckedChange={(v) => set({ bargeIn: v })} />
        </Row>
        {features.aizuchi && (
          <>
            <Row label={t('settingsVoice.response.aizuchi')} hint={(settings.aizuchi ? readFailure(aizuchiClassifier) : null) ?? t('settingsVoice.response.aizuchiHint')}>
              <HoloSwitch checked={settings.aizuchi} onCheckedChange={(v) => set({ aizuchi: v })} />
            </Row>
            {settings.aizuchi && classifier !== null && !classifierReady && (
              <PrepLine text={t('settingsModels.backchannel.notPrepared')} progress={<PrepProgress ctx={ctx} target="aizuchiClassifier" />}>
                <PrepareButton ctx={ctx} target="aizuchiClassifier" onClick={prepare.aizuchiClassifier} />
              </PrepLine>
            )}
            <Row label={t('settingsVoice.response.listeningAizuchi')} hint={t('settingsVoice.response.listeningAizuchiHint')}>
              <HoloSwitch checked={settings.listeningAizuchi} onCheckedChange={(v) => set({ listeningAizuchi: v })} />
            </Row>
            <Row label={t('settingsVoice.response.aizuchiRate')}>
              <input
                type="range"
                aria-label={t('settingsVoice.response.aizuchiRate')}
                min={0}
                max={100}
                value={settings.aizuchiRate * 100}
                onChange={(e) => set({ aizuchiRate: Number(e.target.value) / 100 })}
              />
              <span className="st-value">{Math.round(settings.aizuchiRate * 100)}%</span>
            </Row>
          </>
        )}
        {features.maai && (
          <>
            <Row label={t('settingsVoice.mic.turnTaking')} hint={readFailure(vap) ?? (vapReady ? t('settingsVoice.mic.turnTakingOn') : t('settingsModels.turnTaking.hint'))}>
              {vapRead === null ? (
                <UnreadChip status={vap} />
              ) : vapReady ? (
                <HoloSwitch checked={settings.vapEnabled} onCheckedChange={(v) => set({ vapEnabled: v })} />
              ) : (
                <PrepareButton ctx={ctx} target="vap" onClick={prepare.vap} label={t('settingsModels.prepareAndTurnOn')} />
              )}
            </Row>
            <PrepProgress ctx={ctx} target="vap" />
          </>
        )}
      </Group>

      <MicGroup ctx={ctx} live={null} />
    </Page>
  )
}
