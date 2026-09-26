import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, filesBelow, megabytes, stampCurrent, treeSize, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Puts MinGit, the git that Git for Windows publishes for bundling into applications, into resources/git.
 * The app runs mingw64/bin/git.exe. Building git on Windows needs the MSYS2 toolchain, and MinGit is that
 * build with the MSYS2 runtime and the sh its shell scripts and hooks run in.
 */

const VERSION = '2.55.0.windows.5'
const MODULE = fileURLToPath(import.meta.url)
const ASSET = 'MinGit-2.55.0.5-64-bit.zip'
const SHA256 = '56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e'

/**
 * What ASIST never runs, relative to the MinGit folder: a path removes that file or folder, a pattern every
 * file it matches. ASIST's git only works on local repositories, like the macOS build without curl. Each
 * entry has to match something, so a MinGit that moved one stops the preparation until the list is
 * reviewed. sh, the coreutils, the scripts in libexec/git-core and the licenses stay.
 */
export const UNUSED = [
  // Git Credential Manager and the .NET, Avalonia and MSAL libraries only it loads.
  'mingw64/bin/git-credential-manager.exe',
  'mingw64/bin/git-credential-manager.exe.config',
  'mingw64/bin/git-credential-helper-selector.exe',
  'mingw64/bin/gcmcore.dll',
  'mingw64/bin/av_libglesv2.dll',
  'mingw64/bin/msalruntime.dll',
  /^mingw64\/bin\/(Atlassian|Avalonia|GitHub|GitLab|MicroCom|Microsoft|System)(\..+)?\.dll$/,
  /^mingw64\/bin\/(lib)?(HarfBuzzSharp|SkiaSharp)\.dll$/,
  'mingw64/doc',
  // The transports to remote repositories.
  'mingw64/bin/git-remote-http.exe',
  'mingw64/bin/git-remote-https.exe',
  'mingw64/bin/git-http-fetch.exe',
  'mingw64/bin/git-http-push.exe',
  'usr/bin/ssh.exe',
  'usr/bin/ssh-add.exe',
  'usr/bin/ssh-agent.exe',
  'usr/lib/ssh',
  'etc/ssh',
  // Large repositories, the updater of an installed Git for Windows, shell completion and the manuals.
  'cmd/scalar.exe',
  'mingw64/bin/scalar.exe',
  'mingw64/bin/git-update-git-for-windows',
  'mingw64/share/bash-completion',
  'mingw64/share/doc',
  'usr/share/nano'
]

/** Whether an entry of UNUSED covers file, a path relative to the MinGit folder with / between the parts. */
export function matchesUnused(entry, file) {
  return typeof entry === 'string' ? file === entry || file.startsWith(`${entry}/`) : entry.test(file)
}

/** The files among files that the entries of unused remove. An entry that matches nothing throws. */
export function unusedFiles(files, unused) {
  const removed = new Set()
  for (const entry of unused) {
    const matches = files.filter((file) => matchesUnused(entry, file))
    if (matches.length === 0) throw new Error(`MinGit ${VERSION} has nothing at ${entry}; review the parts that are removed`)
    for (const file of matches) removed.add(file)
  }
  return [...removed].sort()
}

export async function prepareGitWindows({ resources }) {
  const out = path.join(resources, 'git')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return

  await withTemporaryDir('asist-mingit-', async (work) => {
    const zip = path.join(work, ASSET)
    console.error(`git: fetching ${ASSET}`)
    await download(`https://github.com/git-for-windows/git/releases/download/v${VERSION}/${ASSET}`, zip, SHA256)
    fs.rmSync(out, { recursive: true, force: true })
    extract(zip, out)
    const unpacked = treeSize(out)
    for (const file of unusedFiles(filesBelow(out), UNUSED)) fs.rmSync(path.join(out, ...file.split('/')))
    removeEmptyFolders(out)
    const kept = treeSize(out)
    console.error(
      `git: unpacked ${unpacked.files} files (${megabytes(unpacked.bytes)}), kept ${kept.files} (${megabytes(kept.bytes)})`
    )
    writeStamp(stamp, VERSION, MODULE)
  })
}

function removeEmptyFolders(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    removeEmptyFolders(child)
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child)
  }
}
