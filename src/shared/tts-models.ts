import type { TtsEngine } from './ipc'
import type { MessageKey } from './i18n'
import type { PinnedFile } from './pinned-file'
import type { PlatformCapabilities, SpeechBackend } from './platform'

/** The engines whose model ASIST downloads and runs itself, in speech.cpp's worker on the GPU. */
export type LocalTtsEngine = Extract<TtsEngine, 'irodori' | 'qwen3tts'>

export const isLocalTtsEngine = (engine: TtsEngine): engine is LocalTtsEngine => engine === 'irodori' || engine === 'qwen3tts'

/** The sizes of Qwen3-TTS the setting can name. */
export const QWEN_TTS_SIZES = ['0.6b', '1.7b'] as const

export type QwenTtsSize = (typeof QWEN_TTS_SIZES)[number]

/** One size of Qwen3-TTS for speech.cpp: its talker, which runs with the shared codec. */
export interface QwenTtsModelSpec {
  label: string
  talker: PinnedFile
}

const QWEN_TTS_REPO = { repo: 'sakasegawa/qwen3-tts-ggml', revision: '3fa3234ee65c9a70fd23a7b7843722a0284b8027' }

/** The codec decoder every size speaks through. */
export const QWEN_TTS_CODEC: PinnedFile = {
  ...QWEN_TTS_REPO,
  file: 'qwen3-tts-codec-12hz-f16.gguf',
  bytes: 245_553_152,
  sha256: '38763be32099ad36b7b4345fc852ac379fb4fde0782ff85929d2b984b4bc22c1'
}

/**
 * The sizes, in Q8_0 on Japanese sentences. On an M5 with Metal and speech.cpp v0.3.0 (2026-10-01), 0.6B
 * speaks its first audio 0.04 s after the request at 0.37 of real time in 1.8 GB, and 1.7B 0.06 s and 0.47
 * in 2.8 GB. On an RTX 2080 with Vulkan and qwen3-tts-ggml v0.1.1 (2026-09-29), 0.6B took 0.07 s, 0.31 and
 * 1.6 GB of VRAM, and 1.7B 0.08 s, 0.36 and 2.7 GB. 1.7B makes almost no silence before the voice, which
 * 0.6B makes for up to a second.
 */
export const QWEN_TTS_MODELS: Readonly<Record<QwenTtsSize, QwenTtsModelSpec>> = {
  '0.6b': {
    label: 'Qwen3-TTS 0.6B',
    talker: { ...QWEN_TTS_REPO, file: 'qwen3-tts-0.6b-customvoice-q8_0.gguf', bytes: 967_979_712, sha256: '4a819d1c9d9c6358bd5dc1ded15f93db970fbaeac9f0a021dfae62c242682baf' }
  },
  '1.7b': {
    label: 'Qwen3-TTS 1.7B',
    talker: { ...QWEN_TTS_REPO, file: 'qwen3-tts-1.7b-customvoice-q8_0.gguf', bytes: 2_042_225_472, sha256: 'fb6e79b6ae51c1fe5fe8313cf9a69e5c6f4e34a9869b478a576ed954b3d314e1' }
  }
}

const IRODORI_TTS_REPO = { repo: 'sakasegawa/irodori-tts-ggml', revision: '8a45f617775ebc1c71b047b8b80c8350ec010617' }

/**
 * Irodori-TTS v4.1-Small-MF in F16 and the codec it speaks through. On an M5 with Metal and speech.cpp
 * v0.3.0 (2026-10-01) it speaks a sentence's first audio 0.19 to 0.38 s after the request, later the longer
 * the sentence, at 0.17 of real time in 2.1 GB. It makes the whole sentence before the first audio, while
 * Qwen3-TTS streams it frame by frame.
 */
export const IRODORI_TTS_MODEL = {
  label: 'Irodori-TTS',
  model: { ...IRODORI_TTS_REPO, file: 'irodori-tts-v4.1-small-mf-f16.gguf', bytes: 1_514_765_472, sha256: '30b230256ce19a08b8769c582ca1afad0954a7c1f5d37b47c47e520b21d06262' },
  codec: { ...IRODORI_TTS_REPO, file: 'semantic-dacvae-japanese-32dim-f32.gguf', bytes: 370_670_496, sha256: '43ef3084cedd88b73113db2663f1741d5deed97ae9a72d84dff4ff593374f125' }
} as const satisfies { label: string; model: PinnedFile; codec: PinnedFile }

/**
 * The voices ASIST ships for Irodori-TTS, each a voice file under resources/irodori-voices made from a
 * reference recording. Irodori-TTS speaks in the voice of a reference and predicts a sentence's length from
 * it, and for 12 of the sixteen references speech-bench made it predicted 1.3 to 3.6 s for "うん。" and filled
 * the time with words of its own. These three read the 39 backchannels of the bank and 10 other short
 * replies five times each, 735 takes, without a word added (Qwen3-ASR 1.7B, 2026-10-01).
 */
export const IRODORI_TTS_VOICES = [
  { id: 'calm-young-woman', gender: 'female', label: 'settingsVoice.speech.irodoriVoices.calmYoungWoman' },
  { id: 'soft-young-woman', gender: 'female', label: 'settingsVoice.speech.irodoriVoices.softYoungWoman' },
  { id: 'energetic-young-man', gender: 'male', label: 'settingsVoice.speech.irodoriVoices.energeticYoungMan' }
] as const satisfies ReadonlyArray<{ id: string; gender: 'female' | 'male'; label: MessageKey }>

export type IrodoriTtsVoice = (typeof IRODORI_TTS_VOICES)[number]['id']

export const IRODORI_TTS_VOICE_IDS = IRODORI_TTS_VOICES.map((voice) => voice.id) as [IrodoriTtsVoice, ...IrodoriTtsVoice[]]

/** The model a local engine runs, as the settings name it: its name in the messages and the files it needs. */
export interface LocalTtsModel {
  label: string
  files: readonly PinnedFile[]
}

export function localTtsModel(engine: LocalTtsEngine, qwenTtsSize: QwenTtsSize): LocalTtsModel {
  if (engine === 'irodori') return { label: IRODORI_TTS_MODEL.label, files: [IRODORI_TTS_MODEL.model, IRODORI_TTS_MODEL.codec] }
  return { label: QWEN_TTS_MODELS[qwenTtsSize].label, files: [QWEN_TTS_MODELS[qwenTtsSize].talker, QWEN_TTS_CODEC] }
}

/** The files of a model together, in GB of 10^9 bytes. */
export function localTtsSizeGb(model: LocalTtsModel): number {
  return Math.round(model.files.reduce((sum, file) => sum + file.bytes, 0) / 1e7) / 100
}

/**
 * The memory from which a local engine is offered beside the speech recognition, in GB as the capabilities
 * give it: the Mac's own, which every app shares, and the GPU's on Windows, where 1.7B speech recognition and
 * Qwen3-TTS 0.6B held 6.7 GB of an 8 GB RTX 2080 with the desktop's 1.9 GB (2026-09-29), more than a 6 GB GPU
 * has. Irodori-TTS takes 2.1 GB of VRAM there (speech.cpp's measurement, 2026-10-01), half a GB more than
 * Qwen3-TTS 0.6B, which puts it with 1.7B recognition and the desktop at about 7.2 GB; that combination has
 * not been measured.
 */
const RECOMMENDED_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 16, vulkan: 8 }

/** The memory from which Qwen3-TTS 1.7B is offered too; with 1.7B recognition it took 7.7 GB of the same 8 GB. */
const LARGER_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 24, vulkan: 10 }

/**
 * The preset voices of the pinned model. Every voice can speak every language the model supports;
 * `native` is the BCP 47 tag of the language the voice was recorded in, where it sounds most natural.
 */
export const QWEN_TTS_VOICES = [
  { id: 'ono_anna', name: 'Ono Anna', gender: 'female', native: 'ja' },
  { id: 'ryan', name: 'Ryan', gender: 'male', native: 'en' },
  { id: 'aiden', name: 'Aiden', gender: 'male', native: 'en' },
  { id: 'sohee', name: 'Sohee', gender: 'female', native: 'ko' },
  { id: 'vivian', name: 'Vivian', gender: 'female', native: 'zh' },
  { id: 'serena', name: 'Serena', gender: 'female', native: 'zh' },
  { id: 'uncle_fu', name: 'Uncle Fu', gender: 'male', native: 'zh' },
  { id: 'dylan', name: 'Dylan', gender: 'male', native: 'zh' },
  { id: 'eric', name: 'Eric', gender: 'male', native: 'zh' }
] as const

export type QwenTtsVoice = (typeof QWEN_TTS_VOICES)[number]['id']

export const QWEN_TTS_VOICE_IDS = QWEN_TTS_VOICES.map((voice) => voice.id) as [QwenTtsVoice, ...QwenTtsVoice[]]

/**
 * The languages the model speaks, as the BCP 47 tags the worker lists in `ready` and takes in a request.
 * Hindi and Indonesian are not among them.
 */
const QWEN_TTS_LANGUAGES: readonly string[] = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh']

/** The tag a request names for the language of a locale such as `ja-JP`, or null when the model cannot speak it. */
export function qwenTtsLanguage(locale: string): string | null {
  const language = locale.split('-')[0].toLowerCase()
  return QWEN_TTS_LANGUAGES.includes(language) ? language : null
}

/** Whether this machine can run a local engine at all: wherever the local speech runs. */
export function localTtsRuns(
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
  !isLocalTtsEngine(engine) || localTtsRuns(localSpeech)

/** Whether to offer the local engines: a machine that runs them, with the memory for one beside the speech recognition. */
export function recommendLocalTts(localSpeech: PlatformCapabilities['localSpeech']): boolean {
  return localTtsRuns(localSpeech) && localSpeech.memoryGb >= RECOMMENDED_FROM_GB[localSpeech.backend]
}

/** The sizes to choose from on this machine: 0.6B wherever Qwen3-TTS runs, 1.7B where the memory holds it. */
export function offeredQwenTtsSizes(localSpeech: PlatformCapabilities['localSpeech']): QwenTtsSize[] {
  if (!localTtsRuns(localSpeech)) return []
  return localSpeech.memoryGb >= LARGER_FROM_GB[localSpeech.backend] ? ['0.6b', '1.7b'] : ['0.6b']
}
