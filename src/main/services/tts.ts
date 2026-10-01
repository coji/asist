import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { AppSettings, PhonemeEvent, SpeakerOption, TtsEngine } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { withTimeoutSignal } from '@shared/abort'
import { CONVERSATION_LANGUAGE_NAMES, languageOf, ttsEngineSpeaks, type ConversationLocale } from '@shared/conversation-locale'
import { isLocalTtsEngine, qwenTtsLanguage, ttsEngineRuns } from '@shared/tts-models'
import { errorText } from '@shared/i18n/error-text'
import { osMessageKey } from '@shared/i18n/os-message'
import { conversationLocale } from './conversation-locale'
import { platformCapabilities } from './platform'
import { t } from './i18n'
import { getSettings } from './settings'
import * as localTts from './local-tts'
import type { HttpTtsEngine, TtsVoice } from './tts-voice'
import { childEnv } from './child-env'

export type { TtsVoice } from './tts-voice'

/**
 * The speech engines behind one interface. VOICEVOX ENGINE and AivisSpeech Engine speak the same
 * HTTP API of audio_query, synthesis and speakers and are driven by one implementation here;
 * Irodori-TTS and Qwen3-TTS run in speech.cpp's worker. With 'system', or when the chosen engine fails,
 * audio comes back as null and the renderer speaks through Web Speech.
 */

interface EngineDef {
  label: string
  url: string
  /** The engine's executable in the app each OS's installer puts in place, tried in order. */
  binaries: Record<OsFamily, () => Array<string | undefined>>
}

/**
 * The engine inside a Windows app installed with electron-builder's NSIS installer, which both apps
 * use: it installs for the current user under %LOCALAPPDATA%\Programs by default, and under
 * %ProgramFiles% when the user installs for all users. A folder the user picks in the installer
 * cannot be known here, and the app started from there runs the engine itself.
 */
const windowsInstalls = (product: string, engineFolder: string): Array<string | undefined> => {
  const local = process.env.LOCALAPPDATA
  return [local && path.win32.join(local, 'Programs'), process.env.ProgramFiles]
    .map((folder) => folder && path.win32.join(folder, product, engineFolder, 'run.exe'))
}

const ENGINES: Record<HttpTtsEngine, EngineDef> = {
  voicevox: {
    label: 'VOICEVOX',
    url: process.env.VOICEVOX_URL || 'http://127.0.0.1:50021',
    binaries: {
      macos: () => [
        path.join(homedir(), 'opt', 'voicevox_engine', 'run'),
        '/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run'
      ],
      windows: () => windowsInstalls('VOICEVOX', 'vv-engine')
    }
  },
  aivisspeech: {
    label: 'AivisSpeech',
    url: process.env.AIVISSPEECH_URL || 'http://127.0.0.1:10101',
    binaries: {
      macos: () => [
        path.join(homedir(), 'opt', 'aivisspeech_engine', 'run'),
        '/Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run'
      ],
      windows: () => windowsInstalls('AivisSpeech', 'AivisSpeech-Engine')
    }
  }
}

const currentEngine = (): TtsEngine => getSettings().ttsEngine

/** The name of the engine in the interface language. The engines named after their product keep that name in every language. */
export function engineLabel(engine: TtsEngine = currentEngine()): string {
  if (engine === 'system') return t(osMessageKey('settings.ttsEngine.system', platformCapabilities().os))
  if (engine === 'none') return t('settings.ttsEngine.none')
  if (engine === 'irodori') return 'Irodori-TTS'
  if (engine === 'qwen3tts') return 'Qwen3-TTS'
  return ENGINES[engine].label
}

/** Whether speech can be produced. "No speech" reports false, which is what turns the TTS light off in the HUD. */
export async function available(engine: TtsEngine = currentEngine()): Promise<boolean> {
  if (engine === 'system') return true
  if (engine === 'none') return false
  if (isLocalTtsEngine(engine)) return localTts.available(engine)
  try {
    const res = await fetch(`${ENGINES[engine].url}/version`, {
      signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

const children = new Map<TtsEngine, ChildProcess>()

/** Whether a process this app started for the engine is still alive, which is how a caller avoids waiting forever on an engine that is not installed. */
export const engineStarting = (engine: TtsEngine = currentEngine()): boolean =>
  isLocalTtsEngine(engine) ? localTts.isStarting() : children.has(engine)
const starting = new Map<TtsEngine, Promise<void>>()

/**
 * Starts the engine unless it is already running: an HTTP engine from the first executable that
 * exists, a local engine from its installed model. The speech worker holds about 2 GB, so it is
 * stopped as soon as an engine that does not use it is chosen.
 */
export function ensureEngine(engine: TtsEngine = currentEngine()): Promise<void> {
  // An engine this machine cannot run, such as Qwen3-TTS in settings brought from another machine, is
  // never started; reading with it fails with the reason instead.
  if (!ttsEngineRuns(engine, platformCapabilities().localSpeech)) {
    localTts.stop()
    return Promise.resolve()
  }
  if (isLocalTtsEngine(engine)) return localTts.ensureWorker(engine).then(() => undefined)
  localTts.stop()
  if (engine === 'system' || engine === 'none') return Promise.resolve()
  const pending = starting.get(engine)
  if (pending) return pending
  const operation = startEngine(engine).finally(() => {
    if (starting.get(engine) === operation) starting.delete(engine)
  })
  starting.set(engine, operation)
  return operation
}

async function startEngine(engine: HttpTtsEngine): Promise<void> {
  // While a process we own is alive, no second one is started, including the window after spawn in which
  // its HTTP endpoint is not answering yet.
  if (children.has(engine) || (await available(engine))) return
  const binary = ENGINES[engine].binaries[platformCapabilities().os]().find((p): p is string => p !== undefined && fs.existsSync(p))
  if (!binary) return
  console.log(`starting ${ENGINES[engine].label} engine:`, binary)
  const child = spawn(binary, [], { detached: true, stdio: 'ignore', cwd: path.dirname(binary), env: childEnv(), windowsHide: true })
  children.set(engine, child)
  const clear = (): void => {
    if (children.get(engine) === child) children.delete(engine)
  }
  child.once('exit', clear)
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => {
      clear()
      reject(error)
    })
  })
}

export async function listSpeakers(engine: TtsEngine = currentEngine()): Promise<SpeakerOption[]> {
  if (engine === 'system' || engine === 'none' || isLocalTtsEngine(engine)) return []
  const res = await fetch(`${ENGINES[engine].url}/speakers`, {
    signal: AbortSignal.timeout(3000)
  })
  if (!res.ok) {
    throw new Error(errorText('voice.speech.speakersFailed', { engine: engineLabel(engine), status: res.status }))
  }
  const speakers = (await res.json()) as Array<{
    name: string
    styles: Array<{ id: number; name: string }>
  }>
  return speakers.flatMap((speaker) =>
    speaker.styles.map((style) => ({ id: style.id, label: `${speaker.name}(${style.name})` }))
  )
}

let automaticSpeakerLookup: Promise<number> | null = null

async function speakerId(engine: HttpTtsEngine, settings: AppSettings): Promise<number> {
  if (engine === 'voicevox') return settings.voicevoxSpeaker
  if (settings.aivisSpeaker != null) return settings.aivisSpeaker
  // A null speaker means pick one automatically. Synthesis never writes back to the persisted settings;
  // concurrent requests only share the lookup.
  if (!automaticSpeakerLookup) {
    automaticSpeakerLookup = listSpeakers('aivisspeech')
      .then((speakers) => {
        if (speakers.length === 0) throw new Error('AivisSpeech: no speakers available')
        return speakers[0].id
      })
      .finally(() => { automaticSpeakerLookup = null })
  }
  const automatic = await automaticSpeakerLookup
  const current = getSettings()
  // An explicit choice made while this lookup was running wins. If the engine itself changed in the
  // meantime, the id belongs to the engine this request started with and is used as it is.
  return current.ttsEngine === settings.ttsEngine && current.aivisSpeaker !== null
    ? current.aivisSpeaker
    : automatic
}

const cannotSpeak = (engine: TtsEngine, locale: ConversationLocale): Error =>
  new Error(errorText('voice.speech.cannotSpeak', {
    engine: engineLabel(engine),
    language: CONVERSATION_LANGUAGE_NAMES[locale]
  }))

/**
 * Resolves the choice up front so that synthesis and the audio cache are given the same engine and speaker.
 * The locale is the language of the text to be read, which a reply keeps from its start.
 */
export async function resolveVoice(settings: AppSettings = getSettings(), locale: ConversationLocale = conversationLocale()): Promise<TtsVoice> {
  const engine = settings.ttsEngine
  if (engine === 'none') throw new Error(errorText('voice.speech.noSpeech'))
  if (engine === 'system') return { engine: 'system' }
  if (!ttsEngineRuns(engine, platformCapabilities().localSpeech)) {
    throw new Error(errorText('voice.speech.cannotRunHere', { engine: engineLabel(engine) }))
  }
  if (engine === 'irodori') {
    if (!ttsEngineSpeaks(locale, engine)) throw cannotSpeak(engine, locale)
    return { engine, voice: settings.irodoriTtsVoice, language: languageOf(locale) }
  }
  if (engine === 'qwen3tts') {
    const language = qwenTtsLanguage(locale)
    if (!language) throw cannotSpeak(engine, locale)
    return { engine, voice: settings.qwenTtsVoice, language }
  }
  // VOICEVOX and AivisSpeech have Japanese voices only, and read anything else as if the letters
  // were Japanese.
  if (locale !== 'ja-JP') throw cannotSpeak(engine, locale)
  return { engine, speaker: await speakerId(engine, settings) }
}

interface Mora {
  vowel: string
  consonant_length: number | null
  vowel_length: number
}

interface AudioQuery {
  accent_phrases: Array<{ moras: Mora[]; pause_mora: Mora | null }>
  speedScale: number
  prePhonemeLength: number
}

function buildPhonemeTimeline(query: AudioQuery): PhonemeEvent[] {
  const scale = 1 / (query.speedScale || 1)
  let t = (query.prePhonemeLength || 0) * scale
  const events: PhonemeEvent[] = []
  for (const phrase of query.accent_phrases) {
    const moras = phrase.pause_mora ? [...phrase.moras, phrase.pause_mora] : phrase.moras
    for (const mora of moras) {
      const consonant = (mora.consonant_length ?? 0) * scale
      const vowel = (mora.vowel_length ?? 0) * scale
      events.push({ vowel: mora.vowel, start: t + consonant, end: t + consonant + vowel })
      t += consonant + vowel
    }
  }
  return events
}

export interface SynthesisResult {
  audio: string | null
  phonemes: PhonemeEvent[] | null
}

export interface ProsodyOptions {
  /**
   * The speaking rate, where 1.0 is normal. Aizuchi are spoken faster and lighter. Only the HTTP engines
   * apply it: speech.cpp's worker accepts a speed and ignores it.
   */
  speedScale?: number
  /** The volume, where 1.0 is normal. */
  volumeScale?: number
  /**
   * The silence in seconds placed before and after the speech by an HTTP engine. The engine defaults
   * to 0.1 seconds on each side, which on a clip as short as an aizuchi is heard as a delay between
   * playback starting and the voice arriving, so an aizuchi sets the leading silence to 0. The local
   * engines ignore it, because their silence is cut to a fixed short tail.
   */
  prePhonemeLength?: number
  postPhonemeLength?: number
}

type LocalVoice = Extract<TtsVoice, { engine: 'irodori' | 'qwen3tts' }>

const localRequest = (text: string, voice: LocalVoice): localTts.LocalSpeechRequest => ({ text, voice: voice.voice, language: voice.language })

/** Synthesizes the whole text. With no engine reachable, or with 'system' selected, audio is null and the renderer speaks through Web Speech. */
export async function synthesize(
  text: string,
  signal?: AbortSignal,
  prosody?: ProsodyOptions,
  voice?: TtsVoice
): Promise<SynthesisResult> {
  try {
    const selected = voice ?? await resolveVoice()
    if (selected.engine === 'system') return { audio: null, phonemes: null }
    if (selected.engine === 'irodori' || selected.engine === 'qwen3tts') {
      const wav = await localTts.synthesizeWav(selected.engine, localRequest(text, selected), signal, prosody?.volumeScale)
      return { audio: wav.toString('base64'), phonemes: null }
    }
    const { engine, speaker } = selected
    const url = ENGINES[engine].url
    const queryRes = await fetch(
      `${url}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: 'POST', signal: withTimeoutSignal(signal, 10_000) }
    )
    if (!queryRes.ok) throw new Error(`audio_query failed: ${queryRes.status}`)
    const query = (await queryRes.json()) as AudioQuery
    if (prosody?.speedScale) query.speedScale = prosody.speedScale
    if (prosody?.volumeScale) (query as AudioQuery & { volumeScale?: number }).volumeScale = prosody.volumeScale
    if (prosody?.prePhonemeLength !== undefined) query.prePhonemeLength = prosody.prePhonemeLength
    if (prosody?.postPhonemeLength !== undefined) {
      (query as AudioQuery & { postPhonemeLength?: number }).postPhonemeLength = prosody.postPhonemeLength
    }

    const synthRes = await fetch(`${url}/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal: withTimeoutSignal(signal, 60_000)
    })
    if (!synthRes.ok) throw new Error(`synthesis failed: ${synthRes.status}`)
    const wav = Buffer.from(await synthRes.arrayBuffer())

    const timeline = buildPhonemeTimeline(query)
    const hasTiming = timeline.some((event) => event.end > event.start)
    return { audio: wav.toString('base64'), phonemes: hasTiming ? timeline : null }
  } catch (err) {
    if (signal?.aborted) throw err
    // A dead engine, or anything else, must not stop the conversation: the renderer falls back to Web Speech.
    console.error('tts synthesize failed:', err instanceof Error ? err.message : err)
    return { audio: null, phonemes: null }
  }
}

/** One sentence of a reply: either complete, or streaming in pieces from an engine that returns audio while it synthesizes. */
export type SentenceSpeech =
  | ({ kind: 'whole' } & SynthesisResult)
  | { kind: 'stream'; sampleRate: number; pieces: AsyncIterable<Float32Array> }

/**
 * Synthesizes one sentence of a reply written in the given language for the playback queue. A streaming
 * engine resolves as soon as its first piece exists, so a sentence that fails before any audio is handled
 * like any other failed synthesis.
 */
export async function synthesizeSentence(text: string, locale: ConversationLocale, signal?: AbortSignal): Promise<SentenceSpeech> {
  const voice = await resolveVoice(getSettings(), locale)
  if (voice.engine !== 'irodori' && voice.engine !== 'qwen3tts') return { kind: 'whole', ...(await synthesize(text, signal, undefined, voice)) }
  try {
    const pieces = localTts.stream(voice.engine, localRequest(text, voice), signal)
    const first = await pieces.next()
    if (first.done) throw new Error(`${engineLabel(voice.engine)} produced no audible speech`)
    const rest = async function* (): AsyncGenerator<Float32Array> {
      yield first.value
      yield* pieces
    }
    return { kind: 'stream', sampleRate: localTts.sampleRate(), pieces: rest() }
  } catch (err) {
    if (signal?.aborted) throw err
    console.error('tts synthesize failed:', err instanceof Error ? err.message : err)
    return { kind: 'whole', audio: null, phonemes: null }
  }
}
