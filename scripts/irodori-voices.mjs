#!/usr/bin/env node
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { IRODORI_TTS_MODEL, IRODORI_TTS_VOICE_IDS } from '../src/shared/tts-models.ts'
import { modelPath } from './aizuchi-clips/speech.mjs'
import { download, extract, run, withTemporaryDir } from './resources/shared.mjs'

/*
 * Writes resources/irodori-voices/<voice>.voice.gguf, the voices ASIST ships for Irodori-TTS, from the reference
 * recordings speech-bench made (voice-<voice>.wav):
 *
 *   node scripts/irodori-voices.mjs [references folder]
 *
 * The references folder defaults to ~/speech-bench-data/references. Each voice file holds the reference's codec
 * latent and names the codec, so the voices are made again whenever the codec's pin changes. They are made on
 * the CPU, where the latent matches the official encoder to 99 dB; on a GPU it differs by device. The model
 * and the codec are read from the files the app has prepared, or from the folder ASIST_SPEECH_MODELS names.
 */

const VERSION = 'v0.3.0'
const TOOLS = {
  'darwin-arm64': { name: 'speech-cpp-tools-v0.3.0-macos-arm64-metal.zip', sha256: '067e01bb6fe10b0ead1c04982da9fdc0ffed27fae9f245d77d5e9e057030ba0d', program: 'irodori-tts' },
  'win32-x64': { name: 'speech-cpp-tools-v0.3.0-windows-x64-vulkan.zip', sha256: '0ad6efebd29cec9daacbfda4b0d99e3bd1eac777737b558478cbfed77be7a544', program: 'irodori-tts.exe' }
}

const root = path.resolve(import.meta.dirname, '..')
const references = process.argv[2] ?? path.join(homedir(), 'speech-bench-data', 'references')

const tools = TOOLS[`${process.platform}-${process.arch}`]
if (!tools) throw new Error(`speech.cpp ${VERSION} has no tools for ${process.platform} ${process.arch}`)
const out = path.join(root, 'resources', 'irodori-voices')

await withTemporaryDir('asist-irodori-voices-', async (work) => {
  const archive = path.join(work, tools.name)
  await download(`https://github.com/nyosegawa/speech.cpp/releases/download/${VERSION}/${tools.name}`, archive, tools.sha256)
  extract(archive, path.join(work, 'tools'))
  const program = path.join(work, 'tools', tools.program)
  fs.chmodSync(program, 0o755)
  fs.mkdirSync(out, { recursive: true })
  for (const voice of IRODORI_TTS_VOICE_IDS) {
    const reference = path.join(references, `voice-${voice}.wav`)
    run(program, ['--make-voice', modelPath(IRODORI_TTS_MODEL.model), modelPath(IRODORI_TTS_MODEL.codec), reference, path.join(out, `${voice}.voice.gguf`), '--device', 'cpu'])
  }
})
console.log(`irodori voices: ${IRODORI_TTS_VOICE_IDS.length} files → ${path.relative(root, out)}`)
