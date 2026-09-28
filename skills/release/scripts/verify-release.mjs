#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/*
 * Checks a published release the way a user meets it: downloads the dmg and the update feed from
 * releases/latest, compares the dmg with the digest the feed lists, marks the dmg as downloaded from the
 * internet, and asks Gatekeeper about the app inside it.
 *
 * Usage: node skills/release/scripts/verify-release.mjs <version>
 */

const REPOSITORY = 'nyosegawa/asist'
const LATEST = `https://github.com/${REPOSITORY}/releases/latest/download`

const version = process.argv[2]
if (!version) {
  console.error('usage: verify-release.mjs <version>')
  process.exit(2)
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

async function fetchTo(url, file) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-verify-'))
const mount = path.join(work, 'mnt')
try {
  const feed = await (await fetch(`${LATEST}/latest-mac.yml`)).text()
  check(new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(feed), 'latest-mac.yml names the version', feed.split('\n')[0])

  const dmg = path.join(work, 'ASIST-arm64.dmg')
  await fetchTo(`${LATEST}/ASIST-arm64.dmg`, dmg)
  const listed = /- url: ASIST-arm64\.dmg\n\s+sha512: (\S+)/.exec(feed)?.[1]
  const actual = createHash('sha512').update(fs.readFileSync(dmg)).digest('base64')
  check(listed === actual, 'the dmg matches the digest in latest-mac.yml')

  // A browser sets this attribute on a download, and Gatekeeper only assesses files that carry it.
  const quarantine = `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`
  execFileSync('xattr', ['-w', 'com.apple.quarantine', quarantine, dmg])
  const stapled = spawnSync('xcrun', ['stapler', 'validate', dmg], { encoding: 'utf8' })
  check(stapled.status === 0, 'the dmg carries its notarization ticket')

  fs.mkdirSync(mount)
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { stdio: 'ignore' })
  try {
    const app = path.join(mount, 'ASIST.app')
    const shown = execFileSync('defaults', ['read', path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
    check(shown === version, 'the app inside is the version', shown)
    const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' })
    check(assessment.status === 0 && assessment.stderr.includes('source=Notarized Developer ID'), 'Gatekeeper accepts the app as notarized', assessment.stderr.trim().split('\n').slice(1).join(', '))
    check(fs.existsSync(path.join(app, 'Contents/Resources/app-update.yml')), 'the app looks for updates')
  } finally {
    execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' })
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`${version} is published and passes every check`)
