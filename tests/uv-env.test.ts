import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appPath: process.cwd(), os: null as 'macos' | 'windows' | null }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => mocks.appPath, getPath: () => '/unused', on: vi.fn() } }))
// The uv of the machine the tests run on, unless a test asks for what ASIST does on Windows.
vi.mock('../src/main/services/platform', async () => {
  const { HOST, MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.os ? { macos: MACOS, windows: WINDOWS }[mocks.os] : HOST) }
})

import { runUv, uvEnv, uvPath, venvPython } from '../src/main/services/uv'

afterEach(() => {
  mocks.appPath = process.cwd()
  mocks.os = null
})

describe('where uv and the Python of an environment are', () => {
  it('runs uv.exe on Windows and uv on macOS', () => {
    mocks.os = 'windows'
    expect(uvPath()).toBe(path.join(mocks.appPath, 'resources', 'uv', 'uv.exe'))
    mocks.os = 'macos'
    expect(uvPath()).toBe(path.join(mocks.appPath, 'resources', 'uv', 'uv'))
  })

  it('finds the Python of an environment in Scripts on Windows and in bin on macOS, where uv venv puts it', () => {
    const dir = path.join(os.tmpdir(), 'runtime')
    mocks.os = 'windows'
    expect(venvPython(dir)).toBe(path.join(dir, 'Scripts', 'python.exe'))
    mocks.os = 'macos'
    expect(venvPython(dir)).toBe(path.join(dir, 'bin', 'python'))
  })
})

describe('the environment uv runs with', () => {
  it('drops the user uv settings that would change the Python or the package index, and keeps its files under userData', () => {
    const env = uvEnv(
      { PATH: '/usr/bin', UV_INDEX_URL: 'https://mirror.invalid/simple', UV_PYTHON_PREFERENCE: 'only-system', UV_PYTHON_DOWNLOADS: 'never' },
      '/data'
    )
    expect(env.UV_INDEX_URL).toBeUndefined()
    expect(env.UV_PYTHON_PREFERENCE).toBeUndefined()
    expect(env.UV_PYTHON_DOWNLOADS).toBeUndefined()
    expect(env.UV_NO_CONFIG).toBe('1')
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join('/data', 'python'))
    expect(env.UV_CACHE_DIR).toBe(path.join('/data', 'uv-cache'))
    expect(env.PATH).toBe('/usr/bin')
  })

  it('drops the user uv settings written in any case on Windows, where the case of a name does not matter', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const env = uvEnv({ Path: 'C:\\Windows', Uv_Index_Url: 'https://mirror.invalid/simple' }, '/data')
      expect(env).not.toHaveProperty('Uv_Index_Url')
      expect(env.Path).toBe('C:\\Windows')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('passes no provider key to uv', () => {
    expect(uvEnv({ ANTHROPIC_API_KEY: 'sk-test' }, '/data').ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe('running uv', () => {
  it('rejects when uv cannot be started, and leaves nothing listening on the signal', async () => {
    mocks.appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-no-uv-'))
    try {
      const controller = new AbortController()
      await expect(runUv(['--version'], controller.signal)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    } finally {
      fs.rmSync(mocks.appPath, { recursive: true, force: true })
    }
  })
})
