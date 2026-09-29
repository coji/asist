import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ directory: '', createEnvironment: vi.fn(), installRequirements: vi.fn(), recordEnvironment: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory, getVersion: () => '0.0.0' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))
vi.mock('../src/main/services/uv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/uv')>()),
  createEnvironment: mocks.createEnvironment,
  installRequirements: mocks.installRequirements,
  recordEnvironment: mocks.recordEnvironment,
  environmentCurrent: () => false
}))

import { ensureRuntime } from '../src/main/services/onnx-runtime'

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-onnx-runtime-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('the shared ONNX environment', () => {
  it('is built once for two preparations that need it at the same time', async () => {
    const build = deferred()
    mocks.createEnvironment.mockReturnValue(build.promise)
    const signal = new AbortController().signal
    const first = ensureRuntime(signal, () => {}, 'semantic search')
    const second = ensureRuntime(signal, () => {}, 'aizuchi')
    build.resolve()
    await Promise.all([first, second])
    expect(mocks.createEnvironment).toHaveBeenCalledOnce()
    expect(mocks.installRequirements).toHaveBeenCalledOnce()
  })

  it('is built anew by the next preparation after a build failed', async () => {
    const failed = deferred()
    mocks.createEnvironment.mockReturnValueOnce(failed.promise).mockResolvedValueOnce(undefined)
    const signal = new AbortController().signal
    const first = ensureRuntime(signal, () => {}, 'semantic search')
    failed.reject(new Error('uv failed'))
    await expect(first).rejects.toThrow('uv failed')
    await ensureRuntime(signal, () => {}, 'semantic search')
    expect(mocks.createEnvironment).toHaveBeenCalledTimes(2)
    expect(mocks.installRequirements).toHaveBeenCalledOnce()
  })
})
