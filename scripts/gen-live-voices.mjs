#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Builds the voice samples of Gemini Live the settings screen plays.
 *
 *   node scripts/gen-live-voices.mjs           rebuilds all of them
 *   node scripts/gen-live-voices.mjs Kore      rebuilds one voice
 *
 * The same sentence is read by Gemini's TTS (gemini-2.5-flash-preview-tts) for the 30 Gemini voices.
 * ffmpeg turns the result into src/renderer/src/assets/live-voices/gemini-live/<voice>.mp3, which is
 * what the settings screen plays, so listening to a sample needs no API. The key comes from the
 * environment or from userData/.env, as GEMINI_API_KEY.
 */

const TEXT = 'こんにちは。声のテストです。今日はいい天気ですね。'
const OUT = path.resolve('src/renderer/src/assets/live-voices')
const GEMINI_VOICES = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat']

function key(name) {
  if (process.env[name]) return process.env[name]
  const env = readFileSync(path.join(homedir(), 'Library/Application Support/asist/.env'), 'utf8')
  const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'))
  if (!match) throw new Error(`${name} がありません`)
  return match[1].trim()
}

/** Wraps mono PCM16 at 24 kHz in a WAV header, which is what ffmpeg is handed. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function toMp3(wavBytes, target) {
  const temp = path.join(tmpdir(), `live-voice-${process.pid}.wav`)
  writeFileSync(temp, wavBytes)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', temp, '-codec:a', 'libmp3lame', '-b:a', '48k', target])
  rmSync(temp, { force: true })
}

async function geminiTts(apiKey, voice) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `次の文を自然な日本語で読み上げる: ${TEXT}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
    })
  })
  if (!res.ok) throw new Error(`gemini tts ${voice}: ${res.status} ${await res.text()}`)
  const body = await res.json()
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!part) throw new Error(`gemini tts ${voice}: 音声が無い ${JSON.stringify(body).slice(0, 200)}`)
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000)
  return wav(Buffer.from(part.inlineData.data, 'base64'), rate)
}

const onlyVoice = process.argv[2]
const apiKey = key('GEMINI_API_KEY')
mkdirSync(path.join(OUT, 'gemini-live'), { recursive: true })
for (const voice of GEMINI_VOICES.filter((v) => !onlyVoice || v === onlyVoice)) {
  toMp3(await geminiTts(apiKey, voice), path.join(OUT, 'gemini-live', `${voice}.mp3`))
  console.log(`gemini-live ${voice}: tts`)
}
