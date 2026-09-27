import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import type { HotkeyStatus, TtsEngine } from '@shared/ipc'
import { asrModelChoices, type AsrModel } from '@shared/asr-models'
import { HoloSwitch } from '@/components/ui/switch'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { useToastStore } from '@/state/stores'
import { QWEN_TTS_VOICES, ttsEngineRuns, type QwenTtsVoice } from '@shared/tts-models'
import { SPEECH_RUNTIME_UNAVAILABLE_TEXT, hotkeyLabel } from '@shared/platform'
import { conversationFeatures } from '@shared/conversation-locale'
import { ttsEngineLabel, isExternalTts, ttsNeedsPreparation, type SettingsContext } from '../context'
import { useSpeakerOptions } from '../speaker-options'
import { Advanced, Btn, Chip, Group, Link, Page, Row } from '../primitives'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { asrRecommendationReason } from '../../asr-recommendation'
import { osMessageKey } from '@shared/i18n/os-message'

/** The global hotkey, labelled as this OS writes it, with the OS's refusal in place of the hint. */
function HotkeyRow({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const [status, setStatus] = useState<HotkeyStatus | null>(null)
  // The main process registers the hotkey again before the saved settings come back, so reading the
  // status after each change of the switch gives the outcome of that registration.
  useEffect(() => {
    void window.api.hotkeyStatus().then(setStatus)
  }, [settings.globalHotkey])
  const hotkey = hotkeyLabel(platformCapabilities())
  return (
    <Row
      label={t('settingsVoice.mic.hotkey')}
      hint={status === 'failed' ? t('settingsVoice.mic.hotkeyFailed', { hotkey }) : t('settingsVoice.mic.hotkeyHint', { hotkey })}
    >
      <HoloSwitch checked={settings.globalHotkey} onCheckedChange={(v) => set({ globalHotkey: v })} />
    </Row>
  )
}

/** The voice page: speech, recognition, responses and the microphone. Preparing the models and runtimes belongs to the models page. */
export function VoicePage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status, setup, vap, set, save, refreshSetup, refreshStatus, go } = ctx
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const engine = settings.ttsEngine
  const features = conversationFeatures(settings.conversationLocale)
  const capabilities = platformCapabilities()
  const speechRuntime = capabilities.speechRuntime
  // The engines this machine runs that can read the conversation language. A saved engine that is not
  // among them, which a change of language or settings brought from another machine leaves behind,
  // shows as no selection until one is picked.
  const engines: TtsEngine[] = [
    ...(features.japaneseTts ? (['voicevox', 'aivisspeech'] as const) : []),
    ...(features.qwenTts && ttsEngineRuns('qwen3tts', speechRuntime) ? (['qwen3tts'] as const) : []),
    'system',
    'none'
  ]
  const engineUsable = engines.includes(engine)
  const speakers = useSpeakerOptions(engineUsable, engine)
  const asrReady = setup?.asr?.ready === true
  const asrChoices = speechRuntime.kind === null ? [] : asrModelChoices(speechRuntime.kind, settings.asrModel)
  const selectionOffered = asrChoices.every((choice) => choice.offered)
  const vapReady = vap?.runtimeInstalled === true && vap.modelsInstalled
  // True when the selected engine cannot be reached or its model is not prepared; the OS's own speech
  // synthesis needs no preparation and never counts as missing.
  const ttsMissing = engineUsable && ttsNeedsPreparation(engine) && status !== null && !status.tts
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
        <Group title={LIVE_ENGINE_INFO[live].label} description={t('settingsVoice.live.description')}>
          <Row label={t('settingsVoice.live.voice')} hint={`${settings[live === 'gpt-live' ? 'gptLive' : 'geminiLive'].voice}`}>
            <Link onClick={() => go('conversation')}>{t('settingsVoice.openConversation')}</Link>
          </Row>
        </Group>
        <Group title={t('settingsVoice.mic.title')}>
          <Row label={t('settingsVoice.mic.autoStart')} hint={t('settingsVoice.live.micAutoStartHint', { engine: LIVE_ENGINE_INFO[live].label })}>
            <HoloSwitch checked={settings.micAutoStart} onCheckedChange={(v) => set({ micAutoStart: v })} />
          </Row>
          <HotkeyRow ctx={ctx} />
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
        </Group>
      </Page>
    )
  }

  return (
    <Page title={t('settingsVoice.title')} lead={t('settingsVoice.lead')}>
      <Group title={t('settingsVoice.speech.title')} description={t(osMessageKey('settingsVoice.speech.description', capabilities.os))}>
        <Row
          label={t('settingsVoice.speech.engine')}
          hint={
            !ttsEngineRuns(engine, speechRuntime)
              ? t('voice.speech.cannotRunHere', { engine: ttsEngineLabel(t, engine) })
              : !ttsMissing
                ? undefined
                : engine === 'qwen3tts'
                  ? t('settingsVoice.speech.qwenNotPrepared')
                  : t(osMessageKey('settingsVoice.speech.engineMissing', capabilities.os), { engine: ttsEngineLabel(t, engine) })
          }
        >
          {ttsMissing && (engine === 'qwen3tts' ? <Link onClick={() => go('models')}>{t('common.openModels')}</Link> : <Chip tone="warn">{t('common.notFound')}</Chip>)}
          <select
            className="st-select"
            aria-label={t('settingsVoice.speech.engineLabel')}
            value={engineUsable ? engine : ''}
            onChange={(e) => set({ ttsEngine: e.target.value as TtsEngine })}
          >
            {engines.map((option) => (
              <option key={option} value={option}>
                {option === 'qwen3tts' || option === 'none' ? t(`settingsVoice.speech.engines.${option}`) : ttsEngineLabel(t, option)}
              </option>
            ))}
          </select>
        </Row>
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
        {engineUsable && engine === 'qwen3tts' && (
          <Row label={t('settingsVoice.speech.voice')} hint={t('settingsVoice.speech.voiceHint')}>
            <select
              className="st-select"
              aria-label={t('settingsVoice.speech.voice')}
              style={{ maxWidth: 220 }}
              value={settings.qwenTtsVoice}
              onChange={(e) => set({ qwenTtsVoice: e.target.value as QwenTtsVoice })}
            >
              {QWEN_TTS_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {t(voice.gender === 'female' ? 'settingsVoice.speech.femaleVoice' : 'settingsVoice.speech.maleVoice', { name: voice.name })}
                </option>
              ))}
            </select>
            {!ttsMissing && preview}
          </Row>
        )}
      </Group>

      <Group title={t('settingsVoice.recognition.title')} description={t('settingsVoice.recognition.description')}>
        {speechRuntime.kind === null ? (
          <Row label={t('settingsVoice.recognition.model')} hint={t(SPEECH_RUNTIME_UNAVAILABLE_TEXT[speechRuntime.reason])} />
        ) : (
          <>
            <Row
              label={t('settingsVoice.recognition.model')}
              hint={
                !selectionOffered
                  ? t('speechRecognition.errors.unknownModel')
                  : setup?.asr
                    ? t('settingsVoice.recognition.modelHint', { memoryGb: setup.asr.totalMemoryGb, model: setup.asr.label, reason: asrRecommendationReason(t, setup.asr) })
                    : t('settingsVoice.recognition.checking')
              }
            >
              <Chip tone={asrReady ? 'ok' : 'warn'}>{asrReady ? t('common.ready') : t('common.notReady')}</Chip>
              <select
                className="st-select"
                aria-label={t('settingsVoice.recognition.modelLabel')}
                value={settings.asrModel}
                onChange={(event) => {
                  const asrModel = event.target.value as AsrModel
                  void save({ asrModel })
                    .then(() => refreshSetup())
                    .then(() => refreshStatus())
                    .catch((err: unknown) => toast({ kind: 'error', title: t('settingsVoice.recognition.changeFailed'), body: displayError(err) }))
                }}
              >
                <option value="auto">{t('settingsVoice.recognition.automatic')}</option>
                {asrChoices.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Row>
            {!asrReady && (
              <Row label={t('settingsVoice.recognition.prepare')} hint={t('settingsVoice.recognition.prepareHint')}>
                <Link onClick={() => go('models')}>{t('common.openModels')}</Link>
              </Row>
            )}
          </>
        )}
        <Row
          label={t('settingsVoice.recognition.browserWhisper')}
          hint={
            settings.localAsrEnabled
              ? t('settingsVoice.recognition.browserWhisperOn')
              : t('settingsVoice.recognition.browserWhisperOff')
          }
        >
          {settings.localAsrEnabled ? (
            <HoloSwitch checked onCheckedChange={(value) => set({ localAsrEnabled: value })} />
          ) : (
            <Link onClick={() => go('models')}>{t('common.openModels')}</Link>
          )}
        </Row>
      </Group>

      <Group title={t('settingsVoice.response.title')}>
        <Row label={t('settingsVoice.response.bargeIn')} hint={t('settingsVoice.response.bargeInHint')}>
          <HoloSwitch checked={settings.bargeIn} onCheckedChange={(v) => set({ bargeIn: v })} />
        </Row>
        {features.aizuchi && (
          <>
            <Row label={t('settingsVoice.response.aizuchi')} hint={t('settingsVoice.response.aizuchiHint')}>
              <HoloSwitch checked={settings.aizuchi} onCheckedChange={(v) => set({ aizuchi: v })} />
            </Row>
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
      </Group>

      <Group title={t('settingsVoice.mic.title')}>
        <Row label={t('settingsVoice.mic.autoStart')}>
          <HoloSwitch checked={settings.micAutoStart} onCheckedChange={(v) => set({ micAutoStart: v })} />
        </Row>
        <HotkeyRow ctx={ctx} />
        <Advanced title={t('settingsVoice.mic.advanced')} note={t('settingsVoice.mic.advancedNote')}>
          <Row
            label={t('settingsVoice.mic.hangover')}
            hint={t('settingsVoice.mic.hangoverHint')}
          >
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
          {features.maai && (
            <Row
              label={t('settingsVoice.mic.turnTaking')}
              hint={
                vapReady
                  ? t('settingsVoice.mic.turnTakingOn')
                  : t('settingsVoice.mic.turnTakingOff')
              }
            >
              {vapReady ? (
                <HoloSwitch checked={settings.vapEnabled} onCheckedChange={(v) => set({ vapEnabled: v })} />
              ) : (
                <Link onClick={() => go('models')}>{t('common.openModels')}</Link>
              )}
            </Row>
          )}
        </Advanced>
      </Group>
    </Page>
  )
}
