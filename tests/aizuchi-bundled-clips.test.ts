import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AIZUCHI_BANK } from '@shared/aizuchi-bank'
import { IRODORI_TTS_VOICES, QWEN_TTS_VOICES } from '@shared/tts-models'

/**
 * The aizuchi clips of the voices of the local engines are rendered ahead of time and shipped. Changing the
 * bank, or adding a voice, without rendering them again would leave the app without a clip it needs at startup.
 */

const ROOT = path.resolve(import.meta.dirname, '../resources/aizuchi')
const VOICES = [...QWEN_TTS_VOICES.map((voice) => ['qwen3tts', voice.id]), ...IRODORI_TTS_VOICES.map((voice) => ['irodori', voice.id])]

describe('pre-rendered aizuchi clips', () => {
  it.each(VOICES)('has a playable clip for every entry of the bank in the %s voice %s', (engine, voice) => {
    const dir = path.join(ROOT, engine, voice)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      clips: Array<{ text: string; speedScale?: number; volumeScale?: number; file: string }>
    }
    const missing = AIZUCHI_BANK.filter((def) => {
      const entry = manifest.clips.find((clip) => clip.text === def.text && clip.speedScale === def.speedScale && clip.volumeScale === def.volumeScale)
      if (!entry) return true
      const wav = fs.readFileSync(path.join(dir, entry.file))
      // A clip is a RIFF file with at least 0.15 s of 24 kHz 16-bit audio after its 44-byte header.
      return wav.toString('ascii', 0, 4) !== 'RIFF' || wav.length < 44 + 0.15 * 24_000 * 2
    }).map((def) => def.text)
    expect(missing).toEqual([])
  })
})
