import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/unused', on: vi.fn() } }))

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null, kill: vi.fn()
  })
}
let children: ReturnType<typeof fakeChild>[] = []
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  children = []
  mocks.spawn.mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    return child
  })
})
afterEach(async () => {
  const native = await import('../src/main/services/native-mic')
  native.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const child of children) {
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
  }
})

it('settles a start cancelled before the first frame and clears its deadline', async () => {
  const native = await import('../src/main/services/native-mic')
  let result: { ok: boolean } | undefined
  void native.start(() => {}, () => {}).then(value => { result = value })
  native.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(result?.ok).toBe(false)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(mocks.spawn).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('settles the old start without stopping the replacement or forwarding old frames', async () => {
  const native = await import('../src/main/services/native-mic')
  const oldFrame = vi.fn()
  let oldResult: { ok: boolean } | undefined
  void native.start(oldFrame, () => {}).then(value => { oldResult = value })
  const currentFrame = vi.fn()
  const current = native.start(currentFrame, () => {})
  const samples = Buffer.from(new Float32Array([0.1, 0.2]).buffer)
  children[0].stdout.write(samples)
  children[1].stdout.write(samples)
  expect((await current).ok).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldResult?.ok).toBe(false)
  expect(oldFrame).not.toHaveBeenCalled()
  expect(currentFrame).toHaveBeenCalledOnce()
  expect(children[1].stdin.writableEnded).toBe(false)
})

it('gives a helper respawned after a device change the whole first-frame time again', async () => {
  const native = await import('../src/main/services/native-mic')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  let result: { ok: boolean } | undefined
  void native.start(() => {}, () => {}).then(value => { result = value })
  // Opening a Bluetooth microphone takes about two seconds before the helper reports the change.
  await vi.advanceTimersByTimeAsync(2_500)
  children[0].emit('exit', 2, null)
  await vi.advanceTimersByTimeAsync(300)
  expect(children).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(result).toBeUndefined()
  children[1].stdout.write(Buffer.from(new Float32Array([0.1, 0.2]).buffer))
  await vi.advanceTimersByTimeAsync(0)
  expect(result?.ok).toBe(true)
})

it('ends a start that helpers keep delaying by exiting just before their own deadline', async () => {
  const native = await import('../src/main/services/native-mic')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  let result: { ok: boolean } | undefined
  void native.start(() => {}, () => {}).then(value => { result = value })
  let exits = 0
  while (result === undefined && exits < 10) {
    await vi.advanceTimersByTimeAsync(4_600)
    if (result !== undefined) break
    children.at(-1)!.emit('exit', 2, null)
    exits++
    await vi.advanceTimersByTimeAsync(300)
  }
  expect(result?.ok).toBe(false)
  // A start waits through one respawn after a device change, not through every one the helpers report.
  expect(exits).toBeLessThanOrEqual(2)
})

it('gives capture up at once when the helper reports that the configuration keeps changing', async () => {
  const native = await import('../src/main/services/native-mic')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const down = vi.fn()
  const started = native.start(() => {}, down)
  children[0].stdout.write(Buffer.from(new Float32Array([0.1, 0.2]).buffer))
  expect((await started).ok).toBe(true)
  children[0].emit('exit', 5, null)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(down).toHaveBeenCalledOnce()
  expect(children).toHaveLength(1)
})
