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

import { spawnSync } from 'node:child_process'
import { PYTHON_VERSION, installPython, runUv, uvEnv, uvPath, uvRunEnv, venvPython } from '../src/main/services/uv'

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

describe('running a script with uv run, as the curation Agent runs its checks', () => {
  it('leaves out the user\'s uv and Python settings and the provider keys, and keeps uv\'s Python under userData', () => {
    const env = uvRunEnv({ PATH: '/usr/bin', UV_INDEX_URL: 'https://mirror.invalid/simple', PYTHONPATH: '/elsewhere', ANTHROPIC_API_KEY: 'sk-test' }, '/data')
    expect(env.UV_INDEX_URL).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join('/data', 'python'))
  })

  it('runs no script and downloads no Python when the pinned Python is not installed, whatever Python the machine has', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-uv-run-'))
    const script = path.join(userData, 'hello.py')
    fs.writeFileSync(script, 'print("ran")\n')
    try {
      // The machine's Python stays on PATH; the bundled uv runs the script as the curation Agent runs its checks.
      const env = uvRunEnv({ PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT }, userData)
      const run = spawnSync(uvPath(), ['run', '--no-project', script], { env, encoding: 'utf8', windowsHide: true })
      // uv itself ran and refused rather than running the script on another Python.
      expect(run.error).toBeUndefined()
      expect([typeof run.status, run.status === 0]).toEqual(['number', false])
      expect(run.stdout).not.toContain('ran')
      expect(fs.readdirSync(userData)).toEqual(['hello.py'])
    } finally {
      fs.rmSync(userData, { recursive: true, force: true })
    }
  })

  // A stand-in for uv records how it is called; Windows would need it as an .exe.
  it.runIf(process.platform !== 'win32')('installs the pinned Python without putting it into the user\'s bin folder or the Windows registry', async () => {
    mocks.appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-uv-stand-in-'))
    try {
      const record = path.join(mocks.appPath, 'args.txt')
      fs.mkdirSync(path.join(mocks.appPath, 'resources', 'uv'), { recursive: true })
      fs.writeFileSync(path.join(mocks.appPath, 'resources', 'uv', 'uv'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 })
      await installPython(new AbortController().signal)
      expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toEqual(['python', 'install', '--no-bin', '--no-registry', PYTHON_VERSION])
    } finally {
      fs.rmSync(mocks.appPath, { recursive: true, force: true })
    }
  })
})
