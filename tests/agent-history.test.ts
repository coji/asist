import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentJob } from '@shared/ipc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobLogFile } from '../src/main/services/job-history'

const mocks = vi.hoisted(() => ({ root: '', launch: vi.fn(), removeWorktree: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => path.join(mocks.root, 'data') } }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/agent' }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'readonly', agentCwd: mocks.root, uiLocale: 'ja-JP' })
}))
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/git', () => ({ toplevel: () => null, worktreeRemove: mocks.removeWorktree }))

beforeEach(() => {
  vi.resetModules()
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-agent-history-'))
  fs.mkdirSync(path.join(mocks.root, 'data'))
  mocks.launch.mockReset().mockImplementation(() => ({ stop: vi.fn(), completion: Promise.resolve() }))
  mocks.removeWorktree.mockReset()
  let time = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => time++)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(mocks.root, { recursive: true, force: true })
})

const settings = (): { cwd: string; noteProject: false } => ({ cwd: mocks.root, noteProject: false })
const historyFile = (): string => path.join(mocks.root, 'data', 'jobs.json')
const logFile = (id: string): string => path.join(mocks.root, 'data', jobLogFile(id))
const readSaved = (): AgentJob[] => (JSON.parse(fs.readFileSync(historyFile(), 'utf8')) as { jobs: AgentJob[] }).jobs

describe('agent history ownership', () => {
  it('keeps a running job reachable and stoppable after more than 50 finished jobs pile up', async () => {
    const agent = await import('../src/main/services/agent')
    const active = agent.start('long running', settings())
    const stop = mocks.launch.mock.results[0].value.stop
    const finished: string[] = []
    for (let index = 0; index < 55; index++) {
      const job = agent.start(`short ${index}`, settings())
      finished.push(job.id)
      const handlers = mocks.launch.mock.calls.at(-1)![2]
      handlers.onEvent({ kind: 'result', ok: true, summary: 'done' })
      handlers.onExit(0)
    }

    expect(agent.get(active.id)?.status).toBe('running')
    expect(agent.list()).toHaveLength(51)
    expect(agent.getLog(active.id).length).toBeGreaterThan(0)
    agent.cancel(active.id)
    expect(stop).toHaveBeenCalledOnce()
    expect(agent.get(active.id)?.status).toBe('stopping')
    expect(fs.existsSync(logFile(active.id))).toBe(true)
    expect(fs.existsSync(logFile(finished[0]))).toBe(false)
    expect(readSaved().some((job) => job.id === active.id && job.status === 'stopping')).toBe(true)
  })

  it('keeps an old unmerged worktree across a restart so it can still be handled', async () => {
    const saved: AgentJob[] = Array.from({ length: 51 }, (_, index) => ({
      id: `done-${index}`, title: 'done', prompt: 'done', cwd: mocks.root, readonly: true,
      engine: 'codex', status: 'done', startedAt: 100 + index
    }))
    saved.push({ id: 'unmerged', title: 'unmerged', prompt: 'edit', cwd: mocks.root, readonly: false,
      engine: 'codex', status: 'done', startedAt: 1, mergeState: 'conflict',
      worktree: { repo: '/repo', branch: 'branch', base: 'base', commit: 'commit' } })
    fs.writeFileSync(historyFile(), JSON.stringify(saved))
    const agent = await import('../src/main/services/agent')
    expect(agent.get('unmerged')?.mergeState).toBe('conflict')
    expect(readSaved()).toHaveLength(51)
    agent.discard('unmerged')
    // The history was written before the worktree kept its own path, when every job ran at its top.
    expect(mocks.removeWorktree).toHaveBeenCalledWith('/repo', mocks.root, 'branch')
    expect(agent.get('unmerged')?.mergeState).toBe('discarded')
  })

  it('propagates a save failure to the caller and prunes neither the in-memory jobs nor the logs', async () => {
    const agent = await import('../src/main/services/agent')
    const finished: string[] = []
    for (let index = 0; index < 50; index++) {
      const job = agent.start(`short ${index}`, settings())
      finished.push(job.id)
      mocks.launch.mock.calls.at(-1)![2].onExit(0)
    }
    const current = agent.start('new', settings())
    const source = fs.readFileSync(historyFile(), 'utf8')
    const oldLog = fs.readFileSync(logFile(finished[0]), 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => mocks.launch.mock.calls.at(-1)![2].onExit(0)).toThrow('disk full')

    expect(agent.get(finished[0])).toBeDefined()
    expect(agent.get(current.id)).toBeDefined()
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(source)
    expect(fs.readFileSync(logFile(finished[0]), 'utf8')).toBe(oldLog)
  })

  it('starts nothing and keeps the file as it is when the stored history is corrupt', async () => {
    fs.writeFileSync(historyFile(), '{broken')
    const agent = await import('../src/main/services/agent')
    // The parse failure of the broken file cannot be reproduced here, so the error is matched by the
    // message it carries rather than by its whole text.
    expect(() => agent.start('new job', settings())).toThrow(/\[asist:jobs\.history\.invalid\b/)
    expect(() => agent.list()).toThrow(/\[asist:jobs\.history\.invalid\b/)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe('{broken')

    fs.writeFileSync(historyFile(), '[]')
    expect(agent.start('retry', settings()).status).toBe('running')
  })
})
