import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), app: { isPackaged: false, getAppPath: () => '/app' } }))
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }))
vi.mock('electron', () => ({ app: mocks.app }))

import { micHelperPath, readMicCheck, windowsMicCancelsEcho } from '../src/main/services/mic-helper'

const REPORT_ON = 'echo-cancellation: on\r\neffects: acoustic-echo-cancellation=on noise-suppression=on\r\nmicrophone: Microphone Array\r\necho-reference: Speakers\r\n'
const REPORT_OFF = 'echo-cancellation: off\r\neffects: acoustic-echo-cancellation=off\r\nmicrophone: USB Microphone\r\necho-reference: Speakers\r\n'

const exited = (status: number | null, stdout = '', signal: NodeJS.Signals | null = null) => ({ status, signal, stdout, stderr: '', error: undefined })
const errored = (code: string, message: string) => ({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error(message), { code }) })

describe('reading the microphone check', () => {
  it('uses the helper only when the check exits normally and reports echo cancellation on', () => {
    expect(readMicCheck(exited(0, REPORT_ON))).toEqual({ cancelsEcho: true })
  })

  it('takes a microphone without echo cancellation or no microphone as the machine, not as a failed check', () => {
    expect(readMicCheck(exited(3, REPORT_OFF))).toMatchObject({ cancelsEcho: false, failed: false })
    expect(readMicCheck(exited(4))).toMatchObject({ cancelsEcho: false, failed: false })
  })

  it('takes a normal exit that does not report echo cancellation on as a broken helper', () => {
    expect(readMicCheck(exited(0, REPORT_OFF))).toMatchObject({ cancelsEcho: false, failed: true })
    expect(readMicCheck(exited(0, ''))).toMatchObject({ cancelsEcho: false, failed: true })
  })

  it('takes a check that timed out, could not start, crashed or was killed as failed', () => {
    for (const result of [
      errored('ETIMEDOUT', 'spawnSync asist-mic.exe ETIMEDOUT'),
      errored('ENOENT', 'spawnSync asist-mic.exe ENOENT'),
      exited(-1073741819),
      exited(null, '', 'SIGTERM')
    ]) {
      expect(readMicCheck(result)).toMatchObject({ cancelsEcho: false, failed: true })
    }
  })
})

describe('where the microphone helper is', () => {
  const resourcesPath = process.resourcesPath
  afterEach(() => {
    mocks.app.isPackaged = false
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
  })

  it('runs the helper that scripts/prepare-resources.mjs builds for each OS in development', () => {
    expect(micHelperPath('macos')).toBe(path.join('/app', 'resources', 'native', 'macos', 'asist-mic'))
    expect(micHelperPath('windows')).toBe(path.join('/app', 'resources', 'native', 'windows', 'asist-mic.exe'))
  })

  it('runs the helper that electron-builder.yml puts at the top of the resources in the packaged app', () => {
    mocks.app.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: path.join('/installed', 'resources'), configurable: true })
    expect(micHelperPath('macos')).toBe(path.join('/installed', 'resources', 'asist-mic'))
    expect(micHelperPath('windows')).toBe(path.join('/installed', 'resources', 'asist-mic.exe'))
  })
})

describe('the check at startup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.spawnSync.mockReset()
  })

  it('runs the Windows helper with --check, hidden and with a deadline, and follows its answer', () => {
    mocks.spawnSync.mockReturnValue(exited(0, REPORT_ON))
    expect(windowsMicCancelsEcho()).toBe(true)
    const [file, args, options] = mocks.spawnSync.mock.calls[0]
    expect(file).toBe(micHelperPath('windows'))
    expect(args).toEqual(['--check'])
    expect(options).toMatchObject({ windowsHide: true, timeout: expect.any(Number) })

    mocks.spawnSync.mockReturnValue(exited(3, REPORT_OFF))
    expect(windowsMicCancelsEcho()).toBe(false)
  })

  it('reports a check that failed as an error, and a microphone without echo cancellation only in the log', () => {
    mocks.spawnSync.mockReturnValue(errored('ETIMEDOUT', 'spawnSync asist-mic.exe ETIMEDOUT'))
    expect(windowsMicCancelsEcho()).toBe(false)
    expect(console.error).toHaveBeenCalledOnce()

    vi.mocked(console.error).mockClear()
    mocks.spawnSync.mockReturnValue(exited(3, REPORT_OFF))
    expect(windowsMicCancelsEcho()).toBe(false)
    expect(console.error).not.toHaveBeenCalled()
  })
})
