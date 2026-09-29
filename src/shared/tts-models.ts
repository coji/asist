import type { TtsEngine } from './ipc'
import type { PinnedFile } from './pinned-file'
import type { PlatformCapabilities, SpeechBackend } from './platform'

/** The sizes of Qwen3-TTS the setting can name. */
export const QWEN_TTS_SIZES = ['0.6b', '1.7b'] as const

export type QwenTtsSize = (typeof QWEN_TTS_SIZES)[number]

/** One size of Qwen3-TTS for qwen3-tts-ggml: its talker, which runs with the shared codec. */
export interface QwenTtsModelSpec {
  label: string
  talker: PinnedFile
}

const QWEN_TTS_REPO = { repo: 'sakasegawa/qwen3-tts-ggml', revision: 'c014bc3b717c001aa7ac870178656acc30b78f09' }

/** The codec decoder every size speaks through. */
export const QWEN_TTS_CODEC: PinnedFile = {
  ...QWEN_TTS_REPO,
  file: 'qwen3-tts-codec-12hz-f16.gguf',
  bytes: 245_553_152,
  sha256: '38763be32099ad36b7b4345fc852ac379fb4fde0782ff85929d2b984b4bc22c1'
}

/**
 * The sizes, measured on 2026-09-29 with qwen3-tts-ggml and Q8_0 on Japanese sentences: on an M5 with
 * Metal 0.6B speaks its first audio 0.05 s after the request at 0.35 of real time in 2.3 GB, 1.7B 0.08 s
 * and 0.49 in 3.3 GB; on an RTX 2080 with Vulkan 0.6B takes 0.07 s, 0.31 and 1.6 GB of VRAM, 1.7B 0.08 s,
 * 0.36 and 2.7 GB. 1.7B makes almost no silence before the voice, which 0.6B makes for up to a second.
 */
export const QWEN_TTS_MODELS: Readonly<Record<QwenTtsSize, QwenTtsModelSpec>> = {
  '0.6b': {
    label: 'Qwen3-TTS 0.6B',
    talker: { ...QWEN_TTS_REPO, file: 'qwen3-tts-0.6b-customvoice-q8_0.gguf', bytes: 967_979_232, sha256: '11b6d52c4ec154041aee90dbcb10b269f17a27b1643bfa02ca38bb9fb9ee01c1' }
  },
  '1.7b': {
    label: 'Qwen3-TTS 1.7B',
    talker: { ...QWEN_TTS_REPO, file: 'qwen3-tts-1.7b-customvoice-q8_0.gguf', bytes: 2_042_224_992, sha256: 'c3faf095ecc9b4cf503ffef38ae936eca794fbc4f104fac8c6e9deb72c51b943' }
  }
}

/** The files a size needs. */
export const qwenTtsFiles = (size: QwenTtsSize): PinnedFile[] => [QWEN_TTS_MODELS[size].talker, QWEN_TTS_CODEC]

/**
 * The memory from which Qwen3-TTS is offered beside the speech recognition, in GB as the capabilities give
 * it: the Mac's own, which every app shares, and the GPU's on Windows, where 1.7B speech recognition and
 * 0.6B synthesis held 6.7 GB of an 8 GB RTX 2080 with the desktop's 1.9 GB (2026-09-29), more than a 6 GB
 * GPU has.
 */
const RECOMMENDED_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 16, vulkan: 8 }

/** The memory from which 1.7B is offered too; with 1.7B recognition it took 7.7 GB of the same 8 GB. */
const LARGER_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 24, vulkan: 10 }

/**
 * The preset voices of the pinned model. Every voice can speak every language the model supports;
 * `native` is the language the voice was recorded in, where it sounds most natural.
 */
export const QWEN_TTS_VOICES = [
  { id: 'ono_anna', name: 'Ono Anna', gender: 'female', native: 'japanese' },
  { id: 'ryan', name: 'Ryan', gender: 'male', native: 'english' },
  { id: 'aiden', name: 'Aiden', gender: 'male', native: 'english' },
  { id: 'sohee', name: 'Sohee', gender: 'female', native: 'korean' },
  { id: 'vivian', name: 'Vivian', gender: 'female', native: 'chinese' },
  { id: 'serena', name: 'Serena', gender: 'female', native: 'chinese' },
  { id: 'uncle_fu', name: 'Uncle Fu', gender: 'male', native: 'chinese' },
  { id: 'dylan', name: 'Dylan', gender: 'male', native: 'chinese' },
  { id: 'eric', name: 'Eric', gender: 'male', native: 'chinese' }
] as const

export type QwenTtsVoice = (typeof QWEN_TTS_VOICES)[number]['id']

export const QWEN_TTS_VOICE_IDS = QWEN_TTS_VOICES.map((voice) => voice.id) as [QwenTtsVoice, ...QwenTtsVoice[]]

/** The language names the model takes, by the language subtag of a locale. Hindi and Indonesian are not among them. */
const QWEN_TTS_LANGUAGES: Record<string, string> = {
  ja: 'japanese',
  en: 'english',
  ko: 'korean',
  zh: 'chinese',
  fr: 'french',
  de: 'german',
  it: 'italian',
  pt: 'portuguese',
  es: 'spanish',
  ru: 'russian'
}

/** The model's name for the language of a locale such as `ja-JP`, or null when the model cannot speak it. */
export function qwenTtsLanguage(locale: string): string | null {
  return QWEN_TTS_LANGUAGES[locale.split('-')[0].toLowerCase()] ?? null
}

/** Whether this machine can run Qwen3-TTS at all: wherever the local speech runs. */
export function qwenTtsRuns(
  localSpeech: PlatformCapabilities['localSpeech']
): localSpeech is Extract<PlatformCapabilities['localSpeech'], { memoryGb: number }> {
  return localSpeech.backend !== null
}

/**
 * Whether the engine can run on this machine at all. A saved engine that cannot, such as Qwen3-TTS in
 * settings brought over from a Mac, is treated like one that cannot speak the conversation language:
 * it is not offered, not counted as something to prepare, and reading with it fails with the reason.
 */
export const ttsEngineRuns = (engine: TtsEngine, localSpeech: PlatformCapabilities['localSpeech']): boolean =>
  engine !== 'qwen3tts' || qwenTtsRuns(localSpeech)

/** Whether to offer Qwen3-TTS: a machine that runs it, with the memory for it beside the speech recognition. */
export function recommendQwenTts(localSpeech: PlatformCapabilities['localSpeech']): boolean {
  return qwenTtsRuns(localSpeech) && localSpeech.memoryGb >= RECOMMENDED_FROM_GB[localSpeech.backend]
}

/** The sizes to choose from on this machine: 0.6B wherever Qwen3-TTS runs, 1.7B where the memory holds it. */
export function offeredQwenTtsSizes(localSpeech: PlatformCapabilities['localSpeech']): QwenTtsSize[] {
  if (!qwenTtsRuns(localSpeech)) return []
  return localSpeech.memoryGb >= LARGER_FROM_GB[localSpeech.backend] ? ['0.6b', '1.7b'] : ['0.6b']
}

/** The files of a size together, in GB of 10^9 bytes. */
export function qwenTtsSizeGb(size: QwenTtsSize): number {
  return Math.round(qwenTtsFiles(size).reduce((sum, file) => sum + file.bytes, 0) / 1e7) / 100
}
