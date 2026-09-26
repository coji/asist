import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => '/unused', on: vi.fn()
} }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

function fakeChild() {
  const input: Array<{ id: string; prev: string; text: string }> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, killed: false, kill: vi.fn(), input
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => input.push(JSON.parse(String(data))))
  return child
}
let child: ReturnType<typeof fakeChild>
let classifier: typeof import('../src/main/services/aizuchi-classifier')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ASIST_EMBEDDING_PYTHON', '/unused/python')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  child = fakeChild()
  mocks.spawn.mockReset().mockReturnValue(child)
  classifier = await import('../src/main/services/aizuchi-classifier')
})
afterEach(() => {
  classifier.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
})
async function ready() {
  const starting = classifier.ensureStarted()
  child.stdout.write('ASIST_JSON:{"type":"ready"}\n')
  await vi.advanceTimersByTimeAsync(100)
  expect(await starting).toBe(true)
}

describe('whether the aizuchi classifier is wanted', () => {
  const settings = { aizuchi: true, conversationLocale: 'ja-JP', voiceEngine: 'cascade' } as AppSettings

  it('is wanted while aizuchi are on, the conversation is Japanese and the engine is not a live one', () => {
    expect(classifier.wanted(settings)).toBe(true)
    expect(classifier.wanted({ ...settings, aizuchi: false })).toBe(false)
    expect(classifier.wanted({ ...settings, voiceEngine: 'gpt-live' })).toBe(false)
  })

  it('is not wanted in another conversation language, whatever the saved setting says', () => {
    for (const conversationLocale of ['en-US', 'ko-KR', 'pt-BR'] as const) {
      expect(classifier.wanted({ ...settings, conversationLocale })).toBe(false)
    }
  })
})

describe('worker lifetime of the aizuchi-classifier service', () => {
  it('rejects a classification while the worker is not running, instead of falling back', async () => {
    await expect(classifier.classify({ prev: '', text: '明日の天気' })).rejects.toThrow()
    expect(classifier.status()).toEqual({ runtimeInstalled: true, modelInstalled: true, running: false })
  })

  it('passes normalized input to the worker and returns its result, but sends nothing when normalization leaves the text empty', async () => {
    await ready()
    expect(mocks.spawn.mock.calls[0][1]).toContain('1')
    const request = classifier.classify({ prev: '火曜日の予定は3件あります。', text: 'いや、違う。月曜のほう?' })
    await vi.advanceTimersByTimeAsync(10)
    expect(child.input).toEqual([
      { id: expect.any(String), prev: '火曜日の予定は3件あります', text: 'いや違う月曜のほう' }
    ])
    child.stdout.write(
      `ASIST_JSON:${JSON.stringify({ type: 'result', id: child.input[0].id, cls: 'correct', prob: 0.99, complete: 0.9 })}\n`
    )
    await expect(request).resolves.toEqual({ cls: 'correct', prob: 0.99, complete: 0.9 })
    await expect(classifier.classify({ prev: '', text: '。。。' })).rejects.toThrow()
    expect(child.input).toHaveLength(1)
  })

  it('fails one request on a worker error, and fails every request and stops the worker on a fatal one', async () => {
    await ready()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = classifier.classify({ prev: '', text: '明日の天気' })
    await vi.advanceTimersByTimeAsync(10)
    child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'error', id: child.input[0].id, error: 'bad' })}\n`)
    await expect(first).rejects.toThrow('bad')
    const second = classifier.classify({ prev: '', text: '明日の天気' })
    child.stdout.write('ASIST_JSON:{"type":"fatal","error":"model missing"}\n')
    await expect(second).rejects.toThrow('model missing')
    expect(classifier.running()).toBe(false)
  })

  it('fails the request and stops the worker when no result arrives within 5 seconds', async () => {
    await ready()
    const failed = expect(classifier.classify({ prev: '', text: '明日の天気' })).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(5_100)
    await failed
    expect(classifier.running()).toBe(false)
  })

  it('stops a worker whose input pipe breaks and fails its request, without an uncaught error', async () => {
    await ready()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const request = classifier.classify({ prev: '', text: '明日の天気' })
    const outcome = request.then(() => 'resolved', () => 'rejected')
    const uncaught: Error[] = []
    const onUncaught = (error: Error): void => { uncaught.push(error) }
    process.prependListener('uncaughtException', onUncaught)
    try {
      child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      await vi.advanceTimersByTimeAsync(10)
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(await outcome).toBe('rejected')
    expect(classifier.running()).toBe(false)
  })

  it('lets a preparation wait for the worker a start is already loading, instead of starting another', async () => {
    const starting = classifier.ensureStarted()
    const preparing = classifier.prepare(() => {})
    await vi.advanceTimersByTimeAsync(10)
    child.stdout.write('ASIST_JSON:{"type":"ready"}\n')
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    expect((await preparing).ok).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
