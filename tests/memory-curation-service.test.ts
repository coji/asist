import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { PROMPT_DOCUMENT_MAX_TOKENS, promptSize, textForTokens } from '../resources/skills/memory-format.mjs'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({
  root: '', launch: vi.fn(), recover: vi.fn(), readAll: vi.fn(), reindex: vi.fn(),
  conversationLocale: 'ja-JP', day: [{ t: 1000, kind: 'user', text: '猫が好きです' }] as Array<Record<string, unknown>>
}))
vi.mock('electron', () => ({ app: {
  getPath: () => path.join(mocks.root, 'data'), getAppPath: () => process.cwd(), isPackaged: false
} }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch, recoverAgentProcess: mocks.recover }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/agent' }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({
    agentEngine: 'codex', agentMode: 'readonly', agentCwd: mocks.root, persona: '',
    uiLocale: 'ja-JP', conversationLocale: mocks.conversationLocale, region: 'JP'
  })
}))
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/memory', () => ({
  unavailableReason: () => null, ensureLoaded: vi.fn(), reindex: mocks.reindex,
  invalidateBlock: vi.fn()
}))
vi.mock('../src/main/services/memory-store', () => ({
  ensureRepo: vi.fn(), memoryDir: () => path.join(mocks.root, 'repo'),
  readAll: mocks.readAll
}))
vi.mock('../src/main/services/brain/session', () => ({ conversationLog: { readDay: () => mocks.day } }))

const now = new Date(2026, 8, 12, 12).getTime()
const DAY = 24 * 60 * 60_000
const MINUTE = 60_000
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim()
const stateFile = (): string => path.join(mocks.root, 'data', 'memory-curation.json')

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  mocks.root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'asist-curation-')))
  const repo = path.join(mocks.root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'ASIST test')
  git(repo, 'config', 'user.email', 'test@localhost')
  git(repo, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n.agents/\nAGENTS.md\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'initial')
  mocks.conversationLocale = 'ja-JP'
  mocks.day = [{ t: 1000, kind: 'user', text: '猫が好きです' }]
  mocks.readAll.mockReset().mockReturnValue({ errors: [] })
  mocks.reindex.mockReset().mockReturnValue({ units: 1, errors: [] })
  mocks.launch.mockReset().mockImplementation(() => ({ stop: vi.fn(), completion: Promise.resolve() }))
  mocks.recover.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  fs.rmSync(mocks.root, { recursive: true, force: true })
})

/**
 * Loads the service as the app does at startup, at the given time. The start checks whether the
 * curation is due and starts it, so on the first day the job of yesterday is already running.
 */
async function setup(at = now) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(at)
  const curation = await import('../src/main/services/memory-curation')
  const agent = await import('../src/main/services/agent')
  curation.initMemoryCuration()
  return { curation, agent }
}

/** Loads the service again from the saved state, as after quitting and starting the app. */
async function restart(at = now) {
  vi.clearAllTimers()
  vi.resetModules()
  return setup(at)
}

const lastLaunch = () => mocks.launch.mock.calls.at(-1)![2]
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The process of a curation's Agent, as ASIST saves it once the Agent has started. */
const agentProcess = (pid: number) => ({ pid, startedAt: 'Sat Sep 12 12:00:00 2026', token: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff' })

/**
 * What the next start finds of an Agent that a crash of ASIST cut off: gone, since the stop sent as ASIST ends
 * stopped it. The first check runs after the caller has registered the recovery, as the real one does.
 */
function goneAtNextStart(_identity: unknown, onStopped: () => void) {
  let resolve!: () => void
  const completion = new Promise<void>((done) => { resolve = done })
  return { completion, stop: () => { queueMicrotask(() => { onStopped(); resolve() }); return completion } }
}

it('starts the curation of yesterday at startup, and keeps the job out of what the user and the conversation see', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(job.memoryCuration).toEqual({ through: '2026-09-11', applied: false })
  expect(agent.list().map((j) => j.id)).toEqual([job.id])
  expect(agent.userJobs()).toEqual([])
  expect(agent.userJob(job.id)).toBeUndefined()
  expect(agent.contextBlock() ?? '').not.toContain(job.id)
})

it('discards the changes of a run that ends in error, records why, and leaves curatedThrough alone', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'unfinished\n')
  lastLaunch().onExit(1)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(curation.curatedThrough()).toBeNull()
  expect(curation.lastFailure()).toMatchObject({ at: now })
  expect(curation.pendingJob()).toBeNull()
  expect(fs.existsSync(path.join(mocks.root, 'repo', 'memory.md'))).toBe(false)
})

it('discards the changes of a run the app stopped as it quit, records no failure, and curates the same days at the next start', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'unfinished\n')
  const quitting = agent.shutdown()
  lastLaunch().onExit(0)
  await quitting
  expect(agent.get(job.id)?.status).toBe('cancelled')
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(fs.existsSync(path.join(mocks.root, 'repo', 'memory.md'))).toBe(false)
  expect(curation.curatedThrough()).toBeNull()
  expect(curation.lastFailure()).toBeNull()
  const restored = await restart(now + 10 * MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(restored.curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-11', applied: false })
})

it('records a failure when the next curation is stopped by a quit as well, and leaves the retry to the next day', async () => {
  const first = await setup()
  const quitting = first.agent.shutdown()
  lastLaunch().onExit(0)
  await quitting
  const second = await restart(now + 10 * MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  const quittingAgain = second.agent.shutdown()
  lastLaunch().onExit(0)
  await quittingAgain
  expect(second.curation.lastFailure()).toMatchObject({ at: now + 10 * MINUTE, message: ja('memory.curation.quitTwice') })
  await restart(now + 20 * MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await restart(now + DAY)
  expect(mocks.launch).toHaveBeenCalledTimes(3)
})

it('discards the changes of a run that a crash cut off, records no failure, and curates the same days at the next start', async () => {
  const { curation } = await setup()
  const job = curation.pendingJob()!
  lastLaunch().onSpawn(agentProcess(4242))
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'unfinished\n')
  mocks.recover.mockImplementation(goneAtNextStart)
  const restored = await restart(now + 10 * MINUTE)
  await settled()
  expect(restored.agent.get(job.id)?.mergeState).toBe('discarded')
  expect(fs.existsSync(path.join(mocks.root, 'repo', 'memory.md'))).toBe(false)
  expect(restored.curation.lastFailure()).toBeNull()
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(restored.curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-11', applied: false })
})

it.each(['crash', 'quit'] as const)('records a failure when the curation after one a crash cut off is stopped by a %s as well, and leaves the retry to the next day', async (end) => {
  await setup()
  lastLaunch().onSpawn(agentProcess(4242))
  mocks.recover.mockImplementation(goneAtNextStart)
  const second = await restart(now + 10 * MINUTE)
  await settled()
  expect(second.curation.lastFailure()).toBeNull()
  if (end === 'crash') {
    lastLaunch().onSpawn(agentProcess(4243))
  } else {
    const quitting = second.agent.shutdown()
    lastLaunch().onExit(0)
    await quitting
  }
  const third = await restart(now + 20 * MINUTE)
  await settled()
  expect(third.curation.lastFailure()).toMatchObject({ message: ja('memory.curation.quitTwice') })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await restart(now + 30 * MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await restart(now + DAY)
  expect(mocks.launch).toHaveBeenCalledTimes(3)
})

it('records a failure when two curations in a row are cut off by a crash before their Agent started, and starts no third that day', async () => {
  await setup()
  const second = await restart(now + 10 * MINUTE)
  expect(second.curation.lastFailure()).toBeNull()
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  const third = await restart(now + 20 * MINUTE)
  expect(third.curation.lastFailure()).toMatchObject({ message: ja('memory.curation.quitTwice') })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await restart(now + 30 * MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await restart(now + DAY)
  expect(mocks.launch).toHaveBeenCalledTimes(3)
})

it.each([false, true])('takes a curation whose merge reached the memory before the app ended as merged at the next start, and curates no day twice (an edit by hand not yet committed: %s)', async (handEdit) => {
  const { curation } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'curated\n')
  // The app ends after git has merged the curation: from the save that records the merge on, nothing it
  // writes reaches the disk.
  const rename = fs.renameSync
  let ended = false
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    ended ||= path.basename(String(to)) === 'jobs.json' && fs.readFileSync(from, 'utf8').includes('"mergeState":"merged"')
    if (ended) throw new Error('the app ended')
    rename(from, to)
  })
  lastLaunch().onExit(0)
  vi.mocked(fs.renameSync).mockRestore()
  const repo = path.join(mocks.root, 'repo')
  const merged = git(repo, 'rev-parse', 'HEAD')
  expect(fs.readFileSync(path.join(repo, 'memory.md'), 'utf8')).toBe('curated\n')
  const memory = handEdit ? 'curated\nadded by hand\n' : 'curated\n'
  fs.writeFileSync(path.join(repo, 'memory.md'), memory)
  const restored = await restart(now + 10 * MINUTE)
  expect(restored.agent.get(job.id)).toMatchObject({ mergeState: 'merged', memoryCuration: { through: '2026-09-11', applied: true } })
  expect(restored.curation.curatedThrough()).toBe('2026-09-11')
  expect(restored.curation.lastFailure()).toBeNull()
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(merged)
  expect(fs.readFileSync(path.join(repo, 'memory.md'), 'utf8')).toBe(memory)
  expect(fs.existsSync(job.cwd)).toBe(false)
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  const next = restored.curation.pendingJob()!
  expect(next.prompt).not.toContain('# 2026-09-11 の会話')
  expect(next.prompt).toContain('# 2026-09-12 の会話')
})

it('records no failure when the daily check comes while the app is quitting, and curates at the next start', async () => {
  const { curation, agent } = await setup()
  lastLaunch().onExit(0)
  vi.setSystemTime(new Date(2026, 8, 13, 0, 0, 30))
  await agent.shutdown()
  vi.advanceTimersByTime(MINUTE)
  expect(curation.lastFailure()).toBeNull()
  expect(mocks.launch).toHaveBeenCalledOnce()
  const restored = await restart(new Date(2026, 8, 13, 0, 5).getTime())
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(restored.curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
})

it('discards a job whose result fails validation, records why, and leaves the day for the next curation', async () => {
  const { curation, agent } = await setup()
  mocks.readAll.mockReturnValue({ errors: ['invalid memory'] })
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'invalid\n')
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(curation.lastFailure()?.message).toContain('invalid memory')
  expect(curation.curatedThrough()).toBeNull()
  expect(fs.existsSync(path.join(mocks.root, 'repo', 'memory.md'))).toBe(false)
  expect(curation.curateNow(now)).not.toBeNull()
})

it('refuses to merge a curation whose changes reach outside the memory folder through a symbolic link, reads nothing through it, and records why', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  const secret = path.join(mocks.root, 'secret.txt')
  fs.writeFileSync(secret, 'private key\n')
  fs.mkdirSync(path.join(job.cwd, 'pages'))
  fs.symlinkSync(secret, path.join(job.cwd, 'pages', 'leak.md'))
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'curated\n')
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(mocks.readAll).not.toHaveBeenCalled()
  expect(mocks.reindex).not.toHaveBeenCalled()
  expect(curation.lastFailure()?.message).toBe(ja('memory.errors.outsideMemory', { files: 'pages/leak.md' }))
  expect(curation.curatedThrough()).toBeNull()
  const repo = path.join(mocks.root, 'repo')
  expect(fs.existsSync(path.join(repo, 'pages', 'leak.md'))).toBe(false)
  expect(fs.existsSync(path.join(repo, 'memory.md'))).toBe(false)
})

it('discards a job whose merge conflicts with an edit made on the memory screen meanwhile, and keeps the edit', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  const repo = path.join(mocks.root, 'repo')
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'curated\n')
  fs.writeFileSync(path.join(repo, 'memory.md'), 'edited\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'asist: edit memory.md')
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(curation.lastFailure()).not.toBeNull()
  expect(curation.pendingJob()).toBeNull()
  expect(curation.curatedThrough()).toBeNull()
  expect(fs.readFileSync(path.join(repo, 'memory.md'), 'utf8')).toBe('edited\n')
})

// Windows ignores the read-only mode of a folder, so a worktree that cannot be removed is made with it elsewhere only.
it.runIf(process.platform !== 'win32')('lets the next curation start while the worktree of a failed one cannot be removed, and removes it on a later check', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  const repo = path.join(mocks.root, 'repo')
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'curated\n')
  fs.writeFileSync(path.join(repo, 'memory.md'), 'edited\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'asist: edit memory.md')
  // What a scanner holding a file in the worktree does to its removal on Windows.
  const worktrees = path.dirname(job.cwd)
  fs.chmodSync(worktrees, 0o500)
  try {
    lastLaunch().onExit(0)
  } finally {
    fs.chmodSync(worktrees, 0o700)
  }
  expect(agent.get(job.id)?.mergeState).toBe('conflict')
  expect(curation.lastFailure()).not.toBeNull()
  expect(curation.pendingJob()).toBeNull()
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(fs.existsSync(job.cwd)).toBe(false)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
})

const PAGE = '---\nupdated: 2026-09-11\n---\n# 名前\n\n## 要約\n本文。\n'

// Git for Windows cannot add a page named CON.md, and Windows ignores the read-only mode of a folder.
describe.runIf(process.platform !== 'win32')('a curation refused by the check before its merge, whose worktree cannot be removed', () => {
  it.each([
    ['its result breaks the rules', (cwd: string) => {
      mocks.readAll.mockReturnValue({ errors: ['invalid memory'] })
      fs.writeFileSync(path.join(cwd, 'memory.md'), 'invalid\n')
    }],
    ['it reaches outside the memory through a symbolic link', (cwd: string) => {
      fs.writeFileSync(path.join(mocks.root, 'secret.txt'), 'private key\n')
      fs.mkdirSync(path.join(cwd, 'pages'))
      fs.symlinkSync(path.join(mocks.root, 'secret.txt'), path.join(cwd, 'pages', 'leak.md'))
    }],
    ['it adds a page that macOS or Windows cannot name', (cwd: string) => {
      fs.mkdirSync(path.join(cwd, 'pages'))
      fs.writeFileSync(path.join(cwd, 'pages', 'CON.md'), PAGE)
    }]
  ])('holds no later curation back when %s, and is not checked again', async (_, write) => {
    const { curation, agent } = await setup()
    const job = curation.pendingJob()!
    write(job.cwd)
    // What a scanner holding a file in the worktree does to its removal on Windows.
    const worktrees = path.dirname(job.cwd)
    fs.chmodSync(worktrees, 0o500)
    try {
      lastLaunch().onExit(0)
    } finally {
      fs.chmodSync(worktrees, 0o700)
    }
    expect(agent.get(job.id)).toMatchObject({ status: 'done', mergeState: 'pending' })
    const failure = curation.lastFailure()
    expect(failure).not.toBeNull()
    expect(curation.pendingJob()).toBeNull()
    mocks.readAll.mockReturnValue({ errors: [] })
    vi.setSystemTime(now + DAY)
    vi.advanceTimersByTime(MINUTE)
    expect(curation.lastFailure()).toEqual(failure)
    expect(agent.get(job.id)?.mergeState).toBe('discarded')
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(mocks.root, 'repo', 'pages'))).toBe(false)
  })
})

it('starts the next curation while the stop of the Agent of one cut off by a restart cannot be confirmed, and leaves asking again to the next start', async () => {
  const { curation } = await setup()
  const job = curation.pendingJob()!
  lastLaunch().onSpawn(agentProcess(4242))
  let checks = 0
  mocks.recover.mockImplementation(() => {
    checks++
    const completion = Promise.reject(new Error('the stop could not be confirmed'))
    completion.catch(() => {})
    return { completion, stop: () => completion }
  })
  const restored = await restart(now + DAY)
  await settled()
  for (let i = 0; i < 10; i++) vi.advanceTimersByTime(MINUTE)
  await settled()
  expect(restored.agent.get(job.id)?.status).toBe('stopping')
  expect(checks).toBe(1)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(restored.curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
})

/**
 * A curation checked by the real rules, whose Agent adds a section under the heading given after the first
 * section of user.md, while the user adds the section "趣味" at its end on the memory screen. Each side alone
 * keeps the rules.
 */
async function curateBesideScreenEdit(heading: string) {
  const actual = await vi.importActual<typeof import('../src/main/services/memory-store')>('../src/main/services/memory-store')
  mocks.readAll.mockImplementation((dir: string) => actual.readAll(dir))
  const repo = path.join(mocks.root, 'repo')
  const user = '---\nupdated: 2026-09-10\n---\n# ユーザー\n\n## 属性\n東京に住んでいる。\n\n## 好み\n辛いものは控えめが好き。\n'
  fs.writeFileSync(path.join(repo, 'instruction.md'), '# いつも覚えておくこと\n\n## この人について\n東京に住んでいる。\n')
  fs.writeFileSync(path.join(repo, 'user.md'), user)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'memory')
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  const edited = `${user}\n## 趣味\n釣りが好き。\n`
  fs.writeFileSync(path.join(repo, 'user.md'), edited)
  git(repo, 'commit', '-qam', 'asist: edit user.md')
  fs.writeFileSync(path.join(job.cwd, 'user.md'), user.replace('## 好み', `## ${heading}\n将棋が好きらしい。\n\n## 好み`))
  expect(actual.readAll(job.cwd).errors).toEqual([])
  lastLaunch().onExit(0)
  return { curation, agent, job, repo, edited, readAll: actual.readAll }
}

it('merges a curation that keeps the rules together with an edit made on the memory screen meanwhile', async () => {
  const { curation, agent, job, repo, readAll } = await curateBesideScreenEdit('対局')
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(curation.curatedThrough()).toBe('2026-09-11')
  expect(fs.readFileSync(path.join(repo, 'user.md'), 'utf8')).toContain('## 対局\n将棋が好きらしい。')
  expect(fs.readFileSync(path.join(repo, 'user.md'), 'utf8')).toContain('## 趣味\n釣りが好き。')
  expect(readAll(repo).errors).toEqual([])
})

it('discards a job whose merge with an edit made on the memory screen meanwhile breaks the rules that neither side breaks alone, and curates again the next day', async () => {
  const { curation, agent, job, repo, edited, readAll } = await curateBesideScreenEdit('趣味')
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(curation.lastFailure()?.message).toContain(ja('memory.check.duplicateHeading', { file: 'user.md', line: 15, heading: '趣味', first: 9 }))
  expect(curation.pendingJob()).toBeNull()
  expect(curation.curatedThrough()).toBeNull()
  expect(fs.readFileSync(path.join(repo, 'user.md'), 'utf8')).toBe(edited)
  expect(readAll(repo).errors).toEqual([])
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
})

it('discards a curation that leaves a document of the prompt over its token limit, says how far over, and keeps the memory as it was', async () => {
  const actual = await vi.importActual<typeof import('../src/main/services/memory-store')>('../src/main/services/memory-store')
  mocks.readAll.mockImplementation((dir: string) => actual.readAll(dir))
  const repo = path.join(mocks.root, 'repo')
  const me = '---\nupdated: 2026-09-10\n---\n# 私について\n\n落ち着いて話す。\n'
  fs.writeFileSync(path.join(repo, 'instruction.md'), '# いつも覚えておくこと\n\n## この人について\n東京に住んでいる。\n')
  fs.writeFileSync(path.join(repo, 'me.md'), me)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'memory')
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  // Four sections, each within the cap of a section, which together pass the limit of the document.
  const grown = me.replace(
    '落ち着いて話す。',
    ['私は誰か', '大事にしていること', '好きなもの', 'この人との関係'].map((heading) => `## ${heading}\n${'落ち着いて話し、確かめてから答えることを大事にしている。'.repeat(20)}`).join('\n\n')
  )
  fs.writeFileSync(path.join(job.cwd, 'me.md'), grown)
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  const size = promptSize(grown)
  const over = size.tokens - PROMPT_DOCUMENT_MAX_TOKENS
  expect(over).toBeGreaterThan(0)
  expect(curation.lastFailure()?.message).toContain(
    ja('memory.check.tooManyTokens', { file: 'me.md', tokens: size.tokens, limit: PROMPT_DOCUMENT_MAX_TOKENS, characters: textForTokens(size, over).characters })
  )
  expect(curation.curatedThrough()).toBeNull()
  expect(fs.readFileSync(path.join(repo, 'me.md'), 'utf8')).toBe(me)
})

// Windows ignores the read-only mode of a folder, so a folder that cannot be emptied is made with it elsewhere only.
it.runIf(process.platform !== 'win32')('checks the merge without a branch or a worktree in the memory, and merges a curation that passed though its checked copy cannot be removed', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  const repo = path.join(mocks.root, 'repo')
  const refs = (): string => git(repo, 'for-each-ref', '--format=%(refname)')
  const worktrees = (): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))
  const before = { refs: refs(), worktrees: worktrees() }
  const during: Array<typeof before> = []
  const checked: string[] = []
  mocks.readAll.mockImplementation((dir: string) => {
    during.push({ refs: refs(), worktrees: worktrees() })
    // What a scanner holding a file just checked out does to the removal on Windows.
    fs.chmodSync(dir, 0o500)
    checked.push(dir)
    return { errors: [] }
  })
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'curated\n')
  try {
    lastLaunch().onExit(0)
  } finally {
    for (const dir of checked) {
      fs.chmodSync(dir, 0o700)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  expect(during).toEqual([before])
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(curation.curatedThrough()).toBe('2026-09-11')
  expect(fs.readFileSync(path.join(repo, 'memory.md'), 'utf8')).toBe('curated\n')
})

it('starts no job for a day the user did not speak on, whatever language the transcript is written in', async () => {
  mocks.conversationLocale = 'de-DE'
  mocks.day = [{ t: 1000, kind: 'assistant', text: 'Guten Morgen' }, { t: 2000, kind: 'notice', text: 'job done' }]
  const { curation } = await setup()
  expect(curation.pendingJob()).toBeNull()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(curation.curatedThrough()).toBe('2026-09-11')
})

it('writes the prompt, the transcript and the worktree AGENTS.md in English for a conversation held in another language', async () => {
  mocks.conversationLocale = 'de-DE'
  mocks.day = [{ t: new Date(2026, 8, 11, 9, 5).getTime(), kind: 'user', turnId: 1, text: 'Ich mag Katzen' }]
  const { curation } = await setup()
  const job = curation.pendingJob()!
  expect(job.prompt).toContain('[09:05 #1] User: Ich mag Katzen')
  expect(job.prompt).toContain('write the body of every file in German')
  expect(/[぀-ヿ一-鿿]/.test(job.prompt)).toBe(false)
  const agents = fs.readFileSync(path.join(job.cwd, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('memory-curation')
  expect(/[぀-ヿ一-鿿]/.test(agents)).toBe(false)
  // The English skill is the one installed, and it lands under the same name the prompt uses.
  const skill = fs.readFileSync(path.join(job.cwd, '.claude', 'skills', 'memory-curation', 'SKILL.md'), 'utf8')
  expect(skill).toContain('the language of the conversation')
})

it('completes the day only when the run succeeds and leaves no changes behind', async () => {
  const { curation } = await setup()
  lastLaunch().onExit(0)
  expect(curation.curatedThrough()).toBe('2026-09-11')
  expect(curation.pendingJob()).toBeNull()
  expect(curation.lastFailure()).toBeNull()
})

it('leaves the day uncurated and records the failure on error even when nothing changed', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  lastLaunch().onExit(1)
  expect(agent.get(job.id)?.mergeState).toBe('unchanged')
  expect(curation.curatedThrough()).toBeNull()
  expect(curation.lastFailure()).not.toBeNull()
  expect(curation.pendingJob()).toBeNull()
})

it('does not start another curation on the day one failed, and starts one after the next midnight', async () => {
  const { curation } = await setup()
  lastLaunch().onExit(1)
  for (let i = 0; i < 5; i++) vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledOnce()
  vi.setSystemTime(new Date(2026, 8, 13, 0, 0, 30))
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
})

it('checks every minute and starts the curation right after midnight once the previous day has ended', async () => {
  const { curation } = await setup()
  lastLaunch().onExit(0)
  expect(curation.curatedThrough()).toBe('2026-09-11')
  vi.setSystemTime(new Date(2026, 8, 12, 23, 59))
  vi.advanceTimersByTime(MINUTE / 2)
  expect(mocks.launch).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
})

it('clears the recorded failure once a curation succeeds', async () => {
  const { curation } = await setup()
  lastLaunch().onExit(1)
  expect(curation.lastFailure()).not.toBeNull()
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  lastLaunch().onExit(0)
  expect(curation.lastFailure()).toBeNull()
  expect(curation.curatedThrough()).toBe('2026-09-12')
})

it('records the target day before handling a completion that arrives while the job is still starting', async () => {
  mocks.launch.mockImplementationOnce((_job, _args, handlers) => {
    handlers.onExit(0)
    return { stop: vi.fn(), completion: Promise.resolve() }
  })
  const { curation } = await setup()
  expect(curation.curatedThrough()).toBe('2026-09-11')
})

it('holds the day back while the index still reports an invalid memory, and finishes it on the retry', async () => {
  const { curation } = await setup()
  mocks.reindex.mockReturnValueOnce({ units: 0, errors: ['invalid page'] })
  lastLaunch().onExit(0)
  expect(curation.curatedThrough()).toBeNull()
  expect(curation.lastFailure()?.message).toContain('invalid page')
  curation.reconcileMemoryCuration()
  expect(curation.curatedThrough()).toBe('2026-09-11')
  expect(curation.lastFailure()).toBeNull()
})

it('finishes a merged job whose reindex failed on the next day by itself, and then curates the day after it', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'valid\n')
  mocks.reindex.mockImplementationOnce(() => { throw new Error('index busy') })
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(curation.curatedThrough()).toBeNull()
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.reindex).toHaveBeenCalledOnce()
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  expect(agent.get(job.id)?.memoryCuration?.applied).toBe(true)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(curation.pendingJob()?.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
})

it('resumes after a restart when the reindex failed once the merge was done, without merging twice', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'valid\n')
  mocks.reindex.mockImplementationOnce(() => { throw new Error('index busy') })
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(curation.curatedThrough()).toBeNull()
  const repo = path.join(mocks.root, 'repo')
  const mergedHead = git(repo, 'rev-parse', 'HEAD')
  const restored = await restart()
  expect(restored.curation.curatedThrough()).toBe('2026-09-11')
  expect(restored.curation.pendingJob()).toBeNull()
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(mergedHead)
  expect(mocks.reindex).toHaveBeenCalledTimes(2)
})

it('does not treat the day as done when saving the curated date fails, and retries that work on the next curation request', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'valid\n')
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('memory-curation.json')) throw new Error('disk full')
    rename(from, to)
  })
  lastLaunch().onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(curation.curatedThrough()).toBeNull()
  vi.mocked(fs.renameSync).mockRestore()
  expect(curation.curateNow(now)).toBeNull()
  expect(curation.curatedThrough()).toBe('2026-09-11')
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it('keeps a broken curation state file as it is, starts nothing at startup, and throws when a curation is requested', async () => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
  fs.writeFileSync(stateFile(), '{broken')
  const { curation } = await setup()
  vi.advanceTimersByTime(MINUTE)
  expect(() => curation.curateNow(now)).toThrow()
  expect(fs.readFileSync(stateFile(), 'utf8')).toBe('{broken')
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('stops on a curation state file of an unknown shape and names the file and the fields to fix', async () => {
  const { curation } = await setup()
  fs.writeFileSync(stateFile(), '{"curatedThrough":"2026-09-08","jobs":{}}')
  const file = stateFile().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  expect(() => curation.curatedThrough()).toThrow(new RegExp(`${file}[^]*jobs[^]*pendingFrom`))
  expect(fs.readFileSync(stateFile(), 'utf8')).toBe('{"curatedThrough":"2026-09-08","jobs":{}}')
})

it.each(['same-process', 'restart', 'pruned-history'] as const)('loses no target day on the day after a discarded first failure: %s', async (mode) => {
  let { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'unfinished\n')
  lastLaunch().onExit(1)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(curation.curatedThrough()).toBeNull()
  if (mode === 'pruned-history') {
    const { writeJobHistory, readJobHistory } = await import('../src/main/services/job-history')
    const endedAt = Date.now()
    const completed = Array.from({ length: 51 }, (_, index) => ({
      id: `completed-${index}`, title: '完了済み', prompt: '完了済み', cwd: mocks.root,
      readonly: true, engine: 'codex' as const, status: 'done' as const,
      startedAt: endedAt + index + 1, endedAt: endedAt + index + 1
    }))
    writeJobHistory([...agent.list(), ...completed])
    expect(readJobHistory()).toHaveLength(50)
    expect(readJobHistory().some((entry) => entry.id === job.id)).toBe(false)
  }
  if (mode === 'same-process') {
    vi.setSystemTime(now + DAY)
    vi.advanceTimersByTime(MINUTE)
  } else {
    ;({ curation, agent } = await restart(now + DAY))
  }
  const next = curation.pendingJob()!
  expect(next.prompt).toContain('# 2026-09-11 の会話')
  expect(next.prompt).toContain('# 2026-09-12 の会話')
  expect(next.memoryCuration).toEqual({ through: '2026-09-12', applied: false })
  lastLaunch().onExit(0)
  expect(curation.curatedThrough()).toBe('2026-09-12')
  expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toEqual({
    version: 1, curatedThrough: '2026-09-12', pendingFrom: null, lastFailure: null
  })
})

it.each(['error', 'cancelled'] as const)('runs again from the first target day the next day, after a first run that changed nothing and ended in %s', async (status) => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  if (status === 'cancelled') agent.cancel(job.id)
  lastLaunch().onExit(status === 'error' ? 1 : 0)
  expect(agent.get(job.id)?.mergeState).toBe('unchanged')
  vi.setSystemTime(now + DAY)
  vi.advanceTimersByTime(MINUTE)
  const next = curation.pendingJob()!
  expect(next.prompt).toContain('# 2026-09-11 の会話')
  expect(next.prompt).toContain('# 2026-09-12 の会話')
})

it('launches no agent when saving the first target day fails, and starts one on the next check once the save works', async () => {
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('memory-curation.json')) throw new Error('disk full')
    rename(from, to)
  })
  const { curation, agent } = await setup()
  expect(() => curation.curateNow(now)).toThrow('disk full')
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(agent.list()).toEqual([])
  expect(curation.curatedThrough()).toBeNull()
  vi.mocked(fs.renameSync).mockRestore()
  vi.advanceTimersByTime(MINUTE)
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it('keeps a merged job whose reindex is still pending beyond the 50 entries of the history, and finishes it after a restart without merging twice', async () => {
  const { curation, agent } = await setup()
  const job = curation.pendingJob()!
  fs.writeFileSync(path.join(job.cwd, 'memory.md'), 'merged\n')
  mocks.reindex.mockImplementationOnce(() => { throw new Error('index busy') })
  lastLaunch().onExit(0)
  const repo = path.join(mocks.root, 'repo')
  const merged = git(repo, 'rev-parse', 'HEAD')
  const { writeJobHistory, readJobHistory } = await import('../src/main/services/job-history')
  const endedAt = Date.now()
  const completed = Array.from({ length: 51 }, (_, index) => ({
    id: `completed-${index}`, title: '完了済み', prompt: '完了済み', cwd: mocks.root,
    readonly: true, engine: 'codex' as const, status: 'done' as const,
    startedAt: endedAt + index + 1, endedAt: endedAt + index + 1
  }))
  writeJobHistory([...agent.list(), ...completed])
  expect(readJobHistory().find((entry) => entry.id === job.id)?.memoryCuration?.applied).toBe(false)
  const restored = await restart()
  expect(restored.curation.curatedThrough()).toBe('2026-09-11')
  expect(restored.curation.pendingJob()).toBeNull()
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(merged)
})

// Git for Windows cannot open a file named CON.md, a name Windows keeps for the console, so it can neither add nor
// check out such a page, and on Windows git refuses the page before ASIST's own check of page names does.
describe.runIf(process.platform !== 'win32')('a page name that macOS or Windows cannot give a file', () => {
  it('refuses to merge a curation that adds such a page, and records why', async () => {
    const { curation, agent } = await setup()
    const job = curation.pendingJob()!
    fs.mkdirSync(path.join(job.cwd, 'pages'))
    fs.writeFileSync(path.join(job.cwd, 'pages', 'CON.md'), PAGE)
    fs.writeFileSync(path.join(job.cwd, 'pages', '松葉軒.md'), PAGE)
    lastLaunch().onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('discarded')
    expect(curation.lastFailure()?.message).toBe(ja('memory.errors.pageNamesRefused', { files: 'pages/CON.md' }))
    expect(fs.existsSync(path.join(mocks.root, 'repo', 'pages', '松葉軒.md'))).toBe(false)
  })

  it('merges a change to such a page that the memory already had, so that it goes on loading', async () => {
    const repo = path.join(mocks.root, 'repo')
    fs.mkdirSync(path.join(repo, 'pages'))
    fs.writeFileSync(path.join(repo, 'pages', 'CON.md'), PAGE)
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'an older page')
    const { curation, agent } = await setup()
    const job = curation.pendingJob()!
    fs.writeFileSync(path.join(job.cwd, 'pages', 'CON.md'), PAGE.replace('本文。', '書き足した本文。'))
    lastLaunch().onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('merged')
    expect(fs.readFileSync(path.join(repo, 'pages', 'CON.md'), 'utf8')).toContain('書き足した本文。')
  })
})
