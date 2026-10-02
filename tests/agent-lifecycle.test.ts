import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'

const ja = createTranslator('ja-JP')
const mocks = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/codex' }))
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }))
vi.mock('../src/main/services/store', () => ({
  readJsonl: () => [], appendJsonl: vi.fn()
}))
vi.mock('../src/main/services/job-history', () => ({
  readJobHistory: () => [], writeJobHistory: () => [], jobLogFile: (id: string) => `joblogs/${id}.events.jsonl`
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'readonly', agentCwd: '/workspace', uiLocale: 'ja-JP' })
}))
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/git', () => ({ toplevel: () => null }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.launch.mockReturnValue({ stop: mocks.kill, completion: Promise.resolve() })
})

const options = { cwd: '/workspace', noteProject: false }

describe('starting an agent', () => {
  it('records the failure reason instead of leaving the job running when the launch throws synchronously', async () => {
    mocks.launch.mockImplementation(() => { throw new Error('CLI unavailable') })
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    expect(job).toMatchObject({ status: 'error', summary: ja('jobs.log.startFailed', { detail: 'CLI unavailable' }) })
    expect(agent.get(job.id)?.endedAt).toEqual(expect.any(Number))
  })

  it('keeps the original session and the read-only permission when a job is continued', async () => {
    const agent = await import('../src/main/services/agent')
    const first = agent.start('調査する', options)
    const handlers = mocks.launch.mock.calls[0][2]
    handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
    handlers.onEvent({ kind: 'assistant-text', text: '調査結果' })
    handlers.onEvent({ kind: 'result', ok: true, summary: '' })
    expect(agent.get(first.id)?.summary).toBe('調査結果')
    handlers.onExit(0)
    const next = await agent.continueJob(first.id, '続きを調べる')
    expect(next).toMatchObject({ readonly: true, engine: first.engine, cwd: first.cwd, sessionId: 'session', parentId: first.id })
    expect(mocks.launch.mock.calls[1][1]).toContain('session')
  })

  it('keeps a cancelled job in stopping until the process closes, even when a successful result arrives', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    const handlers = mocks.launch.mock.calls[0][2]
    agent.cancel(job.id)
    expect(agent.get(job.id)?.status).toBe('stopping')
    expect(agent.get(job.id)?.endedAt).toBeUndefined()
    handlers.onEvent({ kind: 'result', ok: true, summary: '遅れた成功' })
    expect(agent.get(job.id)?.status).toBe('stopping')
    handlers.onExit(0)
    expect(agent.get(job.id)?.status).toBe('cancelled')
  })

  it('fails the job when the process exits with an error after a successful result', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    const handlers = mocks.launch.mock.calls[0][2]
    handlers.onEvent({ kind: 'result', ok: true, summary: '途中結果' })
    expect(agent.get(job.id)?.status).toBe('running')
    handlers.onExit(1)
    expect(agent.get(job.id)?.status).toBe('error')
  })

  it('words the exit code of a job that failed without a summary from the dictionary, and leaves out a code the process did not give', async () => {
    const agent = await import('../src/main/services/agent')
    const coded = agent.start('調査する', options)
    mocks.launch.mock.calls[0][2].onExit(2)
    expect(agent.get(coded.id)).toMatchObject({ status: 'error', summary: ja('jobs.log.exitCode', { code: 2 }) })
    const signalled = agent.start('もう一度調査する', options)
    mocks.launch.mock.calls[1][2].onExit(null)
    expect(agent.get(signalled.id)?.status).toBe('error')
    expect(agent.get(signalled.id)?.summary).toBeUndefined()
  })

  it('asks the agent to stop again when a job of this run is stopped while it is still stopping, so that a stop that failed can be tried again', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    agent.cancel(job.id)
    agent.cancel(job.id)
    expect(mocks.kill).toHaveBeenCalledTimes(2)
    expect(agent.get(job.id)?.status).toBe('stopping')
  })

  it('leaves the exit code out of a cancelled job, so that the card says it was cancelled', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    agent.cancel(job.id)
    mocks.launch.mock.calls[0][2].onExit(143)
    expect(agent.get(job.id)?.status).toBe('cancelled')
    expect(agent.get(job.id)?.summary).toBeUndefined()
  })

  it('waits for the previous process to close before continuing, and carries on even when the caller gives up during that wait', async () => {
    let close!: () => void
    mocks.launch.mockImplementation((_job, _args, handlers) => ({
      stop: mocks.kill,
      completion: new Promise<void>((resolve) => {
        close = () => { handlers.onExit(0); resolve() }
      })
    }))
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
    const controller = new AbortController()
    const continuation = agent.continueJob(job.id, '続きを調べる', controller.signal)
    expect(agent.get(job.id)?.status).toBe('stopping')
    expect(mocks.launch).toHaveBeenCalledOnce()
    // The approval came near the tool's time limit, which runs out while the running job stops.
    controller.abort()
    close()
    await expect(continuation).resolves.toMatchObject({ parentId: job.id, status: 'running' })
    expect(mocks.launch).toHaveBeenCalledTimes(2)
  })

  it('neither stops the running job nor starts a continuation when the caller gave up before asking for it', async () => {
    mocks.launch.mockImplementation(() => ({ stop: mocks.kill, completion: new Promise<void>(() => {}) }))
    const agent = await import('../src/main/services/agent')
    const job = agent.start('調査する', options)
    mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
    const controller = new AbortController()
    controller.abort()
    await expect(agent.continueJob(job.id, '続きを調べる', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(agent.get(job.id)?.status).toBe('running')
    expect(mocks.kill).not.toHaveBeenCalled()
    expect(mocks.launch).toHaveBeenCalledOnce()
  })

  it('waits for every process to close on shutdown and refuses to start a new job', async () => {
    const close: Array<() => void> = []
    mocks.launch.mockImplementation((_job, _args, handlers) => ({
      stop: mocks.kill,
      completion: new Promise<void>((resolve) => {
        close.push(() => { handlers.onExit(0); resolve() })
      })
    }))
    const agent = await import('../src/main/services/agent')
    const first = agent.start('一つ目', options)
    const second = agent.start('二つ目', options)
    let finished = false
    const stopping = agent.shutdown().then(() => { finished = true })
    expect(mocks.kill).toHaveBeenCalledTimes(2)
    expect(() => agent.start('三つ目', options)).toThrow(errorText('jobs.start.shuttingDown'))
    close[0]()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(agent.get(first.id)?.status).toBe('cancelled')
    expect(agent.get(second.id)?.status).toBe('stopping')
    close[1]()
    await stopping
    expect(agent.get(second.id)?.status).toBe('cancelled')
  })

  it('accepts new jobs again when an agent cannot be stopped and the quit is cancelled', async () => {
    let fail!: (error: Error) => void
    mocks.launch.mockImplementationOnce(() => ({
      stop: mocks.kill,
      completion: new Promise<void>((_resolve, reject) => { fail = reject })
    }))
    const agent = await import('../src/main/services/agent')
    agent.start('止まらない', options)
    const stopping = agent.shutdown()
    expect(() => agent.start('終了中', options)).toThrow(errorText('jobs.start.shuttingDown'))
    fail(new Error(errorText('jobs.process.stopTimedOut')))
    await expect(stopping).rejects.toThrow(errorText('jobs.process.stopTimedOut'))
    expect(agent.start('終了を取りやめたあと', options).status).toBe('running')
  })
})
