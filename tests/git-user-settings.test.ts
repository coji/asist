import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testGitEnv } from './helpers/git'
import { longTempFolder } from './helpers/temp'

const mocks = vi.hoisted(() => ({ root: '', settings: new Map<string, string | null>(), reads: 0 }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => path.join(mocks.root, 'data') } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/git-user-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/git-user-settings')>()),
  userGitSettings: () => {
    mocks.reads += 1
    return mocks.settings
  }
}))

type Git = typeof import('../src/main/services/git')
type UserSettings = typeof import('../src/main/services/git-user-settings')

let repo = ''
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']

const run = (cwd: string, args: string[], env = testGitEnv()): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })

/** ASIST's git module as a new run loads it, which reads the user's settings afresh. */
async function loadGit(settings: Record<string, string>): Promise<Git> {
  mocks.settings = new Map(Object.entries(settings))
  vi.resetModules()
  return import('../src/main/services/git')
}

beforeEach(() => {
  mocks.root = longTempFolder('asist-git-settings-')
  mocks.reads = 0
  repo = path.join(mocks.root, 'repo')
  fs.mkdirSync(repo)
  run(repo, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  run(repo, ['add', 'a.txt'])
  run(repo, [...ID, 'commit', '-q', '-m', 'lf'])
  // The checkout of a user whose git has core.autocrlf=true: CRLF on disk, and LF in the index and the commit.
  const autocrlf = { ...testGitEnv(), GIT_CONFIG_VALUE_0: 'true' }
  fs.rmSync(path.join(repo, 'a.txt'))
  run(repo, ['reset', '-q', '--hard'], autocrlf)
  expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
  // A later mtime makes git read the file rather than trust the stat data the checkout left in the index.
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(repo, 'a.txt'), later, later)
})

describe("ASIST's git with the user's settings for files in a working tree", () => {
  it("takes a checkout by a user's git with core.autocrlf=true for clean when it carries the setting", async () => {
    const git = await loadGit({ autocrlf: 'true' })
    expect(git.isClean(repo)).toBe(true)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\r\nedited\r\n')
    expect(git.isClean(repo)).toBe(false)
  })

  it('takes every file of such a checkout for changed when the user sets nothing', async () => {
    const git = await loadGit({})
    expect(git.isClean(repo)).toBe(false)
  })

  it("lets a repository's own core.autocrlf override the carried one, as it does for the user's git", async () => {
    run(repo, ['config', 'core.autocrlf', 'false'])
    const git = await loadGit({ autocrlf: 'true' })
    expect(git.isClean(repo)).toBe(false)
  })

  it("checks a job's worktree out and commits it as the user's git would, reading the user's settings once", async () => {
    const git = await loadGit({ autocrlf: 'true' })
    const wt = path.join(mocks.root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/job')
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\r\ntwo\r\nthree\r\n')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'new\r\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(run(wt, ['cat-file', 'blob', 'HEAD:a.txt'])).toBe('one\ntwo\nthree\n')
    expect(run(wt, ['cat-file', 'blob', 'HEAD:b.txt'])).toBe('new\n')
    expect(git.isSettled(wt)).toBe(true)
    expect(mocks.reads).toBe(1)
  })
})

describe("reading the user's git", () => {
  const actual = (): Promise<UserSettings> => vi.importActual<UserSettings>('../src/main/services/git-user-settings')

  it('takes only the settings for files in a working tree from the global level, the last value winning', async () => {
    const { settingsSeenBy, configText } = await actual()
    const home = path.join(mocks.root, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      [
        '[core]',
        '\tautocrlf = input',
        '\thooksPath = /elsewhere',
        '\tsymlinks',
        '[commit]',
        '\tgpgsign = true',
        '[filter "lfs"]',
        '\tclean = git-lfs clean -- %f',
        '[core]',
        '\tautocrlf = true',
        '\teol = crlf',
        ''
      ].join('\n')
    )
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), GIT_CONFIG_NOSYSTEM: '1' })
    const bundled = (await import('../src/main/services/git')).gitPath()
    const settings = settingsSeenBy(bundled, env)
    expect(Object.fromEntries(settings)).toEqual({ autocrlf: 'true', symlinks: null, eol: 'crlf' })
    // The file ASIST's git reads gives git the same values back.
    const file = path.join(mocks.root, 'gitconfig')
    fs.writeFileSync(file, configText(new Map([...settings, ['eol', 'a "quoted\\ value']])))
    const listed = execFileSync(bundled, ['config', '--file', file, '--list'], { encoding: 'utf8' })
    expect(listed.trim().split('\n')).toEqual(['core.autocrlf=true', 'core.symlinks', 'core.eol=a "quoted\\ value'])
  })

  it("finds the user's git on PATH and never takes ASIST's own for it", async () => {
    const { userGitOnPath } = await actual()
    const bundledRoot = path.join(mocks.root, 'resources', 'git')
    const place = (folder: string): string => {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, 'git.exe'), '')
      return folder
    }
    const bundledCmd = place(path.join(bundledRoot, 'cmd'))
    const bundledBin = place(path.join(bundledRoot, 'mingw64', 'bin'))
    const user = place(path.join(mocks.root, 'Program Files', 'Git', 'cmd'))
    const empty = path.join(mocks.root, 'empty')
    fs.mkdirSync(empty)
    expect(userGitOnPath([bundledCmd, empty, bundledBin, `"${user}"`].join(';'), bundledRoot)).toBe(path.join(user, 'git.exe'))
    expect(userGitOnPath([bundledCmd, bundledBin, empty].join(';'), bundledRoot)).toBeNull()
  })
})
