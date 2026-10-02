import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { manageAgentProcess } from '../src/main/services/agent-process/posix'

/**
 * What /bin/ps answers, by its arguments, or null for the real one. The tests whose child has a made-up pid
 * answer for it, since the real table would hold whatever process has that pid on the machine.
 */
const ps = vi.hoisted(() => ({ answer: null as null | ((args: readonly string[]) => string) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  type Callback = (error: Error | null, stdout: string, stderr: string) => void
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: readonly string[], options: object) =>
      ps.answer ? ps.answer(args) : actual.execFileSync(file, args, options)),
    execFile: vi.fn((file: string, args: readonly string[], options: object, callback: Callback) => {
      if (!ps.answer) return actual.execFile(file, args, options, callback)
      const answer = ps.answer
      process.nextTick(() => {
        try { callback(null, answer(args), '') } catch (error) { callback(error as Error, '', '') }
      })
    })
  }
})

/** The lines ps prints for the process table, the scan of every environment, and the read of a few processes. */
interface Listing { table: string[]; scan: string[]; read: string[] }
const LAUNCHD = '    1     0     1 Ss   Thu Jan  1 09:00:00 2026'
function answer(listing: Partial<Listing> = {}): (args: readonly string[]) => string {
  return (args) => {
    if (args[0] === '-axo') return [LAUNCHD, ...(listing.table ?? [])].join('\n') + '\n'
    if (args.includes('-E')) return (listing.scan ?? []).join('\n')
    return (listing.read ?? []).join('\n')
  }
}

beforeEach(() => { ps.answer = answer() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** Owns the child under a token of its own, which no process on the machine carries unless the test gives it. */
function own(child: object, token = randomUUID()) {
  const events = { onClose: vi.fn(), onStopFailed: vi.fn() }
  return { run: manageAgentProcess(child as ChildProcess, token, events), token, ...events }
}

it('sends the stop signal to the process group and escalates to SIGKILL while waiting for the exit', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGKILL') groupAlive = false
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished } = own(child)
  const stopped = run.stop()
  void run.stop()
  expect(signal).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGTERM')
  child.emit('exit', 0)
  expect(finished).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2_001)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGKILL')
  child.emit('close', 0)
  await stopped
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('fails the stop, and reports it once, instead of reporting success when close is not observed even after SIGKILL', async () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished, onStopFailed } = own(child)
  const failure = expect(run.stop()).rejects.toThrow(errorText('jobs.process.stopTimedOut'))
  await vi.advanceTimersByTimeAsync(5_001)
  await failure
  expect(onStopFailed).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.process.stopTimedOut')))
  expect(finished).not.toHaveBeenCalled()
})

it('sends the stop again when asked after a stop failed, and settles the end it then sees', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished, onStopFailed } = own(child)
  const first = run.stop()
  await vi.advanceTimersByTimeAsync(5_001)
  await expect(first).rejects.toThrow(errorText('jobs.process.stopTimedOut'))
  signal.mockClear()
  const second = run.stop()
  expect(second).not.toBe(first)
  expect(signal).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGTERM')
  groupAlive = false
  child.emit('close', 0)
  await second
  await run.completion
  expect(onStopFailed).toHaveBeenCalledOnce()
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
})

it('asks a surviving group to stop after a natural close and reports the exit only once the group is gone', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished } = own(child)
  child.emit('close', 0)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGTERM')
  void run.stop()
  await vi.advanceTimersByTimeAsync(2_001)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGKILL')
  expect(finished).not.toHaveBeenCalled()
  groupAlive = false
  await vi.advanceTimersByTimeAsync(25)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('reports a failed stop when the group outlives close, and reports the exit only when the group disappears later', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished, onStopFailed } = own(child)
  child.emit('close', 0)
  await vi.advanceTimersByTimeAsync(5_001)
  expect(onStopFailed).toHaveBeenCalledExactlyOnceWith(new Error(errorText('jobs.process.stopTimedOut')))
  expect(finished).not.toHaveBeenCalled()
  groupAlive = false
  await vi.advanceTimersByTimeAsync(25)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps waiting while the group holds only exited processes that are not reaped yet, which macOS reports as EPERM', async () => {
  vi.useFakeTimers()
  let group: 'zombie' | 'gone' = 'zombie'
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (group === 'zombie') throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished } = own(child)
  void run.stop()
  child.emit('close', 0)
  await vi.advanceTimersByTimeAsync(100)
  expect(finished).not.toHaveBeenCalled()
  group = 'gone'
  await vi.advanceTimersByTimeAsync(25)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
})

it('signals the CLI\'s group while the processes cannot be read, and settles once a later read finds none left', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGKILL') groupAlive = false
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const unreadable = (): never => { throw Object.assign(new Error('ps failed'), { status: 2 }) }
  ps.answer = unreadable
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run, onClose: finished } = own(child)
  void run.stop()
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGTERM')
  await vi.advanceTimersByTimeAsync(2_001)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGKILL')
  child.emit('close', 0)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(finished).not.toHaveBeenCalled()
  ps.answer = answer()
  await vi.advanceTimersByTimeAsync(1_000)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
})

it('confirms every process the scan finds carrying the token with one read of them all', async () => {
  vi.useFakeTimers()
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
  const token = randomUUID()
  const commands = [201, 202, 203]
  ps.answer = answer({
    table: commands.map((pid) => `  ${pid}     1   ${pid} S    Thu Jan  1 09:00:00 2026`),
    scan: commands.map((pid) => `  ${pid}   ${pid} /usr/bin/make test ASIST_AGENT_EXECUTION_ID=${token}`),
    read: commands.map((pid) => `  ${pid} /usr/bin/make test ASIST_AGENT_EXECUTION_ID=${token}`)
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const { run } = own(child, token)
  void run.stop()
  const reads = vi.mocked(execFileSync).mock.calls.filter(([, args]) => (args as string[])[0] === 'eww')
  expect(reads).toHaveLength(1)
  for (const pid of commands) expect(signal).toHaveBeenCalledWith(pid, 'SIGTERM')
})

// Process groups exist only on POSIX; on Windows the agent launcher's Job Object is to take their place, with tests of its own.
const posix = process.platform !== 'win32'

it.runIf(posix)('stops a real Node process together with its child process', { timeout: 15_000 }, async () => {
  const source = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `
  ps.answer = null
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { run, onClose: finished } = own(child)
  try {
    const descendant = await new Promise<number>((resolve, reject) => {
      child.stdout!.once('data', (data) => resolve(Number(String(data).trim())))
      child.once('error', reject)
    })
    expect(Number.isInteger(descendant)).toBe(true)
    void run.stop()
    await run.completion
    expect(finished).toHaveBeenCalledOnce()
    expect(() => process.kill(descendant, 0)).toThrow()
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch (error) {
      if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
})

it.runIf(posix)('waits for a child that ignores SIGTERM when the real CLI exits on its own and leaves the child behind', { timeout: 15_000 }, async () => {
  const descendantSource = `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `
  const source = `
    const {spawn} = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {stdio: ['ignore','pipe','ignore']});
    descendant.stdout.once('data', () => {
      process.stdout.write(String(descendant.pid) + '\\n');
      process.exit(0);
    });
  `
  ps.answer = null
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { run, onClose: finished } = own(child)
  try {
    const descendant = await new Promise<number>((resolve, reject) => {
      child.stdout!.once('data', (data) => resolve(Number(String(data).trim())))
      child.once('error', reject)
    })
    expect(Number.isInteger(descendant)).toBe(true)
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    expect(finished).not.toHaveBeenCalled()
    expect(process.kill(descendant, 0)).toBe(true)
    await run.completion
    expect(finished).toHaveBeenCalledExactlyOnceWith(0)
    expect(() => process.kill(descendant, 0)).toThrow()
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch (error) {
      if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
})
