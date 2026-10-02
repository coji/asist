import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Starts src/main/index.ts with every service replaced, over the real update service and a stand-in for
 * electron-updater: a start in which a service throws, and the launch that only updates, which such a start asks
 * for as it quits.
 */

class FakeUpdater extends EventEmitter {
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn()
  session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  loadURL = vi.fn(() => Promise.resolve())
  isDestroyed = (): boolean => false
}

/** The app's events, which a test emits the way Electron does. */
const appEvents = new EventEmitter()

const mocks = vi.hoisted(() => ({
  os: 'macos' as 'macos' | 'windows',
  windows: [] as unknown[],
  updater: null as unknown as FakeUpdater,
  squirrel: null as unknown as EventEmitter,
  quit: vi.fn(),
  relaunch: vi.fn(),
  showErrorBox: vi.fn(),
  notify: vi.fn(() => true),
  prepare: vi.fn(),
  settingsBroken: false,
  registerIpc: vi.fn(),
  checkAfter: vi.fn(),
  initJobReporting: vi.fn(),
  initMaintenance: vi.fn(),
  initMail: vi.fn(),
  ensureLoaded: vi.fn(),
  initMemoryCuration: vi.fn(),
  ensureServer: vi.fn(() => Promise.resolve(true)),
  ensureEngine: vi.fn(() => Promise.resolve()),
  // The quit gate stops the agents and then quits or installs; here it does the last step at once.
  quitAfterAgentsStop: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (event: string, listener: (...args: unknown[]) => void) => appEvents.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => appEvents.off(event, listener),
    quit: mocks.quit,
    relaunch: mocks.relaunch,
    getAppPath: () => '/Applications/ASIST.app/Contents/Resources/app.asar'
  },
  BrowserWindow: class {
    constructor() {
      const window = new FakeWindow()
      mocks.windows.push(window)
      return window
    }
  },
  dialog: { showErrorBox: mocks.showErrorBox },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  shell: { openExternal: () => undefined },
  get autoUpdater() {
    return mocks.squirrel
  }
}))
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return mocks.updater
  }
}))
vi.mock('../src/main/environment', () => ({}))
vi.mock('../src/main/logging', () => ({ logRenderer: () => undefined }))
vi.mock('../src/main/ipc', () => ({ registerIpc: mocks.registerIpc }))
vi.mock('../src/main/os-integration', () => ({
  setupOsIntegration: () => undefined,
  notify: mocks.notify,
  quitAfterAgentsStop: mocks.quitAfterAgentsStop
}))
vi.mock('../src/main/window-chrome', () => ({ windowChrome: () => ({ frame: {}, prepare: mocks.prepare }) }))
vi.mock('../src/main/file-protocol', () => ({ handleFileScheme: () => undefined, registerFileScheme: () => undefined }))
vi.mock('../src/main/services/native-mic', () => ({ stop: () => undefined }))
vi.mock('../src/main/services/live', () => ({ stop: () => Promise.resolve() }))
vi.mock('../src/main/services/asr', () => ({ ensureServer: mocks.ensureServer }))
vi.mock('../src/main/services/tts', () => ({ ensureEngine: mocks.ensureEngine }))
vi.mock('../src/main/services/aizuchi', () => ({ getBank: () => undefined }))
vi.mock('../src/main/services/aizuchi-classifier', () => ({ wanted: () => false, ensureStarted: () => undefined }))
vi.mock('../src/main/services/watchdog', () => ({ checkAfter: mocks.checkAfter }))
vi.mock('../src/main/services/brain/job-reporting', () => ({ initJobReporting: mocks.initJobReporting }))
vi.mock('../src/main/services/maintenance', () => ({ compactionJob: {}, initMaintenance: mocks.initMaintenance }))
vi.mock('../src/main/services/memory', () => ({ ensureLoaded: mocks.ensureLoaded, startEmbeddingIfEnabled: () => Promise.resolve(false) }))
vi.mock('../src/main/services/memory-curation', () => ({ initMemoryCuration: mocks.initMemoryCuration }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => [] }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => {
    if (mocks.settingsBroken) throw new Error('settings.json is damaged')
    return { uiLocale: 'en-US' }
  }
}))
vi.mock('../src/main/services/mail', () => ({ initMail: mocks.initMail }))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.os === 'windows' ? WINDOWS : MACOS) }
})

/** The resources of a release, which carry the address of the releases, and of a local build, which do not. */
const releaseResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-release-'))
const localResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-local-build-'))
fs.writeFileSync(path.join(releaseResources, 'app-update.yml'), 'provider: github\n')

const argv = process.argv

/** Starts the app the way the OS does, with these arguments after the executable. */
async function launch(args: string[]): Promise<void> {
  process.argv = [argv[0], ...args]
  await import('../src/main/index')
}

/** Starts the app with the memory curation failing as a broken jobs.json made it fail, and waits for the error. */
async function failToStart(): Promise<void> {
  mocks.initMemoryCuration.mockImplementation(() => {
    throw new Error('jobs.json is damaged')
  })
  await launch([])
  await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalled())
}

/** Starts the launch a start that failed asks for, and waits until it checks for a newer version. */
async function launchToUpdate(platform: 'macos' | 'windows'): Promise<void> {
  mocks.os = platform
  await failToStart()
  const [{ args }] = mocks.relaunch.mock.calls[0] as [{ args: string[] }]
  vi.resetModules()
  vi.clearAllMocks()
  appEvents.removeAllListeners()
  mocks.initMemoryCuration.mockReset()
  await launch(args)
  await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
}

/** What electron-updater, and on macOS Squirrel.Mac, report for a newer version found, downloaded and staged. */
function publish(version: string): void {
  mocks.updater.emit('checking-for-update')
  mocks.updater.emit('update-available', { version })
  mocks.updater.emit('download-progress', { percent: 100 })
  mocks.updater.emit('update-downloaded', { version })
  if (mocks.os === 'macos') mocks.squirrel.emit('update-downloaded')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  appEvents.removeAllListeners()
  mocks.windows.length = 0
  mocks.os = 'macos'
  mocks.settingsBroken = false
  mocks.initMemoryCuration.mockReset()
  mocks.quitAfterAgentsStop.mockImplementation((install?: () => void) => (install ? install() : mocks.quit()))
  mocks.updater = new FakeUpdater()
  mocks.squirrel = new EventEmitter()
  Object.defineProperty(process, 'resourcesPath', { value: releaseResources, configurable: true })
})

afterEach(() => {
  process.argv = argv
})

afterAll(() => {
  fs.rmSync(releaseResources, { recursive: true, force: true })
  fs.rmSync(localResources, { recursive: true, force: true })
})

describe('a start that failed', () => {
  it('quits through the quit gate and starts again in a launch that only updates, in a build that updates itself', async () => {
    await failToStart()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.quitAfterAgentsStop).toHaveBeenCalledExactlyOnceWith()
    expect(mocks.relaunch).toHaveBeenCalledOnce()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('quits without starting again in a build that does not update itself', async () => {
    Object.defineProperty(process, 'resourcesPath', { value: localResources, configurable: true })
    await failToStart()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('opens no window and starts no voice when one of the services fails to start', async () => {
    await failToStart()
    expect(mocks.windows).toEqual([])
    expect(mocks.ensureServer).not.toHaveBeenCalled()
    expect(mocks.ensureEngine).not.toHaveBeenCalled()
  })

  it('tries the quit again when ASIST is launched again after the agents did not stop', async () => {
    mocks.quitAfterAgentsStop.mockImplementation(() => undefined)
    await failToStart()
    appEvents.emit('activate')
    appEvents.emit('second-instance')
    expect(mocks.quitAfterAgentsStop).toHaveBeenCalledTimes(3)
  })
})

describe('the launch that only updates after a failed start', () => {
  it.each(['macos', 'windows'] as const)('installs a newer version the check finds and starts it, on %s', async (platform) => {
    await launchToUpdate(platform)
    publish('0.5.1')
    await vi.waitFor(() => expect(mocks.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true))
    expect(mocks.notify).toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('starts nothing of the app while it checks and downloads', async () => {
    await launchToUpdate('macos')
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalled())
    expect(mocks.windows).toEqual([])
    for (const started of [mocks.registerIpc, mocks.checkAfter, mocks.initJobReporting, mocks.initMaintenance, mocks.initMail, mocks.ensureLoaded, mocks.initMemoryCuration, mocks.ensureServer, mocks.ensureEngine]) {
      expect(started).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['the running version is the latest', () => mocks.updater.emit('update-not-available')],
    ['the check fails', () => mocks.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))]
  ])('quits without installing anything or starting again when %s', async (_case, answer) => {
    await launchToUpdate('macos')
    answer()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('says again what it is doing when ASIST is launched again during the download, from the Dock as from anywhere else', async () => {
    await launchToUpdate('macos')
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
    appEvents.emit('activate')
    appEvents.emit('second-instance')
    expect(mocks.notify).toHaveBeenCalledTimes(3)
  })

  it('shows why the download failed and quits, and no longer says it is updating', async () => {
    await launchToUpdate('windows')
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
    mocks.updater.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.showErrorBox).toHaveBeenCalledOnce()
    appEvents.emit('second-instance')
    expect(mocks.notify).toHaveBeenCalledOnce()
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('shows why the install failed and quits when Squirrel.Mac reports an error instead of quitting into the new version', async () => {
    await launchToUpdate('macos')
    publish('0.5.1')
    await vi.waitFor(() => expect(mocks.updater.quitAndInstall).toHaveBeenCalled())
    mocks.updater.emit('error', new Error('Could not locate update bundle'))
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.showErrorBox).toHaveBeenCalledOnce()
  })

  it('gives the app its identity before it notifies, so that Windows shows the notification, even with settings it cannot read', async () => {
    mocks.settingsBroken = true
    await launchToUpdate('windows')
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalled())
    expect(mocks.prepare).toHaveBeenCalled()
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0])
  })
})
