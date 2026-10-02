import type { AizuchiClassifierStatus, AppSettings, AppStatus, EmbeddingStatus, SetupStatus, TtsEngine, VapStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import type { SettingsPage } from '@shared/mini-apps'
import type { SettingsPatch } from '@shared/settings'
import type { PlatformCapabilities } from '@shared/platform'
import { osMessageKey } from '@shared/i18n/os-message'
import { isLocalTtsEngine, ttsEngineRuns } from '@shared/tts-models'
import { platformCapabilities } from '@/platform'
import { displayError, errorMessageOf } from '@/display-error'
import type { Preparation } from '@/state/preparation'
import type { Pending } from './pending'

export type { SettingsPage }

/** A state read from main: null until main answers, then what it answered, or the message of the error it threw. */
export type StatusRead<T> = { read: T } | { error: string } | null

/** Reads a state from main and hands it on as what main answered or as the error it threw. */
export function readStatus<T>(read: () => Promise<T>, store: (status: StatusRead<T>) => void): Promise<void> {
  return read().then(
    (value) => store({ read: value }),
    (err: unknown) => store({ error: errorMessageOf(err) })
  )
}

/** What main answered, or null while it has not answered or after the read failed. */
export const statusOf = <T>(status: StatusRead<T>): T | null => (status !== null && 'read' in status ? status.read : null)

/** Why the read failed, in the language of the interface, or null when it has not failed. */
export const readFailure = (status: StatusRead<unknown>): string | null => (status !== null && 'error' in status ? displayError(status.error) : null)

/** The state and the operations each page receives. Saving settings and reloading status belong to the shell, SettingsDialog. */
export interface SettingsContext {
  settings: AppSettings
  status: AppStatus | null
  setup: StatusRead<SetupStatus>
  vap: StatusRead<VapStatus>
  embedding: StatusRead<EmbeddingStatus>
  aizuchiClassifier: StatusRead<AizuchiClassifierStatus>
  prep: Preparation
  /** What is turned on and cannot work yet, which the overview lists and the list on the left counts. */
  pending: Pending[]
  /** Saves and reloads the status, reporting a failure as a toast. It resolves to whether the patch was saved. */
  set: (patch: SettingsPatch) => Promise<boolean>
  /** Saves and throws on failure, for a caller that wants to word the message itself. */
  save: (patch: SettingsPatch) => Promise<void>
  refreshStatus: () => Promise<void>
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

/** Where the CLI of each Agent engine is installed from. */
export const AGENT_INSTALL_GUIDE = { codex: 'https://developers.openai.com/codex/cli', claude: 'https://docs.claude.com/en/docs/claude-code' } as const

/** Where each speech application that is installed separately is downloaded. */
export const TTS_SITE = { voicevox: 'https://voicevox.hiroshiba.jp/', aivisspeech: 'https://aivis-project.com/' } as const

const TTS_ENGINE_NAME = { voicevox: 'VOICEVOX', aivisspeech: 'AivisSpeech', irodori: 'Irodori-TTS', qwen3tts: 'Qwen3-TTS' } as const

/** The name of a speech engine. The engines named after their product keep that name in every language. */
export function ttsEngineLabel(t: Translate, engine: TtsEngine): string {
  if (engine === 'system') return t(osMessageKey('settings.ttsEngine.system', platformCapabilities().os))
  if (engine === 'none') return t('settings.ttsEngine.none')
  return TTS_ENGINE_NAME[engine]
}

/** Whether the engine is a separate application to install. */
export const isExternalTts = (engine: TtsEngine): engine is 'voicevox' | 'aivisspeech' => engine === 'voicevox' || engine === 'aivisspeech'
/** Whether the engine can be unavailable: a separate application, or a model this app downloads. The OS's own speech synthesis and the engine that reads nothing need no preparation. */
export const ttsNeedsPreparation = (engine: TtsEngine): boolean => isExternalTts(engine) || isLocalTtsEngine(engine)

/**
 * Whether speech recognition is ready, which the models card shows and the page list counts: the local
 * model where the machine runs one, as main last pushed its status, and Whisper in the browser where it
 * does not. Null while the status is still being read.
 */
export function speechRecognitionReady(
  settings: AppSettings,
  status: AppStatus | null,
  localSpeech: PlatformCapabilities['localSpeech']
): boolean | null {
  if (localSpeech.backend === null) return settings.localAsrEnabled
  return status ? status.asr : null
}

/**
 * Whether the microphone can be turned on for the cascade engine. The voice controller listens through
 * the local model when it runs and through Whisper in the browser once that is enabled, and refuses to
 * start with neither. Null while the state of the local model is still being read.
 */
export function cascadeListeningReady(
  settings: AppSettings,
  status: AppStatus | null,
  localSpeech: PlatformCapabilities['localSpeech']
): boolean | null {
  return settings.localAsrEnabled || speechRecognitionReady(settings, status, localSpeech)
}

/** How the replies of the cascade engine are read aloud, as speechReadiness tells it. */
export type SpeechReadiness = 'ready' | 'starting' | 'off' | 'missing' | 'cannotRun' | 'checking'

/**
 * How the replies are read aloud. 'off' is the engine that reads nothing, which leaves a reply as text
 * alone. 'starting' is an engine that is there and still loading, as a local model does for a few seconds
 * each time its engine is chosen. 'missing' is an engine that cannot be reached or whose model is not
 * prepared, in which case the OS's speech synthesis reads the replies instead.
 */
export function speechReadiness(engine: TtsEngine, status: AppStatus | null, localSpeech: PlatformCapabilities['localSpeech']): SpeechReadiness {
  if (engine === 'none') return 'off'
  if (!ttsEngineRuns(engine, localSpeech)) return 'cannotRun'
  if (!ttsNeedsPreparation(engine)) return 'ready'
  if (status === null) return 'checking'
  if (status.tts) return 'ready'
  return status.ttsStarting ? 'starting' : 'missing'
}
