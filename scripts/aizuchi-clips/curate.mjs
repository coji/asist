import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CARRIER, FRAME, RATE, VOICED_FRAME_RMS, cutAizuchi, frameRms, plain, trimAizuchi } from './cut.mjs'
import { TTS_MODELS, startRecognizer, startSynthesizer } from './speech.mjs'

/**
 * Pre-renders the aizuchi clips of one voice of a local engine, which the app ships instead of synthesizing
 * them, so that every clip it plays has been checked.
 *
 * Qwen3-TTS rambles on a short interjection read alone ("あー。" came out between 0.6 and 6.5 s, measured
 * on 2026-09-21), but reads it naturally in front of a longer sentence. So with Qwen3-TTS every aizuchi is
 * read several times in front of a carrier sentence and cut out (cut.mjs). Irodori-TTS fixes the length of
 * what it reads before it speaks, so it reads the aizuchi alone. A reading is kept only when speech
 * recognition hears the aizuchi in it; the most typical candidate wins. Where the recognizer never writes an
 * aizuchi out in full, a partly recognized reading stands in. The result still has to be listened to.
 */

/** The voiced RMS the app's SpeechShaper levels streamed sentences to. */
const TARGET_RMS = 0.07
const PEAK_CEILING = 0.95

export function level(samples, volume) {
  const rms = frameRms(samples)
  let sum = 0
  let count = 0
  rms.forEach((value, frame) => {
    if (value < VOICED_FRAME_RMS) return
    for (let i = frame * FRAME; i < (frame + 1) * FRAME; i++) sum += samples[i] * samples[i]
    count += FRAME
  })
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  const gain = Math.min(TARGET_RMS / Math.sqrt(sum / count), PEAK_CEILING / peak) * volume
  const out = samples.map((value) => value * gain)
  const fade = Math.floor(0.03 * RATE)
  for (let i = 0; i < fade; i++) out[out.length - fade + i] *= 1 - i / (fade - 1)
  return out
}

export function wavBytes(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The candidates of a clip kept beside it for the review page, the chosen one first. */
const KEPT_CANDIDATES = 5

/**
 * Renders `defs` ({ text, speedScale?, volumeScale? }) for the voice into outDir and its manifest.json, keeping
 * the clips of the manifest that are not among them, and writes the best candidates of each clip into
 * candidatesDir/<clip>/ for the review page of the demo. A clip rendered here is not reviewed yet. With
 * keepReviewed, a clip someone accepts on the review page while the run goes on is left as they chose it.
 */
export async function curate({ engine, voice, language, outDir, candidatesDir, candidates, defs, keepReviewed }) {
  const synthesizer = await startSynthesizer(engine)
  const recognizer = await startRecognizer()
  try {
    mkdirSync(outDir, { recursive: true })
    const manifestPath = path.join(outDir, 'manifest.json')
    const model = `${TTS_MODELS[engine].repo}@${TTS_MODELS[engine].revision}/${TTS_MODELS[engine].file}`
    // The manifest is read again for every clip, so that a verdict the review page wrote meanwhile is kept.
    const save = (entry) => {
      const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { clips: [] }
      // A clip names the model that read it, so that clips kept from an earlier run keep theirs.
      const clips = previous.clips.map((clip) => ({ ...clip, model: clip.model ?? previous.model })).filter((clip) => clip.file !== entry?.file)
      if (entry) clips.push(entry)
      clips.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
      writeFileSync(manifestPath, JSON.stringify({ voice, language, clips }, null, 2) + '\n')
    }
    for (const definition of defs) {
      const head = definition.text
      // A run takes half an hour for a voice of Qwen3-TTS, and the review goes on meanwhile.
      if (keepReviewed && existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).clips.some((clip) => clip.text === head && clip.reviewed)) {
        console.error(`${head}: accepted meanwhile, kept`)
        continue
      }
      const alone = engine === 'irodori'
      const text = alone ? head : head + ('。、'.includes(head.at(-1)) ? '' : '、') + CARRIER
      // Reading goes on until enough candidates passed the checks, within a budget of attempts.
      const scored = []
      const partial = []
      const rejected = []
      let attempts = 0
      while (scored.length < candidates && attempts < candidates * 6) {
        attempts++
        const audio = await synthesizer.speak(text, voice, language)
        const recognize = (samples) => recognizer.recognize(samples)
        const found = alone ? await trimAizuchi(audio, head, recognize) : await cutAizuchi(audio, head, recognize)
        if (typeof found === 'string') rejected.push(found)
        else if (plain(found.heard) === plain(head)) scored.push(found)
        else if (plain(found.heard) && plain(head).includes(plain(found.heard))) {
          // The recognizer writes a doubled form such as "うんうん" once and drops a weak "えっ", but a reading of
          // "なるほどなるほど" that says it once is heard the same way. These stand behind every reading heard word
          // for word, and the review page marks them for the ear.
          partial.push(found)
        } else rejected.push(`heard "${found.heard}"`)
      }
      if (scored.length + partial.length === 0) {
        console.error(`${head}: no verified candidate in ${attempts} readings (${rejected.join('; ')})`)
        continue
      }
      for (const group of [scored, partial]) {
        const typical = median(group.map((c) => c.voicedMs))
        for (const c of group) c.score = Math.min(c.pauseMs, 300) / 300 - Math.abs(c.voicedMs - typical) / typical
        group.sort((a, b) => b.score - a.score)
      }
      const usable = [...scored.map((c) => ({ ...c, exact: true })), ...partial.map((c) => ({ ...c, exact: false }))].slice(0, KEPT_CANDIDATES)
      // The name is the one Python's json.dumps(sort_keys=True) gave, with its spaces, so that a clip read again
      // replaces the file of the same definition.
      const key = '{' + Object.keys(definition).sort().map((name) => `${JSON.stringify(name)}: ${JSON.stringify(definition[name])}`).join(', ') + '}'
      const file = `${createHash('sha1').update(key).digest('hex').slice(0, 12)}.wav`
      const leveled = usable.map((c) => wavBytes(level(c.samples, definition.volumeScale ?? 1)))
      writeFileSync(path.join(outDir, file), leveled[0])
      const dir = path.join(candidatesDir, path.basename(file, '.wav'))
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      leveled.forEach((wav, index) => writeFileSync(path.join(dir, `${index}.wav`), wav))
      writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify(usable.map((c, index) => ({ file: `${index}.wav`, heard: c.heard, voicedMs: c.voicedMs, exact: c.exact })), null, 2) + '\n')
      // The entry repeats the definition as it is, without the keys it leaves out, so that the app can match the two.
      save({ ...definition, file, model })
      console.error(`${head}: ${scored.length} verified and ${partial.length} partly recognized in ${attempts} readings, chose ${usable[0].voicedMs} ms`)
    }
    save()
  } finally {
    synthesizer.stop()
    recognizer.stop()
  }
}
