import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Emitter } from 'mitt'
import type { AgentJob, JobEvent } from '@shared/ipc'

type Listener = (event: { preventDefault: () => void }) => void

const mocks = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string }>,
  agentEvents: null as unknown as Emitter<{ event: JobEvent }>,
  appListeners: new Map<string, Listener[]>(),
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  shutdown: vi.fn<() => Promise<void>>(),
  register: vi.fn((_accelerator: string, _callback: () => void) => true),
  settings: { globalHotkey: false },
  windows: false
}))

vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('electron', () => {
  class Notification {
    static isSupported = (): boolean => true
    constructor(private readonly options: { title: string; body: string }) {}
    show(): void {
      mocks.notifications.push({ title: this.options.title, body: this.options.body })
    }
  }
  class Tray {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
  }
  return {
    app: {
      on: (name: string, listener: Listener) => mocks.appListeners.set(name, [...(mocks.appListeners.get(name) ?? []), listener]),
      quit: mocks.quit
    },
    dialog: { showErrorBox: mocks.showErrorBox },
    globalShortcut: { unregister: vi.fn(), register: mocks.register, unregisterAll: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }) },
    Notification,
    Tray
  }
})
vi.mock('../src/main/services/agent', async () => {
  const { default: mitt } = await import('mitt')
  mocks.agentEvents = mitt()
  return { events: mocks.agentEvents, shutdown: mocks.shutdown }
})
vi.mock('../src/main/services/i18n', () => ({ t: (key: string) => key, errorMessage: (error: unknown) => (error as Error).message }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))

import { hotkeyStatus, refreshHotkey, setupOsIntegration } from '../src/main/os-integration'

/** A hidden window that keeps its listeners, so that a test can close it the way the user does. */
function hiddenWindow() {
  const listeners = new Map<string, Listener>()
  return {
    on: (name: string, listener: Listener) => listeners.set(name, listener),
    /** Closes the window the way the user does, and says whether it closed. */
    close: () => {
      let prevented = false
      listeners.get('close')?.({ preventDefault: () => (prevented = true) })
      return !prevented
    },
    hide: vi.fn(),
    isVisible: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    webContents: { send: vi.fn() }
  }
}

/** Asks the app to quit the way Cmd+Q does, and says whether the quit went ahead. */
function quit(): boolean {
  let prevented = false
  for (const listener of mocks.appListeners.get('before-quit') ?? []) listener({ preventDefault: () => (prevented = true) })
  return !prevented
}

const finished = (id: string, patch: Partial<AgentJob> = {}): AgentJob => ({
  id, title: id, prompt: id, cwd: '/w', readonly: true, engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, ...patch
})

beforeEach(() => {
  mocks.notifications.length = 0
  mocks.appListeners.clear()
  mocks.quit.mockReset()
  mocks.showErrorBox.mockReset()
  mocks.shutdown.mockReset()
  mocks.register.mockReset().mockReturnValue(true)
  mocks.settings.globalHotkey = false
  mocks.windows = false
})

describe('the OS notification when a job ends while the window is hidden', () => {
  it('is raised for a job of the user and not for the memory curation, which runs behind the conversation', () => {
    setupOsIntegration(hiddenWindow() as never)
    mocks.agentEvents.emit('event', { type: 'update', job: finished('curation', { memoryCuration: { through: '2026-09-25', applied: false } }) })
    mocks.agentEvents.emit('event', { type: 'update', job: finished('report') })
    expect(mocks.notifications).toEqual([{ title: 'app.notify.jobDone', body: 'report' }])
  })
})

describe('quitting while agents run', () => {
  it('closes the window only after every agent has stopped', async () => {
    const window = hiddenWindow()
    setupOsIntegration(window as never)
    let stopped!: () => void
    mocks.shutdown.mockReturnValue(new Promise((resolve) => (stopped = resolve)))
    expect(quit()).toBe(false)
    expect(quit()).toBe(false)
    expect(window.close()).toBe(false)
    stopped()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(quit()).toBe(true)
    expect(window.close()).toBe(true)
  })

  it('leaves the app as it was when an agent cannot be stopped, so the window still hides and a later quit tries again', async () => {
    const window = hiddenWindow()
    setupOsIntegration(window as never)
    mocks.shutdown.mockRejectedValueOnce(new Error('an agent did not stop'))
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledWith('app.startup.agentStopFailed', 'an agent did not stop'))
    expect(window.close()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(mocks.quit).not.toHaveBeenCalled()

    mocks.shutdown.mockResolvedValueOnce(undefined)
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(mocks.shutdown).toHaveBeenCalledTimes(2)
    expect(quit()).toBe(true)
    expect(window.close()).toBe(true)
  })
})

describe('the global hotkey', () => {
  it('registers the accelerator of the OS it runs on', () => {
    mocks.settings.globalHotkey = true
    setupOsIntegration(hiddenWindow() as never)
    mocks.windows = true
    setupOsIntegration(hiddenWindow() as never)
    expect(mocks.register.mock.calls.map(([accelerator]) => accelerator)).toEqual(['Alt+Space', 'Ctrl+Alt+Space'])
    expect(hotkeyStatus()).toBe('registered')
  })

  it('reports a registration the OS refuses, and nothing once the setting turns the hotkey off', () => {
    mocks.settings.globalHotkey = true
    mocks.register.mockReturnValue(false)
    setupOsIntegration(hiddenWindow() as never)
    expect(hotkeyStatus()).toBe('failed')
    mocks.settings.globalHotkey = false
    refreshHotkey()
    expect(hotkeyStatus()).toBe('off')
  })
})
