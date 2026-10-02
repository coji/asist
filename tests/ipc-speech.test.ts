import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'

/**
 * A service ipc.ts reaches whose functions are mocks, apart from the ones a test gives, so that registerIpc
 * runs without the app around it.
 */
function stub(given: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(given, {
    get: (target, key) => {
      if (key in target || typeof key !== 'string' || key === 'then' || key === 'default' || key === '__esModule') return target[key as string]
      target[key] = vi.fn()
      return target[key]
    },
    has: () => true
  })
}
const emitter = (): { on: () => void } => ({ on: () => {} })

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  settings: { uiLocale: 'en-US', vapEnabled: false, conversationLocale: 'ja-JP' },
  spawn: vi.fn(),
  watchdogStart: vi.fn(),
  llmKeyStates: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '0.0.0', isPackaged: false, getAppPath: () => '/unused', on: () => {} },
  dialog: {},
  shell: {},
  ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, listener) }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings, saveSettings: vi.fn() }))
vi.mock('../src/main/services/watchdog', () => ({ start: mocks.watchdogStart, checkAfter: vi.fn() }))
vi.mock('../src/main/services/llm', () => stub({ llmKeyStates: mocks.llmKeyStates, configuredApiKeyAvailable: async () => true }))
vi.mock('../src/main/services/tts', () => stub({ available: async () => true, engineStarting: () => false, engineLabel: () => 'Irodori-TTS' }))
vi.mock('../src/main/services/asr', () => stub({ available: async () => true, installed: () => true }))
vi.mock('../src/main/services/live', () => stub({ events: emitter(), connection: () => 'closed' }))
vi.mock('../src/main/services/agent-process/cli-locator', () => stub({ cliStatus: () => 'found' }))
vi.mock('../src/main/services/calendar', () => stub())
vi.mock('../src/main/services/mail', () => stub({ events: emitter() }))
vi.mock('../src/main/services/confirm', () => stub({ confirmEvents: emitter() }))
vi.mock('../src/main/services/local-tts', () => stub())
vi.mock('../src/main/services/aizuchi', () => stub({ events: emitter() }))
vi.mock('../src/main/services/bridge-plan', () => stub())
vi.mock('../src/main/services/aizuchi-classifier', () => stub())
vi.mock('../src/main/services/brain', () => stub({ events: emitter() }))
vi.mock('../src/main/services/brain/interject', () => stub())
vi.mock('../src/main/services/brain/job-reporting', () => stub())
vi.mock('../src/main/services/agent', () => stub({ events: emitter() }))
vi.mock('../src/main/services/usage-ledger', () => stub())
vi.mock('../src/main/services/app-update', () => stub({ events: emitter() }))
vi.mock('../src/main/services/panel-fetchers', () => stub())
vi.mock('../src/main/services/store', () => stub())
vi.mock('../src/main/services/native-mic', () => stub())
vi.mock('../src/main/services/memory', () => stub())
vi.mock('../src/main/services/embedding', () => stub())
vi.mock('../src/main/services/memory-curation', () => stub())
vi.mock('../src/main/services/timers', () => stub({ events: emitter() }))
vi.mock('../src/main/services/user-notes', () => stub({ events: emitter() }))
vi.mock('../src/main/services/user-tasks', () => stub({ events: emitter() }))
vi.mock('../src/main/os-integration', () => stub())
vi.mock('../src/main/services/microphone-permission', () => stub({ microphonePermission: () => ({}) }))
vi.mock('../src/main/services/setup-completion', () => stub())
vi.mock('../src/main/services/file-preview', () => stub())
vi.mock('../src/main/services/mini-app-view', () => stub())
vi.mock('../src/main/window-chrome', () => stub({ windowChrome: () => ({}) }))
vi.mock('../src/main/page-lifetime', () => stub())

/** A MaAI worker that reports ready as soon as it is started, as one that loads its models does. */
function fakeWorker() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, killed: false, kill: vi.fn()
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  setTimeout(() => child.stdout.write('ASIST_JSON:{"type":"ready","device":"cpu","frameHz":12.5}\n'), 0)
  return child
}

const window = { webContents: { send: vi.fn() }, isDestroyed: () => false }
const APP_PAGE = 'http://localhost:5173/'
/** Calls a handler as the app's own page does. */
const invoke = (channel: string, ...args: unknown[]): unknown =>
  mocks.handlers.get(channel)!({ sender: window.webContents, senderFrame: { parent: null, url: APP_PAGE } }, ...args)
let vap: typeof import('../src/main/services/vap')

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  mocks.settings.vapEnabled = false
  mocks.watchdogStart.mockReset()
  mocks.llmKeyStates.mockReset().mockReturnValue({})
  mocks.spawn.mockReset().mockImplementation(fakeWorker)
  window.webContents.send.mockReset()
  vi.stubEnv('ASIST_VAP_PYTHON', '/unused/python')
  // MaAI's runtime, models and script are taken to be in place.
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { registerIpc } = await import('../src/main/ipc')
  vap = await import('../src/main/services/vap')
  registerIpc(window as never, APP_PAGE)
})
afterEach(() => {
  vap.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the status the watchdog pushes', () => {
  it('logs a status it cannot compute, such as one whose API key file is damaged, rather than leaving the rejection to no one', async () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const damaged = new Error('The API key file is damaged')
    mocks.llmKeyStates.mockImplementation(() => { throw damaged })
    const push = mocks.watchdogStart.mock.calls[0][0] as () => void
    push()
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.any(String), damaged))
    expect(window.webContents.send).not.toHaveBeenCalledWith(IpcChannel.StatusChanged, expect.anything())
  })
})

describe('the preparation of MaAI', () => {
  it('keeps the worker it loaded to check, which the settings use once they turn MaAI on', async () => {
    await expect(invoke(IpcChannel.VapPrepare)).resolves.toMatchObject({ ok: true })
    expect(vap.installationStatus().running).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('unloads the worker when the first-run setup, which leaves MaAI off, is done with its check', async () => {
    await invoke(IpcChannel.VapPrepare)
    await invoke(IpcChannel.VapStop)
    expect(vap.installationStatus().running).toBe(false)
  })
})
