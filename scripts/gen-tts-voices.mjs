#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IRODORI_TTS_VOICE_IDS, QWEN_TTS_VOICE_IDS } from '../src/shared/tts-models.ts'
import { VOICE_SAMPLE_TEXT } from '../src/shared/voice-samples.ts'
import { level, wavBytes } from './aizuchi-clips/curate.mjs'
import { plain, trimAizuchi } from './aizuchi-clips/cut.mjs'
import { startRecognizer, startSynthesizer } from './aizuchi-clips/speech.mjs'

/**
 * Builds the samples of the voices of the local engines that the settings screen plays, so that a voice can be
 * heard before its model is downloaded and in the language of the conversation.
 *
 *   node scripts/gen-tts-voices.mjs                       builds the samples that are missing
 *   node scripts/gen-tts-voices.mjs qwen3tts              builds those of one engine again
 *   node scripts/gen-tts-voices.mjs qwen3tts en           builds those of one engine in one language again
 *   node scripts/gen-tts-voices.mjs qwen3tts en ryan      builds one again
 *
 * Every voice reads VOICE_SAMPLE_TEXT of src/shared/voice-samples.ts, Irodori-TTS in Japanese and Qwen3-TTS
 * in each language it reads for a conversation locale, through the bundled speech-worker and the model files
 * the app has prepared (Irodori-TTS and Qwen3-TTS 0.6B), until speech recognition hears it as written. The
 * reading is trimmed and levelled like a reply and written by ffmpeg to
 * src/renderer/src/assets/tts-voices/<engine>/<language>/<voice>.mp3.
 */

const ATTEMPTS = 6
const OUT = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'src', 'assets', 'tts-voices')
const ENGINES = {
  irodori: { voices: IRODORI_TTS_VOICE_IDS, languages: ['ja'] },
  qwen3tts: { voices: QWEN_TTS_VOICE_IDS, languages: Object.keys(VOICE_SAMPLE_TEXT) }
}
const ENGLISH_NAME = new Intl.DisplayNames('en', { type: 'language' })

/** The words of a reading, without the punctuation, spacing and case the recognizer writes as it likes. */
const words = (text, language) => (language === 'ja' ? plain(text) : text.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, ''))

const [onlyEngine, onlyLanguage, onlyVoice] = process.argv.slice(2)
const engines = Object.keys(ENGINES).filter((engine) => !onlyEngine || engine === onlyEngine)
if (engines.length === 0) throw new Error(`no engine ${onlyEngine}; use ${Object.keys(ENGINES).join(' or ')}`)
const file = (engine, language, voice) => path.join(OUT, engine, language, `${voice}.mp3`)

const recognizer = await startRecognizer()
try {
  for (const engine of engines) {
    const wanted = ENGINES[engine].languages
      .filter((language) => !onlyLanguage || language === onlyLanguage)
      .flatMap((language) => ENGINES[engine].voices.filter((voice) => !onlyVoice || voice === onlyVoice).map((voice) => ({ language, voice })))
      .filter(({ language, voice }) => onlyEngine || !existsSync(file(engine, language, voice)))
    if (wanted.length === 0) continue
    const synthesizer = await startSynthesizer(engine)
    try {
      for (const { language, voice } of wanted) {
        const text = VOICE_SAMPLE_TEXT[language]
        let chosen = null
        for (let attempt = 0; attempt < ATTEMPTS && !chosen; attempt++) {
          const reading = await trimAizuchi(await synthesizer.speak(text, voice, language), text, (samples) => recognizer.recognize(samples, ENGLISH_NAME.of(language)))
          if (typeof reading !== 'string' && words(reading.heard, language) === words(text, language)) chosen = reading
          else console.error(`${engine} ${language} ${voice}: ${typeof reading === 'string' ? reading : `heard "${reading.heard}"`}`)
        }
        if (!chosen) throw new Error(`${engine} ${language} ${voice}: no reading heard as written in ${ATTEMPTS} attempts`)
        const temp = path.join(tmpdir(), `asist-tts-voice-${engine}-${language}-${voice}.wav`)
        writeFileSync(temp, wavBytes(level(chosen.samples, 1)))
        mkdirSync(path.dirname(file(engine, language, voice)), { recursive: true })
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', temp, '-codec:a', 'libmp3lame', '-b:a', '48k', file(engine, language, voice)])
        rmSync(temp)
        console.error(`${engine} ${language} ${voice}: ${(chosen.voicedMs / 1000).toFixed(2)} s`)
      }
    } finally {
      synthesizer.stop()
    }
  }
} finally {
  recognizer.stop()
}
