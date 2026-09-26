import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import type { AgentJob } from '@shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn(), existsSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFileSync: mocks.execFileSync }))
vi.mock('node:fs', () => ({ default: { existsSync: mocks.existsSync } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ agentEngine: 'codex', uiLocale: 'ja-JP' }) }))
// The output is parsed the same on every OS; macOS's launch through /bin/sh is the one whose spawn these tests replace.
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))

const job: AgentJob = {
  id: 'job', title: '調査', prompt: '調査する', cwd: '/workspace',
  readonly: true, engine: 'codex', status: 'running', startedAt: 1
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.existsSync.mockReturnValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function launch(engine: AgentJob['engine'] = 'codex') {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
  mocks.spawn.mockReturnValue(child)
  const { launchAgentProcess } = await import('../src/main/services/agent-process')
  launchAgentProcess({ ...job, engine }, ['exec'], handlers)
  return { child, handlers }
}

describe('launchAgentProcess', () => {
  it('reads UTF-8 split across chunks and a last JSONL line without a newline, losing nothing', async () => {
    const { child, handlers } = await launch()
    const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '日本語の結果' } }))
    const split = bytes.indexOf(Buffer.from('日本語')) + 1
    child.stdout.write(bytes.subarray(0, split))
    child.stdout.end(bytes.subarray(split))
    await setImmediate()
    expect(handlers.onEvent.mock.calls).toEqual([[{ kind: 'assistant-text', text: '日本語の結果' }]])
  })

  it('delivers the output still buffered at exit before the exit notification', async () => {
    const { child, handlers } = await launch('claude')
    const order: string[] = []
    handlers.onEvent.mockImplementation(() => order.push('result'))
    handlers.onExit.mockImplementation(() => order.push('exit'))
    child.emit('exit', 0)
    expect(order).toEqual([])
    child.stdout.end(JSON.stringify({ type: 'result', result: '終わりました', is_error: false }))
    child.stderr.end()
    await setImmediate()
    child.emit('close', 0)
    expect(order).toEqual(['result', 'exit'])
  })

  it('reassembles split UTF-8 on stderr and reports the error text without a trailing newline', async () => {
    const { child, handlers } = await launch()
    const bytes = Buffer.from('注意\n処理に失敗しました')
    child.stderr.write(bytes.subarray(0, 1))
    child.stderr.end(bytes.subarray(1))
    await setImmediate()
    expect(handlers.onStderr.mock.calls).toEqual([['注意'], ['処理に失敗しました']])
  })

  it('throws instead of appearing started when the CLI is not found', async () => {
    mocks.existsSync.mockReturnValue(false)
    mocks.execFileSync.mockImplementation(() => { throw new Error('not found') })
    await expect(launch()).rejects.toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts the CLI without the API keys of the app, so that a job cannot send them anywhere', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-dotenv')
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-from-dotenv')
    vi.stubEnv('PATH', '/opt/homebrew/bin:/usr/bin:/bin')
    await launch('claude')
    const env = mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('asist')
    expect(env.ASIST_AGENT_EXECUTION_ID).toEqual(expect.any(String))
  })

  it('reports a process spawn failure to the caller', async () => {
    const { child, handlers } = await launch()
    const error = new Error('permission denied')
    child.emit('error', error)
    expect(handlers.onError).toHaveBeenCalledWith(error)
  })
})
