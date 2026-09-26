#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { megabytes, treeSize } from './resources/shared.mjs'
import { stepsFor } from './resources/targets.mjs'

/**
 * Prepares what the app runs outside Node before it is started, tested or built: the bundled git and uv,
 * the native helpers and the Electron binary.
 *
 *   node scripts/prepare-resources.mjs <dev|build|test>
 *   node scripts/prepare-resources.mjs check --platform <win32|darwin> --arch <x64|arm64>
 *
 * check fetches, verifies and unpacks the downloaded tools of any supported platform into a new temporary
 * folder, and leaves the folder there to be looked at; it never writes into resources/.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`check needs ${name}`)
  return args[index + 1]
}

async function main(args) {
  const [purpose] = args
  if (purpose === 'check') {
    const platform = option(args, '--platform')
    const arch = option(args, '--arch')
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-resources-check-'))
    for (const step of stepsFor('check', platform, arch)) await step({ root, resources, platform, arch })
    for (const tool of fs.readdirSync(resources)) {
      const { files, bytes } = treeSize(path.join(resources, tool))
      console.log(`${tool}: ${files} files, ${megabytes(bytes)}`)
    }
    console.log(`unpacked into ${resources}`)
    return
  }
  if (args.length !== 1) throw new Error('usage: prepare-resources.mjs <dev|build|test> | check --platform <platform> --arch <arch>')
  const context = { root, resources: path.join(root, 'resources'), platform: process.platform, arch: process.arch }
  for (const step of stepsFor(purpose, process.platform, process.arch)) await step(context)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`prepare-resources: ${error.message}`)
  process.exitCode = 1
})
