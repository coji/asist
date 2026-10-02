import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { shellPath, testGitEnv } from './helpers/git'
import { longTempFolder } from './helpers/temp'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({ root: '', launch: vi.fn(), requestConfirm: vi.fn(), differentOwner: false }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => path.join(mocks.root, 'data') } }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/agent' }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'readonly', agentCwd: mocks.root, fileRoots: [], uiLocale: 'ja-JP', conversationLocale: 'ja-JP' })
}))
// git's own switch for taking every repository for another user's, which a git that reads no safe.directory refuses to open.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) =>
    actual.execFileSync(file, args, mocks.differentOwner ? { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } } : options)) as typeof actual.execFileSync
  return { ...actual, default: { ...actual, execFileSync }, execFileSync }
})
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/confirm', () => ({ requestConfirm: mocks.requestConfirm }))
vi.mock('../src/main/services/memory', () => ({ search: vi.fn() }))

let repo: string
type Agent = typeof import('../src/main/services/agent')
/** Merges what the job's review shows, as the card and merge_agent_job do. */
const mergeReviewed = (agent: Agent, id: string): void => {
  const review = agent.diff(id)
  agent.merge(id, review)
}

/** Calls merge_agent_job as the conversation model does, after the review it read gave the commit. */
/** Runs merge_agent_job, with a failure in the Japanese the model reads rather than packed in both languages. */
const mergeThroughTool = async (id: string, commit: string): Promise<unknown> => {
  const { jobTools } = await import('../src/main/services/brain/job-tools')
  const { ToolError, resolvePromptTexts } = await import('@shared/tool-registry')
  const tool = jobTools('ja-JP').find((definition) => definition.name === 'merge_agent_job')!
  try {
    return await tool.run({ jobId: id, commit }, {} as never, new AbortController().signal)
  } catch (err) {
    throw err instanceof ToolError ? new Error(resolvePromptTexts(err.message, 'ja')) : err
  }
}

/** A job that touched submodules waits with its worktree, and no merge of it changes the user's branch. */
const expectRefused = (agent: Agent, id: string, submodules: string[], head: string): void => {
  const job = agent.get(id)!
  expect(job.mergeState).toBe('pending')
  const review = agent.diff(id)
  expect(review.submodules).toEqual(submodules)
  expect(() => agent.merge(id, review)).toThrow(
    errorText('jobs.merging.submodules', { paths: submodules.join(', '), branch: job.worktree!.branch, dir: job.worktree!.dir })
  )
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.existsSync(job.worktree!.dir)).toBe(true)
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: testGitEnv() }).trim()

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  mocks.launch.mockReset()
  mocks.requestConfirm.mockReset()
  mocks.launch.mockImplementation((_job, _args, handlers) => {
    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    const onExit = handlers.onExit
    handlers.onExit = (code: number | null) => { onExit(code); resolve() }
    return { completion, stop: vi.fn() }
  })
  mocks.root = longTempFolder('asist-worktree-test-')
  repo = path.join(mocks.root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'ASIST test')
  git(repo, 'config', 'user.email', 'test@localhost')
  git(repo, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'initial')
})

afterEach(() => { fs.rmSync(mocks.root, { recursive: true, force: true }) })

it('commits uncommitted tracked and untracked output on restart and merges the diff that was shown', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed\n')
  fs.writeFileSync(path.join(job.cwd, 'untracked.txt'), 'new\n')
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  const review = restored.diff(job.id)
  expect(review.patch).toContain('+changed')
  expect(review.patch).toContain('+new')
  restored.merge(job.id, review)
  expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('new\n')
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
  expect(fs.existsSync(job.cwd)).toBe(false)
})

it('refuses to merge and keeps the worktree when uncommitted changes appear after the diff was reviewed', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'reviewed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  fs.writeFileSync(path.join(job.cwd, 'late.txt'), 'not reviewed\n')
  expect(() => agent.merge(job.id, review)).toThrow()
  expect(fs.existsSync(path.join(job.cwd, 'late.txt'))).toBe(true)
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
})

it('keeps the worktree on a stop request and commits the output once the process closes', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  agent.cancel(job.id)
  expect(fs.existsSync(job.cwd)).toBe(true)
  expect(() => agent.diff(job.id)).toThrow()
  fs.writeFileSync(path.join(job.cwd, 'after-signal.txt'), 'cleanup output\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.status).toBe('cancelled')
  expect(agent.diff(job.id).patch).toContain('+cleanup output')
})

it('keeps output whose commit failed instead of offering it for merge, until the commit is retried', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'preserved\n')
  vi.spyOn(operations, 'commitAll').mockImplementationOnce(() => { throw new Error('disk error') })
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('error')
  expect(() => agent.merge(job.id, { commit: 'unconfirmed', base: 'unconfirmed', into: 'main' })).toThrow()
  expect(fs.readFileSync(path.join(job.cwd, 'new.txt'), 'utf8')).toBe('preserved\n')
  const review = agent.diff(job.id)
  expect(review.patch).toContain('+preserved')
  agent.merge(job.id, review)
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('preserved\n')
})

it('does not merge when the commit was replaced after the review', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'reviewed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'changed after review\n')
  operations.commitAll(job.cwd, 'changed')
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.worktree.commitChanged'))
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
  expect(fs.readFileSync(path.join(job.cwd, 'new.txt'), 'utf8')).toBe('changed after review\n')
})

it('rewrites artifact paths inside the worktree to the repository on merge and leaves paths outside it alone', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.mkdirSync(path.join(job.cwd, 'pages'))
  fs.writeFileSync(path.join(job.cwd, 'pages', 'note.md'), 'hello\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'file-change', paths: [path.join(job.cwd, 'pages', 'note.md'), '/tmp/elsewhere/report.md'] })
  handlers.onExit(0)
  expect(agent.get(job.id)?.artifacts).toEqual([path.join(job.cwd, 'pages', 'note.md'), '/tmp/elsewhere/report.md'])
  mergeReviewed(agent, job.id)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(agent.get(job.id)?.artifacts).toEqual([path.join(repo, 'pages', 'note.md'), '/tmp/elsewhere/report.md'])
  expect(fs.existsSync(path.join(repo, 'pages', 'note.md'))).toBe(true)
})

it('moves to the repository on merge a file the CLI names by its real path while the job\'s folders were named through a symbolic link', async () => {
  const agent = await import('../src/main/services/agent')
  const alias = path.join(mocks.root, 'alias')
  fs.symlinkSync(mocks.root, alias, 'dir')
  const job = agent.startIsolated('修正する', { cwd: path.join(alias, 'repo'), worktreeRoot: path.join(alias, 'jobs') })
  fs.mkdirSync(path.join(job.cwd, 'pages'))
  fs.writeFileSync(path.join(job.cwd, 'pages', 'note.md'), 'hello\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'file-change', paths: [path.join(fs.realpathSync(job.cwd), 'pages', 'note.md')] })
  handlers.onExit(0)
  mergeReviewed(agent, job.id)
  const [artifact] = agent.get(job.id)!.artifacts!
  expect(fs.readFileSync(artifact, 'utf8')).toBe('hello\n')
  expect(fs.realpathSync.native(artifact)).toBe(path.join(repo, 'pages', 'note.md'))
})

it('lets the files card open what a merged job produced, in the repository where the merge put it', async () => {
  const agent = await import('../src/main/services/agent')
  const { allowedPath } = await import('../src/main/services/file-preview')
  const job = agent.startIsolated('docs/guide.md を書いて', { cwd: repo })
  fs.mkdirSync(path.join(job.cwd, 'docs'))
  const written = path.join(job.cwd, 'docs', 'guide.md')
  fs.writeFileSync(written, '# Guide\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'file-change', paths: [written] })
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(allowedPath(written, agent.allowedFileRoots())).not.toBeNull()
  mergeReviewed(agent, job.id)
  const [merged] = agent.get(job.id)!.artifacts!
  expect(merged).toBe(path.join(repo, 'docs', 'guide.md'))
  expect(allowedPath(merged, agent.allowedFileRoots())).not.toBeNull()
})

describe('a job that reports a file where the repository ignores it', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n.env\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-qm', 'ignore the build output')
  })

  /** Writes a report under dist/, which the repository ignores, and reports it as the agent's file-change does. */
  const writeReport = (cwd: string): string => {
    fs.mkdirSync(path.join(cwd, 'dist'))
    const report = path.join(cwd, 'dist', 'report.html')
    fs.writeFileSync(report, '<h1>the report the user asked for</h1>\n')
    mocks.launch.mock.calls[0][2].onEvent({ kind: 'file-change', paths: [report] })
    return report
  }

  it('keeps the worktree for the user, rather than removing it, when the report is all the job wrote', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('dist にレポートを書き出して', { cwd: repo })
    const report = writeReport(job.cwd)
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('pending')
    expect(fs.existsSync(report)).toBe(true)
    const review = agent.diff(job.id)
    expect(review.leftOut).toEqual(['dist/report.html'])
    expect(review.blocked).toBe(errorText('jobs.merging.noChanges', { id: job.id }))
    agent.discard(job.id)
    expect(fs.existsSync(report)).toBe(false)
  })

  it('names the report in the discard confirmation of a job kept for it alone, as what the discard deletes', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('dist にレポートを書き出して', { cwd: repo })
    writeReport(job.cwd)
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.worktree?.keptFor).toEqual(['dist/report.html'])
    const { jobTools } = await import('../src/main/services/brain/job-tools')
    const discard = jobTools('ja-JP').find((definition) => definition.name === 'discard_agent_job')!
    mocks.requestConfirm.mockResolvedValueOnce(false)
    await discard.run({ jobId: job.id }, {} as never, new AbortController().signal)
    const [asked] = mocks.requestConfirm.mock.calls[0] as [{ detail: string }]
    expect(asked.detail).toContain(ja('jobs.merging.leftOut', { paths: 'dist/report.html' }))
  })

  it('keeps the report its parent wrote when a continuation that wrote nothing settles in the same worktree', async () => {
    const agent = await import('../src/main/services/agent')
    const parent = agent.startIsolated('dist にレポートを書き出して', { cwd: repo })
    mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
    const report = writeReport(parent.cwd)
    mocks.launch.mock.calls[0][2].onExit(0)
    const child = await agent.continueJob(parent.id, 'レポートに何を書いたか教えて')
    mocks.launch.mock.calls[1][2].onExit(0)
    expect(agent.get(child.id)?.mergeState).toBe('pending')
    expect(fs.existsSync(report)).toBe(true)
    expect(agent.diff(child.id).leftOut).toEqual(['dist/report.html'])
  })

  it('lets the files card open a report the job wrote at the top of its worktree, outside the folder it worked in', async () => {
    fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'packages', 'web', 'index.ts'), 'export {}\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'package')
    const agent = await import('../src/main/services/agent')
    const { allowedPath } = await import('../src/main/services/file-preview')
    // Worktrees kept apart from the agent's folder, which the files card may read on its own.
    const worktreeRoot = path.join(mocks.root, 'elsewhere')
    const job = agent.startIsolated('dist にレポートを書き出して', { cwd: path.join(repo, 'packages', 'web'), worktreeRoot })
    const report = writeReport(job.worktree!.dir)
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('pending')
    expect(allowedPath(report, agent.allowedFileRoots())).not.toBeNull()
  })

  it('says in the merge confirmation that the report is not merged, and no longer lists it once the worktree is gone', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直して、dist にレポートも書き出して', { cwd: repo })
    writeReport(job.cwd)
    const fixed = path.join(job.cwd, 'tracked.txt')
    fs.writeFileSync(fixed, 'fixed\n')
    mocks.launch.mock.calls[0][2].onEvent({ kind: 'file-change', paths: [fixed] })
    mocks.launch.mock.calls[0][2].onExit(0)
    mocks.requestConfirm.mockResolvedValueOnce(true)
    await mergeThroughTool(job.id, agent.diff(job.id).commit)
    const [asked] = mocks.requestConfirm.mock.calls[0] as [{ detail: string }]
    expect(asked.detail).toContain(ja('jobs.merging.leftOut', { paths: 'dist/report.html' }))
    expect(agent.get(job.id)?.mergeState).toBe('merged')
    expect(agent.get(job.id)?.artifacts).toEqual([path.join(repo, 'tracked.txt')])
  })
})

it('names the files of a job as they are spelled, in the patch and in the merge confirmation', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('議事録をまとめて', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, '議事録.md'), '# 議事録\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  expect(review.patch).toContain('b/議事録.md')
  mocks.requestConfirm.mockResolvedValueOnce(false)
  await mergeThroughTool(job.id, review.commit)
  const [asked] = mocks.requestConfirm.mock.calls[0] as [{ detail: string }]
  expect(asked.detail).toContain('議事録.md |')
})

it('starts no job in a repository that ASIST\'s git refuses to open, and says why before asking', async () => {
  const { agentTool } = await import('../src/main/services/brain/job-tools')
  const ctx = { turnId: 1, emit: vi.fn(), signal: new AbortController().signal }
  mocks.differentOwner = true
  try {
    await expect(agentTool('ja-JP').run({ prompt: '直して', cwd: repo, readonly: false }, ctx as never, new AbortController().signal))
      .rejects.toThrow('dubious ownership')
  } finally {
    mocks.differentOwner = false
  }
  expect(mocks.requestConfirm).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('runs a read-only job in a repository that ASIST\'s git refuses to open, in the folder named, as in any folder', async () => {
  const { agentTool } = await import('../src/main/services/brain/job-tools')
  const ctx = { turnId: 1, emit: vi.fn(), signal: new AbortController().signal }
  mocks.requestConfirm.mockResolvedValueOnce(true)
  mocks.differentOwner = true
  try {
    await agentTool('ja-JP').run({ prompt: 'README を要約して', cwd: repo, readonly: true }, ctx as never, new AbortController().signal)
  } finally {
    mocks.differentOwner = false
  }
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({ cwd: repo, readonly: true })
  expect(mocks.launch.mock.calls[0][0].worktree).toBeUndefined()
})

it('merges a job that only changed the letter case of a file\'s name, as git itself does', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('tracked.txt を TRACKED.txt に改名して', { cwd: repo })
  git(job.cwd, 'mv', 'tracked.txt', 'TRACKED.txt')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  expect(review.blocked).toBeNull()
  agent.merge(job.id, review)
  expect(git(repo, 'ls-files')).toBe('TRACKED.txt')
})

it('refuses to merge a job that turned a folder into a file while the folder holds a file of the user\'s that git ignores', async () => {
  fs.writeFileSync(path.join(repo, '.gitignore'), 'local.json\n')
  fs.mkdirSync(path.join(repo, 'conf'))
  fs.writeFileSync(path.join(repo, 'conf', 'shared.json'), '{}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'settings')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('conf をひとつのファイルにまとめて', { cwd: repo })
  git(job.cwd, 'rm', '-rq', 'conf')
  fs.writeFileSync(path.join(job.cwd, 'conf'), 'all settings\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  fs.writeFileSync(path.join(repo, 'conf', 'local.json'), '{"key":"the user\'s"}\n')
  const review = agent.diff(job.id)
  const reason = errorText('jobs.merging.untrackedInTheWay', { paths: 'conf' })
  expect(review.blocked).toBe(reason)
  expect(() => agent.merge(job.id, review)).toThrow(reason)
  expect(fs.readFileSync(path.join(repo, 'conf', 'local.json'), 'utf8')).toBe('{"key":"the user\'s"}\n')
})

it('discards a job whose agent renamed the job\'s branch, and leaves the renamed branch with its commit', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('このブランチを feature/renamed にしてコミットして', { cwd: repo })
  git(job.cwd, 'branch', '-m', 'feature/renamed')
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'work\n')
  git(job.cwd, 'commit', '-qam', 'work')
  const agentCommit = git(repo, 'rev-parse', 'feature/renamed')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.worktree?.movedTo).toBe('feature/renamed')
  expect(agent.discardPreview(job.id).stat).toBe('')
  agent.discard(job.id)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(fs.existsSync(job.cwd)).toBe(false)
  expect(git(repo, 'rev-parse', 'feature/renamed')).toBe(agentCommit)
})

it('does not merge a job whose agent switched the worktree to a branch of its own, names that branch, and commits nothing onto it', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('feature/greeting ブランチを切って直し、コミットして', { cwd: repo })
  git(job.cwd, 'switch', '-q', '-c', 'feature/greeting')
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'hello\n')
  git(job.cwd, 'commit', '-qam', 'Say hello')
  fs.writeFileSync(path.join(job.cwd, 'notes.md'), 'left uncommitted\n')
  const agentCommit = git(repo, 'rev-parse', 'feature/greeting')
  mocks.launch.mock.calls[0][2].onExit(0)
  const { worktree, mergeState } = agent.get(job.id)!
  expect(mergeState).toBe('pending')
  expect(worktree?.movedTo).toBe('feature/greeting')
  const reason = errorText('jobs.merging.movedTo', { branch: 'feature/greeting', dir: worktree!.dir })
  expect(() => agent.diff(job.id)).toThrow(reason)
  expect(() => agent.merge(job.id, { commit: worktree!.commit!, base: worktree!.base, into: 'main' })).toThrow(reason)
  expect(git(repo, 'rev-parse', 'feature/greeting')).toBe(agentCommit)
  expect(git(job.cwd, 'status', '--porcelain')).toBe('?? notes.md')
  agent.discard(job.id)
  expect(git(repo, 'rev-parse', 'feature/greeting')).toBe(agentCommit)
})

it('refuses to merge a job that committed a file where the user keeps one git ignores, and leaves the user\'s file', async () => {
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-qm', 'ignore the local settings')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('.env を作ってコミットして', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, '.env'), 'FROM_THE_JOB=1\n')
  git(job.cwd, 'add', '-f', '.env')
  mocks.launch.mock.calls[0][2].onExit(0)
  fs.writeFileSync(path.join(repo, '.env'), 'THE_USERS_KEY=1\n')
  const review = agent.diff(job.id)
  const reason = errorText('jobs.merging.untrackedInTheWay', { paths: '.env' })
  expect(review.blocked).toBe(reason)
  expect(() => agent.merge(job.id, review)).toThrow(reason)
  expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toBe('THE_USERS_KEY=1\n')
})

it('reports a failure to remove the worktree after a merge, and keeps both the merged state and the worktree', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'merged\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  vi.spyOn(operations, 'worktreeRemove').mockImplementationOnce(() => { throw new Error('permission denied') })
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.removeFailed', { detail: 'permission denied' }))
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('merged\n')
  expect(fs.existsSync(job.cwd)).toBe(true)
})

it('takes a job whose merge reached the branch before ASIST ended as merged at the next start, without another commit', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  const written = path.join(job.cwd, 'new.txt')
  fs.writeFileSync(written, 'merged\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'file-change', paths: [written] })
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  // ASIST ends after git has merged the job and before the save that records the merge.
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (path.basename(String(to)) === 'jobs.json' && fs.readFileSync(from, 'utf8').includes('"mergeState":"merged"')) throw new Error('ASIST ended')
    rename(from, to)
  })
  expect(() => agent.merge(job.id, review)).toThrow('ASIST ended')
  vi.mocked(fs.renameSync).mockRestore()
  const merged = git(repo, 'rev-parse', 'HEAD')
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  expect(restored.get(job.id)?.mergeState).toBe('pending')
  const again = restored.diff(job.id)
  expect(again).toMatchObject({ blocked: null, alreadyMerged: true })
  mocks.requestConfirm.mockResolvedValueOnce(true)
  await mergeThroughTool(job.id, again.commit)
  const [asked] = mocks.requestConfirm.mock.calls[0] as [{ detail: string }]
  expect(asked.detail).toContain(ja('jobs.merging.alreadyMerged', { into: 'main' }))
  expect(restored.get(job.id)).toMatchObject({ mergeState: 'merged', artifacts: [path.join(repo, 'new.txt')] })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(merged)
  expect(fs.existsSync(job.worktree!.dir)).toBe(false)
  expect(git(repo, 'branch', '--list', job.worktree!.branch)).toBe('')
})

it('records a job whose commit the branch already holds as merged while the repository has uncommitted changes, and leaves them', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'merged\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  git(repo, 'merge', '-q', '--no-ff', '--no-edit', agent.get(job.id)!.worktree!.branch)
  const head = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'the user is editing\n')
  const review = agent.diff(job.id)
  expect(review).toMatchObject({ blocked: null, alreadyMerged: true })
  agent.merge(job.id, review)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('the user is editing\n')
})

it('refuses as having nothing to merge a job that committed nothing while the user moved the branch back and forth, and keeps it waiting', async () => {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'second\n')
  git(repo, 'commit', '-qam', 'second')
  const second = git(repo, 'rev-parse', 'HEAD')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('調べる', { cwd: repo })
  git(repo, 'reset', '-q', '--hard', 'HEAD~1')
  mocks.launch.mock.calls[0][2].onExit(0)
  git(repo, 'reset', '-q', '--hard', second)
  const review = agent.diff(job.id)
  expect(review).toMatchObject({ alreadyMerged: false, blocked: errorText('jobs.merging.noChanges', { id: job.id }) })
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.noChanges', { id: job.id }))
  expect(agent.get(job.id)?.mergeState).toBe('pending')
})

it('blocks worktree operations on the parent while a continuation runs, and refuses a second continuation', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  handlers.onExit(0)
  const review = agent.diff(parent.id)
  const child = await agent.continueJob(parent.id, 'テストも足す')
  fs.writeFileSync(path.join(child.cwd, 'child.txt'), 'child\n')
  expect(() => agent.discard(parent.id)).toThrow()
  expect(() => agent.merge(parent.id, review)).toThrow()
  await expect(agent.continueJob(parent.id, 'もう一つ')).rejects.toThrow()
  expect(fs.readFileSync(path.join(child.cwd, 'child.txt'), 'utf8')).toBe('child\n')
  mocks.launch.mock.calls[1][2].onExit(0)
  const childReview = agent.diff(child.id)
  agent.merge(child.id, childReview)
  expect(fs.readFileSync(path.join(repo, 'parent.txt'), 'utf8')).toBe('parent\n')
  expect(fs.readFileSync(path.join(repo, 'child.txt'), 'utf8')).toBe('child\n')
})

it('hands the output of a conflicting worktree to the continuation', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'tracked.txt'), 'agent changes\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  handlers.onExit(0)
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user changes\n')
  git(repo, 'commit', '-qam', 'user edit')
  mergeReviewed(agent, parent.id)
  expect(agent.get(parent.id)?.mergeState).toBe('conflict')
  const child = await agent.continueJob(parent.id, '衝突を解決する')
  expect(fs.readFileSync(path.join(child.cwd, 'tracked.txt'), 'utf8')).toBe('agent changes\n')
  expect(child.cwd).toBe(parent.cwd)
})

it('persists the transfer of ownership so parent and child do not both hold the worktree after a restart', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  mocks.launch.mock.calls[0][2].onExit(0)
  const child = await agent.continueJob(parent.id, 'テストも足す')
  fs.writeFileSync(path.join(child.cwd, 'child.txt'), 'child\n')
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  expect(restored.get(parent.id)?.worktree).toBeUndefined()
  expect(restored.diff(child.id).patch).toContain('+child')
  expect(() => restored.discard(parent.id)).toThrow()
  expect(fs.existsSync(child.cwd)).toBe(true)
})

it('returns ownership to the parent and starts no continuation process when the transfer cannot be saved', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  mocks.launch.mock.calls[0][2].onExit(0)
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })
  await expect(agent.continueJob(parent.id, 'テストも足す')).rejects.toThrow('disk full')
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(agent.list()).toHaveLength(1)
  expect(agent.diff(parent.id).patch).toContain('+parent')
})

it('keeps the whole log readable after a restart that appended a line to it', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'assistant-text', text: '再起動の前' })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'x\n')
  const before = agent.getLog(job.id)
  // The restart settles the worktree the process left behind, which adds a line before anyone reads the log.
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  expect(restored.get(job.id)?.mergeState).toBe('pending')
  const after = restored.getLog(job.id)
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after.length).toBeGreaterThan(before.length)
})

it('runs a job started for a folder inside a repository in that folder of the worktree, and merges it back there', async () => {
  fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'packages', 'web', 'index.ts'), 'export {}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'package')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('このフォルダのテストを直す', { cwd: path.join(repo, 'packages', 'web') })
  expect(mocks.launch.mock.calls[0][0].cwd).toBe(path.join(job.worktree!.dir, 'packages', 'web'))
  fs.writeFileSync(path.join(job.cwd, 'index.test.ts'), 'test\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  handlers.onEvent({ kind: 'file-change', paths: [path.join(job.cwd, 'index.test.ts')] })
  handlers.onExit(0)
  mergeReviewed(agent, job.id)
  expect(fs.readFileSync(path.join(repo, 'packages', 'web', 'index.test.ts'), 'utf8')).toBe('test\n')
  expect(agent.get(job.id)?.artifacts).toEqual([path.join(repo, 'packages', 'web', 'index.test.ts')])
  expect(fs.existsSync(job.worktree!.dir)).toBe(false)
  // Once merged, the job carries on in a fresh worktree, in the same folder.
  const next = await agent.continueJob(job.id, '続き')
  expect(path.relative(next.worktree!.dir, next.cwd)).toBe(path.join('packages', 'web'))
  expect(fs.existsSync(path.join(next.cwd, 'index.test.ts'))).toBe(true)
})

it('refuses a folder that is not committed and leaves no worktree or branch behind', async () => {
  fs.mkdirSync(path.join(repo, 'drafts'))
  fs.writeFileSync(path.join(repo, 'drafts', 'note.md'), 'untracked\n')
  const agent = await import('../src/main/services/agent')
  const named = path.join(repo, 'drafts')
  expect(() => agent.startIsolated('下書きを直す', { cwd: named })).toThrow(errorText('jobs.start.folderNotCommitted', { path: named }))
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(git(repo, 'branch', '--list', 'asist/*')).toBe('')
  expect(agent.list()).toEqual([])
})

it.each([
  ['a post-checkout hook fails', (): void => {
    // The hook Git LFS installs exits 2 when an app opened from Finder has no git-lfs on its PATH.
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
  }, {}],
  ['preparing the worktree fails', (): void => {}, { prepareWorktree: (): void => { throw new Error('skill missing') } }],
  ['the new job cannot be saved', (): void => {
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })
  }, {}]
])('starts nothing and leaves no worktree, branch or running job behind when %s', async (_case, arrange, options) => {
  const agent = await import('../src/main/services/agent')
  agent.list()
  arrange()
  expect(() => agent.startIsolated('修正する', { cwd: repo, ...options })).toThrow()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(agent.list()).toEqual([])
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(git(repo, 'branch', '--list', 'asist/*')).toBe('')
})

it('shows the folder, the branch and the changes a discard removes, and then removes exactly those', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'thrown away\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const worktree = agent.get(job.id)!.worktree!
  const preview = agent.discardPreview(job.id)
  expect(preview).toMatchObject({ repo, dir: worktree.dir, branch: worktree.branch })
  expect(preview.stat).toContain('new.txt')
  agent.discard(job.id)
  expect(fs.existsSync(worktree.dir)).toBe(false)
  expect(git(repo, 'branch', '--list', worktree.branch)).toBe('')
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
})

it.each([
  ['merged', (agent: typeof import('../src/main/services/agent'), id: string): void => {
    mergeReviewed(agent, id)
  }],
  ['already discarded', (agent: typeof import('../src/main/services/agent'), id: string): void => {
    agent.discard(id)
  }]
])('refuses to discard a job whose changes were %s, so the user is not asked about changes that are gone', async (_case, settle) => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'changed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  settle(agent, job.id)
  const nothing = errorText('jobs.discard.noChanges', { id: job.id })
  expect(() => agent.discardPreview(job.id)).toThrow(nothing)
  expect(() => agent.discard(job.id)).toThrow(nothing)
})

it('names the branch checked out in the repository as the one a merge goes into, and merges into a branch cut from the same commit once it was reviewed there', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.diff(job.id).into).toBe('main')
  const main = git(repo, 'rev-parse', 'main')
  git(repo, 'switch', '-q', '-c', 'hotfix')
  const review = agent.diff(job.id)
  expect(review.into).toBe('hotfix')
  agent.merge(job.id, review)
  expect(git(repo, 'show', 'hotfix:new.txt')).toBe('from job')
  expect(git(repo, 'rev-parse', 'main')).toBe(main)
})

it('refuses to merge while the repository is in the middle of a bisect, and keeps the job\'s branch and worktree', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  for (const message of ['second', 'third']) git(repo, 'commit', '-q', '--allow-empty', '-m', message)
  const main = git(repo, 'rev-parse', 'main')
  git(repo, 'bisect', 'start', 'HEAD', 'HEAD~2')
  const review = agent.diff(job.id)
  expect(review.into).toBeNull()
  expect(review.blocked).toBe(errorText('jobs.merging.detached'))
  expect(review.stat).toContain('new.txt')
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.detached'))
  git(repo, 'bisect', 'reset')
  expect(git(repo, 'rev-parse', 'main')).toBe(main)
  const { branch } = agent.get(job.id)!.worktree!
  expect(git(repo, 'branch', '--list', branch)).toContain(branch)
  expect(fs.existsSync(job.cwd)).toBe(true)
  expect(agent.get(job.id)?.mergeState).toBe('pending')
})

it('refuses the merge the card sends when a branch cut from the same commit was checked out after the review, and leaves that branch as it was', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  expect(review.into).toBe('main')
  git(repo, 'switch', '-q', '-c', 'hotfix')
  const hotfix = git(repo, 'rev-parse', 'hotfix')
  const shown = { commit: review.commit, base: review.base, into: review.into }
  expect(() => agent.merge(job.id, shown)).toThrow(errorText('jobs.merging.baseChanged'))
  expect(git(repo, 'rev-parse', 'hotfix')).toBe(hotfix)
  expect(agent.get(job.id)?.mergeState).toBe('pending')
  expect(fs.existsSync(job.cwd)).toBe(true)
})

it('refuses merge_agent_job when a branch cut from the same commit is checked out while its confirmation is open', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const { commit } = agent.diff(job.id)
  mocks.requestConfirm.mockImplementationOnce(async (request: { detail: string }) => {
    expect(request.detail).toContain(ja('jobs.confirm.mergeInto', { into: 'main', repo }))
    git(repo, 'switch', '-q', '-c', 'hotfix')
    return true
  })
  await expect(mergeThroughTool(job.id, commit)).rejects.toThrow(ja('jobs.merging.baseChanged'))
  expect(mocks.requestConfirm).toHaveBeenCalledTimes(1)
  expect(git(repo, 'rev-parse', 'hotfix')).toBe(git(repo, 'rev-parse', 'main'))
  expect(agent.get(job.id)?.mergeState).toBe('pending')
})

it('refuses merge_agent_job before asking while HEAD is not on a branch', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  git(repo, 'switch', '-q', '--detach')
  const head = git(repo, 'rev-parse', 'HEAD')
  await expect(mergeThroughTool(job.id, agent.diff(job.id).commit)).rejects.toThrow(ja('jobs.merging.detached'))
  expect(mocks.requestConfirm).not.toHaveBeenCalled()
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.existsSync(job.cwd)).toBe(true)
})

it('warns before discarding a job whose worktree came to hold a staged move of a submodule after it settled', async () => {
  const sub = path.join(mocks.root, 'sub')
  fs.mkdirSync(sub)
  git(sub, 'init', '-q', '-b', 'main')
  git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 's')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub')
  git(repo, 'commit', '-qm', 'submodule')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.discardPreview(job.id).submodules).toEqual([])
  git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
  git(job.cwd, 'update-index', '--cacheinfo', `160000,${git(sub, 'rev-parse', 'HEAD')},vendor/sub`)
  expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
})

it('refuses to discard a job that changed nothing', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('unchanged')
  expect(() => agent.discardPreview(job.id)).toThrow(errorText('jobs.discard.noChanges', { id: job.id }))
})

it('reports a job state that cannot be saved while the agent runs in its log instead of throwing into the output listener', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })
  expect(() => mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })).not.toThrow()
  const texts = agent.getLog(job.id).map((line) => ('text' in line.event ? line.event.text : ''))
  expect(texts).toContain(ja('jobs.log.saveFailed', { detail: 'disk full' }))
})

it('settles a job whose agent staged a change and then undid it on disk, instead of leaving it uncommitted for good', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  git(job.cwd, 'add', '-A')
  git(job.cwd, 'commit', '-qm', 'agent work')
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'tried something\n')
  git(job.cwd, 'add', 'tracked.txt')
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'base\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  mergeReviewed(agent, job.id)
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('from job\n')
})

it('refuses a merge once another branch is checked out than the one its diff was counted against, and shows the new diff', async () => {
  git(repo, 'branch', 'old')
  fs.writeFileSync(path.join(repo, 'main-only.txt'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'main only')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  expect(review.stat).not.toContain('main-only.txt')
  git(repo, 'checkout', '-q', 'old')
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.baseChanged'))
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
  expect(agent.diff(job.id).stat).toContain('main-only.txt')
})

it('settles a job while the repository has a branch with no history in common checked out, and says why it cannot be merged there', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  git(repo, 'checkout', '-q', '--orphan', 'gh-pages')
  git(repo, 'rm', '-q', '-rf', '.')
  fs.writeFileSync(path.join(repo, 'index.html'), 'pages\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'pages')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('pending')
  expect(() => agent.diff(job.id)).toThrow(errorText('jobs.merging.noCommonHistory'))
  expect(agent.discardPreview(job.id).stat).toContain('new.txt')
  agent.discard(job.id)
  expect(fs.existsSync(job.cwd)).toBe(false)
})

it('keeps and offers a job that only added a new file although status.showUntrackedFiles=no hides new files', async () => {
  git(repo, 'config', 'status.showUntrackedFiles', 'no')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new-feature.ts'), 'export const x = 1\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('pending')
  const review = agent.diff(job.id)
  expect(review.stat).toContain('new-feature.ts')
  // A file that appears in the worktree after the review is not merged, and the merge is refused.
  fs.writeFileSync(path.join(job.cwd, 'notes.md'), 'written after the review\n')
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.worktree.uncommitted'))
  expect(fs.existsSync(path.join(job.cwd, 'notes.md'))).toBe(true)
})

it('says that a worktree deleted by hand is gone, settles it only once, and discards the job with its branch', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  const { dir, branch } = agent.get(job.id)!.worktree!
  fs.rmSync(dir, { recursive: true, force: true })
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('error')
  const gone = errorText('jobs.worktree.gone', { dir, branch })
  expect(() => agent.diff(job.id)).toThrow(gone)
  expect(() => agent.diff(job.id)).toThrow(gone)
  const failures = agent.getLog(job.id).filter(({ event }) => event.kind === 'stderr' && event.text === ja('jobs.worktree.settleFailed', { detail: ja('jobs.worktree.gone', { dir, branch }) }))
  expect(failures).toHaveLength(1)
  agent.discard(job.id)
  expect(agent.get(job.id)?.mergeState).toBe('discarded')
  expect(git(repo, 'branch', '--list', branch)).toBe('')
})

it('discards a job waiting to be merged whose worktree was deleted by hand and pruned', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'from job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const { dir, branch } = agent.get(job.id)!.worktree!
  fs.rmSync(dir, { recursive: true, force: true })
  git(repo, 'worktree', 'prune')
  expect(() => agent.diff(job.id)).toThrow(errorText('jobs.worktree.gone', { dir, branch }))
  expect(agent.discardPreview(job.id).stat).toContain('new.txt')
  agent.discard(job.id)
  expect(git(repo, 'branch', '--list', branch)).toBe('')
})

it('merges an edit that core.ignoreStat in the repository hid, and refuses the merge while a file differs from the review', async () => {
  git(repo, 'config', 'core.ignoreStat', 'true')
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('pending')
  const review = agent.diff(job.id)
  expect(review.patch).toContain('+changed')
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed after the review\n')
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.worktree.uncommitted'))
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed\n')
  agent.merge(job.id, review)
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
})

it('refuses to merge over an uncommitted edit of the user\'s that a fsmonitor hook missed, and keeps the edit', async () => {
  // A hook that answers every query with a fresh token and no changed path, as one that lost its events does.
  const hook = path.join(mocks.root, 'fsmonitor')
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "token-1\\0"\n', { mode: 0o755 })
  git(repo, 'config', 'core.fsmonitor', shellPath(hook))
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed by the job\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  git(repo, 'status', '--porcelain')
  git(repo, 'status', '--porcelain')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'the user\'s edit\n')
  expect(agent.diff(job.id).blocked).toBe(errorText('jobs.merging.dirtyRepo'))
  expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.dirtyRepo'))
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('the user\'s edit\n')
})

describe('a repository with a sparse checkout of src/', () => {
  let before = ''
  beforeEach(() => {
    for (const file of ['src/a.txt', 'src/b.txt', 'docs/x.txt', 'docs/y.txt']) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      fs.writeFileSync(path.join(repo, file), `${file}\n`)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'tree')
    git(repo, 'sparse-checkout', 'set', '--cone', 'src')
    before = git(repo, 'rev-parse', 'HEAD')
  })

  it('merges the edits of a job inside the checkout and outside it, and deletes none of the files it leaves out', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('修正する', { cwd: repo })
    const { dir } = agent.get(job.id)!.worktree!
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'edited inside\n')
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'x.txt'), 'edited outside\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    mergeReviewed(agent, job.id)
    expect(git(repo, 'diff', '--name-status', before, 'HEAD')).toBe('M\tdocs/x.txt\nM\tsrc/a.txt')
    expect(git(repo, 'show', 'HEAD:docs/x.txt')).toBe('edited outside')
  })

  it('keeps the worktree of a job with a file inside the checkout absent behind skip-worktree, and settles it once the file is checked out again', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('修正する', { cwd: repo })
    const { dir } = agent.get(job.id)!.worktree!
    git(dir, 'update-index', '--skip-worktree', 'src/b.txt')
    fs.rmSync(path.join(dir, 'src', 'b.txt'))
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'edited inside\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('error')
    const reason = ja('jobs.worktree.settleFailed', { detail: ja('jobs.worktree.skippedMissing', { paths: 'src/b.txt', dir }) })
    expect(agent.getLog(job.id).some(({ event }) => event.kind === 'stderr' && event.text === reason)).toBe(true)
    expect(fs.existsSync(dir)).toBe(true)
    git(dir, 'sparse-checkout', 'reapply')
    mergeReviewed(agent, job.id)
    expect(git(repo, 'diff', '--name-status', before, 'HEAD')).toBe('M\tsrc/a.txt')
  })
})

describe('a repository with a submodule', () => {
  beforeEach(() => {
    const sub = path.join(mocks.root, 'sub')
    fs.mkdirSync(sub)
    git(sub, 'init', '-q', '-b', 'main')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 's')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub')
    git(repo, 'commit', '-qm', 'submodule')
  })

  it('keeps the worktree of a job whose agent only initialized the submodule, since the commits of its repository may exist nowhere else', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not tell that the branch holds the changes of a job that only initialized the submodule and committed nothing', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.diff(job.id).alreadyMerged).toBe(false)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('refuses to merge a job that touched the submodule once the user merged its branch, and keeps its worktree', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    git(repo, 'merge', '-q', '--no-edit', agent.get(job.id)!.worktree!.branch)
    expect(agent.diff(job.id).alreadyMerged).toBe(true)
    expectRefused(agent, job.id, ['vendor/sub'], git(repo, 'rev-parse', 'HEAD'))
  })

  it('keeps the worktree of a job that committed inside the submodule and deinitialized it, whose repository outlasts the deinit', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    const pinned = git(inside, 'rev-parse', 'HEAD')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent work')
    const onlyCopy = git(inside, 'rev-parse', '--absolute-git-dir')
    git(inside, 'checkout', '-q', pinned)
    git(job.cwd, 'submodule', 'deinit', '-q', '-f', 'vendor/sub')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(fs.existsSync(onlyCopy)).toBe(true)
  })

  it('warns before discarding a job whose settling failed while its submodule holds a commit', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent work')
    // An empty repository nested in the worktree makes `git add -A` fail, so the job cannot settle.
    git(job.cwd, 'init', '-q', 'scratch')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('error')
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
  })

  it('has nothing to warn about before discarding a job whose worktree folder is gone', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
    fs.rmSync(job.cwd, { recursive: true, force: true })
    expect(agent.discardPreview(job.id).submodules).toEqual([])
    agent.discard(job.id)
    expect(agent.get(job.id)?.mergeState).toBe('discarded')
  })

  it('does not merge a job that wrote into the folder of a submodule that is not initialized, and keeps its worktree', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    // In a new worktree the submodule is not initialized, and git does not look inside its empty folder.
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('keeps the worktree of a job whose only change is a commit inside a submodule, which has no other copy, and does not merge it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'fix.txt'), 'fixed by the agent\n')
    git(inside, 'add', 'fix.txt')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix')
    const onlyCopy = git(inside, 'rev-parse', '--absolute-git-dir')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(fs.existsSync(onlyCopy)).toBe(true)
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
  })

  it('tells in the log of a job that touched a submodule only that the user merges or discards it, not that it waits to be merged', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    const { branch, dir } = agent.get(job.id)!.worktree!
    const texts = agent.getLog(job.id).map((line) => ('text' in line.event ? line.event.text : ''))
    expect(texts).toContain(ja('jobs.merging.submodules', { paths: 'vendor/sub', branch, dir }))
    expect(texts).not.toContain(ja('jobs.worktree.committed'))
  })

  it('keeps a submodule bump the user made on main when the agent merged main into its branch, and shows only the agent\'s change', async () => {
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    // The user moves the submodule on main while the job runs.
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'bump the submodule')
    const bumped = git(repo, 'rev-parse', 'HEAD:vendor/sub')
    // The agent brings main into its branch, as a job resolving a conflict does.
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'main')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.patch).not.toContain('Subproject commit')
    expect(review.stat).toContain('tracked.txt')
    expect(review.submodules).toEqual([])
    agent.merge(job.id, review)
    expect(git(repo, 'rev-parse', 'HEAD:vendor/sub')).toBe(bumped)
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('fixed\n')
  })

  it('keeps a submodule the user added on main when the agent rebased its branch onto main', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', path.join(mocks.root, 'sub'), 'vendor/added')
    git(repo, 'commit', '-qm', 'add a submodule')
    const gitmodules = fs.readFileSync(path.join(repo, '.gitmodules'), 'utf8')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'rebase', '-q', 'main')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.stat).not.toContain('.gitmodules')
    expect(review.submodules).toEqual([])
    agent.merge(job.id, review)
    expect(fs.readFileSync(path.join(repo, '.gitmodules'), 'utf8')).toBe(gitmodules)
    expect(git(repo, 'ls-tree', '--name-only', 'HEAD', 'vendor/added')).toBe('vendor/added')
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('fixed\n')
  })

  it('shows a review as blocked by work that appeared in a submodule of the worktree after the job settled, as the merge refuses it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.diff(job.id).blocked).toBeNull()
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written after the job settled\n')
    expect(agent.diff(job.id).blocked).toBe(
      errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch: job.worktree!.branch, dir: job.worktree!.dir })
    )
    await expect(mergeThroughTool(job.id, agent.diff(job.id).commit)).rejects.toThrow(ja('jobs.merging.submodules', { paths: 'vendor/sub', branch: job.worktree!.branch, dir: job.worktree!.dir }))
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it.each(['all', 'dirty', 'untracked'])('does not merge a job that changed a submodule whose ignore setting is %s, and keeps its worktree', async (mode) => {
    const lib = path.join(mocks.root, 'lib')
    fs.mkdirSync(lib)
    git(lib, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(lib, 'lib.txt'), 'lib\n')
    git(lib, 'add', '.')
    git(lib, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
    git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/lib.ignore', mode)
    git(repo, 'add', '.gitmodules')
    git(repo, 'commit', '-qm', 'a submodule whose changes git is told to ignore')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', 'vendor/lib')
    const inside = path.join(job.cwd, 'vendor', 'lib')
    if (mode === 'all') {
      fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
    } else if (mode === 'dirty') {
      fs.writeFileSync(path.join(inside, 'lib.txt'), 'edited, not committed\n')
    } else {
      fs.writeFileSync(path.join(inside, 'new.txt'), 'a new file\n')
    }
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/lib'], head)
  })

  it('does not merge a job that changed a submodule while diff.ignoreSubmodules hides such changes, and keeps its worktree', async () => {
    git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'new.txt'), 'a new file\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that took in another branch which moved a submodule, and leaves the user\'s branch as it was', async () => {
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    // A branch the user has not merged, such as an upstream one, moves the submodule.
    git(repo, 'checkout', '-q', '-b', 'upstream')
    git(repo, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(repo, 'up.txt'), 'upstream\n')
    git(repo, 'add', 'up.txt')
    git(repo, 'commit', '-qm', 'upstream moves the submodule')
    git(repo, 'checkout', '-q', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'upstream')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that settled while a branch was checked out against which a submodule moved, even back on the first branch', async () => {
    git(repo, 'branch', 'release')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'bump the submodule')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(repo, 'checkout', '-q', 'release')
    mocks.launch.mock.calls[0][2].onExit(0)
    git(repo, 'checkout', '-q', 'main')
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('settles again a job that version 3 of the history kept as waiting to be merged, so that work only its worktree holds is not deleted by a merge', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    // What the code of version 3 did when the job ended: commit what git shows, and wait for the merge.
    git(job.cwd, 'add', '-A')
    git(job.cwd, 'commit', '-qm', 'asist: 直す')
    const file = path.join(mocks.root, 'data', 'jobs.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    const saved = stored.jobs.find((entry) => entry.id === job.id)!
    Object.assign(saved, { status: 'done', endedAt: Date.now(), mergeState: 'pending' })
    saved.worktree = { ...(saved.worktree as object), commit: git(job.cwd, 'rev-parse', 'HEAD') }
    fs.writeFileSync(file, JSON.stringify({ ...stored, version: 3 }))
    vi.resetModules()
    const restored = await import('../src/main/services/agent')
    expectRefused(restored, job.id, ['vendor/sub'], head)
  })

  it.each(['gitmodules', 'config'])('keeps the worktree of a job that only moved a submodule while an ignore setting in %s hides it from git diff', async (where) => {
    fs.writeFileSync(path.join(mocks.root, 'sub', 'lib.txt'), 'lib\n')
    git(path.join(mocks.root, 'sub'), 'add', '.')
    git(path.join(mocks.root, 'sub'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'the submodule with a file')
    if (where === 'gitmodules') {
      git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all')
      git(repo, 'add', '.gitmodules')
      git(repo, 'commit', '-qm', 'ignore the submodule')
    } else {
      git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    }
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
    git(job.cwd, 'add', '-f', 'vendor/sub')
    git(job.cwd, 'commit', '-qm', 'move the submodule')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that moved a submodule beside another change while diff.ignoreSubmodules hides the move', async () => {
    git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'move the submodule and fix')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(git(repo, 'rev-parse', 'HEAD:vendor/sub')).not.toBe(v2)
  })

  it('does not merge a job that took in a branch which moved a submodule whose ignore setting in .gitmodules is all', async () => {
    git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all')
    git(repo, 'add', '.gitmodules')
    git(repo, 'commit', '-qm', 'ignore the submodule')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', '-b', 'upstream')
    git(repo, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(repo, 'up.txt'), 'upstream\n')
    git(repo, 'add', 'up.txt')
    git(repo, 'commit', '-qm', 'upstream moves the submodule')
    git(repo, 'checkout', '-q', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'upstream')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it.each(['side branch', 'stash'])('keeps the worktree of a job whose submodule holds work its remote lacks on a %s, with the pinned commit checked out again', async (kind) => {
    fs.writeFileSync(path.join(mocks.root, 'sub', 'lib.txt'), 'lib\n')
    git(path.join(mocks.root, 'sub'), 'add', '.')
    git(path.join(mocks.root, 'sub'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'the submodule with a file')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
    if (kind === 'side branch') {
      git(inside, 'checkout', '-q', '-b', 'feature')
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
      git(inside, 'checkout', '-q', '-')
    } else {
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'stash', '-q')
    }
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('pending')
    expect(agent.get(job.id)?.worktree?.submodules).toEqual(['vendor/sub'])
    expect(fs.existsSync(inside)).toBe(true)
  })

  it('keeps the worktree of a job from version 3 whose branch the user merged by hand, since the commit its submodule points to is only there', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'fix.txt'), 'fixed by the agent\n')
    git(inside, 'add', 'fix.txt')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix')
    const fix = git(inside, 'rev-parse', 'HEAD')
    git(job.cwd, 'add', '-A')
    git(job.cwd, 'commit', '-qm', 'asist: 直す')
    const file = path.join(mocks.root, 'data', 'jobs.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    const saved = stored.jobs.find((entry) => entry.id === job.id)!
    Object.assign(saved, { status: 'done', endedAt: Date.now(), mergeState: 'pending' })
    saved.worktree = { ...(saved.worktree as object), commit: git(job.cwd, 'rev-parse', 'HEAD') }
    fs.writeFileSync(file, JSON.stringify({ ...stored, version: 3 }))
    const branch = (saved.worktree as { branch: string }).branch
    git(repo, 'merge', '-q', '--no-edit', branch)
    vi.resetModules()
    const restored = await import('../src/main/services/agent')
    expect(restored.get(job.id)?.mergeState).toBe('pending')
    expect(git(inside, 'cat-file', '-t', fix)).toBe('commit')
  })

  it.each([false, true])('keeps the worktree of a job that wrote into the folder of a repository its index holds but .gitmodules does not name, beside another change: %s', async (beside) => {
    git(repo, '-c', 'protocol.file.allow=always', 'clone', '-q', path.join(mocks.root, 'sub'), 'tools/dep')
    git(repo, 'add', 'tools/dep')
    git(repo, 'commit', '-qm', 'a repository added without git submodule add')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tools', 'dep', 'patch.txt'), 'written by the agent\n')
    if (beside) fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['tools/dep'], head)
    expect(fs.existsSync(path.join(job.cwd, 'tools', 'dep', 'patch.txt'))).toBe(true)
  })

  it('refuses a merge whose worktree came to hold submodule work after the job settled, since the merge removes the worktree', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.submodules).toEqual([])
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    git(inside, 'checkout', '-q', '-b', 'later')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'later work')
    git(inside, 'checkout', '-q', '-')
    const { branch, dir } = agent.get(job.id)!.worktree!
    expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch, dir }))
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(fs.existsSync(inside)).toBe(true)
  })
})
