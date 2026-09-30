import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireCommand, run, upToDate } from './shared.mjs'

/**
 * Builds the Swift helpers in resources/native/macos: asist-mic, which captures the microphone through
 * voice processing. A helper older than its sources or than this module is built again.
 */

// swiftc would build for the macOS of its SDK; the target is the arm64 macOS 14 that electron-builder.yml supports.
const TARGET = ['-target', 'arm64-apple-macosx14.0', '-O']

export function prepareNativeMacos({ resources }) {
  const dir = path.join(resources, 'native', 'macos')
  const module = fileURLToPath(import.meta.url)
  const helpers = [
    { name: 'asist-mic', sources: ['asist-mic.swift'], flags: [] }
  ]
  for (const { name, sources, flags } of helpers) {
    // The helpers used to be built into resources/native itself, which is no longer ignored by Git, so a
    // checkout that built them there would otherwise show them as new files to commit.
    fs.rmSync(path.join(resources, 'native', name), { force: true })
    const out = path.join(dir, name)
    if (upToDate(out, [...sources.map((source) => path.join(dir, source)), module])) continue
    requireCommand('swiftc', 'install Xcode Command Line Tools before building')
    console.error(`native: compiling ${name}`)
    run('swiftc', [...TARGET, ...flags, '-o', out, path.join(dir, `${name}.swift`)])
  }
}
