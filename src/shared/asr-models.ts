import { languageOf, type ConversationLocale } from './conversation-locale'
import type { SpeechRuntime } from './platform'

/**
 * The speech recognition models the setting can name. A name says which model it is, not how a runtime
 * builds it: the quantization and the repository of each runtime's build are in its table below, so a
 * setting written on one machine means the same model on another.
 */
export const ASR_MODELS = ['auto', 'qwen3-asr-1.7b', 'qwen3-asr-0.6b', 'whisper-large-v3-turbo'] as const

export type AsrModel = (typeof ASR_MODELS)[number]
export type ResolvedAsrModel = Exclude<AsrModel, 'auto'>

/** The name of each model apart from any runtime's build, which the screens show for one this machine does not offer. */
export const ASR_MODEL_NAMES: Record<ResolvedAsrModel, string> = {
  'qwen3-asr-1.7b': 'Qwen3-ASR 1.7B',
  'qwen3-asr-0.6b': 'Qwen3-ASR 0.6B',
  'whisper-large-v3-turbo': 'Whisper large-v3-turbo'
}

/** One runtime's build of a model, pinned to a revision of its Hugging Face repository. */
export interface AsrModelSpec {
  id: string
  revision: string
  label: string
  /** Every file of the revision, as paths inside the snapshot. A new revision needs its own list. */
  files: readonly string[]
  /** The size of every file of the revision, which the first preparation downloads, in GB of 10^9 bytes. */
  downloadGb: number
  /**
   * How a transcription request names the language. Qwen3-ASR takes the English name and writes it into
   * the prompt it forces on the model, so a name it does not know leaves the model with a prefix it never
   * saw in training; Whisper on MLX takes the ISO 639-1 code.
   */
  language: 'english-name' | 'iso-639-1'
}

interface RuntimeModels {
  /** The models the runtime offers, in the order the screens list them. */
  models: Partial<Record<ResolvedAsrModel, AsrModelSpec>>
  /** `auto` stands for `larger` from `largerFromGb` of the runtime's memory and for `smaller` below it. */
  recommendation: { larger: ResolvedAsrModel; largerFromGb: number; smaller: ResolvedAsrModel }
}

/** Which of its two models a runtime recommends, the larger one or the one that fits less memory. */
export type AsrRecommendationSize = 'larger' | 'smaller'

/** A runtime's table, checked to recommend only models the runtime offers. */
function runtimeModels<M extends ResolvedAsrModel>(
  models: Record<M, AsrModelSpec>,
  recommendation: { larger: NoInfer<M>; largerFromGb: number; smaller: NoInfer<M> }
): RuntimeModels {
  return { models, recommendation }
}

const QWEN_HF_FILES = [
  '.gitattributes', 'README.md', 'chat_template.jinja', 'config.json', 'generation_config.json', 'model.safetensors',
  'processor_config.json', 'tokenizer.json', 'tokenizer_config.json'
]

// The download sizes are the sums of the file sizes the Hugging Face API reports for each pinned revision
// (2026-09-27).
const ASR_RUNTIME_MODELS: Record<SpeechRuntime, RuntimeModels> = {
  // On a Mac the model shares the memory with every other app. Qwen3-ASR 1.7B 8-bit peaks at 4.13 GB and
  // Whisper at 2.3 GB, so Qwen3-ASR is recommended only from 16 GB.
  mlx: runtimeModels(
    {
      'qwen3-asr-1.7b': {
        id: 'mlx-community/Qwen3-ASR-1.7B-8bit',
        revision: 'a8379a2e2f9e313c9292cdf1af4055ab56d50d55',
        label: 'Qwen3-ASR 1.7B 8-bit MLX',
        files: [
          '.gitattributes', 'README.md', 'chat_template.json', 'config.json', 'generation_config.json', 'merges.txt',
          'model.safetensors', 'model.safetensors.index.json', 'preprocessor_config.json', 'tokenizer_config.json',
          'vocab.json'
        ],
        downloadGb: 2.47,
        language: 'english-name'
      },
      'whisper-large-v3-turbo': {
        id: 'mlx-community/whisper-large-v3-turbo-asr-fp16',
        revision: '624c19c9af5603fa73b83bce14d4aeea96156d18',
        label: 'Whisper large-v3-turbo fp16 MLX',
        files: [
          '.gitattributes', 'README.md', 'added_tokens.json', 'config.json', 'generation_config.json', 'merges.txt',
          'model.safetensors', 'model.safetensors.index.json', 'normalizer.json', 'preprocessor_config.json',
          'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'
        ],
        downloadGb: 1.62,
        language: 'iso-639-1'
      }
    },
    { larger: 'qwen3-asr-1.7b', largerFromGb: 16, smaller: 'whisper-large-v3-turbo' }
  ),
  // Measured on 2026-09-27 on an RTX 2080 with torch 2.14.0+cu130 and transformers 5.17.0 in fp16:
  // Qwen3-ASR 1.7B holds 3.9 GB of VRAM (4.1 GB reserved) and 0.6B 1.6 GB, and the CUDA context adds
  // about 0.5 GB. 1.7B therefore does not fit the 4 GB of the smallest GPU the runtime accepts (compute
  // capability 7.5, such as a GTX 1650), and leaves about 1.4 GB of a 6 GB GPU to the desktop and the
  // other apps. Whisper is not offered, because the cuda worker runs only Qwen3-ASR.
  cuda: runtimeModels(
    {
      'qwen3-asr-1.7b': {
        id: 'Qwen/Qwen3-ASR-1.7B-hf',
        revision: 'bcd2b5b7f32b480ab5790554cfa8347f246a14f3',
        label: 'Qwen3-ASR 1.7B CUDA',
        files: QWEN_HF_FILES,
        downloadGb: 4.09,
        language: 'english-name'
      },
      'qwen3-asr-0.6b': {
        id: 'Qwen/Qwen3-ASR-0.6B-hf',
        revision: '7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c',
        label: 'Qwen3-ASR 0.6B CUDA',
        files: QWEN_HF_FILES,
        downloadGb: 1.58,
        language: 'english-name'
      }
    },
    { larger: 'qwen3-asr-1.7b', largerFromGb: 6, smaller: 'qwen3-asr-0.6b' }
  )
}

export const MLX_AUDIO_VERSION = '0.4.7'

/**
 * What building each runtime's environment downloads, in GB: the wheels its requirements file pins for its
 * platform, summed from the sizes PyPI and download.pytorch.org report (2026-09-27). torch is 1.99 GB of
 * cuda's. The Python that uv downloads once for every environment of the app is not counted.
 */
const ENVIRONMENT_DOWNLOAD_GB: Record<SpeechRuntime, number> = { mlx: 0.13, cuda: 2.04 }

/**
 * What preparing a model downloads on a runtime: the environment and the model, less what is installed.
 * A model the runtime does not offer, passed as null, has nothing to download, since it cannot be prepared.
 */
export function asrDownloadGb(
  runtime: SpeechRuntime,
  model: AsrModelSpec | null,
  { runtimeInstalled, modelInstalled }: { runtimeInstalled: boolean; modelInstalled: boolean }
): number {
  if (model === null) return 0
  return (runtimeInstalled ? 0 : ENVIRONMENT_DOWNLOAD_GB[runtime]) + (modelInstalled ? 0 : model.downloadGb)
}

export interface AsrHardwareRecommendation {
  totalMemoryGb: number
  recommendedModel: ResolvedAsrModel
}

export function isAsrModel(value: unknown): value is AsrModel {
  return typeof value === 'string' && (ASR_MODELS as readonly string[]).includes(value)
}

/** The models a runtime offers with its build of each, in the order the screens list them. */
export const offeredAsrBuilds = (runtime: SpeechRuntime): Array<[ResolvedAsrModel, AsrModelSpec]> =>
  Object.entries(ASR_RUNTIME_MODELS[runtime].models) as Array<[ResolvedAsrModel, AsrModelSpec]>

export const offeredAsrModels = (runtime: SpeechRuntime): ResolvedAsrModel[] => offeredAsrBuilds(runtime).map(([model]) => model)

/** The runtime's build of a model, or null when the runtime does not offer that model. */
export const asrModelSpec = (runtime: SpeechRuntime, model: ResolvedAsrModel): AsrModelSpec | null =>
  ASR_RUNTIME_MODELS[runtime].models[model] ?? null

/**
 * Which model a runtime recommends for this much memory, in GB as the capabilities give it: the Mac's
 * memory for mlx, the GPU's for cuda.
 */
export const asrRecommendationSize = (runtime: SpeechRuntime, totalMemoryGb: number): AsrRecommendationSize =>
  totalMemoryGb >= ASR_RUNTIME_MODELS[runtime].recommendation.largerFromGb ? 'larger' : 'smaller'

/** The model for a machine whose speech runtime has this much memory. */
export function recommendAsrModel(runtime: SpeechRuntime, totalMemoryGb: number): AsrHardwareRecommendation {
  return { totalMemoryGb, recommendedModel: ASR_RUNTIME_MODELS[runtime].recommendation[asrRecommendationSize(runtime, totalMemoryGb)] }
}

/**
 * The model a setting stands for. Only `auto` is resolved, to the runtime's recommendation; a model the
 * user chose stays that model even where the runtime does not offer it, because another model in its
 * place would transcribe differently and download gigabytes the user never asked for.
 */
export function resolveAsrModel(
  selected: AsrModel,
  recommendation: AsrHardwareRecommendation
): ResolvedAsrModel {
  return selected === 'auto' ? recommendation.recommendedModel : selected
}

/** A model the screens let the user choose, and whether this runtime offers it. */
export interface AsrModelChoice {
  id: ResolvedAsrModel
  label: string
  offered: boolean
}

/**
 * The models to choose from on this runtime. A selected model the runtime does not offer is listed too,
 * under its plain name, so that the choice shows what the setting holds rather than another model.
 */
export function asrModelChoices(runtime: SpeechRuntime, selected: AsrModel): AsrModelChoice[] {
  const choices = offeredAsrBuilds(runtime).map(([id, spec]) => ({ id, label: spec.label, offered: true }))
  if (selected === 'auto' || asrModelSpec(runtime, selected)) return choices
  return [...choices, { id: selected, label: ASR_MODEL_NAMES[selected], offered: false }]
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

/** What the `language` of one transcription request to the worker has to be for this model. */
export function asrLanguage(model: AsrModelSpec, locale: ConversationLocale): string {
  return model.language === 'english-name' ? ASR_LANGUAGE_NAMES[locale] : languageOf(locale)
}
