#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Writes build/THIRD_PARTY_NOTICES.txt, which electron-builder puts into the app's resources folder next to
 * LICENSE.txt: ASIST's own license, the programs bundled beside the app, and the license of every npm
 * package that reaches the app. Those packages are the ones electron-vite put into a bundle
 * (the bundled-packages-*.json files the plugin in electron.vite.config.ts adds to out/) and the
 * production dependencies that stay in node_modules inside app.asar. It runs after every `npm run build`.
 */

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

/** The license a package.json declares, in the forms npm has accepted over the years, or null. */
export function declaredLicense(manifest) {
  const { license, licenses } = manifest
  if (typeof license === 'string' && license.trim()) return license.trim()
  if (license && typeof license.type === 'string') return license.type
  if (Array.isArray(licenses) && licenses.length > 0) return licenses.map((one) => (typeof one === 'string' ? one : one.type)).join(' OR ')
  return null
}

/** The license and notice files at the top of a package's folder, sorted by name. */
export function licenseFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** The folders of the production packages package-lock.json installs, the ones that go into app.asar. */
export function productionPackageDirs(lock, root) {
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([key]) => path.join(root, key))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
}

/**
 * One section for each package, name@version once however many copies are installed. A package that
 * declares no license stops the build, since nothing could be shipped for it.
 */
export function packageSections(dirs) {
  const seen = new Map()
  const undeclared = []
  for (const dir of dirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    // Some packages carry a package.json in a subfolder only to mark its module type; it names nothing.
    if (!manifest.name) continue
    const id = `${manifest.name}@${manifest.version}`
    if (seen.has(id)) continue
    const license = declaredLicense(manifest)
    if (!license) {
      undeclared.push(id)
      continue
    }
    const files = licenseFiles(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim())
    seen.set(id, { id, license, files })
  }
  if (undeclared.length > 0) throw new Error(`These packages declare no license: ${undeclared.join(', ')}`)
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

const RULE = '-'.repeat(78)

/**
 * Where the licenses of the programs bundled beside the app are, from the resources folder the notices are
 * in, for each platform the app is built for. electron-builder moves Electron's license files into the
 * resources folder only on macOS and leaves them next to ASIST.exe on Windows. The git of macOS is built
 * from source and carries its COPYING; MinGit carries the same text as LICENSE.txt, and the licenses of the
 * MSYS2 and MinGW libraries it runs with in two folders of their own.
 */
const BUNDLED_PROGRAMS = {
  darwin: [
    'Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html in this folder.',
    'Git (GPL-2.0): see git/COPYING in this folder. The source code of the same version is attached to',
    '  each release at https://github.com/nyosegawa/asist/releases.',
    'uv (MIT or Apache-2.0): see uv/LICENSE-MIT and uv/LICENSE-APACHE in this folder.',
    'llama.cpp (MIT): see llama.cpp/LICENSE in this folder.',
    'speech.cpp (MIT): see speech-worker/LICENSE in this folder.'
  ],
  win32: [
    'Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html next to ASIST.exe, in the',
    '  folder above this one.',
    'Git (GPL-2.0): see git/LICENSE.txt in this folder, and the licenses of the libraries it runs with in',
    '  git/mingw64/share/licenses and git/usr/share/licenses. The source code of the same version is',
    '  attached to each release at https://github.com/nyosegawa/asist/releases.',
    'uv (MIT or Apache-2.0): see uv/LICENSE-MIT and uv/LICENSE-APACHE in this folder.',
    'llama.cpp (MIT): see llama.cpp/LICENSE in this folder, and llama.cpp/LICENSE-LLVM-OpenMP for the',
    '  OpenMP runtime it runs with.',
    'speech.cpp (MIT): see speech-worker/LICENSE in this folder.'
  ]
}

/** The whole text of the notices file of the app for platform. */
export function renderNotices(ownLicense, sections, platform) {
  const programs = BUNDLED_PROGRAMS[platform]
  if (!programs) throw new Error(`ASIST is built for darwin and win32, not ${platform}, so its bundled programs are unknown`)
  const lines = [
    'ASIST',
    '',
    ownLicense.trim(),
    '',
    RULE,
    'Programs bundled with ASIST',
    RULE,
    '',
    ...programs,
    '',
    RULE,
    'npm packages',
    RULE
  ]
  for (const section of sections) {
    lines.push('', `${section.id} (${section.license})`)
    if (section.files.length === 0) lines.push('', '(The package ships no license file; its license is named above.)')
    for (const text of section.files) lines.push('', text)
    lines.push('', RULE)
  }
  return `${lines.join('\n')}\n`
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const bundled = fs
    .readdirSync(path.join(root, 'out'), { recursive: true })
    .filter((name) => /(^|[\\/])bundled-packages-[^\\/]+\.json$/.test(name))
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(root, 'out', name), 'utf8')))
  if (bundled.length === 0) throw new Error('out/ lists no bundled packages; run electron-vite build first')
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const sections = packageSections([...bundled, ...productionPackageDirs(lock, root)])
  // The bundled programs are prepared for the machine that builds, and scripts/before-pack.mjs lets
  // electron-builder package the app only for that machine's platform.
  const text = renderNotices(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), sections, process.platform)
  fs.writeFileSync(path.join(root, 'build', 'THIRD_PARTY_NOTICES.txt'), text)
  console.log(`third-party notices: ${sections.length} packages → build/THIRD_PARTY_NOTICES.txt`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
