import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { shellPath, testGitEnv } from './helpers/git'
import { longTempFolder } from './helpers/temp'
const mocks = vi.hoisted(() => ({ windows: false }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
// The git of the machine the tests run on, unless a test asks for what ASIST does on Windows.
vi.mock('../src/main/services/platform', async () => {
  const { HOST, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : HOST) }
})
// The null device as Node names it on Windows, which Git for Windows refuses to open as a configuration file.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const devNull = '\\\\.\\nul'
  return { ...actual, default: { ...actual, devNull }, devNull }
})
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))

import * as git from '../src/main/services/git'

let root = ''
let repo = ''

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: testGitEnv() }).trim()

beforeEach(() => {
  root = longTempFolder('asist-git-')
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  run(repo, ['init', '-q', '-b', 'main'])
  run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  run(repo, ['add', 'a.txt'])
  run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a'])
})

describe('the git ASIST runs', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => {
    mocks.windows = false
  })

  it('is the git.exe of MinGit on Windows, not the wrapper in its cmd folder', () => {
    mocks.windows = true
    expect(git.gitPath()).toBe(path.join(process.cwd(), 'resources', 'git', 'mingw64', 'bin', 'git.exe'))
  })

  it('drops the GIT_ variables and MSYSTEM written in any case on Windows, where the case of a name does not matter', () => {
    mocks.windows = true
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const env = git.gitEnv({ Path: 'C:\\Windows', Git_Dir: 'C:\\elsewhere\\.git', git_work_tree: 'C:\\elsewhere', Msystem: 'MINGW64' })
      expect(Object.keys(env).filter((name) => name.toUpperCase().startsWith('GIT_')).sort()).toEqual([
        'GIT_ATTR_NOSYSTEM',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_VALUE_0'
      ])
      expect(Object.keys(env).filter((name) => name.toUpperCase() === 'MSYSTEM')).toEqual([])
      expect(env.GIT_ATTR_NOSYSTEM).toBe('1')
      expect(env.Path).toBe('C:\\Windows')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('reads core.longpaths from the environment on Windows, and no system or user configuration', () => {
    const executable = git.gitPath()
    mocks.windows = true
    const env = git.gitEnv({ ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, 'a.txt') })
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    const scopes = execFileSync(executable, ['config', '--list', '--show-scope'], { cwd: repo, env, encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
    expect(scopes).toContainEqual(['command', 'core.longpaths=true'])
    expect(scopes.filter(([scope]) => scope === 'system' || scope === 'global')).toEqual([])
  })
})

describe('git service with an isolated worktree', () => {
  it('returns the repository top inside a repository and null outside one', () => {
    fs.mkdirSync(path.join(repo, 'sub'))
    expect(fs.realpathSync(git.toplevel(path.join(repo, 'sub'))!)).toBe(fs.realpathSync(repo))
    expect(git.toplevel(root)).toBeNull()
  })

  it('commits changes in the worktree, shows the diff, and on merge lands them on the user branch and drops the worktree', () => {
    const wt = path.join(root, 'asist-jobs', '20260908-job')
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    git.worktreeAdd(repo, wt, 'asist/20260908-job')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\nworld\n')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n')
    // The user's own working tree is untouched by the work in the worktree.
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(git.commitAll(wt, 'asist: job')).toBe(false)
    const base = git.headCommit(repo)
    const stat = git.diffStat(repo, base, 'asist/20260908-job')
    expect(stat).toContain('a.txt')
    expect(stat).toContain('b.txt')
    expect(git.diffPatch(repo, base, 'asist/20260908-job')).toContain('+world')
    expect(git.isClean(repo)).toBe(true)
    expect(git.mergeNoFf(repo, 'asist/20260908-job', 'asist: job')).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('new\n')
    git.worktreeRemove(repo, wt, 'asist/20260908-job')
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('reports a conflict and leaves the working tree as it was', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/conflict')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'from job\n')
    git.commitAll(wt, 'job')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from user\n')
    run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'user'])
    const outcome = git.mergeNoFf(repo, 'asist/conflict', 'merge')
    expect(outcome).toMatchObject({ ok: false, conflict: true })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from user\n')
    expect(git.isClean(repo)).toBe(true)
    git.worktreeRemove(repo, wt, 'asist/conflict')
  })

  it('makes the merge commit without running the hooks of the user that can stop a merge half done', () => {
    const before = git.headCommit(repo)
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/hooked')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    git.commitAll(wt, 'job')
    // A commitlint hook rejects the "asist: ..." message, and a hook that calls npx fails on the PATH of an
    // app opened from Finder. git merge would stop with MERGE_HEAD set and the job's changes staged.
    for (const hook of ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg']) {
      fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 })
    }
    expect(git.mergeNoFf(repo, 'asist/hooked', 'asist: job (1)')).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('from job\n')
    expect(git.isClean(repo)).toBe(true)
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(run(repo, ['log', '-1', '--format=%P%n%s']).split('\n')).toEqual([`${before} ${git.headCommit(wt)}`, 'asist: job (1)'])
  })

  it('commits in the worktree without running the commit hooks it shares with the repository', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/hooked-job')
    const ran = path.join(root, 'hooks-that-ran')
    // A hook that calls npx fails on the PATH of an app opened from Finder, and --no-verify does not stop prepare-commit-msg.
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> '${ran}'\nexit 1\n`, { mode: 0o755 })
    }
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(fs.existsSync(ran)).toBe(false)
    expect(run(wt, ['log', '-1', '--format=%s'])).toBe('asist: job')
    expect(git.isClean(wt)).toBe(true)
  })

  it('leaves the index as it was when the commit cannot be made after the changes were staged', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/locked')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'staged by the agent\n')
    run(wt, ['add', 'a.txt'])
    fs.writeFileSync(path.join(wt, 'b.txt'), 'left unstaged\n')
    const before = run(wt, ['status', '--porcelain'])
    // A lock on the branch that a git process left behind when it died stops the commit only once everything is staged.
    const lock = path.join(repo, '.git', 'refs', 'heads', 'asist', 'locked.lock')
    fs.writeFileSync(lock, '')
    expect(() => git.commitAll(wt, 'asist: job')).toThrow()
    expect(run(wt, ['status', '--porcelain'])).toBe(before)
    fs.rmSync(lock)
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(git.isClean(wt)).toBe(true)
  })

  it('cuts a diff larger than the output buffer of git at the limit instead of failing', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/lockfile')
    // A regenerated lockfile of 5 MB, more than the 4 MB that git's output is otherwise read into.
    fs.writeFileSync(path.join(wt, 'package-lock.json'), `${'x'.repeat(99)}\n`.repeat(50_000))
    git.commitAll(wt, 'job')
    const patch = git.diffPatch(repo, git.headCommit(repo), 'asist/lockfile')
    expect(patch.startsWith('diff --git a/package-lock.json')).toBe(true)
    expect(patch.length).toBeLessThan(61_000)
  })

  it('removes the worktree and the branch again when git fails after creating them in a post-checkout hook', () => {
    // The hook Git LFS installs exits 2 when an app opened from Finder has no git-lfs on its PATH.
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    const wt = path.join(root, 'wt')
    expect(() => git.worktreeAdd(repo, wt, 'asist/lfs')).toThrow()
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['worktree', 'list', '--porcelain'])).not.toContain('asist/lfs')
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('removes a worktree in which a submodule was initialized', () => {
    const sub = path.join(root, 'sub')
    fs.mkdirSync(sub)
    run(sub, ['init', '-q', '-b', 'main'])
    run(sub, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 's'])
    run(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'])
    run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub'])
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/sub')
    run(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'])
    git.worktreeRemove(repo, wt, 'asist/sub')
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('builds its commit without holding the index lock of the repository, which a crash would leave behind', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/unlocked')
    const lock = `${path.resolve(wt, run(wt, ['rev-parse', '--git-path', 'index']))}.lock`
    const log = path.join(root, 'filter-log')
    // A clean filter runs while git hashes a file it adds, and notes whether the index was locked then and
    // which index the add was for. The lock is git's own only while it writes that very index.
    run(repo, ['config', 'filter.probe.clean', `sh -c 'printf "%s %s\\n" "\${GIT_INDEX_FILE:-index}" "$(test -e "${shellPath(lock)}" && echo locked || echo free)" >> "${shellPath(log)}"; cat'`])
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=probe\n')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' '))
    const scratch = lines.filter(([index]) => index !== 'index')
    expect(scratch.length).toBeGreaterThan(0)
    expect(scratch.map(([, state]) => state)).toEqual(scratch.map(() => 'free'))
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('brings the index up to HEAD when nothing is left to commit, so that a job whose staged change was undone on disk settles', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/undone')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    run(wt, ['add', '-A'])
    run(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'agent work'])
    fs.writeFileSync(path.join(wt, 'a.txt'), 'tried something\n')
    run(wt, ['add', 'a.txt'])
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(false)
    expect(git.isSettled(wt)).toBe(true)
  })

  it('settles a worktree whose commit was made but whose index a crash left behind', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/crashed')
    const base = git.headCommit(repo)
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    // What commitAll does up to moving the branch, with the index never brought up to the new commit.
    const staging = path.join(root, 'crashed-index')
    fs.copyFileSync(path.resolve(wt, run(wt, ['rev-parse', '--git-path', 'index'])), staging)
    const env = { ...testGitEnv(), GIT_INDEX_FILE: staging }
    execFileSync('git', ['add', '-A'], { cwd: wt, env })
    const tree = execFileSync('git', ['write-tree'], { cwd: wt, env, encoding: 'utf8' }).trim()
    const commit = run(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', base, '-m', 'asist: job'])
    run(wt, ['update-ref', 'HEAD', commit, base])
    expect(git.isSettled(wt)).toBe(false)
    expect(git.commitAll(wt, 'asist: job')).toBe(false)
    expect(git.isSettled(wt)).toBe(true)
    expect(git.headCommit(wt)).toBe(commit)
  })

  it('commits a change to thousands of paths, whose raw diff passes the output buffer git is otherwise read into', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/vendored')
    const base = git.headCommit(repo)
    const folder = path.join(wt, 'vendor', 'package')
    fs.mkdirSync(folder, { recursive: true })
    // 14,000 names of 200 characters make the raw diff about 4.4 MB, past the 4 MB git's output is otherwise read into.
    for (let i = 0; i < 14_000; i++) fs.writeFileSync(path.join(folder, `${String(i).padStart(5, '0')}-${'x'.repeat(195)}.js`), '')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(git.hasChanges(repo, base, git.headCommit(wt))).toBe(true)
    expect(git.submoduleEntryChanges(repo, base, git.headCommit(wt))).toEqual([])
    expect(git.diffStat(repo, base, git.headCommit(wt))).toContain('14000 files changed')
    expect(git.isSettled(wt)).toBe(true)
  }, 120_000)

  it('puts the branch back and leaves the index as it was when git cannot bring the index up to the new commit', () => {
    fs.writeFileSync(path.join(repo, 'c.txt'), 'new\n')
    const head = git.headCommit(repo)
    // A lock another git process holds on the index lets the commit be built but not the index be written.
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '')
    expect(() => git.commitAll(repo, 'asist: job')).toThrow()
    expect(git.headCommit(repo)).toBe(head)
    fs.rmSync(path.join(repo, '.git', 'index.lock'))
    expect(run(repo, ['status', '--porcelain'])).toBe('?? c.txt')
  })

  describe('with a submodule', () => {
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    const FILE = ['-c', 'protocol.file.allow=always']
    const makeSub = (): string => {
      const sub = path.join(root, 'sub')
      fs.mkdirSync(sub)
      run(sub, ['init', '-q', '-b', 'main'])
      fs.writeFileSync(path.join(sub, 'lib.txt'), 'lib\n')
      run(sub, ['add', '.'])
      run(sub, [...ID, 'commit', '-q', '-m', 's'])
      return sub
    }
    const cut = (branch: string): { wt: string; base: string } => {
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, branch)
      return { wt, base: git.headCommit(repo) }
    }
    const withSubmodule = (): { wt: string; base: string } => {
      run(repo, [...FILE, 'submodule', 'add', '-q', makeSub(), 'vendor/sub'])
      run(repo, [...ID, 'commit', '-q', '-m', 'sub'])
      return cut('asist/sub')
    }

    it('commits a submodule entry and .gitmodules as the agent left them, and names them among the changes', () => {
      const { wt, base } = withSubmodule()
      run(wt, [...FILE, 'submodule', 'update', '-q', '--init'])
      const inside = path.join(wt, 'vendor', 'sub')
      fs.writeFileSync(path.join(inside, 'lib.txt'), 'changed by the agent\n')
      run(inside, [...ID, 'commit', '-q', '-am', 'inside'])
      fs.appendFileSync(path.join(wt, '.gitmodules'), '\tbranch = main\n')
      fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(git.submoduleEntryChanges(repo, base, git.headCommit(wt))).toEqual(['.gitmodules', 'vendor/sub'])
      expect(git.isSettled(wt)).toBe(true)
    })

    it('names a submodule the agent removed, one it added, and a folder turned into one or out of one', () => {
      fs.mkdirSync(path.join(repo, 'lib'))
      fs.writeFileSync(path.join(repo, 'lib', 'x.txt'), 'x\n')
      run(repo, ['add', '-A'])
      run(repo, [...ID, 'commit', '-q', '-m', 'lib'])
      const { wt, base } = withSubmodule()
      run(wt, ['rm', '-q', '--cached', 'vendor/sub'])
      fs.writeFileSync(path.join(wt, 'vendor', 'sub', 'lib.txt'), 'vendored\n')
      run(wt, ['rm', '-q', '-r', 'lib'])
      run(wt, [...FILE, 'submodule', 'add', '-q', path.join(root, 'sub'), 'lib'])
      run(wt, [...FILE, 'submodule', 'add', '-q', path.join(root, 'sub'), 'vendor/other'])
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(git.submoduleEntryChanges(repo, base, git.headCommit(wt))).toEqual(['.gitmodules', 'lib', 'vendor/other', 'vendor/sub'])
      expect(git.isSettled(wt)).toBe(true)
    })

    it('finds files written into the folder of a submodule that is not initialized, which git does not show', () => {
      const { wt } = withSubmodule()
      fs.writeFileSync(path.join(wt, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
      expect(git.commitAll(wt, 'asist: job')).toBe(false)
      expect(git.submodulesWithWork(wt)).toEqual(['vendor/sub'])
    })

    it.each(['all', 'dirty', 'untracked'])('finds changes inside a submodule whose ignore setting is %s', (mode) => {
      run(repo, [...FILE, 'submodule', 'add', '-q', makeSub(), 'vendor/sub'])
      run(repo, ['config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', mode])
      run(repo, ['add', '.gitmodules'])
      run(repo, [...ID, 'commit', '-q', '-m', 'sub'])
      const { wt } = cut('asist/ignored')
      run(wt, [...FILE, 'submodule', 'update', '-q', '--init'])
      const inside = path.join(wt, 'vendor', 'sub')
      if (mode === 'all') {
        fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
        run(inside, [...ID, 'commit', '-q', '-am', 'fix'])
      } else if (mode === 'dirty') {
        fs.writeFileSync(path.join(inside, 'lib.txt'), 'edited, not committed\n')
      } else {
        fs.writeFileSync(path.join(inside, 'new.txt'), 'new file\n')
      }
      git.commitAll(wt, 'asist: job')
      expect(git.submodulesWithWork(wt)).toEqual(['vendor/sub'])
    })

    it('finds a change inside a submodule that diff.ignoreSubmodules in the repository would hide', () => {
      const { wt } = withSubmodule()
      run(repo, ['config', 'diff.ignoreSubmodules', 'all'])
      run(wt, [...FILE, 'submodule', 'update', '-q', '--init'])
      fs.writeFileSync(path.join(wt, 'vendor', 'sub', 'lib.txt'), 'edited, not committed\n')
      expect(git.submodulesWithWork(wt)).toEqual(['vendor/sub'])
    })

    it('finds the repository a deinitialized submodule leaves in the worktree, by its path while .gitmodules names it and by its name after', () => {
      run(repo, [...FILE, 'submodule', 'add', '-q', '--name', 'lib', makeSub(), 'vendor/lib'])
      run(repo, [...ID, 'commit', '-q', '-m', 'sub'])
      const { wt } = cut('asist/deinit')
      run(wt, [...FILE, 'submodule', 'update', '-q', '--init'])
      run(wt, ['submodule', 'deinit', '-q', '-f', 'vendor/lib'])
      expect(fs.readdirSync(path.join(wt, 'vendor', 'lib'))).toEqual([])
      expect(git.submodulesWithWork(wt)).toEqual(['vendor/lib'])
      run(wt, ['config', '-f', '.gitmodules', '--remove-section', 'submodule.lib'])
      expect(git.submodulesWithWork(wt)).toEqual(['lib'])
    })

    it('does not take a folder .gitmodules still names for a submodule once it holds ordinary files', () => {
      run(repo, [...FILE, 'submodule', 'add', '-q', makeSub(), 'lib'])
      run(repo, [...ID, 'commit', '-q', '-m', 'sub'])
      run(repo, ['rm', '-q', '--cached', 'lib'])
      fs.rmSync(path.join(repo, 'lib'), { recursive: true, force: true })
      fs.mkdirSync(path.join(repo, 'lib'))
      fs.writeFileSync(path.join(repo, 'lib', 'x.txt'), 'x\n')
      run(repo, ['add', 'lib'])
      run(repo, [...ID, 'commit', '-q', '-m', 'vendored, with .gitmodules left behind'])
      const { wt } = cut('asist/vendored')
      expect(git.submodulesWithWork(wt)).toEqual([])
    })
  })

  it('reads the exact change whatever the repository configures for showing a diff', () => {
    const base = git.headCommit(repo)
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/shown')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\nworld\n')
    git.commitAll(wt, 'asist: job')
    const replaced = path.join(root, 'replaced.sh')
    fs.writeFileSync(replaced, '#!/bin/sh\necho replaced\n', { mode: 0o755 })
    run(repo, ['config', 'diff.external', shellPath(replaced)])
    run(repo, ['config', 'diff.shown.textconv', shellPath(replaced)])
    run(repo, ['config', 'color.diff', 'always'])
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt diff=shown\n')
    const patch = git.diffPatch(repo, base, 'asist/shown')
    expect(patch).toContain('+world')
    expect(patch).not.toContain('replaced')
    expect(patch).not.toContain('\u001b[')
    expect(git.diffStat(repo, base, 'asist/shown')).toContain('a.txt')
  })

  it.each([false, true])('removes the branch of a worktree whose folder was deleted by hand, pruned by git: %s', (pruned) => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/deleted')
    fs.rmSync(wt, { recursive: true, force: true })
    if (pruned) run(repo, ['worktree', 'prune'])
    git.worktreeRemove(repo, wt, 'asist/deleted')
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
    expect(run(repo, ['worktree', 'list', '--porcelain'])).not.toContain('asist/deleted')
  })

  it('keeps another worktree whose folder is missing registered when it removes a job whose folder was deleted', () => {
    const job = path.join(root, 'job')
    const mine = path.join(root, 'mine')
    git.worktreeAdd(repo, job, 'asist/job')
    run(repo, ['worktree', 'add', '-q', '-b', 'mine', mine])
    // The user's own worktree, as on an external disk that is not mounted.
    fs.rmSync(mine, { recursive: true, force: true })
    fs.rmSync(job, { recursive: true, force: true })
    git.worktreeRemove(repo, job, 'asist/job')
    const listed = run(repo, ['worktree', 'list', '--porcelain'])
    expect(listed).toContain('branch refs/heads/mine')
    expect(listed).not.toContain('asist/job')
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('finishes a removal that deleted the files and forgot the worktree but could not delete its folder', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/half')
    // What a removal leaves on Windows while a process has its current folder in the worktree.
    for (const entry of fs.readdirSync(wt)) fs.rmSync(path.join(wt, entry), { recursive: true, force: true })
    run(repo, ['worktree', 'prune'])
    git.worktreeRemove(repo, wt, 'asist/half')
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('refuses to leave a folder that git no longer lists behind in silence', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/unlisted')
    fs.renameSync(wt, `${wt}-moved`)
    run(repo, ['worktree', 'prune'])
    fs.renameSync(`${wt}-moved`, wt)
    expect(() => git.worktreeRemove(repo, wt, 'asist/unlisted')).toThrow()
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('reports a dirty working tree before a merge', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n')
    expect(git.isClean(repo)).toBe(false)
  })

  it('commits without reading the user configuration, which could require a signature', () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n')
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
    process.env.HOME = home
    process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig')
    try {
      fs.writeFileSync(path.join(repo, 'c.txt'), 'signed?\n')
      expect(git.commitAll(repo, 'unsigned')).toBe(true)
      expect(git.isClean(repo)).toBe(true)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  describe('with files the index keeps git from looking at', () => {
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    /** The paths the job's commit changed against base, with the kind of each change. */
    const committed = (wt: string, base: string): string[] => run(wt, ['diff', '--name-status', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean)
    const userIndex = (): Buffer => fs.readFileSync(path.join(repo, '.git', 'index'))
    const worktreeIndex = (wt: string): Buffer => fs.readFileSync(path.resolve(wt, run(wt, ['rev-parse', '--git-path', 'index'])))

    it('commits an edit that core.ignoreStat hid, sees a later one, and leaves the index of the repository as it was', () => {
      run(repo, ['config', 'core.ignoreStat', 'true'])
      // The user's own add marks the files of the repository's index as assume-unchanged.
      fs.writeFileSync(path.join(repo, 'b.txt'), 'the user\'s\n')
      run(repo, ['add', '-A'])
      run(repo, [...ID, 'commit', '-q', '-m', 'b'])
      const base = git.headCommit(repo)
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/ignore-stat')
      const before = userIndex()
      fs.writeFileSync(path.join(wt, 'a.txt'), 'edited by the agent\n')
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(committed(wt, base)).toEqual(['M\ta.txt'])
      expect(git.isSettled(wt)).toBe(true)
      fs.writeFileSync(path.join(wt, 'b.txt'), 'edited after the job settled\n')
      expect(git.isSettled(wt)).toBe(false)
      expect(userIndex().equals(before)).toBe(true)
    })

    it.each([
      ['--assume-unchanged', 'edit'],
      ['--assume-unchanged', 'delete'],
      ['--skip-worktree', 'edit']
    ])('commits a change the agent hid with update-index %s in a worktree that is not sparse: %s', (flag, change) => {
      const base = git.headCommit(repo)
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/hidden')
      run(wt, ['update-index', flag, 'a.txt'])
      if (change === 'edit') fs.writeFileSync(path.join(wt, 'a.txt'), 'edited by the agent\n')
      else fs.rmSync(path.join(wt, 'a.txt'))
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(committed(wt, base)).toEqual([change === 'edit' ? 'M\ta.txt' : 'D\ta.txt'])
      expect(git.isSettled(wt)).toBe(true)
    })

    it('refuses a file the agent removed behind skip-worktree, which cannot be told from one never checked out, and leaves the index as it was', () => {
      const base = git.headCommit(repo)
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/hidden')
      run(wt, ['update-index', '--skip-worktree', 'a.txt'])
      fs.rmSync(path.join(wt, 'a.txt'))
      const before = worktreeIndex(wt)
      const refusal = errorText('jobs.worktree.skippedMissing', { paths: 'a.txt', dir: wt })
      expect(() => git.commitAll(wt, 'asist: job')).toThrow(refusal)
      expect(() => git.isSettled(wt)).toThrow(refusal)
      expect(git.headCommit(wt)).toBe(base)
      expect(worktreeIndex(wt).equals(before)).toBe(true)
    })

    it('reads a worktree whose index core.ignoreStat marked without writing that index, even while another git holds its lock', () => {
      run(repo, ['config', 'core.ignoreStat', 'true'])
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/ignore-stat')
      fs.writeFileSync(path.join(wt, 'a.txt'), 'edited by the agent\n')
      const before = worktreeIndex(wt)
      expect(git.isSettled(wt)).toBe(false)
      expect(worktreeIndex(wt).equals(before)).toBe(true)
      const lock = `${path.resolve(wt, run(wt, ['rev-parse', '--git-path', 'index']))}.lock`
      fs.writeFileSync(lock, '')
      expect(git.isSettled(wt)).toBe(false)
      fs.rmSync(lock)
    })

    // Git for Windows records the creation time of a file as its ctime, so on Windows no setting lets git see an
    // edit in place that keeps the size and puts the mtime back; ASIST's answer there belongs to the agent's port to Windows.
    it.runIf(process.platform !== 'win32').each(['core.checkStat=minimal', 'core.trustctime=false'])('commits an edit in place that keeps the size and puts the mtime back although %s leaves out the ctime', async (setting) => {
      const [name, value] = setting.split('=')
      run(repo, ['config', name, value])
      const base = git.headCommit(repo)
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/stat')
      const file = path.join(wt, 'a.txt')
      const earlier = new Date(Date.now() - 3_600_000)
      fs.utimesSync(file, earlier, earlier)
      run(wt, ['update-index', '--refresh'])
      // git compares the ctime to the second, so the edit comes in a later second than the one the index recorded.
      await new Promise((resolve) => setTimeout(resolve, 1_050 - (Date.now() % 1_000)))
      fs.writeFileSync(file, 'HELLO\n')
      fs.utimesSync(file, earlier, earlier)
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(committed(wt, base)).toEqual(['M\ta.txt'])
    })

    it('reads the working tree of the repository before a merge without writing its index', () => {
      const before = userIndex()
      // A file whose stat changed without its content is one git refreshes and writes to the index.
      const later = new Date(Date.now() + 3_600_000)
      fs.utimesSync(path.join(repo, 'a.txt'), later, later)
      expect(git.isClean(repo)).toBe(true)
      expect(userIndex().equals(before)).toBe(true)
    })

    it('sees an edit in the working tree of the repository that a fsmonitor hook missed, so that no merge overwrites it', () => {
      const hook = path.join(root, 'fsmonitor')
      fs.writeFileSync(hook, '#!/bin/sh\nprintf "token-1\\0"\n', { mode: 0o755 })
      run(repo, ['config', 'core.fsmonitor', shellPath(hook)])
      run(repo, ['status', '--porcelain'])
      run(repo, ['status', '--porcelain'])
      fs.writeFileSync(path.join(repo, 'a.txt'), 'the user\'s edit\n')
      expect(run(repo, ['status', '--porcelain'])).toBe('')
      expect(git.isClean(repo)).toBe(false)
    })

    it('commits an edit that a fsmonitor hook which missed it hides from status', () => {
      const base = git.headCommit(repo)
      // A hook that answers every query with a fresh token and no changed path, as one that lost its events does.
      const hook = path.join(root, 'fsmonitor')
      fs.writeFileSync(hook, '#!/bin/sh\nprintf "token-1\\0"\n', { mode: 0o755 })
      run(repo, ['config', 'core.fsmonitor', shellPath(hook)])
      const wt = path.join(root, 'wt')
      git.worktreeAdd(repo, wt, 'asist/fsmonitor')
      run(wt, ['status', '--porcelain'])
      fs.writeFileSync(path.join(wt, 'a.txt'), 'edited by the agent\n')
      expect(git.commitAll(wt, 'asist: job')).toBe(true)
      expect(committed(wt, base)).toEqual(['M\ta.txt'])
    })

    describe('in a sparse checkout', () => {
      /**
       * A worktree cut from a repository whose checkout holds src/ alone, which the worktree takes over. The
       * branch `other` changes docs/x.txt.
       */
      const sparseWorktree = (sparseIndex = false): { wt: string; base: string } => {
        for (const file of ['src/a.txt', 'src/b.txt', 'docs/x.txt', 'docs/y.txt', 'docs/deep/z.txt']) {
          fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
          fs.writeFileSync(path.join(repo, file), `${file}\n`)
        }
        run(repo, ['add', '-A'])
        run(repo, [...ID, 'commit', '-q', '-m', 'tree'])
        run(repo, ['checkout', '-q', '-b', 'other'])
        fs.writeFileSync(path.join(repo, 'docs', 'x.txt'), 'changed on other\n')
        run(repo, [...ID, 'commit', '-q', '-am', 'other'])
        run(repo, ['checkout', '-q', 'main'])
        run(repo, ['sparse-checkout', 'set', '--cone', ...(sparseIndex ? ['--sparse-index'] : []), 'src'])
        const wt = path.join(root, 'wt')
        git.worktreeAdd(repo, wt, 'asist/sparse')
        expect(fs.existsSync(path.join(wt, 'docs'))).toBe(false)
        return { wt, base: git.headCommit(repo) }
      }
      /** The same, with the sparse checkout in the repository's shared configuration, as git set it up before worktree configuration. */
      const sharedSparseWorktree = (): { wt: string; base: string } => {
        for (const file of ['src/a.txt', 'src/b.txt', 'docs/x.txt', 'docs/y.txt', 'docs/deep/z.txt']) {
          fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
          fs.writeFileSync(path.join(repo, file), `${file}\n`)
        }
        run(repo, ['add', '-A'])
        run(repo, [...ID, 'commit', '-q', '-m', 'tree'])
        run(repo, ['config', 'core.sparseCheckout', 'true'])
        fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
        fs.writeFileSync(path.join(repo, '.git', 'info', 'sparse-checkout'), '/*\n!/*/\n/src/\n')
        run(repo, ['read-tree', '-mu', 'HEAD'])
        const wt = path.join(root, 'wt')
        git.worktreeAdd(repo, wt, 'asist/sparse')
        expect(fs.existsSync(path.join(wt, 'docs'))).toBe(false)
        return { wt, base: git.headCommit(repo) }
      }
      /** The user turns the shared sparse checkout off in the repository's own working tree. */
      const turnSharedSparseOff = (): void => {
        run(repo, ['config', 'core.sparseCheckout', 'false'])
        run(repo, ['read-tree', '-mu', 'HEAD'])
      }
      const LEFT_OUT = 'docs/deep/z.txt, docs/x.txt, docs/y.txt'

      it.each([
        [false, 'docs/x.txt', 'M'],
        [false, 'docs/new.txt', 'A'],
        [true, 'docs/x.txt', 'M'],
        [true, 'docs/deep/new.txt', 'A']
      ])('commits a file written outside the checkout and deletes none of those left out, sparse index %s: %s', (sparseIndex, file, kind) => {
        const { wt, base } = sparseWorktree(sparseIndex)
        const before = userIndex()
        fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true })
        fs.writeFileSync(path.join(wt, file), 'written by the agent\n')
        expect(git.commitAll(wt, 'asist: job')).toBe(true)
        expect(committed(wt, base)).toEqual([`${kind}\t${file}`])
        expect(git.isSettled(wt)).toBe(true)
        expect(userIndex().equals(before)).toBe(true)
      })

      /** Commands with which the agent stages a file left out, leaving it without skip-worktree, and what they stage. */
      const STAGING: Record<string, { stage: (wt: string) => void; staged: string | null }> = {
        'apply --cached and a commit': {
          stage: (wt) => {
            const patch = path.join(root, 'fix.patch')
            fs.writeFileSync(patch, 'diff --git a/docs/x.txt b/docs/x.txt\n--- a/docs/x.txt\n+++ b/docs/x.txt\n@@ -1 +1 @@\n-docs/x.txt\n+fixed by the agent\n')
            run(wt, ['apply', '--cached', patch])
            run(wt, [...ID, 'commit', '-q', '-m', 'fix docs'])
          },
          staged: 'fixed by the agent'
        },
        'restore --staged --source': {
          stage: (wt) => run(wt, ['restore', '--staged', '--source=other', '--', 'docs/x.txt']),
          staged: 'changed on other'
        },
        'update-index --cacheinfo': {
          stage: (wt) => {
            const content = path.join(root, 'plumbing.txt')
            fs.writeFileSync(content, 'written by plumbing\n')
            const blob = run(wt, ['hash-object', '-w', content])
            run(wt, ['update-index', '--cacheinfo', `100644,${blob},docs/x.txt`])
          },
          staged: 'written by plumbing'
        },
        'read-tree HEAD': { stage: (wt) => run(wt, ['read-tree', 'HEAD']), staged: null }
      }

      it.each([
        ['apply --cached and a commit', false],
        ['apply --cached and a commit', true],
        ['restore --staged --source', false],
        ['update-index --cacheinfo', false],
        ['update-index --cacheinfo', true],
        ['read-tree HEAD', false],
        ['read-tree HEAD', true]
      ])('keeps what %s stages for a file left out, which git leaves absent without skip-worktree, sparse index %s', (command, sparseIndex) => {
        const { wt, base } = sparseWorktree(sparseIndex)
        const { stage, staged } = STAGING[command]
        stage(wt)
        git.commitAll(wt, 'asist: job')
        expect(committed(wt, base)).toEqual(staged === null ? [] : ['M\tdocs/x.txt'])
        expect(run(wt, ['show', 'HEAD:docs/x.txt'])).toBe(staged ?? 'docs/x.txt')
        expect(git.isSettled(wt)).toBe(true)
      })

      it('commits a change inside the checkout without staging the deletion of the files it leaves out', () => {
        const { wt, base } = sparseWorktree()
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        expect(git.commitAll(wt, 'asist: job')).toBe(true)
        expect(committed(wt, base)).toEqual(['M\tsrc/a.txt'])
        expect(git.isSettled(wt)).toBe(true)
      })

      it('commits a file brought back outside the checkout although sparse.expectFilesOutsideOfPatterns keeps git from looking at it', () => {
        const { wt, base } = sparseWorktree()
        run(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true'])
        fs.mkdirSync(path.join(wt, 'docs'))
        fs.writeFileSync(path.join(wt, 'docs', 'x.txt'), 'edited by the agent\n')
        expect(git.commitAll(wt, 'asist: job')).toBe(true)
        expect(committed(wt, base)).toEqual(['M\tdocs/x.txt'])
      })

      it.each(['the agent turns it off in the worktree', 'the user turns it off for the repository'])('refuses the files a sparse checkout left out once %s, instead of deleting them', (who) => {
        let wt: string
        let base: string
        if (who.startsWith('the agent')) {
          ;({ wt, base } = sparseWorktree())
          run(wt, ['config', '--worktree', 'core.sparseCheckout', 'false'])
        } else {
          ;({ wt, base } = sharedSparseWorktree())
          turnSharedSparseOff()
        }
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        expect(() => git.commitAll(wt, 'asist: job')).toThrow(errorText('jobs.worktree.skippedMissing', { paths: LEFT_OUT, dir: wt }))
        expect(git.headCommit(wt)).toBe(base)
      })

      it('refuses the review of a settled job while its sparse checkout is off, without changing its index, and settles it once it is on again', () => {
        const { wt, base } = sharedSparseWorktree()
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        expect(git.commitAll(wt, 'asist: job')).toBe(true)
        turnSharedSparseOff()
        const before = worktreeIndex(wt)
        expect(() => git.isSettled(wt)).toThrow(errorText('jobs.worktree.skippedMissing', { paths: LEFT_OUT, dir: wt }))
        expect(worktreeIndex(wt).equals(before)).toBe(true)
        run(repo, ['config', 'core.sparseCheckout', 'true'])
        expect(git.isSettled(wt)).toBe(true)
        expect(committed(wt, base)).toEqual(['M\tsrc/a.txt'])
      })

      it('refuses the files left out when the file of the sparse checkout\'s patterns is gone, since git then skips the sparse checkout', () => {
        const { wt, base } = sparseWorktree()
        fs.rmSync(path.resolve(wt, run(wt, ['rev-parse', '--git-path', 'info/sparse-checkout'])))
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        expect(() => git.commitAll(wt, 'asist: job')).toThrow(errorText('jobs.worktree.skippedMissing', { paths: LEFT_OUT, dir: wt }))
        expect(git.headCommit(wt)).toBe(base)
      })

      it('counts the files of a folder left out that cannot be searched as left out, as git does', () => {
        const { wt, base } = sparseWorktree()
        fs.mkdirSync(path.join(wt, 'docs'), { mode: 0o000 })
        try {
          fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
          expect(git.commitAll(wt, 'asist: job')).toBe(true)
          expect(committed(wt, base)).toEqual(['M\tsrc/a.txt'])
        } finally {
          fs.chmodSync(path.join(wt, 'docs'), 0o755)
        }
      })

      it.each(['a link that points to itself', 'a file'])('refuses %s where a folder left out belongs, which a commit would put in place of the files left out', (thing) => {
        const { wt, base } = sparseWorktree()
        if (thing === 'a file') fs.writeFileSync(path.join(wt, 'docs'), 'written by the agent\n')
        else fs.symlinkSync('docs', path.join(wt, 'docs'))
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        expect(() => git.commitAll(wt, 'asist: job')).toThrow(errorText('jobs.worktree.leftOutReplaced', { paths: LEFT_OUT, dir: wt }))
        expect(git.headCommit(wt)).toBe(base)
      })

      it('refuses a file inside the checkout that is absent behind skip-worktree, which cannot be told from one never checked out', () => {
        const { wt, base } = sparseWorktree()
        run(wt, ['update-index', '--skip-worktree', 'src/b.txt'])
        fs.rmSync(path.join(wt, 'src', 'b.txt'))
        fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'edited by the agent\n')
        const refusal = errorText('jobs.worktree.skippedMissing', { paths: 'src/b.txt', dir: wt })
        expect(() => git.commitAll(wt, 'asist: job')).toThrow(refusal)
        expect(() => git.isSettled(wt)).toThrow(refusal)
        expect(git.headCommit(wt)).toBe(base)
      })
    })
  })
})
