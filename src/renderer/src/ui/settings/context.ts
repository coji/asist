import type { AizuchiClassifierStatus, AppSettings, AppStatus, EmbeddingStatus, SetupProgress, SetupStatus, TtsEngine, VapStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import type { SettingsPage } from '@shared/mini-apps'
import type { SettingsPatch } from '@shared/settings'
import type { PlatformCapabilities } from '@shared/platform'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

export type { SettingsPage }

/** The items on the models page that are prepared by a download in the main process. */
export type PreparationTarget = 'asr' | 'tts' | 'vap' | 'embedding' | 'aizuchiClassifier'

/**
 * The progress of a preparation, such as fetching a model. Only one preparation runs at a time. The
 * progress channel does not say which preparation it belongs to, so `target` records the one that was
 * started, and only that item shows the progress.
 */
export interface Preparation {
  busy: boolean
  target: PreparationTarget | null
  progress: SetupProgress | null
  message: string
  /** The progress of preparing Whisper inside the browser, in percent, or null while nothing runs. */
  localAsr: number | null
}

/** The state and the operations each page receives. Saving settings and reloading status belong to the shell, SettingsDialog. */
export interface SettingsContext {
  settings: AppSettings
  status: AppStatus | null
  setup: SetupStatus | null
  vap: VapStatus | null
  embedding: EmbeddingStatus | null
  aizuchiClassifier: AizuchiClassifierStatus | null
  prep: Preparation
  /** Saves and reloads the status, reporting a failure as a toast. It resolves to whether the patch was saved. */
  set: (patch: SettingsPatch) => Promise<boolean>
  /** Saves and throws on failure, for a caller that wants to word the message itself. */
  save: (patch: SettingsPatch) => Promise<void>
  refreshStatus: () => Promise<void>
  refreshSetup: () => Promise<void>
  go: (page: SettingsPage) => void
  prepare: {
    asr: () => void
    cancelAsr: () => void
    localAsr: () => void
    cancelLocalAsr: () => void
    tts: () => void
    vap: () => void
    embedding: () => void
    aizuchiClassifier: () => void
  }
}

const TTS_ENGINE_NAME = { voicevox: 'VOICEVOX', aivisspeech: 'AivisSpeech', qwen3tts: 'Qwen3-TTS' } as const

/** The name of a speech engine. The three engines named after their product keep that name in every language. */
export function ttsEngineLabel(t: Translate, engine: TtsEngine): string {
  if (engine === 'system') return t(osMessageKey('settings.ttsEngine.system', platformCapabilities().os))
  if (engine === 'none') return t('settings.ttsEngine.none')
  return TTS_ENGINE_NAME[engine]
}

/** Whether the engine is a separate application to install. */
export const isExternalTts = (engine: TtsEngine): engine is 'voicevox' | 'aivisspeech' => engine === 'voicevox' || engine === 'aivisspeech'
/** Whether the engine can be unavailable: a separate application, or a model this app downloads. The OS's own speech synthesis and the engine that reads nothing need no preparation. */
export const ttsNeedsPreparation = (engine: TtsEngine): boolean => isExternalTts(engine) || engine === 'qwen3tts'

/**
 * Whether speech recognition is ready, which the models card shows and the page list counts: the local
 * model where the machine has a runtime for one, Whisper in the browser where it has not. Null while the
 * state of the local model is still being read.
 */
export function speechRecognitionReady(
  settings: AppSettings,
  setup: SetupStatus | null,
  speechRuntime: PlatformCapabilities['speechRuntime']
): boolean | null {
  if (speechRuntime.kind === null) return settings.localAsrEnabled
  return setup ? setup.asr?.ready === true : null
}
