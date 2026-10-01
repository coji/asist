import { Play } from 'lucide-react'
import type { LiveEngine } from '@shared/voice-engine'
import type { LocalTtsEngine } from '@shared/tts-models'
import { VOICE_SAMPLE_TEXT, type VoiceSampleLanguage } from '@shared/voice-samples'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { useToastStore } from '@/state/stores'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * The voice samples the settings screen plays: the live engine's voices, which scripts/gen-live-voices.mjs has
 * the provider's TTS read in Japanese, and the local engines' voices, which scripts/gen-tts-voices.mjs has the
 * bundled worker read in each language the engine reads. Listening to one needs neither an API, a key nor a
 * downloaded model. Adding a voice or a language means generating its samples with those scripts.
 */
const SAMPLES = import.meta.glob<string>(['../../assets/live-voices/*/*.mp3', '../../assets/tts-voices/*/*/*.mp3'], { eager: true, query: '?url', import: 'default' })

export interface VoiceSample {
  url: string
  language: VoiceSampleLanguage
}

function bundled(suffix: string, language: VoiceSampleLanguage): VoiceSample | null {
  const entry = Object.entries(SAMPLES).find(([file]) => file.endsWith(suffix))
  return entry ? { url: entry[1], language } : null
}

const isSampleLanguage = (language: string): language is VoiceSampleLanguage => Object.hasOwn(VOICE_SAMPLE_TEXT, language)

/** The bundled sample of a voice of a live engine, or null when none was generated for it. */
export function liveVoiceSample(engine: LiveEngine, voice: string): VoiceSample | null {
  return bundled(`/live-voices/${engine}/${voice}.mp3`, 'ja')
}

/** The bundled sample of a voice of a local engine read in `language`, or null when none was generated for it. */
export function localVoiceSample(engine: LocalTtsEngine, voice: string, language: string): VoiceSample | null {
  return isSampleLanguage(language) ? bundled(`/tts-voices/${engine}/${language}/${voice}.mp3`, language) : null
}

/** Plays a bundled mp3 through the speech playback queue, where decodeAudioData handles it just as it does WAV. */
export async function playVoiceSample(sample: VoiceSample): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(sample.url)).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  speechPlayer.playClip(btoa(binary), VOICE_SAMPLE_TEXT[sample.language], { role: 'preview' })
}

export interface VoiceChoice {
  id: string
  name: string
  /** What the voice is like, under its name. */
  detail?: string
  sample: VoiceSample | null
}

/**
 * The voices of an engine side by side, each chosen by its card and heard with its own play button, which
 * plays the bundled sample and leaves the setting as it is.
 */
export function VoicePicker({ label, voices, selected, onSelect }: {
  label: string
  voices: readonly VoiceChoice[]
  selected: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const t = useT()
  const toast = useToastStore((s) => s.push)
  const play = (sample: VoiceSample): void => {
    void playVoiceSample(sample).catch((err: unknown) => toast({ kind: 'error', title: t('common.playSampleFailed'), body: displayError(err) }))
  }
  return (
    <div className="st-voices" role="radiogroup" aria-label={label}>
      {voices.map((voice) => (
        <div key={voice.id} className="st-voice" data-checked={voice.id === selected}>
          <button type="button" role="radio" aria-checked={voice.id === selected} className="st-voice-choose" onClick={() => onSelect(voice.id)}>
            <span className="st-voice-name">{voice.name}</span>
            {voice.detail && <span className="st-voice-detail">{voice.detail}</span>}
          </button>
          <button
            type="button"
            className="st-voice-play"
            aria-label={t('settingsVoice.speech.playVoiceSample', { name: voice.name })}
            title={voice.sample === null ? t('settingsConversation.live.noSample') : t('settingsVoice.speech.playVoiceSample', { name: voice.name })}
            disabled={voice.sample === null}
            onClick={() => voice.sample && play(voice.sample)}
          >
            <Play size={13} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
