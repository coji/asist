import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GIT_SOURCE } from './resources/git-macos.mjs'
import { download } from './resources/shared.mjs'

/*
 * Builds the version in package.json from main, signs it with Developer ID, notarizes it and publishes it
 * as a GitHub release: the dmg for a first install, the zip and latest-mac.yml that electron-updater reads,
 * and the source of the git that ships inside the app, which GPL-2.0 asks to be offered from the same
 * place as the binary. The Windows installer, its latest.yml and the source of its Git are built and added
 * to the draft by .github/workflows/windows-release.yml, which this dispatches and waits for before it
 * publishes.
 *
 * Environment: CSC_NAME (the name after "Developer ID Application: " of the signing identity; without it, the
 * only such identity in the keychain)
 * and APPLE_KEYCHAIN_PROFILE (the notarytool profile; asist-notary without it).
 */

const REPOSITORY = 'nyosegawa/asist'
const WINDOWS_WORKFLOW = 'windows-release.yml'
/** What the Windows workflow adds to the draft, besides the source of Git for Windows. */
const WINDOWS_FILES = ['ASIST-Setup-x64.exe', 'ASIST-Setup-x64.exe.blockmap', 'latest.yml']
const WINDOWS_GIT_SOURCE = /^git-for-windows-.+\.tar\.gz$/
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

/**
 * Rewrites the digest of one file listed in latest-mac.yml. Stapling the notarization ticket to the dmg
 * changes its bytes after electron-builder wrote the file.
 */
export function withFileDigest(yml, url, sha512, size) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const entry = new RegExp(`(  - url: ${escaped}\\n    sha512: )\\S+(\\n    size: )\\d+`)
  if (!entry.test(yml)) throw new Error(`latest-mac.yml does not list ${url}`)
  return yml.replace(entry, `$1${sha512}$2${size}`)
}

function gitNote(version) {
  return `The Mac app includes Git ${GIT_SOURCE.version} (GPL-2.0). ${GIT_SOURCE.file} is its source, compiled by [scripts/resources/git-macos.mjs](https://github.com/${REPOSITORY}/blob/v${version}/scripts/resources/git-macos.mjs).`
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
}

function read(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/**
 * The Windows files of a release that are not on the draft yet. The source of Git for Windows is named by the
 * version the workflow bundled, so it is matched by its pattern.
 */
export function missingWindowsFiles(assets) {
  const missing = WINDOWS_FILES.filter((name) => !assets.includes(name))
  if (!assets.some((name) => WINDOWS_GIT_SOURCE.test(name))) missing.push('git-for-windows-<version>.tar.gz')
  return missing
}

/** Dispatches the Windows workflow for the draft and waits for it; a failure leaves the draft unpublished. */
function addWindows(tag, commit) {
  const dispatch = ['workflow', 'run', WINDOWS_WORKFLOW, '--repo', REPOSITORY, '--ref', 'main', '-f', `tag=${tag}`, '-f', `commit=${commit}`]
  console.log(`$ gh ${dispatch.join(' ')}`)
  const dispatched = spawnSync('gh', dispatch, { cwd: root, encoding: 'utf8' })
  const said = `${dispatched.stdout}${dispatched.stderr}`
  process.stdout.write(said)
  if (dispatched.status !== 0) fail(`the Windows workflow could not be started; the draft ${tag} is left as it is`)
  const runId = /\/actions\/runs\/(\d+)/.exec(said)?.[1]
  if (!runId) fail(`gh did not name the run of ${WINDOWS_WORKFLOW}; find it with gh run list --repo ${REPOSITORY} --workflow ${WINDOWS_WORKFLOW}`)
  const rerun = `gh workflow run ${WINDOWS_WORKFLOW} --repo ${REPOSITORY} --ref main -f tag=${tag} -f commit=${commit}`
  const watched = spawnSync('gh', ['run', 'watch', runId, '--repo', REPOSITORY, '--exit-status', '--compact', '--interval', '30'], { cwd: root, stdio: 'inherit' })
  if (watched.status !== 0) {
    fail([
      `the Windows installer was not added. The draft ${tag} is not published, so no user sees it.`,
      `  Read why: gh run view ${runId} --repo ${REPOSITORY} --log-failed`,
      `  When the cause is outside the code (a secret, the runner), run the workflow again and wait for it:`,
      `    ${rerun}`,
      `  and publish once the draft has the Windows files: gh release edit ${tag} --repo ${REPOSITORY} --draft=false --latest`,
      `  When the code has to change, delete the draft (gh release delete ${tag} --repo ${REPOSITORY}), merge the fix and run npm run release again.`
    ].join('\n'))
  }
  const release = JSON.parse(read('gh', ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft,assets']))
  if (!release.isDraft) fail(`${tag} was published while the Windows workflow ran`)
  const missing = missingWindowsFiles(release.assets.map((asset) => asset.name))
  if (missing.length > 0) fail(`the Windows workflow succeeded, but the draft ${tag} lacks ${missing.join(', ')}; run it again: ${rerun}`)
}

function digest(file, algorithm, encoding) {
  return createHash(algorithm).update(fs.readFileSync(file)).digest(encoding)
}

/**
 * electron-builder refuses a name that starts with "Developer ID Application:" and picks that kind of
 * certificate itself, so the identity is named by what follows it.
 */
function developerIdIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME
  const identities = read('security', ['find-identity', '-v', '-p', 'codesigning'])
    .split('\n')
    .map((line) => /"Developer ID Application: ([^"]+)"/.exec(line)?.[1])
    .filter(Boolean)
  const unique = [...new Set(identities)]
  if (unique.length !== 1) {
    fail(`expected one Developer ID Application identity in the keychain, found ${unique.length}; set CSC_NAME`)
  }
  return unique[0]
}

function checkSource(tag) {
  if (read('git', ['branch', '--show-current']) !== 'main') fail('release from main')
  if (read('git', ['status', '--porcelain'])) fail('the working tree has changes')
  run('git', ['fetch', 'origin', 'main'])
  if (read('git', ['rev-parse', 'HEAD']) !== read('git', ['rev-parse', 'origin/main'])) fail('main is not the same as origin/main')
  const existing = spawnSync('gh', ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft,targetCommitish'], { cwd: root, encoding: 'utf8' })
  if (existing.status === 0) fail(existingRelease(tag, JSON.parse(existing.stdout)))
  if (existing.stderr.trim() !== 'release not found') fail(`could not ask GitHub whether ${tag} exists: ${existing.stderr.trim()}`)
}

/**
 * Why a release of tag cannot start, given what gh found under that tag. gh finds a draft as well, and a draft
 * is what a release leaves when it stopped after creating it, typically in the Windows workflow; no user has
 * seen it, so it is finished or deleted rather than the version raised.
 */
export function existingRelease(tag, { isDraft, targetCommitish }) {
  if (!isDraft) return `${tag} is already released; raise the version in package.json`
  return [
    `a draft release of ${tag}, made from ${targetCommitish}, is left from a release that stopped. Either finish it:`,
    `    gh workflow run ${WINDOWS_WORKFLOW} --repo ${REPOSITORY} --ref main -f tag=${tag} -f commit=${targetCommitish}`,
    `  wait for that run, check that the draft has the Windows files and publish it:`,
    `    gh release edit ${tag} --repo ${REPOSITORY} --draft=false --latest`,
    `  or delete it and run npm run release again: gh release delete ${tag} --repo ${REPOSITORY}`
  ].join('\n')
}

/**
 * The map card needs the Maps Embed key at build time; electron-vite reads it from the environment or from
 * .env. A release built without it would ship map cards that never load.
 */
function checkMapsKey() {
  const name = 'RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY'
  const inFile = ['.env', '.env.production'].some((file) => {
    const full = path.join(root, file)
    return fs.existsSync(full) && new RegExp(`^${name}=.+`, 'm').test(fs.readFileSync(full, 'utf8'))
  })
  if (!process.env[name] && !inFile) fail(`${name} is not set; the map cards of the release would not load`)
}

function checkApp(app) {
  run('codesign', ['--verify', '--deep', '--strict', app])
  const signature = spawnSync('codesign', ['-dvv', app], { cwd: root, encoding: 'utf8' }).stderr
  if (!signature.includes('Authority=Developer ID Application')) fail(`${app} is not signed with Developer ID`)
  run('xcrun', ['stapler', 'validate', app])
  const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '-vv', app], { cwd: root, encoding: 'utf8' })
  if (assessment.status !== 0 || !assessment.stderr.includes('Notarized Developer ID')) {
    fail(`Gatekeeper does not accept ${app}:\n${assessment.stderr}`)
  }
  if (!fs.existsSync(path.join(app, 'Contents/Resources/app-update.yml'))) fail(`${app} has no app-update.yml`)
}

async function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const tag = `v${version}`
  checkSource(tag)
  const identity = developerIdIdentity()
  const profile = process.env.APPLE_KEYCHAIN_PROFILE ?? 'asist-notary'
  run('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: 'ignore' })
  checkMapsKey()
  run('npm', ['audit', '--omit=dev'])

  fs.rmSync(dist, { recursive: true, force: true })
  run('npm', ['run', 'build'])
  // Without APPLE_KEYCHAIN_PROFILE electron-builder only warns and skips notarization; it is always set here.
  run('npx', ['electron-builder', '--mac', 'dmg', 'zip', '--arm64', '--publish', 'never'], {
    env: { ...process.env, CSC_NAME: identity, APPLE_KEYCHAIN_PROFILE: profile }
  })

  const app = path.join(dist, 'mac-arm64/ASIST.app')
  const dmg = path.join(dist, 'ASIST-arm64.dmg')
  const zip = path.join(dist, `ASIST-${version}-arm64-mac.zip`)
  checkApp(app)
  // The zip is what electron-updater installs, so the app inside it is checked too, not only the one it was made from.
  const unzipped = fs.mkdtempSync(path.join(dist, 'zip-'))
  run('ditto', ['-x', '-k', zip, unzipped])
  checkApp(path.join(unzipped, 'ASIST.app'))
  fs.rmSync(unzipped, { recursive: true })

  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'])
  run('xcrun', ['stapler', 'staple', dmg])
  run('xcrun', ['stapler', 'validate', dmg])
  const feed = path.join(dist, 'latest-mac.yml')
  const yml = fs.readFileSync(feed, 'utf8')
  fs.writeFileSync(feed, withFileDigest(yml, path.basename(dmg), digest(dmg, 'sha512', 'base64'), fs.statSync(dmg).size))

  const gitTarball = path.join(dist, GIT_SOURCE.file)
  await download(GIT_SOURCE.url, gitTarball, GIT_SOURCE.sha256)

  // The release stays a draft until every file is in place, since electron-updater reads the latest
  // published release and would find it without latest-mac.yml or latest.yml.
  const commit = read('git', ['rev-parse', 'HEAD'])
  run('gh', ['release', 'create', tag, '--repo', REPOSITORY, '--target', commit, '--title', `ASIST ${version}`,
    '--notes', gitNote(version), '--generate-notes', '--draft', dmg, zip, `${zip}.blockmap`, feed, gitTarball])
  addWindows(tag, commit)
  run('gh', ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest'])
  console.log(`released ${tag}: https://github.com/${REPOSITORY}/releases/tag/${tag}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
