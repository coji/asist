import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MODEL, vectorToBytes } from '@shared/memory-embedding'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => '/unused', on: vi.fn()
} }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

function fakeChild() {
  const input: Array<{ id: string; kind: string; texts: string[] }> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, killed: false, kill: vi.fn(), input
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => input.push(JSON.parse(String(data))))
  return child
}
let child: ReturnType<typeof fakeChild>
let embedding: typeof import('../src/main/services/embedding')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ASIST_EMBEDDING_PYTHON', '/unused/python')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  child = fakeChild()
  mocks.spawn.mockReset().mockReturnValue(child)
  embedding = await import('../src/main/services/embedding')
})
afterEach(() => {
  embedding.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
})
async function ready() {
  const starting = embedding.ensureStarted()
  child.stdout.write(`ASIST_JSON:{"type":"ready","dim":${EMBEDDING_MODEL.dim}}\n`)
  await vi.advanceTimersByTimeAsync(100)
  expect(await starting).toBe(true)
}
function result(id: string, vector: number[]) {
  const encoded = Buffer.from(vectorToBytes(new Float32Array(vector))).toString('base64')
  child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'result', id, vectors: [encoded] })}\n`)
}

describe('embedding worker start', () => {
  it('stops a worker whose model has another number of dimensions than the pinned one', async () => {
    const starting = embedding.ensureStarted()
    child.stdout.write(`ASIST_JSON:{"type":"ready","dim":${EMBEDDING_MODEL.dim + 128}}\n`)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await starting).toBe(false)
    expect(embedding.running()).toBe(false)
    expect(child.kill).toHaveBeenCalled()
  })

  it('lets a preparation wait for the worker a start is already loading, instead of starting another', async () => {
    const starting = embedding.ensureStarted()
    const preparing = embedding.prepare(() => {})
    await vi.advanceTimersByTimeAsync(10)
    child.stdout.write(`ASIST_JSON:{"type":"ready","dim":${EMBEDDING_MODEL.dim}}\n`)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    expect((await preparing).ok).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('stops a worker whose input pipe breaks and fails its request, without an uncaught error', async () => {
    await ready()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = embedding.embed(['猫の名前'], 'query').then(() => 'resolved', () => 'rejected')
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
    expect(embedding.running()).toBe(false)
  })
})

describe('embedding request cancellation', () => {
  it('releases the waiter when a query is aborted, and finishes the indexing and later queries on the same worker', async () => {
    await ready()
    const controller = new AbortController()
    const document = embedding.embed(['本人は猫と暮らしている'], 'document')
    const query = embedding.embed(['猫の名前'], 'query', controller.signal)
    const outcome = query.catch((error: Error) => error)
    const [documentRequest, oldQuery] = child.input
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(embedding.running()).toBe(true)

    result(oldQuery.id, [1, 0])
    result(documentRequest.id, [0, 1])
    expect(await document).toEqual([new Float32Array([0, 1])])
    const next = embedding.embed(['週末の買い物'], 'query')
    result(child.input.at(-1)!.id, [1, 1])
    expect(await next).toEqual([new Float32Array([1, 1])])
    await vi.advanceTimersByTimeAsync(21_000)
    expect(embedding.running()).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('never sends an already aborted query to the worker and rejects with the abort reason itself', async () => {
    await ready()
    const controller = new AbortController()
    const reason = new Error('次の発話へ進む')
    controller.abort(reason)
    await expect(embedding.embed(['古い発話'], 'query', controller.signal)).rejects.toBe(reason)
    expect(child.input).toEqual([])
  })

  it('keeps later requests working after an abort of a finished request and a late error for an aborted one', async () => {
    await ready()
    const firstController = new AbortController()
    const first = embedding.embed(['現在の発話'], 'query', firstController.signal)
    result(child.input[0].id, [1, 0])
    expect(await first).toEqual([new Float32Array([1, 0])])
    firstController.abort()

    const oldController = new AbortController()
    const old = embedding.embed(['古い発話'], 'query', oldController.signal)
    const outcome = old.catch((error: Error) => error)
    oldController.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    const next = embedding.embed(['新しい発話'], 'query')
    child.stdout.write(`ASIST_JSON:${JSON.stringify({ type: 'error', id: child.input[1].id, error: 'late error' })}\n`)
    result(child.input[2].id, [0, 1])
    expect(await next).toEqual([new Float32Array([0, 1])])
    await vi.advanceTimersByTimeAsync(21_000)
    expect(embedding.running()).toBe(true)
  })
})
