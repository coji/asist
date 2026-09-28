import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, extract, requireCommand, run, stampCurrent, withTemporaryDir, writeStamp } from './shared.mjs'

/**
 * Builds the git that ships inside the app on macOS, from the release tarball on kernel.org, into
 * resources/git. ASIST only runs local operations (init, commit, worktree, diff, merge), so the transports,
 * Perl, Python, Tcl/Tk and translations are left out. RUNTIME_PREFIX makes the tree relocatable: git finds
 * libexec/git-core and its templates relative to bin/git, wherever the app is installed.
 */

const VERSION = '2.55.0'
const MODULE = fileURLToPath(import.meta.url)

/** The release tarball the Mac app's git is compiled from, which scripts/release.mjs also publishes. */
export const GIT_SOURCE = {
  version: VERSION,
  file: `git-${VERSION}.tar.xz`,
  url: `https://www.kernel.org/pub/software/scm/git/git-${VERSION}.tar.xz`,
  sha256: '457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357'
}

// The flags keep the build to the system libraries of macOS 14 and later on Apple Silicon.
const FLAGS = [
  'prefix=/',
  'RUNTIME_PREFIX=YesPlease',
  'NO_GETTEXT=YesPlease',
  'NO_PERL=YesPlease',
  'NO_PYTHON=YesPlease',
  'NO_TCLTK=YesPlease',
  'NO_CURL=YesPlease',
  'NO_EXPAT=YesPlease',
  'NO_OPENSSL=YesPlease',
  'NO_INSTALL_HARDLINKS=YesPlease',
  'SKIP_DASHED_BUILT_INS=YesPlease',
  'INSTALL_SYMLINKS=YesPlease',
  'CC=cc',
  'CFLAGS=-O2 -target arm64-apple-macosx14.0',
  'LDFLAGS=-target arm64-apple-macosx14.0'
]

// These serve repositories to other machines, manage large ones (scalar) or complete a shell, which ASIST
// never does.
const UNUSED = [
  'share/perl5',
  'share/gitweb',
  'share/bash-completion',
  'bin/git-shell',
  'bin/git-cvsserver',
  'bin/scalar',
  'libexec/git-core/git-shell',
  'libexec/git-core/git-cvsserver',
  'libexec/git-core/scalar',
  'libexec/git-core/git-daemon',
  'libexec/git-core/git-http-backend',
  'libexec/git-core/git-imap-send'
]

export async function prepareGitMacos({ resources }) {
  const out = path.join(resources, 'git')
  const stamp = path.join(out, 'VERSION')
  if (stampCurrent(stamp, VERSION, MODULE)) return
  requireCommand('cc', 'install Xcode Command Line Tools before building')

  await withTemporaryDir('asist-git-', async (work) => {
    const tarball = path.join(work, GIT_SOURCE.file)
    console.error(`git: fetching git ${VERSION}`)
    await download(GIT_SOURCE.url, tarball, GIT_SOURCE.sha256)
    extract(tarball, work)
    const source = path.join(work, `git-${VERSION}`)

    console.error(`git: compiling git ${VERSION}`)
    const quiet = { stdio: ['ignore', 'ignore', 'inherit'] }
    run('make', ['-C', source, `-j${os.availableParallelism()}`, ...FLAGS], quiet)
    fs.rmSync(out, { recursive: true, force: true })
    run('make', ['-C', source, ...FLAGS, `DESTDIR=${path.resolve(out)}`, 'install'], quiet)
    for (const unused of UNUSED) fs.rmSync(path.join(out, unused), { recursive: true, force: true })
    fs.copyFileSync(path.join(source, 'COPYING'), path.join(out, 'COPYING'))
    writeStamp(stamp, VERSION, MODULE)
  })
}
