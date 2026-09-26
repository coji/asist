import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { manageAgentProcess } from '../src/main/services/agent-process/posix'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('sends the stop signal to the process group and escalates to SIGKILL while waiting for the exit', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGKILL') groupAlive = false
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const finished = vi.fn()
  const run = manageAgentProcess(child as ChildProcess, finished)
  run.stop()
  run.stop()
  expect(signal).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGTERM')
  child.emit('exit', 0)
  expect(finished).not.toHaveBeenCalled()
  await vi.advanceTimersToNextTimerAsync()
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGKILL')
  child.emit('close', 0)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects instead of reporting success when close is not observed even after SIGKILL', async () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const finished = vi.fn()
  const run = manageAgentProcess(child as ChildProcess, finished)
  run.stop()
  const failure = expect(run.completion).rejects.toThrow(errorText('jobs.process.stopTimedOut'))
  await vi.runAllTimersAsync()
  await failure
  expect(finished).not.toHaveBeenCalled()
})

it('asks a surviving group to stop after a natural close and reports the exit only once the group is gone', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const finished = vi.fn()
  const run = manageAgentProcess(child as ChildProcess, finished)
  child.emit('close', 0)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGTERM')
  run.stop()
  await vi.advanceTimersByTimeAsync(2_001)
  expect(signal).toHaveBeenCalledWith(-12345, 'SIGKILL')
  expect(finished).not.toHaveBeenCalled()
  groupAlive = false
  await vi.advanceTimersByTimeAsync(25)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects when the group outlives close, and reports the exit only when the group disappears later', async () => {
  vi.useFakeTimers()
  let groupAlive = true
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!groupAlive && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  const child = Object.assign(new EventEmitter(), { pid: 12345 })
  const finished = vi.fn()
  const run = manageAgentProcess(child as ChildProcess, finished)
  const failure = expect(run.completion).rejects.toThrow()
  child.emit('close', 0)
  await vi.advanceTimersByTimeAsync(5_001)
  await failure
  expect(finished).not.toHaveBeenCalled()
  groupAlive = false
  await vi.advanceTimersByTimeAsync(25)
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
  const finished = vi.fn()
  const run = manageAgentProcess(child as ChildProcess, finished)
  run.stop()
  child.emit('close', 0)
  await vi.advanceTimersByTimeAsync(100)
  expect(finished).not.toHaveBeenCalled()
  group = 'gone'
  await vi.advanceTimersByTimeAsync(25)
  await run.completion
  expect(finished).toHaveBeenCalledExactlyOnceWith(0)
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
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = vi.fn()
  const run = manageAgentProcess(child, finished)
  try {
    const descendant = await new Promise<number>((resolve, reject) => {
      child.stdout!.once('data', (data) => resolve(Number(String(data).trim())))
      child.once('error', reject)
    })
    expect(Number.isInteger(descendant)).toBe(true)
    run.stop()
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
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = vi.fn()
  const run = manageAgentProcess(child, finished)
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
