import { z } from 'zod'
import type { MessageKey, Translate } from './i18n'
import { errorText } from './i18n/error-text'
import type { LlmProvider } from './llm-catalog'

/**
 * The voice engines, that is, who handles listening, speaking and timing in a conversation.
 *
 * - cascade: the renderer's VAD and ASR produce text, brain decides in runTurn, and VOICEVOX or
 *   AivisSpeech speaks.
 * - gpt-live: GPT-Live-1 listens and speaks, and delegates deciding and tools back to brain's runTurn
 *   through client delegation.
 * - gemini-live: Gemini Live listens and speaks and also decides and calls functions itself, using
 *   only brain's parts.
 *
 * With either live engine the audio goes to the provider, the voice is the provider's, and the model
 * decides about aizuchi and barge-in. The prices are the providers' public ones as of 2026-09:
 * GPT-Live bills the time the session is open, Gemini the minutes of audio in and out.
 */

export const VOICE_ENGINES = ['cascade', 'gpt-live', 'gemini-live'] as const
export type VoiceEngine = (typeof VOICE_ENGINES)[number]
export type LiveEngine = Exclude<VoiceEngine, 'cascade'>

/** Takes any string, because the first-run setup hands main a voice mode that is either a way of listening or a live engine. */
export const isLiveEngine = (value: string): value is LiveEngine => value !== 'cascade' && (VOICE_ENGINES as readonly string[]).includes(value)

/**
 * The longest typed text a live engine is handed, in UTF-16 code units as `String.length` counts them.
 * Longer text is refused, never cut. A cascade turn has no such limit: the conversation model is bounded
 * only by its context window, which the history's compaction already watches.
 */
export const LIVE_TEXT_MAX_LENGTH = 4000

/** The typed text as a live engine takes it, trimmed. Text over the limit is refused with a message for the user. */
export function liveTextInput(text: unknown): string {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) throw new Error('invalid live text')
  if (value.length > LIVE_TEXT_MAX_LENGTH) throw new Error(errorText('voice.live.textTooLong', { max: LIVE_TEXT_MAX_LENGTH }))
  return value
}

/** The model and voice chosen for a live engine. `model` is the model ID of the provider's Live API. */
export interface LiveModelSetting {
  model: string
  voice: string
}

export const liveModelSettingSchema = z.strictObject({
  model: z.string().trim().min(1),
  voice: z.string().trim().min(1)
})

/** The key of a description in the dictionary, because a shared module holds no interface text. */
type ModelNote = Extract<MessageKey, `voiceEngines.models.${string}`>
type VoiceNote = Extract<MessageKey, `voiceEngines.voices.${string}`>

export interface LiveEngineInfo {
  label: string
  /** The provider whose API key is read, through the envKey of llm-catalog. */
  provider: LlmProvider
  models: ReadonlyArray<{ id: string; label: string; note: ModelNote }>
  /**
   * The voices the provider offers. A note names the one-phrase description from the provider's
   * documentation, and is null when the documentation gives none.
   */
  voices: ReadonlyArray<{ id: string; note: VoiceNote | null }>
  /**
   * The price in USD per minute. GPT-Live counts the session time, while Gemini counts audio in and
   * audio out separately.
   */
  pricing: { sessionPerMinute?: number; audioInPerMinute?: number; audioOutPerMinute?: number }
  /**
   * The sample rate in Hz of the audio round trip. The renderer's microphone sends 16 kHz and the main
   * process resamples to this rate.
   */
  inputRate: 16000 | 24000
  outputRate: 24000
}

export const LIVE_ENGINE_INFO: Record<LiveEngine, LiveEngineInfo> = {
  'gpt-live': {
    label: 'GPT-Live',
    provider: 'openai',
    models: [{ id: 'gpt-live-1', label: 'GPT-Live 1', note: 'voiceEngines.models.gptLive1' }],
    // Every BuiltInVoice of the SDK, openai 7.15. The documentation describes none of them, so no
    // voice carries a note.
    voices: [
      'marin', 'cedar', 'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cinder', 'coral', 'delta', 'echo', 'gleam',
      'meridian', 'quartz', 'ripple', 'sage', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow'
    ].map((id) => ({ id, note: null })),
    pricing: { sessionPerMinute: 0.05 },
    inputRate: 24000,
    outputRate: 24000
  },
  'gemini-live': {
    label: 'Gemini Live',
    provider: 'google',
    models: [
      { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live', note: 'voiceEngines.models.gemini38Live' },
      { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live (extended thinking)', note: 'voiceEngines.models.gemini38LiveExtendedThinking' }
    ],
    // The 30 voices of the speech-generation documentation. On 2026-09-16 every one of them was
    // confirmed to return audio on gemini-3.8-live.
    voices: [
      { id: 'Kore', note: 'voiceEngines.voices.kore' },
      { id: 'Zephyr', note: 'voiceEngines.voices.zephyr' },
      { id: 'Puck', note: 'voiceEngines.voices.puck' },
      { id: 'Charon', note: 'voiceEngines.voices.charon' },
      { id: 'Fenrir', note: 'voiceEngines.voices.fenrir' },
      { id: 'Leda', note: 'voiceEngines.voices.leda' },
      { id: 'Orus', note: 'voiceEngines.voices.orus' },
      { id: 'Aoede', note: 'voiceEngines.voices.aoede' },
      { id: 'Callirrhoe', note: 'voiceEngines.voices.callirrhoe' },
      { id: 'Autonoe', note: 'voiceEngines.voices.autonoe' },
      { id: 'Enceladus', note: 'voiceEngines.voices.enceladus' },
      { id: 'Iapetus', note: 'voiceEngines.voices.iapetus' },
      { id: 'Umbriel', note: 'voiceEngines.voices.umbriel' },
      { id: 'Algieba', note: 'voiceEngines.voices.algieba' },
      { id: 'Despina', note: 'voiceEngines.voices.despina' },
      { id: 'Erinome', note: 'voiceEngines.voices.erinome' },
      { id: 'Algenib', note: 'voiceEngines.voices.algenib' },
      { id: 'Rasalgethi', note: 'voiceEngines.voices.rasalgethi' },
      { id: 'Laomedeia', note: 'voiceEngines.voices.laomedeia' },
      { id: 'Achernar', note: 'voiceEngines.voices.achernar' },
      { id: 'Alnilam', note: 'voiceEngines.voices.alnilam' },
      { id: 'Schedar', note: 'voiceEngines.voices.schedar' },
      { id: 'Gacrux', note: 'voiceEngines.voices.gacrux' },
      { id: 'Pulcherrima', note: 'voiceEngines.voices.pulcherrima' },
      { id: 'Achird', note: 'voiceEngines.voices.achird' },
      { id: 'Zubenelgenubi', note: 'voiceEngines.voices.zubenelgenubi' },
      { id: 'Vindemiatrix', note: 'voiceEngines.voices.vindemiatrix' },
      { id: 'Sadachbia', note: 'voiceEngines.voices.sadachbia' },
      { id: 'Sadaltager', note: 'voiceEngines.voices.sadaltager' },
      { id: 'Sulafat', note: 'voiceEngines.voices.sulafat' }
    ],
    pricing: { audioInPerMinute: 0.005, audioOutPerMinute: 0.018 },
    inputRate: 16000,
    outputRate: 24000
  }
}

export const DEFAULT_LIVE_MODELS: Record<LiveEngine, LiveModelSetting> = {
  'gpt-live': { model: 'gpt-live-1', voice: 'marin' },
  'gemini-live': { model: 'gemini-3.8-live', voice: 'Kore' }
}

/**
 * Prices are only displayed and logged, so floating-point noise is cut off at a unit of 1e-6 USD.
 */
const usd = (value: number): number => Math.round(value * 1e6) / 1e6

/** The cost in USD of a GPT-Live session of the given length. */
export const gptLiveCost = (seconds: number): number => usd((seconds / 60) * (LIVE_ENGINE_INFO['gpt-live'].pricing.sessionPerMinute ?? 0))

/** The cost in USD of the given seconds of Gemini Live audio in and audio out. */
export const geminiLiveCost = (inputSeconds: number, outputSeconds: number): number => {
  const pricing = LIVE_ENGINE_INFO['gemini-live'].pricing
  return usd((inputSeconds / 60) * (pricing.audioInPerMinute ?? 0) + (outputSeconds / 60) * (pricing.audioOutPerMinute ?? 0))
}

export const voiceEngineLabel = (t: Translate, engine: VoiceEngine): string =>
  engine === 'cascade' ? t('voiceEngines.cascade.label') : LIVE_ENGINE_INFO[engine].label
