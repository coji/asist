import { z } from 'zod'
import { calendarSettingsSchema } from './calendar'
import { mailSettingsSchema } from './mail'
import { ASR_MODELS, type AsrModel } from './asr-models'
import { dockOrderSchema } from './dock'
import { conversationModelSchema } from './llm-catalog'
import { IRODORI_TTS_VOICE_IDS, QWEN_TTS_SIZES, QWEN_TTS_VOICE_IDS } from './tts-models'
import { CONVERSATION_LOCALES } from './conversation-locale'
import { UI_LOCALES } from './i18n'
import { THEMES } from './themes'
import { errorText } from './i18n/error-text'
import type { StoredFormat } from './stored-format'
import { VOICE_ENGINES, liveModelSettingSchema } from './voice-engine'

/** Every setting, without a default: a patch that names one field must leave the others as they are. */
const fields = {
  onboardingVersion: z.union([z.literal(0), z.literal(1)]),
  /**
   * 1 once the user has read the risks of using ASIST and ticked the box under them, in the setup or,
   * for someone who finished the setup before the notice existed, in a dialog of its own.
   */
  safetyNoticeVersion: z.union([z.literal(0), z.literal(1)]),
  conversationModel: conversationModelSchema,
  /**
   * The provider and model for the aizuchi lookahead, which picks the kind of aizuchi and prepares a
   * short bridging phrase while the user is still speaking.
   */
  bridgeModel: conversationModelSchema,
  voiceEngine: z.enum(VOICE_ENGINES),
  gptLive: liveModelSettingSchema,
  geminiLive: liveModelSettingSchema,
  /**
   * How many seconds a live session stays open after the conversation stops. An open session is
   * billed.
   */
  liveIdleSeconds: z.number().int().min(10).max(900),
  /** The language of the interface. The language of the conversation is a separate matter. */
  uiLocale: z.enum(UI_LOCALES),
  /** The look of the whole interface: its colours, surfaces, background picture and the type of card headings. */
  theme: z.enum(THEMES),
  /** Whether the top of the screen shows how long each stage of the latest turn took. */
  showHud: z.boolean(),
  /** The language the user and the assistant speak: prompts, speech recognition and speech follow it. */
  conversationLocale: z.enum(CONVERSATION_LOCALES),
  /** The ISO 3166-1 alpha-2 country whose weather, news, currency and formats apply. */
  region: z.string().regex(/^[A-Z]{2}$/),
  persona: z.string(),
  conversationLogRetentionDays: z.number().int().positive(),
  ttsEngine: z.enum(['voicevox', 'aivisspeech', 'irodori', 'qwen3tts', 'system', 'none']),
  voicevoxSpeaker: z.number().int().nonnegative(),
  aivisSpeaker: z.number().int().nonnegative().nullable(),
  irodoriTtsVoice: z.enum(IRODORI_TTS_VOICE_IDS),
  qwenTtsVoice: z.enum(QWEN_TTS_VOICE_IDS),
  qwenTtsSize: z.enum(QWEN_TTS_SIZES),
  bargeIn: z.boolean(),
  aizuchi: z.boolean(),
  aizuchiRate: z.number().min(0).max(1),
  listeningAizuchi: z.boolean(),
  /** The VAD's silence duration, chosen in the settings screen. */
  hangoverMs: z.number().int().min(200).max(900),
  /** How often partial recognition runs. Zero disables it. */
  partialIntervalMs: z.number().int().min(0).max(1500),
  calendar: calendarSettingsSchema,
  mail: mailSettingsSchema,
  agentCwd: z.string(),
  agentEngine: z.enum(['codex', 'claude']),
  agentMode: z.enum(['readonly', 'auto']),
  /**
   * The folders the files card, show_files, may display. A job's working directory and the memory
   * directory can always be shown as well.
   */
  fileRoots: z.array(z.string()),
  micAutoStart: z.boolean(),
  localAsrEnabled: z.boolean(),
  nativeMic: z.boolean(),
  noiseSuppression: z.boolean(),
  vapEnabled: z.boolean(),
  memoryEmbeddingEnabled: z.boolean(),
  asrModel: z.enum(ASR_MODELS),
  globalHotkey: z.boolean(),
  /** The order of the bottom navigation, excluding ASIST itself. Dragging an icon changes it. */
  dockOrder: dockOrderSchema
}

/**
 * The settings contract, shared by the saved file and IPC. The defaults are what a settings file written
 * before the field existed is read with. They belong to the file alone: on the patch schema zod would fill
 * them into every save, and saving any one setting put the interface back into Japanese and emptied the
 * folders of the file viewer.
 */
export const appSettingsSchema = z.strictObject({
  ...fields,
  uiLocale: fields.uiLocale.default('ja-JP'),
  conversationLocale: fields.conversationLocale.default('ja-JP'),
  region: fields.region.default('JP'),
  qwenTtsVoice: fields.qwenTtsVoice.default('ono_anna'),
  fileRoots: fields.fileRoots.default([])
})

export type AppSettings = z.infer<typeof appSettingsSchema>
/**
 * A key whose value is undefined names no change. zod keeps such a key in a partial object, and spreading
 * the patch over the settings then put that field back to its default.
 */
const withoutUndefined = <T extends object>(patch: T): T =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T

/**
 * A patch names only the fields it changes, and the same holds inside the mail group: main changes its
 * accounts while the settings screen is open, so a page sending the whole group as it drew it would write
 * back the accounts of that moment, and an account added in the meantime would vanish while its password
 * stays stored.
 */
const patchSchema = z
  .strictObject({ ...fields, mail: z.strictObject(mailSettingsSchema.shape).partial().transform(withoutUndefined) })
  .partial()
  .transform(withoutUndefined)
export type SettingsPatch = z.infer<typeof patchSchema>

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const details = result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    throw new Error(errorText('settings.errors.invalid', { details: details.join(' / ') }))
  }
  return result.data
}

export const parseAppSettings = (value: unknown): AppSettings => parse(appSettingsSchema, value)
export const parseSettingsPatch = (value: unknown): SettingsPatch => parse(patchSchema, value)

/** The settings with the patch applied. Whoever stores the result checks it as a whole. */
export const mergeSettings = (current: AppSettings, patch: SettingsPatch): AppSettings => ({ ...current, ...patch, mail: { ...current.mail, ...patch.mail } })

/**
 * Whether the risks have to be shown in a dialog of their own: the setup is finished, but the box under
 * them has not been ticked. During the setup the notice is one of its steps instead.
 */
export const safetyNoticePending = (settings: Pick<AppSettings, 'onboardingVersion' | 'safetyNoticeVersion'>): boolean =>
  settings.onboardingVersion >= 1 && settings.safetyNoticeVersion < 1

/** The speech recognition models of version 3, which named the macOS runtime, by the names of version 4. */
const V3_ASR_MODELS: Record<string, string> = {
  auto: 'auto',
  'qwen3-asr-1.7b-mlx': 'qwen3-asr-1.7b',
  'whisper-large-v3-turbo-mlx': 'whisper-large-v3-turbo'
}

/**
 * The speech recognition models of version 4 by the names of version 5, which has no Whisper: the local
 * speech moved to llama.cpp, which runs Qwen3-ASR only, and a Mac that chose Whisper for its memory is
 * given the recommendation for that memory.
 */
const V4_ASR_MODELS: Record<string, AsrModel> = {
  auto: 'auto',
  'qwen3-asr-1.7b': 'qwen3-asr-1.7b',
  'qwen3-asr-0.6b': 'qwen3-asr-0.6b',
  'whisper-large-v3-turbo': 'auto'
}

export const SETTINGS_FORMAT: StoredFormat<AppSettings> = {
  name: 'settings.json',
  version: 8,
  upgrades: {
    // Version 2 adds the theme. Everything written before it was drawn in future.
    1: (content) => ({ ...(content as Record<string, unknown>), theme: 'future' }),
    // Version 3 adds the acknowledgement of the risks. Nobody has seen them before it, so everyone,
    // including someone who finished the setup, is asked once.
    2: (content) => ({ ...(content as Record<string, unknown>), safetyNoticeVersion: 0 }),
    // Version 4 names the speech recognition model without the runtime. A value version 3 did not allow
    // is kept, for the parse to refuse.
    3: (content) => {
      const { asrModel, ...rest } = content as Record<string, unknown>
      return { ...rest, asrModel: typeof asrModel === 'string' && Object.hasOwn(V3_ASR_MODELS, asrModel) ? V3_ASR_MODELS[asrModel] : asrModel }
    },
    // Version 5 drops Whisper and adds the size of Qwen3-TTS, which was 0.6B until then. A value version 4
    // did not allow is kept, for the parse to refuse.
    4: (content) => {
      const { asrModel, ...rest } = content as Record<string, unknown>
      return {
        ...rest,
        asrModel: typeof asrModel === 'string' && Object.hasOwn(V4_ASR_MODELS, asrModel) ? V4_ASR_MODELS[asrModel] : asrModel,
        qwenTtsSize: '0.6b'
      }
    },
    // Version 6 reads the calendar from Google alone. The calendars version 5 chose on a Mac are the
    // Mac's own, whose ids no Google calendar has, so they are dropped and the integration is left off
    // until the account is signed in and the calendars are chosen again.
    5: (content) => ({
      ...(content as Record<string, unknown>),
      calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null }
    }),
    // Version 7 lets the times of a turn at the top of the screen be turned off. They matter to someone
    // tuning the conversation rather than to someone using it, so they are hidden for everyone, including
    // those who saw them until now.
    6: (content) => ({ ...(content as Record<string, unknown>), showHud: false }),
    // Version 8 adds Irodori-TTS and its voice. The engine chosen until now stays, and the voice starts on the
    // one a new installation starts on.
    7: (content) => ({ ...(content as Record<string, unknown>), irodoriTtsVoice: 'calm-young-woman' })
  },
  parse: parseAppSettings,
  serialize: (settings) => ({ ...settings })
}
