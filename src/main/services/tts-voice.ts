import type { IrodoriTtsVoice, QwenTtsVoice } from '@shared/tts-models'

/** The engines that serve the VOICEVOX-compatible HTTP API from a process of their own. */
export type HttpTtsEngine = 'voicevox' | 'aivisspeech'

/** The engine and the voice a synthesis uses, resolved from the settings once so that the audio cache is keyed by the same choice. */
export type TtsVoice =
  | { engine: 'system' }
  | { engine: HttpTtsEngine; speaker: number }
  | { engine: 'irodori'; voice: IrodoriTtsVoice; language: string }
  | { engine: 'qwen3tts'; voice: QwenTtsVoice; language: string }

/** Identifies the voice in the key of an audio cache. */
export function voiceKey(voice: Exclude<TtsVoice, { engine: 'system' }>): string {
  return 'voice' in voice
    ? `${voice.engine}:${voice.voice}:${voice.language}`
    : `${voice.engine}:${voice.speaker}`
}
