import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Starts src/main/index.ts with Electron and every service replaced, and keeps the window it creates, so that
 * a test can see which page the window loads and trusts and what happens when that page is replaced.
 */

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn()
  session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
}

const mocks = vi.hoisted(() => ({
  packaged: true,
  windows: [] as Array<{ webContents: FakeWebContents; loadURL: ReturnType<typeof vi.fn>; loadFile: ReturnType<typeof vi.fn>; destroyed: boolean }>,
  registerIpc: vi.fn(),
  micStop: vi.fn(),
  liveStop: vi.fn(() => Promise.resolve())
}))

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = new FakeWebContents()
    destroyed = false
    once = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    isDestroyed = (): boolean => this.destroyed
    constructor() {
      mocks.windows.push(this)
    }
  }
  return {
    app: {
      get isPackaged() {
        return mocks.packaged
      },
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      quit: vi.fn(),
      getAppPath: () => '/Applications/ASIST.app/Contents/Resources/app.asar',
      dock: { setIcon: vi.fn() }
    },
    BrowserWindow,
    dialog: { showErrorBox: vi.fn() },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    shell: { openExternal: vi.fn() }
  }
})
vi.mock('../src/main/environment', () => ({}))
vi.mock('../src/main/logging', () => ({ logRenderer: vi.fn() }))
vi.mock('../src/main/ipc', () => ({ registerIpc: mocks.registerIpc }))
vi.mock('../src/main/os-integration', () => ({ setupOsIntegration: vi.fn() }))
vi.mock('../src/main/window-chrome', () => ({ windowChrome: () => ({ frame: {}, prepare: vi.fn() }) }))
vi.mock('../src/main/file-protocol', () => ({ handleFileScheme: vi.fn(), registerFileScheme: vi.fn() }))
vi.mock('../src/main/services/native-mic', () => ({ stop: mocks.micStop }))
vi.mock('../src/main/services/live', () => ({ stop: mocks.liveStop }))
vi.mock('../src/main/services/asr', () => ({ ensureServer: () => Promise.resolve(true) }))
vi.mock('../src/main/services/tts', () => ({ ensureEngine: () => Promise.resolve() }))
vi.mock('../src/main/services/aizuchi', () => ({ getBank: vi.fn() }))
vi.mock('../src/main/services/aizuchi-classifier', () => ({ wanted: () => false, ensureStarted: vi.fn() }))
vi.mock('../src/main/services/watchdog', () => ({ checkAfter: vi.fn() }))
vi.mock('../src/main/services/brain/job-reporting', () => ({ initJobReporting: vi.fn() }))
vi.mock('../src/main/services/maintenance', () => ({ compactionJob: {}, initMaintenance: vi.fn() }))
vi.mock('../src/main/services/memory', () => ({ ensureLoaded: vi.fn(), startEmbeddingIfEnabled: () => Promise.resolve(false) }))
vi.mock('../src/main/services/app-update', () => ({ initAppUpdates: vi.fn() }))
vi.mock('../src/main/services/memory-curation', () => ({ initMemoryCuration: vi.fn() }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => [] }))
vi.mock('../src/main/services/i18n', () => ({ errorMessage: String, t: (key: string) => key }))
vi.mock('../src/main/services/platform', () => ({ platformCapabilities: () => ({ os: 'macos' }) }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/services/mail', () => ({ initMail: vi.fn() }))

/** Starts the main process and returns its window once the IPC handlers trust a page. */
async function startApp() {
  await import('../src/main/index')
  await vi.waitFor(() => expect(mocks.registerIpc).toHaveBeenCalledTimes(1))
  const window = mocks.windows[0]
  const trusted = mocks.registerIpc.mock.calls[0][1] as string
  return { window, trusted }
}

/** The pages the window was told to show, whichever call it was told with. */
function loadedPages(window: (typeof mocks.windows)[number]): string[] {
  return [...window.loadURL.mock.calls.map(([url]) => String(url)), ...window.loadFile.mock.calls.map(([file]) => `file ${String(file)}`)]
}

beforeEach(() => {
  vi.resetModules()
  mocks.packaged = true
  mocks.windows.length = 0
  mocks.registerIpc.mockClear()
  mocks.micStop.mockClear()
  mocks.liveStop.mockClear()
  vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('the page the main window shows', () => {
  it('loads and trusts only the page inside the package of a packaged app, whatever ELECTRON_RENDERER_URL says', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example/')
    const { window, trusted } = await startApp()
    expect(new URL(trusted).protocol).toBe('file:')
    expect(loadedPages(window)).toEqual([trusted])
  })

  it('loads and trusts the development server in a development launch', async () => {
    mocks.packaged = false
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')
    const { window, trusted } = await startApp()
    expect(new URL(trusted).origin).toBe('http://localhost:5173')
    expect(loadedPages(window)).toEqual([trusted])
  })
})

describe('the launch', () => {
  it('is the first page the app shows, and not the page a reload commits', async () => {
    const { window, trusted } = await startApp()
    const { isLaunchPage } = await import('../src/main/page-lifetime')
    window.webContents.emit('did-navigate', {}, trusted, -1, '')
    expect(isLaunchPage()).toBe(true)
    window.webContents.emit('did-navigate', {}, trusted, -1, '')
    expect(isLaunchPage()).toBe(false)
  })

  it('is not the page loaded again after a crash', async () => {
    const { window, trusted } = await startApp()
    const { isLaunchPage } = await import('../src/main/page-lifetime')
    window.webContents.emit('did-navigate', {}, trusted, -1, '')
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    window.webContents.emit('did-navigate', {}, trusted, -1, '')
    expect(isLaunchPage()).toBe(false)
  })
})

describe('what main runs for the page when the page is replaced', () => {
  it('stops the microphone helper and the live engine when a reload commits a new page', async () => {
    const { window, trusted } = await startApp()
    mocks.micStop.mockClear()
    mocks.liveStop.mockClear()
    window.webContents.emit('did-navigate', {}, trusted, -1, '')
    expect(mocks.micStop).toHaveBeenCalled()
    expect(mocks.liveStop).toHaveBeenCalled()
  })

  it('stops them when the renderer crashes and loads the app page again', async () => {
    const { window, trusted } = await startApp()
    window.loadURL.mockClear()
    window.loadFile.mockClear()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    expect(mocks.micStop).toHaveBeenCalled()
    expect(mocks.liveStop).toHaveBeenCalled()
    expect(loadedPages(window)).toEqual([trusted])
  })

  it('leaves down a page that crashes again soon after it was loaded again for a crash, rather than loading it in a loop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { window, trusted } = await startApp()
    window.loadURL.mockClear()
    window.loadFile.mockClear()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    expect(loadedPages(window)).toEqual([trusted])
    vi.advanceTimersByTime(24 * 60 * 60_000)
    window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 0 })
    expect(loadedPages(window)).toEqual([trusted, trusted])
  })
})
