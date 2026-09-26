import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => '/unused', on: vi.fn()
} }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, killed: false, kill: vi.fn()
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  return child
}
let children: ReturnType<typeof fakeChild>[] = []
let vap: typeof import('../src/main/services/vap')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ASIST_VAP_PYTHON', '/unused/python')
  // The runtime, the models and the worker script are taken to be installed.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  children = []
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    return child
  })
  vap = await import('../src/main/services/vap')
})
afterEach(() => {
  vap.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const child of children) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
})
const READY = 'ASIST_JSON:{"type":"ready","device":"cpu","frameHz":12.5}\n'

describe('the VAP worker', () => {
  it('lets a preparation wait for the worker the conversation is already loading, and the other way round', async () => {
    const starting = vap.ensureStarted(() => {})
    const preparing = vap.prepare(() => {})
    await vi.advanceTimersByTimeAsync(10)
    const again = vap.ensureStarted(() => {})
    children[0].stdout.write(READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    expect(await again).toBe(true)
    expect((await preparing).ok).toBe(true)
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(vap.installationStatus().running).toBe(true)
  })

  it('stops a worker whose input pipe breaks while audio streams to it, without an uncaught error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const starting = vap.ensureStarted(() => {})
    children[0].stdout.write(READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    const uncaught: Error[] = []
    const onUncaught = (error: Error): void => { uncaught.push(error) }
    process.prependListener('uncaughtException', onUncaught)
    try {
      children[0].stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      await vi.advanceTimersByTimeAsync(10)
      vap.pushAudio(new Float32Array(1280), new Float32Array(1280))
      await vi.advanceTimersByTimeAsync(10)
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(vap.installationStatus().running).toBe(false)
  })
})
