import { languageOf, type ConversationLocale } from './conversation-locale'

export const ASR_MODELS = ['auto', 'qwen3-asr-1.7b-mlx', 'whisper-large-v3-turbo-mlx'] as const

export type AsrModel = (typeof ASR_MODELS)[number]
export type ResolvedAsrModel = Exclude<AsrModel, 'auto'>

export const QWEN_MLX_MODEL = Object.freeze({
  id: 'mlx-community/Qwen3-ASR-1.7B-8bit',
  revision: 'a8379a2e2f9e313c9292cdf1af4055ab56d50d55',
  label: 'Qwen3-ASR 1.7B 8-bit MLX',
  files: [
    '.gitattributes', 'README.md', 'chat_template.json', 'config.json', 'generation_config.json', 'merges.txt',
    'model.safetensors', 'model.safetensors.index.json', 'preprocessor_config.json', 'tokenizer_config.json',
    'vocab.json'
  ],
  weightSizeGb: 2.3,
  peakMemoryGb: 4.13
})

export const WHISPER_MLX_MODEL = Object.freeze({
  id: 'mlx-community/whisper-large-v3-turbo-asr-fp16',
  revision: '624c19c9af5603fa73b83bce14d4aeea96156d18',
  label: 'Whisper large-v3-turbo fp16 MLX',
  files: [
    '.gitattributes', 'README.md', 'added_tokens.json', 'config.json', 'generation_config.json', 'merges.txt',
    'model.safetensors', 'model.safetensors.index.json', 'normalizer.json', 'preprocessor_config.json',
    'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'
  ],
  weightSizeGb: 1.5,
  peakMemoryGb: 2.3
})

export const MLX_AUDIO_VERSION = '0.4.7'
export const QWEN_MIN_RECOMMENDED_MEMORY_GB = 16

export interface AsrHardwareRecommendation {
  totalMemoryGb: number
  recommendedModel: ResolvedAsrModel
}

export function isAsrModel(value: unknown): value is AsrModel {
  return typeof value === 'string' && (ASR_MODELS as readonly string[]).includes(value)
}

/** The model for a machine whose speech runtime has this much memory, in GB as the capabilities give it. */
export function recommendAsrModel(totalMemoryGb: number): AsrHardwareRecommendation {
  return {
    totalMemoryGb,
    recommendedModel: totalMemoryGb >= QWEN_MIN_RECOMMENDED_MEMORY_GB ? 'qwen3-asr-1.7b-mlx' : 'whisper-large-v3-turbo-mlx'
  }
}

export function resolveAsrModel(
  selected: AsrModel,
  recommendation: AsrHardwareRecommendation
): ResolvedAsrModel {
  return selected === 'auto' ? recommendation.recommendedModel : selected
}

export function asrModelLabel(model: ResolvedAsrModel): string {
  return model === 'qwen3-asr-1.7b-mlx' ? QWEN_MLX_MODEL.label : WHISPER_MLX_MODEL.label
}

/**
 * The English name of the conversation language for the models that take a name rather than a code.
 * Qwen3-ASR matches it against the `support_languages` of its config, where Portuguese and Spanish
 * stand for every region, and Whisper lower-cases the same names into its own codes.
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

/**
 * What the `language` of one MLX transcription request has to be. Qwen3-ASR writes the name into the
 * prompt it forces on the model, so a name it does not know leaves the model with a prefix it never
 * saw in training; Whisper on MLX takes the ISO 639-1 code.
 */
export function mlxAsrLanguage(model: ResolvedAsrModel, locale: ConversationLocale): string {
  return model === 'qwen3-asr-1.7b-mlx' ? ASR_LANGUAGE_NAMES[locale] : languageOf(locale)
}
