import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { errorText } from '@shared/i18n/error-text'
import type { AgentJob } from '@shared/ipc'

/** What the user's shell answers: the folders its startup files add, which an app opened from Finder does not inherit. */
const SHELL_PATH = '/Users/me/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  installed: vi.fn<(file: string) => boolean>(),
  readShellPath: vi.fn(),
  prepareCurationScripts: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  curationScriptEnv: vi.fn<(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>()
}))
// ps, which reads the agent's processes once the CLI has closed, finds none but launchd.
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFileSync: mocks.execFileSync }))
vi.mock('node:fs', () => {
  const missing = (file: string): void => {
    if (!mocks.installed(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
  }
  const statSync = (file: string): { isFile: () => boolean } => {
    missing(file)
    return { isFile: () => true }
  }
  return { default: { constants: { X_OK: 1 }, accessSync: missing, statSync } }
})
vi.mock('../src/main/services/agent-process/shell-path', () => ({ readShellPath: mocks.readShellPath }))
vi.mock('../src/main/services/memory-curation-skill', () => ({
  prepareCurationScripts: mocks.prepareCurationScripts,
  curationScriptEnv: mocks.curationScriptEnv
}))
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
  mocks.installed.mockReturnValue(true)
  mocks.readShellPath.mockResolvedValue(SHELL_PATH)
  mocks.prepareCurationScripts.mockResolvedValue()
  mocks.curationScriptEnv.mockImplementation((env) => ({ ...env, CURATION_SCRIPTS: 'ready' }))
  mocks.execFileSync.mockImplementation((_file: string, args: string[]) => (args[0] === '-axo' ? '    1     0     1 Ss   Thu Jan  1 09:00:00 2026\n' : ''))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function launch(engine: AgentJob['engine'] = 'codex') {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
  mocks.spawn.mockReturnValue(child)
  const { launchAgentProcess } = await import('../src/main/services/agent-process')
  const run = launchAgentProcess({ ...job, engine }, ['exec'], handlers)
  // The CLI starts once it is located, which on macOS waits for the user's shell.
  await vi.waitFor(() => expect(mocks.spawn.mock.calls.length + handlers.onExit.mock.calls.length).toBeGreaterThan(0))
  return { child, handlers, run }
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

  it('reports a CLI that is not found as a start that failed, and starts nothing', async () => {
    mocks.installed.mockReturnValue(false)
    const { handlers, run } = await launch()
    await run.completion
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.start.cliMissing', { engine: 'codex' })))
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts nothing for a job stopped while its CLI is being located', async () => {
    let answer!: (path: string) => void
    mocks.readShellPath.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const run = launchAgentProcess(job, ['exec'], handlers)
    run.stop()
    answer(SHELL_PATH)
    await run.completion
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reports a stop that the search for the CLI keeps from ending by its deadline, as any stop that fails', async () => {
    vi.useFakeTimers()
    mocks.readShellPath.mockReturnValue(new Promise(() => {}))
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn(), onStopFailed: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const run = launchAgentProcess(job, ['exec'], handlers)
    let failure: unknown
    run.stop().catch((error: unknown) => { failure = error })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(handlers.onStopFailed).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.process.stopTimedOut')))
    expect(failure).toEqual(new Error(errorText('jobs.process.stopTimedOut')))
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts the CLI without the API keys of the app, so that a job cannot send them anywhere', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-dotenv')
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-from-dotenv')
    await launch('claude')
    const env = mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('asist')
    expect(env.ASIST_AGENT_EXECUTION_ID).toEqual(expect.any(String))
  })

  it('starts a memory curation\'s CLI only once the Python of its skill\'s scripts is ready, in the environment that runs them', async () => {
    let ready!: () => void
    mocks.prepareCurationScripts.mockReturnValue(new Promise<void>((resolve) => { ready = resolve }))
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    mocks.spawn.mockReturnValue(child)
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    launchAgentProcess({ ...job, memoryCuration: { through: '2026-10-01', applied: false } }, ['exec'], handlers)
    await setImmediate()
    expect(mocks.spawn).not.toHaveBeenCalled()
    ready()
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    expect((mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv).CURATION_SCRIPTS).toBe('ready')
  })

  it('fails a memory curation whose Python cannot be prepared as a start that failed, and starts nothing', async () => {
    const reason = new Error('no network')
    mocks.prepareCurationScripts.mockRejectedValue(reason)
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    await launchAgentProcess({ ...job, memoryCuration: { through: '2026-10-01', applied: false } }, ['exec'], handlers).completion
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(reason)
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('stops preparing the Python of a memory curation stopped before its CLI starts, and reports the stop rather than a start that failed', async () => {
    let signal!: AbortSignal
    mocks.prepareCurationScripts.mockImplementation((given) => {
      signal = given
      return new Promise<void>((_, reject) => given.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const run = launchAgentProcess({ ...job, memoryCuration: { through: '2026-10-01', applied: false } }, ['exec'], handlers)
    run.stop()
    await run.completion
    expect(signal.aborted).toBe(true)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('stops preparing the Python of a memory curation whose CLI cannot be located, and reports the missing CLI', async () => {
    mocks.installed.mockReturnValue(false)
    let signal!: AbortSignal
    mocks.prepareCurationScripts.mockImplementation((given) => {
      signal = given
      return new Promise<void>((_, reject) => given.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    await launchAgentProcess({ ...job, memoryCuration: { through: '2026-10-01', applied: false } }, ['exec'], handlers).completion
    expect(signal.aborted).toBe(true)
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.start.cliMissing', { engine: 'codex' })))
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('prepares no Python for a job that is not a memory curation, and starts it in the plain environment', async () => {
    await launch()
    expect(mocks.prepareCurationScripts).not.toHaveBeenCalled()
    expect((mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv).CURATION_SCRIPTS).toBeUndefined()
  })

  it('starts the CLI with the PATH of the user\'s shell, not the one an app opened from Finder inherits', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')
    await launch()
    expect((mocks.spawn.mock.calls[0][2].env as NodeJS.ProcessEnv).PATH).toBe(SHELL_PATH)
  })

  it('fails the job and never lets its CLI start when the watcher that stops it if ASIST ends cannot be started', async () => {
    // The launcher starts; the watcher does not, as when the user's processes are at their limit (EAGAIN).
    const stdin = new PassThrough()
    const launcher = Object.assign(new EventEmitter(), { pid: 4242, stdin, stdout: new PassThrough(), stderr: new PassThrough() })
    const watcher = Object.assign(new EventEmitter(), { pid: undefined, stdin: new PassThrough() })
    mocks.spawn.mockReturnValueOnce(launcher).mockReturnValueOnce(watcher)
    mocks.execFileSync.mockReturnValue(' 4242     1  4242 Ss   Thu Jan  1 09:00:00 2026\n')
    const handlers = { onSpawn: vi.fn(), onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onExit: vi.fn(), onStopFailed: vi.fn() }
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    launchAgentProcess(job, ['exec'], handlers)
    await vi.waitFor(() => expect(handlers.onSpawn.mock.calls.length + handlers.onExit.mock.calls.length).toBeGreaterThan(0))
    expect(String(stdin.read() ?? '')).toBe('')
    expect(stdin.writableEnded).toBe(true)
    expect(handlers.onSpawn).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.process.watcherUnavailable')))
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('reports a process spawn failure to the caller', async () => {
    const { child, handlers } = await launch()
    const error = new Error('permission denied')
    child.emit('error', error)
    expect(handlers.onError).toHaveBeenCalledWith(error)
  })
})
