import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CARRIER, FRAME, RATE, VOICED_FRAME_RMS, cutAizuchi, frameRms, plain } from './cut.mjs'
import { TTS_MODEL, startRecognizer, startSynthesizer } from './speech.mjs'

/**
 * Pre-renders the aizuchi clips of one Qwen3-TTS voice, which the app ships instead of synthesizing them.
 *
 * Qwen3-TTS rambles on a short interjection read alone ("あー。" came out between 0.6 and 6.5 s, measured
 * on 2026-09-21), but reads it naturally in front of a longer sentence. So every aizuchi is read several
 * times in front of a carrier sentence and cut out (cut.mjs), and kept only when speech recognition hears
 * the aizuchi in the cut; the most typical candidate wins. Where the recognizer never writes an aizuchi out
 * in full, a partly recognized reading stands in. The result still has to be listened to.
 */

/** The voiced RMS the app's SpeechShaper levels streamed sentences to. */
const TARGET_RMS = 0.07
const PEAK_CEILING = 0.95

function level(samples, volume) {
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

/**
 * Renders `defs` ({ text, speedScale?, volumeScale? }) for the voice into outDir and its manifest.json, keeping
 * the clips of the manifest that are not among them, and returns the report the review page shows.
 */
export async function curate({ voice, language, outDir, candidates, defs }) {
  const synthesizer = await startSynthesizer()
  const recognizer = await startRecognizer()
  try {
    mkdirSync(outDir, { recursive: true })
    const manifestPath = path.join(outDir, 'manifest.json')
    const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { clips: [] }
    // A clip names the model that read it, so that clips kept from an earlier run keep theirs.
    const kept = previous.clips
      .filter((clip) => !defs.some((def) => def.text === clip.text))
      .map((clip) => ({ ...clip, model: clip.model ?? previous.model }))
    const model = `${TTS_MODEL.repo}@${TTS_MODEL.revision}/${TTS_MODEL.file}`
    const manifest = []
    const report = []
    for (const definition of defs) {
      const head = definition.text
      const text = head + ('。、'.includes(head.at(-1)) ? '' : '、') + CARRIER
      // Reading goes on until enough candidates passed the checks, within a budget of attempts.
      const scored = []
      const partial = []
      const rejected = []
      let attempts = 0
      while (scored.length < candidates && attempts < candidates * 6) {
        attempts++
        const audio = await synthesizer.speak(text, voice, language)
        const found = await cutAizuchi(audio, head, (samples) => recognizer.recognize(samples))
        if (typeof found === 'string') rejected.push(found)
        else if (plain(found.heard) === plain(head)) scored.push(found)
        else if (plain(found.heard) && plain(head).includes(plain(found.heard))) {
          // The recognizer writes a doubled form such as "うんうん" once and drops a weak "えっ". With the
          // carrier whole the clip still holds everything spoken before it, so these stand in when no
          // reading is recognized word for word, and the review page marks them for the ear.
          partial.push(found)
        } else rejected.push(`heard "${found.heard}"`)
      }
      const exact = scored.length > 0
      const usable = exact ? scored : partial
      if (usable.length === 0) {
        console.error(`${head}: no verified candidate in ${attempts} readings (${rejected.join('; ')})`)
        report.push({ text: head, candidates: [] })
        continue
      }
      const typical = median(usable.map((c) => c.voicedMs))
      for (const c of usable) c.score = Math.min(c.pauseMs, 300) / 300 - Math.abs(c.voicedMs - typical) / typical
      usable.sort((a, b) => b.score - a.score)
      // The name is the one Python's json.dumps(sort_keys=True) gave, with its spaces, so that a clip read again
      // replaces the file of the same definition.
      const key = '{' + Object.keys(definition).sort().map((name) => `${JSON.stringify(name)}: ${JSON.stringify(definition[name])}`).join(', ') + '}'
      const file = `${createHash('sha1').update(key).digest('hex').slice(0, 12)}.wav`
      const clips = usable.slice(0, 3).map((c) => level(c.samples, definition.volumeScale ?? 1))
      writeFileSync(path.join(outDir, file), wavBytes(clips[0]))
      // The entry repeats the definition as it is, without the keys it leaves out, so that the app can match the two.
      manifest.push({ ...definition, file, model })
      report.push({
        text: head,
        usable: `${usable.length} of ${attempts}`,
        exact,
        candidates: usable.slice(0, 3).map((c, index) => ({ ms: c.voicedMs, pauseMs: c.pauseMs, heard: c.heard, audio: wavBytes(clips[index]).toString('base64') }))
      })
      console.error(`${head}: ${usable.length} ${exact ? 'verified' : 'partly recognized'} in ${attempts} readings, chose ${usable[0].voicedMs} ms`)
    }
    const clips = [...kept, ...manifest].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    writeFileSync(manifestPath, JSON.stringify({ voice, language, clips }, null, 2) + '\n')
    return report
  } finally {
    synthesizer.stop()
    recognizer.stop()
  }
}
