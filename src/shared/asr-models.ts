import type { ConversationLocale } from './conversation-locale'
import type { PinnedFile } from './pinned-file'
import type { SpeechBackend } from './platform'

/**
 * The speech recognition models the setting can name. Both run on llama.cpp from the same GGUF files on
 * every machine, so a setting written on one machine means the same model on another.
 */
export const ASR_MODELS = ['auto', 'qwen3-asr-1.7b', 'qwen3-asr-0.6b'] as const

export type AsrModel = (typeof ASR_MODELS)[number]
export type ResolvedAsrModel = Exclude<AsrModel, 'auto'>

/** A Qwen3-ASR model for llama.cpp: the language model and the audio projector llama-server loads with it. */
export interface AsrModelSpec {
  label: string
  model: PinnedFile
  mmproj: PinnedFile
}

const ASR_1_7B = { repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF', revision: '36a678687ba7d07a74ca70ccb0e36902e005fb80' }
const ASR_0_6B = { repo: 'ggml-org/Qwen3-ASR-0.6B-GGUF', revision: '928ab958557df9aa2ef1c93e0e83c7ad0933fae2' }

/**
 * The models in the order the screens list them. Measured on 2026-09-29 with llama.cpp b11246 and Q8_0, a
 * 17 s utterance of the user's: 1.7B took 1.40 s and 3.4 GB on an M5 with Metal, 0.60-0.68 s and 3.2 GB of
 * VRAM on an RTX 2080 with Vulkan; 0.6B took 0.58 s and 1.8 GB on the M5, 0.36-0.40 s and 1.9 GB on the
 * RTX 2080. 0.6B heard 「いいえ」 as 「いや」, which 1.7B did not.
 */
export const ASR_MODEL_SPECS: Readonly<Record<ResolvedAsrModel, AsrModelSpec>> = {
  'qwen3-asr-1.7b': {
    label: 'Qwen3-ASR 1.7B',
    model: { ...ASR_1_7B, file: 'Qwen3-ASR-1.7B-Q8_0.gguf', bytes: 2_165_034_944, sha256: '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57' },
    mmproj: { ...ASR_1_7B, file: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', bytes: 355_709_344, sha256: '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d' }
  },
  'qwen3-asr-0.6b': {
    label: 'Qwen3-ASR 0.6B',
    model: { ...ASR_0_6B, file: 'Qwen3-ASR-0.6B-Q8_0.gguf', bytes: 804_749_248, sha256: 'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971' },
    mmproj: { ...ASR_0_6B, file: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf', bytes: 214_392_480, sha256: '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d' }
  }
}

/** The files a model needs. */
export const asrModelFiles = (spec: AsrModelSpec): PinnedFile[] => [spec.model, spec.mmproj]

/** Which of the two models is recommended, the larger one or the one that fits less memory. */
export type AsrRecommendationSize = 'larger' | 'smaller'

/**
 * The memory from which 1.7B is recommended, in GB as the capabilities give it. On a Mac the models share
 * the memory with every other app, so 1.7B waits for 16 GB; on Windows it is the GPU's own, which 1.7B
 * fits from 6 GB beside the desktop.
 */
const LARGER_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 16, vulkan: 6 }

/** What preparing a model downloads, in GB of 10^9 bytes: nothing once it is installed. */
export function asrDownloadGb(spec: AsrModelSpec, modelInstalled: boolean): number {
  if (modelInstalled) return 0
  return Math.round(asrModelFiles(spec).reduce((sum, file) => sum + file.bytes, 0) / 1e7) / 100
}

export interface AsrHardwareRecommendation {
  totalMemoryGb: number
  recommendedModel: ResolvedAsrModel
}

export function isAsrModel(value: unknown): value is AsrModel {
  return typeof value === 'string' && (ASR_MODELS as readonly string[]).includes(value)
}

export const offeredAsrModels = (): ResolvedAsrModel[] => Object.keys(ASR_MODEL_SPECS) as ResolvedAsrModel[]

export const asrModelSpec = (model: ResolvedAsrModel): AsrModelSpec => ASR_MODEL_SPECS[model]

/** Which model a backend recommends for this much memory: the Mac's for metal, the GPU's for vulkan. */
export const asrRecommendationSize = (backend: SpeechBackend, totalMemoryGb: number): AsrRecommendationSize =>
  totalMemoryGb >= LARGER_FROM_GB[backend] ? 'larger' : 'smaller'

/** The model for a machine whose local speech has this much memory. */
export function recommendAsrModel(backend: SpeechBackend, totalMemoryGb: number): AsrHardwareRecommendation {
  const size = asrRecommendationSize(backend, totalMemoryGb)
  return { totalMemoryGb, recommendedModel: size === 'larger' ? 'qwen3-asr-1.7b' : 'qwen3-asr-0.6b' }
}

/** The model a setting stands for: `auto` is the recommendation, any other value that model. */
export function resolveAsrModel(selected: AsrModel, recommendation: AsrHardwareRecommendation): ResolvedAsrModel {
  return selected === 'auto' ? recommendation.recommendedModel : selected
}

/** A model the screens let the user choose. */
export interface AsrModelChoice {
  id: ResolvedAsrModel
  label: string
}

export function asrModelChoices(): AsrModelChoice[] {
  return offeredAsrModels().map((id) => ({ id, label: ASR_MODEL_SPECS[id].label }))
}

/**
 * The English name of the conversation language. Qwen3-ASR is told the language by the start of its
 * answer, `language Japanese<asr_text>`, and matches the name against the `support_languages` of its
 * config, where Portuguese and Spanish stand for every region; Whisper in the browser takes the same
 * names in lower case.
 */
const ASR_LANGUAGE_NAMES: Record<ConversationLocale, string> = {
  'ja-JP': 'Japanese',
  'en-US': 'English',
  'fr-FR': 'French',
  'de-DE': 'German',
  'hi-IN': 'Hindi',
  'id-ID': 'Indonesian',
  'it-IT': 'Italian',
  'ko-KR': 'Korean',
  'pt-BR': 'Portuguese',
  'es-419': 'Spanish',
  'es-ES': 'Spanish'
}

/** Transformers.js takes the language of a Whisper transcription as the English name in lower case. */
export const whisperLanguageName = (locale: ConversationLocale): string => ASR_LANGUAGE_NAMES[locale].toLowerCase()

/** The language name Qwen3-ASR is told to transcribe in. */
export const asrLanguage = (locale: ConversationLocale): string => ASR_LANGUAGE_NAMES[locale]
