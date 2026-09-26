import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promptLanguage } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from './conversation-locale'
import { childEnv, removeVariables } from './child-env'
import { resourcePath } from './resource-path'

/**
 * The git operations behind worktree isolation. Every call is a synchronous execFile and a failure throws,
 * leaving the decision to the caller. The user's working tree and index are never touched: only the inside
 * of the worktree, and the branch at merge time.
 */

/**
 * The git that ships in resources/git. The one in /usr/bin only asks to install the Command Line Tools
 * when they are missing, and the memory repository is opened at every start.
 */
export function gitPath(): string {
  return resourcePath(path.join('git', 'bin', 'git'))
}

/**
 * The environment git runs with: the child environment without GIT_ variables, and without the system and
 * user configuration. A user's commit.gpgsign would otherwise make every commit wait for a signature, and
 * a filter such as git-lfs names a program that a Finder launch has no PATH to.
 */
export function gitEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnv({}, parent)
  removeVariables(env, (key) => key.startsWith('GIT_'))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}

interface GitOptions {
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  input?: string
}

function git(cwd: string, args: string[], options: GitOptions = {}): string {
  return execFileSync(gitPath(), args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...gitEnv(), ...options.env },
    windowsHide: true
  })
}

/**
 * The top level of the repository dir sits in, or null when it is not inside one. It is spelled as
 * resolvedAsFarAsExists spells a path, because git writes C:/Users/... on Windows, and a path is compared
 * and stored in that one form.
 */
export function toplevel(dir: string): string | null {
  let top: string
  try {
    top = git(dir, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
  return top ? resolvedAsFarAsExists(top) : null
}

export function headCommit(repo: string, ref = 'HEAD'): string {
  return git(repo, ['rev-parse', '--verify', ref]).trim()
}

/** Makes dir a repository, and does nothing when it already is one. */
export function init(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main'])
}

/** Whether a first commit exists. A worktree is cut from HEAD, so without one it cannot be created. */
export function hasHead(repo: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** The folder of dir within its repository, such as `packages/web`, or an empty string at the top. */
export function pathInRepo(dir: string): string {
  return git(dir, ['rev-parse', '--show-prefix']).trim().replace(/\/$/, '')
}

/**
 * Cuts a branch for the job from HEAD and creates a worktree on it. When git fails after it has created
 * them, both are removed again before its error is thrown: git keeps the worktree when only its
 * post-checkout hook fails, as the hook of Git LFS does when an app opened from Finder has no git-lfs on
 * its PATH, and it never deletes the branch.
 */
export function worktreeAdd(repo: string, path: string, branch: string): void {
  git(repo, ['branch', branch, 'HEAD'])
  try {
    git(repo, ['worktree', 'add', path, branch])
  } catch (error) {
    try {
      const created = worktreeOn(repo, branch)
      if (created) git(repo, ['worktree', 'remove', '--force', created])
      git(repo, ['branch', '-D', branch])
    } catch (cleanupError) {
      console.error('cannot remove the worktree git left behind:', path, cleanupError)
    }
    throw error
  }
}

/** The worktrees git has registered for repo, the main one included, with the branch each has checked out. */
function listWorktrees(repo: string): Array<{ path: string; branch?: string }> {
  const worktrees: Array<{ path: string; branch?: string }> = []
  for (const line of git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length) })
    else if (line.startsWith('branch refs/heads/')) worktrees[worktrees.length - 1].branch = line.slice('branch refs/heads/'.length)
  }
  return worktrees
}

/** The path of the worktree that has the branch checked out, or null when none has. */
function worktreeOn(repo: string, branch: string): string | null {
  return listWorktrees(repo).find((worktree) => worktree.branch === branch)?.path ?? null
}

/**
 * The absolute path with its symbolic links resolved as far as it exists, and those names spelled as the
 * disk stores them, which is how git records a worktree and finds one by its path: one made under /tmp is
 * listed under /private/tmp on macOS, and a worktree's folder may be gone. Two spellings of one folder
 * come out the same, such as git's C:/Users/... and a folder written in another letter case on Windows.
 */
export function resolvedAsFarAsExists(file: string): string {
  const missing: string[] = []
  let existing = path.resolve(file)
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  // fs.realpathSync keeps a name as it was written, such as a Windows short name like RUNNER~1, while the
  // native call returns the name the disk stores.
  return path.join(fs.realpathSync.native(existing), ...missing)
}

/**
 * Removes the worktree and its branch together with whatever the worktree still holds. git refuses to
 * remove a worktree in which a submodule was initialized unless it is forced, so a caller removes one only
 * when nothing in it is left to lose: its changes are merged, there were none, or the user threw them away.
 * `worktree remove --force` also forgets a worktree whose folder was deleted by hand, and refuses one that git
 * no longer lists, as after a prune by the user or by gc, so only such a worktree is left alone before its
 * branch goes. A repository-wide `worktree prune` is never run: it would also forget the user's own worktrees
 * whose folders are missing at that moment, such as one on an external disk that is not mounted.
 */
export function worktreeRemove(repo: string, dir: string, branch: string): void {
  const target = resolvedAsFarAsExists(dir)
  const listed = listWorktrees(repo).some((worktree) => resolvedAsFarAsExists(worktree.path) === target)
  // A folder git does not list is not left behind in silence: git refuses to remove it and says why.
  if (listed || fs.existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir])
  git(repo, ['branch', '-D', branch])
}

const GITMODULES = '.gitmodules'
const SUBMODULE_MODE = '160000'

/** A pathspec that names exactly this path and whatever lies under it. */
const literal = (file: string): string => `:(literal)${file}`

/**
 * For output that grows with the number of changed paths. A job that adds a large package passes the default
 * 4 MB, and git would then be stopped on every attempt to settle the job: 14,000 new paths of 200 characters
 * made a raw diff of 4.4 MB (2026-09-26).
 */
const WHOLE = { maxBuffer: Infinity }

/**
 * What ASIST reads to settle, review or merge a job is the exact change, whatever the repository's settings
 * for showing changes say, and only the command line overrides those. `submodule.<name>.ignore` in .gitmodules
 * or the configuration, and `diff.ignoreSubmodules`, hide a moved submodule from git diff and git status, so
 * a job that only moved one looked unchanged and its worktree was removed with the only copy of the commit;
 * `status.showUntrackedFiles=no` hides new files the same way; and `diff.external`, a textconv driver or
 * `color.diff` replace what git diff prints, so the patch under review would not be the change.
 */
const EXACT_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none']
const EXACT_STATUS = ['--untracked-files=normal', '--ignore-submodules=none']

/**
 * The options of every command that reads the files of a working tree to tell what changed on disk: the job's
 * worktree before it is committed, and the user's working tree before a merge. The repository's configuration
 * can let git skip the files. core.ignoreStat makes git mark each file it checks out or adds as
 * assume-unchanged and stop looking at it, so ASIST's own add would hide the files again; a fsmonitor hook
 * that misses an event hides a changed or a new file; and core.checkStat=minimal or core.trustctime=false
 * leave out the ctime, so an edit in place that keeps the size and puts the mtime back, as `touch -r`,
 * `cp -p` and `rsync -a` do, looks unchanged. A job whose edit is hidden settles as unchanged and its
 * worktree is removed with the edit, and a fast-forward over an edit of the user's that is hidden overwrites
 * it. With --no-optional-locks, status does not write the index it refreshed, so a read changes neither the
 * user's index nor the job's.
 */
const ON_DISK = [
  '--no-optional-locks',
  '-c', 'core.ignoreStat=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.checkStat=default',
  '-c', 'core.trustctime=true'
]

function onDisk(dir: string, args: string[], options: GitOptions = {}): string {
  return git(dir, [...ON_DISK, ...args], options)
}

/**
 * Stages everything as it is on disk. Without --sparse, add refuses a file outside a sparse checkout, a new
 * one or one the agent brought back, and the commit fails; with it, a file that is outside and absent keeps
 * its skip-worktree and is not staged as deleted.
 */
const ADD_ALL = ['add', '-A', '--sparse']

const nulTerminated = (paths: Iterable<string>): string => [...paths].map((file) => `${file}\0`).join('')

/**
 * Whether anything is at a path of the index of dir, a link or an empty folder included, without following a
 * link at its end. Any failure of lstat counts as absent, as it does when git decides which files a sparse
 * checkout leaves out; a symbolic link that loops where a folder was, or a folder without search permission,
 * would otherwise stop every settle and review. A folder is looked at once for all the paths under it, since
 * a sparse worktree leaves out most of the files: for the 99,900 files left out of a checkout of 100 out of
 * 100,000, an lstat of each took 108 ms and this takes 6 ms (Apple M5, 2026-09-27).
 */
function presenceIn(dir: string): (file: string) => boolean {
  const folders = new Map<string, boolean>([['.', true]])
  const present = (file: string): boolean => {
    try {
      return fs.lstatSync(path.join(dir, file), { throwIfNoEntry: false }) !== undefined
    } catch {
      return false
    }
  }
  const folder = (name: string): boolean => {
    let known = folders.get(name)
    if (known === undefined) {
      known = folder(path.posix.dirname(name)) && present(name)
      folders.set(name, known)
    }
    return known
  }
  return (file) => folder(path.posix.dirname(file)) && present(file)
}

/**
 * The changes to the flags of an index that let status and add see the files of dir as they are on disk: the
 * entries that lose assume-unchanged, those that lose skip-worktree, and those that get skip-worktree back.
 */
interface FlagChanges {
  assumeUnchanged: string[]
  skipWorktree: string[]
  leftOutAgain: string[]
}

/** What revealFiles changed in the index, and every file the sparse checkout leaves out. */
interface Revealed extends FlagChanges {
  leftOut: string[]
}

/** The first few of paths, for a message. */
const named = (paths: string[]): string => paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', …' : '')

/**
 * Whether git applies a sparse checkout in dir: it is on and the file of its patterns is there. git skips a
 * sparse checkout whose file of patterns is gone, and check-rules then fails.
 */
function sparseCheckoutOn(dir: string): boolean {
  if (git(dir, ['config', '--type=bool', '--default=false', 'core.sparseCheckout']).trim() !== 'true') return false
  return fs.existsSync(path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'info/sparse-checkout']).trim()))
}

/** Those of paths that the patterns of dir's sparse checkout include. */
function includedBySparse(dir: string, paths: string[]): string[] {
  if (paths.length === 0) return []
  return git(dir, ['sparse-checkout', 'check-rules', '-z'], { ...WHOLE, input: nulTerminated(paths) }).split('\0').filter(Boolean)
}

/**
 * Changes the flags of the index env names so that status and add see every file of dir as it is on disk,
 * and refuses an index in which an absent file cannot be told apart from a deleted one. The index is a copy:
 * a read never writes the job's index, and a commit makes the same changes in it only as it brings it up to
 * the commit.
 *
 * A file that is present counts as it is, so both flags go from it. Assume-unchanged is only a hint that
 * spares git a look at the file, so it goes from an absent file as well. An absent file that the sparse
 * checkout leaves out never counts as deleted and keeps what the index has staged for it: it keeps
 * skip-worktree, the flag with which a sparse checkout marks the files it leaves out, and gets it back when
 * a command of the agent's such as `apply --cached`, `restore --staged` or `read-tree` staged the file
 * without it, since add would otherwise stage its deletion. The agent cannot then delete such a file by
 * removing it from disk, only by `rm --sparse`. Any other absent file with skip-worktree was either deleted
 * behind the flag or never checked out, because the agent or the user turned the sparse checkout off or
 * changed its patterns without reapplying them, and it is refused.
 *
 * Reading a worktree of 100,000 files this way, on a copy of its index, took 144 ms against 112 ms for a
 * status alone, and 93 ms against 12 ms in a sparse checkout of 100 of them. While core.ignoreStat keeps all
 * 100,000 marked, until the first commit clears them in the index, it took 210 to 309 ms in two runs
 * (bundled git 2.55, Apple M5, 2026-09-27).
 */
function revealFiles(dir: string, env: NodeJS.ProcessEnv): Revealed {
  const assumeUnchanged: string[] = []
  const skipped = new Set<string>()
  // With -v, ls-files tags an entry with skip-worktree S, and writes the tag in lower case when the entry is
  // assume-unchanged. An unmerged entry is tagged M whatever its flags, and add replaces all its stages with
  // the file on disk.
  for (const entry of onDisk(dir, ['ls-files', '-v', '-z'], { ...WHOLE, env }).split('\0')) {
    const tag = entry[0]
    if (tag === 'h' || tag === 's') assumeUnchanged.push(entry.slice(2))
    if (tag === 'S' || tag === 's') skipped.add(entry.slice(2))
  }
  const present = presenceIn(dir)
  const skipWorktree: string[] = []
  const absent: string[] = []
  for (const file of skipped) (present(file) ? skipWorktree : absent).push(file)
  const sparse = sparseCheckoutOn(dir)
  const unexplained = sparse ? includedBySparse(dir, absent) : absent
  if (unexplained.length > 0) throw new Error(errorText('jobs.worktree.skippedMissing', { paths: named(unexplained), dir }))
  applyFlagChanges(dir, { assumeUnchanged, skipWorktree, leftOutAgain: [] }, env)
  let leftOutAgain: string[] = []
  if (sparse) {
    // With the flags cleared, diff-files names every entry without skip-worktree whose file is absent.
    const missing = onDisk(dir, ['diff-files', '--name-only', '-z', '--diff-filter=D'], { ...WHOLE, env }).split('\0').filter(Boolean)
    const included = new Set(includedBySparse(dir, missing))
    leftOutAgain = missing.filter((file) => !included.has(file))
    applyFlagChanges(dir, { assumeUnchanged: [], skipWorktree: [], leftOutAgain }, env)
  }
  return { assumeUnchanged, skipWorktree, leftOutAgain, leftOut: [...absent, ...leftOutAgain] }
}

function applyFlagChanges(dir: string, changes: FlagChanges, env?: NodeJS.ProcessEnv): void {
  const update = (option: string, paths: string[]): void => {
    if (paths.length > 0) onDisk(dir, ['update-index', '-z', option, '--stdin'], { env, input: nulTerminated(paths) })
  }
  update('--no-assume-unchanged', changes.assumeUnchanged)
  update('--no-skip-worktree', changes.skipWorktree)
  update('--skip-worktree', changes.leftOutAgain)
}

/**
 * Runs read with a copy of dir's index, in a folder of its own, named by GIT_INDEX_FILE in the environment it
 * is given. The copy keeps the time the index was written: git takes a file changed since then within the
 * same second for possibly changed, and a copy made later would make such a file look unchanged.
 */
function withIndexCopy<T>(dir: string, read: (env: NodeJS.ProcessEnv) => T): T {
  const index = path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']).trim())
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'asist-index-'))
  try {
    const copy = path.join(scratch, 'index')
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, copy)
      const { atime, mtime } = fs.statSync(index)
      fs.utimesSync(copy, atime, mtime)
    }
    return read({ GIT_INDEX_FILE: copy })
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Commits every uncommitted change in dir as it is on disk, and returns false when there is nothing to
 * commit.
 *
 * The commit is built by write-tree and commit-tree from a copy of the index in a folder of its own, so no
 * hook of the repository runs and ASIST holds no lock of the repository between git's commands: git commit
 * runs prepare-commit-msg even with --no-verify, and a lock left by a crash would stop every later commit.
 * The index is brought up to the commit by git itself once the branch has moved, and when that fails the
 * branch goes back. A commit that fails therefore leaves the branch as it was and every entry of the index
 * with what it had staged; only the flags revealFiles changes may differ.
 */
export function commitAll(dir: string, message: string): boolean {
  return withIndexCopy(dir, (env) => {
    const revealed = revealFiles(dir, env)
    if (onDisk(dir, ['status', '--porcelain', ...EXACT_STATUS], { ...WHOLE, env }).trim() === '') return false
    const head = hasHead(dir) ? headCommit(dir) : null
    onDisk(dir, ADD_ALL, { env })
    const tree = onDisk(dir, ['write-tree'], { env }).trim()
    if (head && revealed.leftOut.length > 0) {
      // add replaces the entries under a path with a file or a link the agent put there, so a file where a
      // folder the sparse checkout leaves out belongs would delete the files that are not checked out.
      const deleted = new Set(git(dir, ['diff-tree', '-r', '-z', '--name-only', '--diff-filter=D', head, tree], WHOLE).split('\0'))
      const replaced = revealed.leftOut.filter((file) => deleted.has(file))
      if (replaced.length > 0) throw new Error(errorText('jobs.worktree.leftOutReplaced', { paths: named(replaced), dir }))
    }
    const bringIndexUp = (): void => {
      applyFlagChanges(dir, revealed)
      onDisk(dir, ADD_ALL)
    }
    if (head && tree === git(dir, ['rev-parse', `${head}^{tree}`]).trim()) {
      // Nothing is left to commit, but the index can still disagree with HEAD: a change staged and then
      // undone on disk, or a commit whose index was never brought up to it before a crash. Left so, the
      // job would never count as settled.
      bringIndexUp()
      return false
    }
    const commit = git(dir, [
      '-c', 'user.name=ASIST', '-c', 'user.email=asist@localhost', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message
    ]).trim()
    git(dir, ['update-ref', '-m', message, 'HEAD', commit, head ?? ''])
    try {
      bringIndexUp()
    } catch (error) {
      git(dir, head ? ['update-ref', 'HEAD', head, commit] : ['update-ref', '-d', 'HEAD', commit])
      throw error
    }
    return true
  })
}

interface RawEntry {
  path: string
  oldMode: string
  newMode: string
}

/** The entries of a raw diff made with -z and --no-renames, where a field of modes and ids is followed by a field with the path. */
function rawEntries(raw: string): RawEntry[] {
  const fields = raw.split('\0')
  const entries: RawEntry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode] = fields[i].slice(1).split(' ')
    entries.push({ path: fields[i + 1], oldMode, newMode })
  }
  return entries
}

/**
 * The submodules the changes from base to commit touch, with .gitmodules when it changed: a submodule moved
 * to another commit, added or removed, or a path turned into a submodule or out of one.
 */
export function submoduleEntryChanges(repo: string, base: string, commit: string): string[] {
  return rawEntries(git(repo, ['diff', ...EXACT_DIFF, '--raw', '-z', '--no-renames', base, commit], WHOLE))
    .filter((entry) => entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE || entry.path === GITMODULES)
    .map((entry) => entry.path)
}

/**
 * The submodules of dir that may hold work no commit of dir carries, which is deleted with the worktree: one
 * whose folder holds anything, or whose repository is kept in the worktree's git folder. In a new worktree
 * the folder of a submodule is empty, so anything in it was put there by the job: its repository after an
 * init, or files written into it, which git status does not show while the submodule is not initialized. The
 * repository of a submodule initialized in a worktree lives in the worktree's git folder and outlasts a
 * `deinit`. Whether its commits exist anywhere else cannot be told from here, since a tag, a shallow clone or
 * a branch deleted upstream look the same as a commit made by the job, so any such repository counts.
 * Changes that git status shows, such as a staged move of a submodule, count as well.
 */
export function submodulesWithWork(dir: string): string[] {
  const found = new Set<string>()
  const submodules = gitlinks(dir)
  if (submodules.length > 0) {
    // With -z an entry of the second porcelain format is one field, and its path is all that follows the
    // fixed fields, spaces included. Without renames no entry carries a second path.
    const fixedFields: Record<string, number> = { '1': 8, u: 10 }
    const status = onDisk(dir, ['status', '--porcelain=v2', '-z', '--no-renames', ...EXACT_STATUS, '--', ...submodules.map(literal)], WHOLE)
    for (const entry of status.split('\0')) {
      const count = fixedFields[entry[0]]
      if (count === undefined) continue
      const fields = entry.split(' ')
      if (fields[2].startsWith('S')) found.add(fields.slice(count).join(' '))
    }
    for (const file of submodules) if (holdsAnything(path.join(dir, file))) found.add(file)
  }
  const modules = moduleRepositories(dir)
  if (modules.length > 0) {
    const paths = submodulePaths(dir)
    for (const name of modules) found.add(paths.get(name) ?? name)
  }
  return [...found].sort()
}

/**
 * The paths of the submodule entries in dir's index. .gitmodules does not list a repository that was added
 * without `git submodule add`, and can still name a path that holds ordinary files by now, so the index,
 * which git itself reads, is what counts. Listing it took a median of 19 ms for 100,000 entries, an output
 * of 8.3 MB, with the bundled git 2.55 on an Apple M5 (2026-09-26).
 */
function gitlinks(dir: string): string[] {
  return onDisk(dir, ['ls-files', '--stage', '-z'], WHOLE)
    .split('\0')
    .filter((entry) => entry.startsWith(`${SUBMODULE_MODE} `))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
}

function holdsAnything(folder: string): boolean {
  try {
    return fs.readdirSync(folder).length > 0
  } catch (error) {
    // A folder that is gone or replaced by a file shows in git status already.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * The names of the submodule repositories kept in the git folder of the worktree dir, under `modules/`. A
 * name may hold slashes, so folders are looked into until one that is a repository, whose own `modules/`
 * belongs to it.
 */
function moduleRepositories(dir: string): string[] {
  const root = path.join(git(dir, ['rev-parse', '--absolute-git-dir']).trim(), 'modules')
  const names: string[] = []
  const walk = (folder: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (entries.some((entry) => entry.name === 'HEAD' && entry.isFile())) {
      names.push(path.relative(root, folder).split(path.sep).join('/'))
      return
    }
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(folder, entry.name))
  }
  walk(root)
  return names
}

/** The path of each submodule by its name, as the .gitmodules of dir gives them. */
function submodulePaths(dir: string): Map<string, string> {
  const paths = new Map<string, string>()
  const file = path.join(dir, GITMODULES)
  if (!fs.existsSync(file)) return paths
  let listed: string
  try {
    listed = git(dir, ['config', '--file', file, '--null', '--get-regexp', '^submodule\\..*\\.path$'])
  } catch (error) {
    // config exits with 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return paths
    throw error
  }
  // With --null each entry is the key, a newline and the value.
  for (const entry of listed.split('\0')) {
    const newline = entry.indexOf('\n')
    if (newline < 0) continue
    paths.set(entry.slice('submodule.'.length, newline - '.path'.length), entry.slice(newline + 1))
  }
  return paths
}

/**
 * Whether dir holds no change that commitAll would commit, new files included whatever
 * status.showUntrackedFiles says, and files the index was told not to look at as well. It does not look
 * inside submodules, whose changes no commit of dir carries and which submodulesWithWork finds instead.
 */
export function isSettled(dir: string): boolean {
  return withIndexCopy(dir, (env) => {
    revealFiles(dir, env)
    return onDisk(dir, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], { ...WHOLE, env }).trim() === ''
  })
}

/**
 * The commit a merge of `commit` into the repository's HEAD starts from, or null when they share no history,
 * as with a branch made by `checkout --orphan`, or when HEAD has no commit yet.
 */
export function mergeBase(repo: string, commit: string): string | null {
  if (!hasHead(repo)) return null
  try {
    return git(repo, ['merge-base', 'HEAD', commit]).trim()
  } catch (error) {
    // merge-base exits with 1 and prints nothing when the two have no common ancestor.
    if ((error as { status?: number }).status === 1) return null
    throw error
  }
}

/**
 * The branch checked out in repo, which a merge moves, or null when HEAD is not on a branch: detached, as
 * during a bisect, at a stop of a rebase or after checking out a tag, or pointing outside refs/heads. The
 * full name is read, since the short one of a branch that shares its name with a tag is `heads/<name>`.
 */
export function checkedOut(repo: string): string | null {
  let ref: string
  try {
    ref = git(repo, ['symbolic-ref', '--quiet', 'HEAD']).trim()
  } catch (error) {
    // With --quiet, symbolic-ref exits with 1 and prints nothing when HEAD is detached.
    if ((error as { status?: number }).status === 1) return null
    throw error
  }
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
}

/** Whether anything changed from base to commit. */
export function hasChanges(repo: string, base: string, commit: string): boolean {
  try {
    git(repo, ['diff', ...EXACT_DIFF, '--quiet', base, commit])
    return false
  } catch (error) {
    if ((error as { status?: number }).status === 1) return true
    throw error
  }
}

/**
 * A summary of the changes from base to commit, listing at most the first 500 files before its total line.
 * An empty string means nothing changed.
 */
export function diffStat(repo: string, base: string, commit: string): string {
  return git(repo, ['diff', ...EXACT_DIFF, '--stat', '--stat-count=500', base, commit]).trim()
}

export interface DiffEntry {
  path: string
  /** The git file mode after the change, such as 100644, 120000 for a symbolic link, or 000000 for a deletion. */
  mode: string
  /** Whether the path did not exist at base. */
  added: boolean
}

/** Every path the changes from base to commit touch, with its mode afterwards. Renames count as a deletion and an addition. */
export function diffEntries(repo: string, base: string, commit: string): DiffEntry[] {
  return rawEntries(git(repo, ['diff', ...EXACT_DIFF, '--raw', '-z', '--no-renames', base, commit], WHOLE))
    .map((entry) => ({ path: entry.path, mode: entry.newMode, added: entry.oldMode === '000000' }))
}

/**
 * The diff from base to commit, cut at the limit. git is stopped once its output passes four bytes for each
 * character kept, so a diff of any size is read only that far; a character takes at most three bytes of
 * UTF-8, so what was read always reaches past the limit. The note on the cut is part of the patch, which the
 * merge view shows and the LLM reads in get_agent_job, so it is written in the language of the conversation.
 */
export function diffPatch(repo: string, base: string, commit: string, maxChars = 60_000): string {
  let patch: string
  try {
    patch = git(repo, ['diff', ...EXACT_DIFF, base, commit], { maxBuffer: maxChars * 4 })
  } catch (error) {
    // Node ends git with ENOBUFS at the buffer's size and hands over the output read until then.
    const cut = error as NodeJS.ErrnoException & { stdout?: unknown }
    if (cut.code !== 'ENOBUFS' || typeof cut.stdout !== 'string') throw error
    patch = cut.stdout
  }
  if (patch.length <= maxChars) return patch
  const note = {
    ja: '(以下省略。全文は worktree のブランチにある)',
    en: '(cut here; the whole patch is on the branch in the worktree)'
  }[promptLanguage(conversationLocale())]
  return `${patch.slice(0, maxChars)}\n…${note}`
}

export type MergeOutcome = { ok: true } | { ok: false; conflict: boolean; message: string }

const firstLines = (text: string): string => text.trim().split('\n').slice(0, 5).join('\n')

/**
 * Merges the branch into the user's repository as a merge commit. The commit is made by merge-tree and
 * commit-tree, which touch neither the working tree nor the index, and the working tree then moves to it
 * only by a fast-forward. git merge would stop half done in them on a conflict or when a hook of the
 * user's, such as a commit-msg hook that rejects the message, fails, and a later git commit of the user's
 * would then commit changes nobody reviewed.
 */
export function mergeNoFf(repo: string, branch: string, message: string): MergeOutcome {
  const head = headCommit(repo)
  const incoming = headCommit(repo, branch)
  let tree: string
  try {
    tree = git(repo, ['merge-tree', '--write-tree', '--name-only', head, incoming]).split('\n')[0]
  } catch (error) {
    // Status 1 with a tree is a conflict. The lines after the blank one are git's messages about it.
    const failure = error as { status?: number; stdout?: unknown }
    if (failure.status !== 1 || typeof failure.stdout !== 'string' || !failure.stdout) throw error
    return { ok: false, conflict: true, message: firstLines(failure.stdout.split('\n\n')[1] ?? '') }
  }
  const commit = git(repo, [
    '-c', 'user.name=ASIST', '-c', 'user.email=asist@localhost', 'commit-tree', tree, '-p', head, '-p', incoming, '-m', message
  ]).trim()
  try {
    git(repo, ['merge', '--ff-only', '-q', commit])
  } catch (error) {
    const failure = error as { message?: string; stderr?: string }
    return { ok: false, conflict: false, message: firstLines(failure.stderr || String(failure.message)) }
  }
  return { ok: true }
}

/**
 * Whether the working tree has no uncommitted change, which a merge requires. A fast-forward overwrites a
 * changed file that git takes for unchanged without a word, so this reads the files as they are on disk.
 */
export function isClean(repo: string): boolean {
  return onDisk(repo, ['status', '--porcelain']).trim() === ''
}
