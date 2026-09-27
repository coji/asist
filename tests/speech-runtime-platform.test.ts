import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asrModelSpec } from '@shared/asr-models'
import type { PlatformCapabilities } from '@shared/platform'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

const mocks = vi.hoisted(() => ({ userData: '', spawn: vi.fn(), createEnvironment: vi.fn(), installRequirements: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.userData, on: vi.fn() } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))
vi.mock('../src/main/services/uv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/uv')>()),
  createEnvironment: mocks.createEnvironment,
  installRequirements: mocks.installRequirements,
  recordEnvironment: vi.fn(async () => {}),
  environmentCurrent: () => true
}))

import { SPEECH_RUNTIMES, prepareModel, snapshotPath, startWorker } from '../src/main/services/speech-runtime'
import { venvPython } from '../src/main/services/uv'

/** The speech runtime the capabilities choose, used as a whole: the environment, its lock and its workers. */

const CUDA_MODEL = asrModelSpec('cuda', 'qwen3-asr-1.7b')!

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: vi.fn()
  })
}

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-speech-runtime-'))
  mocks.userData = path.join(root, 'userData')
  vi.stubEnv('HOME', path.join(root, 'home'))
  vi.stubEnv('USERPROFILE', path.join(root, 'home'))
  vi.stubEnv('ASIST_CUDA_PYTHON', '')
  mocks.spawn.mockImplementation(() => fakeChild())
  mocks.createEnvironment.mockImplementation(async (dir: string) => {
    fs.mkdirSync(path.dirname(venvPython(dir)), { recursive: true })
    fs.writeFileSync(venvPython(dir), '')
  })
  mocks.installRequirements.mockResolvedValue(undefined)
  setCapabilities(WINDOWS)
})

afterEach(() => {
  setCapabilities(MACOS)
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Puts every file of the model's revision into the snapshot, as a finished download does. */
function downloaded(model: typeof CUDA_MODEL): void {
  for (const file of model.files) {
    fs.mkdirSync(path.dirname(path.join(snapshotPath(model), file)), { recursive: true })
    fs.writeFileSync(path.join(snapshotPath(model), file), '')
  }
}

describe('the speech runtime on Windows with an NVIDIA GPU', () => {
  const cuda = SPEECH_RUNTIMES.cuda

  it('builds the CUDA environment under userData from its own lock before it starts the worker', async () => {
    downloaded(CUDA_MODEL)
    const start = vi.fn(async () => true)
    const result = await prepareModel({ model: CUDA_MODEL, feature: 'Test', signal: new AbortController().signal, onProgress: () => {}, start })
    expect(result.ok).toBe(true)
    const directory = path.join(mocks.userData, cuda.directory)
    expect(mocks.createEnvironment).toHaveBeenCalledWith(directory, expect.any(AbortSignal))
    expect(mocks.installRequirements).toHaveBeenCalledWith(venvPython(directory), cuda.requirements, expect.any(AbortSignal))
    expect(cuda.requirements).not.toBe(SPEECH_RUNTIMES.mlx.requirements)
    expect(start).toHaveBeenCalledOnce()
  })

  it('starts the CUDA worker from the resources of the checkout on the downloaded snapshot, without a console window', async () => {
    downloaded(CUDA_MODEL)
    await mocks.createEnvironment(path.join(mocks.userData, cuda.directory))
    const worker = startWorker({ worker: 'asr', model: CUDA_MODEL, onMessage: () => {}, onFailure: () => {} })
    expect(worker).not.toBeNull()
    expect(mocks.spawn).toHaveBeenCalledWith(
      venvPython(path.join(mocks.userData, cuda.directory)),
      [path.join(process.cwd(), 'resources', cuda.asr.file), snapshotPath(CUDA_MODEL), '-'],
      expect.objectContaining({ windowsHide: true })
    )
    worker!.stop()
  })

  it('has no Qwen3-TTS worker to start', async () => {
    downloaded(CUDA_MODEL)
    await mocks.createEnvironment(path.join(mocks.userData, cuda.directory))
    expect(() => startWorker({ worker: 'tts', model: CUDA_MODEL, onMessage: () => {}, onFailure: () => {} })).toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

/**
 * The `from` and `to` of each entry of an extraResources list in electron-builder.yml, at the top level
 * for `section` null and otherwise under that platform's key.
 */
function extraResources(yaml: string, section: string | null): Array<{ from: string; to: string }> {
  const lines = yaml.split('\n')
  const start = section === null ? 0 : lines.indexOf(`${section}:`) + 1
  const indent = section === null ? '' : '  '
  const end = section === null ? lines.length : lines.findIndex((line, i) => i >= start && /^\S/.test(line))
  const block = lines.slice(start, end === -1 ? lines.length : end)
  const list = block.indexOf(`${indent}extraResources:`)
  const entries: Array<{ from: string; to: string }> = []
  for (const line of block.slice(list + 1)) {
    if (line.trim().startsWith('#')) continue
    const from = new RegExp(`^${indent}  - from: (\\S+)$`).exec(line)
    const to = new RegExp(`^${indent}    to: (\\S+)$`).exec(line)
    if (from) entries.push({ from: from[1], to: '' })
    else if (to) entries.at(-1)!.to = to[1]
    else break
  }
  return entries
}

describe('what the app of each OS ships for its speech runtime', () => {
  const yaml = fs.readFileSync('electron-builder.yml', 'utf8')
  const machines: Array<[string, PlatformCapabilities]> = [['mac', MACOS], ['win', WINDOWS]]

  it.each(machines)('ships in the %s app the lock and the workers of its runtime, at the top of the resources where resourcePath looks', (section, capabilities) => {
    const kind = capabilities.speechRuntime.kind
    expect(kind).not.toBeNull()
    const runtime = SPEECH_RUNTIMES[kind!]
    const shipped = [...extraResources(yaml, null), ...extraResources(yaml, section)]
    const files = [runtime.requirements, runtime.asr.file, ...(runtime.tts ? [runtime.tts.file] : []), 'hf_snapshot.py']
    for (const file of files) {
      expect(shipped).toContainEqual({ from: `resources/${file}`, to: file })
      expect(fs.existsSync(path.join('resources', file))).toBe(true)
    }
  })
})
