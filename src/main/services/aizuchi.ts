import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import mitt from 'mitt'
import type { AizuchiClip } from '@shared/ipc'
import { AIZUCHI_BANK, type AizuchiDef } from '@shared/aizuchi-bank'
import { pickWeightedClip } from '@shared/aizuchi-clips'
import type { QwenTtsVoice } from '@shared/tts-models'
import { getSettings } from './settings'
import { features } from './conversation-locale'
import * as qwenTts from './qwen-tts'
import { resourcePath } from './resource-path'
import * as tts from './tts'
import { voiceKey } from './tts-voice'

/**
 * The aizuchi bank. For the HTTP engines every clip is synthesized ahead of time at startup and whenever
 * the TTS settings change, and cached as a WAV file under userData/aizuchi/; for Qwen3-TTS the clips
 * ship with the app. The renderer keeps all the clips in memory so
 * that it can start one within tens of milliseconds of detecting the end of an utterance.
 */

/**
 * The silence before and after a clip, in seconds. The engine's default of 0.1 s in front becomes a delay
 * between the start of playback and the voice; measured clips already carried about 0.2 s of silence at
 * their head. A listening aizuchi lands in a pause of 0.25 to 0.55 s inside a sentence, so the leading
 * silence is 0 to keep the voice inside that window, and the trailing silence is the smallest that does
 * not cut the ending. The fillers of bridge-plan are synthesized under the same conditions.
 */
export const CLIP_SILENCE = { prePhonemeLength: 0, postPhonemeLength: 0.05 } as const


const cacheDir = (): string => path.join(app.getPath('userData'), 'aizuchi')

/** Bumped whenever the synthesis conditions (prosody, silence) change; build deletes older generations. */
const CACHE_VERSION = 'v4'

function cacheFile(def: AizuchiDef, voice: Exclude<tts.TtsVoice, { engine: 'system' }>): string {
  // The cache key is the engine and speaker actually handed to the synthesizer, including one picked
  // automatically.
  const hash = crypto
    .createHash('sha1')
    .update(
      `${voiceKey(voice)}:${def.text}:${def.speedScale ?? 1}:${def.volumeScale ?? 1}:` +
        `${CLIP_SILENCE.prePhonemeLength}:${CLIP_SILENCE.postPhonemeLength}`
    )
    .digest('hex')
    .slice(0, 16)
  return `${CACHE_VERSION}-${hash}.wav`
}

/**
 * `changed` goes out each time the bank is thrown away, and the renderer asks for the new one. Main alone
 * decides which settings and which engine events change the clips.
 */
export const events = mitt<{ changed: void }>()

let bank: AizuchiClip[] | null = null
/** The cached bank has a clip without audio although an HTTP engine should have synthesized it. */
let incomplete = false
/** Whether the next check that finds the TTS answering builds an incomplete bank again. */
let retryOnAnswer = false
/** The generation of the last build started because the TTS answered. */
let answerGeneration = -1
let building: Promise<AizuchiClip[]> | null = null
let generation = 0

/** Returns the bank, synthesizing or reading the cache on the first call. `audio` is null when TTS is unreachable. */
export async function getBank(): Promise<AizuchiClip[]> {
  if (bank) return bank
  if (!building) {
    const current = generation
    const operation = build().then(({ clips, missingAudio }) => {
      // A request that started before a settings change still gets the bank built from the current settings.
      if (generation !== current) return getBank()
      bank = clips
      incomplete = missingAudio
      retryOnAnswer = missingAudio && current !== answerGeneration
      return clips
    }).finally(() => {
      if (building === operation) building = null
    })
    building = operation
  }
  return building
}

/** Picks one clip of a category by weight, for brain's work filler. */
export async function randomClip(category: AizuchiClip['category']): Promise<AizuchiClip | null> {
  const clips = (await getBank()).filter((c) => c.category === category && c.audio)
  return pickWeightedClip(clips)
}

/**
 * Throws the bank away and builds it again from the current settings, after the TTS settings change, the
 * Qwen3-TTS model arrives or the engine answers again. Nothing waits for the build, so a failure, such
 * as shipped clips that do not cover the bank, is logged here instead of being lost.
 */
export function rebuild(): void {
  generation += 1
  bank = null
  building = null
  getBank().catch((error) => console.error('aizuchi bank failed:', error))
  events.emit('changed')
}

/**
 * The watchdog reports each check that finds the TTS answering, and whether it had found it down just
 * before. A bank missing audio, because the engine did not answer yet or died while the clips were
 * synthesized, is built again at the first such check after it was built, and again whenever the TTS
 * comes back after being seen down. Waiting for down to up alone missed a bank built before the
 * watchdog first saw the engine, such as the one built at launch while the spawned engine did not serve
 * HTTP yet. A bank built again because the TTS answered and still missing audio is not retried on every
 * check: synthesis then fails for another reason, which the build has logged.
 */
export function ttsAnswered(recovered: boolean): void {
  if (!bank || !incomplete || !(recovered || retryOnAnswer)) return
  rebuild()
  answerGeneration = generation
}

interface BundledManifest {
  clips: Array<{ text: string; speedScale?: number; volumeScale?: number; file: string }>
}

/**
 * The clips of a Qwen3-TTS voice ship with the app instead of being synthesized here. Read alone, a
 * short interjection makes the model ramble for seconds, so the clips are rendered ahead of time in
 * front of a carrier sentence, cut out and checked (scripts/aizuchi-clips). A clip missing for an
 * entry of the bank means the bank changed without rendering the clips again, which is a packaging
 * defect and fails loudly.
 */
function bundledClips(voice: QwenTtsVoice): (def: AizuchiDef) => string {
  const dir = resourcePath(path.join('aizuchi', 'qwen3tts', voice))
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BundledManifest
  return (def) => {
    const entry = manifest.clips.find((clip) => clip.text === def.text && clip.speedScale === def.speedScale && clip.volumeScale === def.volumeScale)
    if (!entry) throw new Error(`no pre-rendered aizuchi clip for "${def.text}" in the voice ${voice}`)
    return fs.readFileSync(path.join(dir, entry.file)).toString('base64')
  }
}

async function build(): Promise<{ clips: AizuchiClip[]; missingAudio: boolean }> {
  // The bank is a set of Japanese interjections, so in another conversation language nothing is
  // synthesized, no cache file is read, and the renderer receives no clip to play.
  if (!features().aizuchi) return { clips: [], missingAudio: false }
  const dir = cacheDir()
  fs.mkdirSync(dir, { recursive: true })
  const settings = getSettings()
  const ttsUp = await tts.available(settings.ttsEngine)
  let voice: tts.TtsVoice | null = null
  // The shipped clips need no running worker, only the engine the replies will be read with. Asking whether the
  // worker is ready instead would build a silent bank whenever it is still loading, which is every switch to this engine.
  const qwen = qwenTts.installationStatus()
  const bundled = settings.ttsEngine === 'qwen3tts' && qwen.runtimeInstalled && qwen.modelInstalled ? bundledClips(settings.qwenTtsVoice) : null
  const httpEngine = settings.ttsEngine !== 'system' && settings.ttsEngine !== 'none' && settings.ttsEngine !== 'qwen3tts'
  if (httpEngine && !ttsUp) console.warn(`aizuchi bank built without audio: ${settings.ttsEngine} does not answer`)
  const clips: AizuchiClip[] = []
  for (const def of AIZUCHI_BANK) {
    let audio: string | null = null
    if (bundled) {
      audio = bundled(def)
    } else if (ttsUp && settings.ttsEngine !== 'system' && settings.ttsEngine !== 'none') {
      try {
        voice ??= await tts.resolveVoice(settings)
        if (voice.engine === 'system') throw new Error('the aizuchi bank resolved to the system voice')
        const file = path.join(dir, cacheFile(def, voice))
        if (fs.existsSync(file)) {
          audio = fs.readFileSync(file).toString('base64')
        } else {
          const result = await tts.synthesize(def.text, undefined, {
            speedScale: def.speedScale,
            volumeScale: def.volumeScale,
            ...CLIP_SILENCE
          }, voice)
          if (result.audio) {
            fs.writeFileSync(file, Buffer.from(result.audio, 'base64'))
            audio = result.audio
          }
        }
      } catch (err) {
        console.error('aizuchi synth failed:', def.text, err)
      }
    }
    clips.push({ text: def.text, category: def.category, weight: def.weight, audio })
  }
  pruneStaleClips(dir)
  console.log(`aizuchi bank ready: ${clips.length} clips (audio: ${clips.some((c) => c.audio)})`)
  return { clips, missingAudio: httpEngine && clips.some((clip) => clip.audio === null) }
}

/**
 * Deletes the WAV files made under older synthesis conditions. Current-generation files of another
 * speaker are kept, so that switching the speaker back reuses them.
 */
function pruneStaleClips(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.wav') && !name.startsWith(`${CACHE_VERSION}-`)) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  }
}
