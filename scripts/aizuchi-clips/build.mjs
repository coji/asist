#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AIZUCHI_BANK } from '../../src/shared/aizuchi-bank.ts'
import { curate } from './curate.mjs'

/**
 * Pre-renders the aizuchi bank for one voice of a local engine (qwen3tts or irodori) into
 * resources/aizuchi/<engine>/<voice>/, with the best candidates of each clip in .aizuchi-candidates/ for the
 * review page of the demo (/aizuchi). curate.mjs explains why the clips are made ahead of time and how.
 *
 *   node scripts/aizuchi-clips/build.mjs <engine> <voice> [candidates] [text ...]
 *
 * It runs the bundled speech-worker and llama-server (node scripts/prepare-resources.mjs dev) on the files the
 * app has prepared: Qwen3-TTS 0.6B or Irodori-TTS, and Qwen3-ASR 1.7B. A clip marked reviewed in the manifest
 * is kept unless its text is given; with texts given, only those entries of the bank are rendered again. Commit
 * the clips only after reviewing them; every regeneration adds binary history.
 */

const [engine, voice, candidates = '5', ...only] = process.argv.slice(2)
if (!['qwen3tts', 'irodori'].includes(engine) || !voice) {
  console.error('usage: node scripts/aizuchi-clips/build.mjs <qwen3tts|irodori> <voice> [candidates] [text ...]')
  process.exit(2)
}

const root = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(root, 'resources/aizuchi', engine, voice)
const manifestPath = path.join(outDir, 'manifest.json')
const reviewed = new Set(
  (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).clips : []).filter((clip) => clip.reviewed).map((clip) => clip.text)
)
const defs = AIZUCHI_BANK.map(({ text, speedScale, volumeScale }) => Object.fromEntries(Object.entries({ text, speedScale, volumeScale }).filter(([, value]) => value !== undefined)))
// Two categories share "あー、はい。" under the same conditions, and one clip serves both.
const unique = defs
  .filter((def, index) => defs.findIndex((other) => JSON.stringify(other) === JSON.stringify(def)) === index)
  .filter((def) => (only.length === 0 ? !reviewed.has(def.text) : only.includes(def.text)))

await curate({
  engine,
  voice,
  language: 'ja',
  outDir,
  candidatesDir: path.join(root, '.aizuchi-candidates', engine, voice),
  candidates: Number(candidates),
  defs: unique,
  keepReviewed: only.length === 0
})
console.error(`${engine} ${voice}: ${unique.length} clips rendered into ${path.relative(root, outDir)}; review them at /aizuchi of npm run demo`)
