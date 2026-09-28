import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ windows: false, updater: null as unknown as FakeUpdater, squirrel: null as unknown as EventEmitter }))

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  get autoUpdater() {
    return mocks.squirrel
  }
}))
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return mocks.updater
  }
}))

// The controller is made once for the whole process, so each test takes a fresh copy of the module.
async function start(os: 'macos' | 'windows'): Promise<typeof import('../src/main/services/app-update')> {
  mocks.windows = os === 'windows'
  mocks.updater = new FakeUpdater()
  mocks.squirrel = new EventEmitter()
  const service = await import('../src/main/services/app-update')
  service.initAppUpdates()
  return service
}

/** What the NSIS updater and electron-updater's zip download on macOS both report for a finished download. */
function downloaded(version: string): void {
  mocks.updater.emit('update-available', { version })
  mocks.updater.emit('update-downloaded', { version })
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('an update on Windows', () => {
  it('is ready once the NSIS updater has downloaded it, with no Squirrel event', async () => {
    const service = await start('windows')
    downloaded('0.1.2')
    expect(service.appUpdateState()).toEqual({ phase: 'ready', version: '0.1.2' })
  })

  it('installs now without the installer window and starts the app again', async () => {
    const service = await start('windows')
    downloaded('0.1.2')
    service.readyUpdateInstall()()
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })
})

describe('an update on macOS', () => {
  it('is ready only once Squirrel.Mac has staged the downloaded zip', async () => {
    const service = await start('macos')
    downloaded('0.1.2')
    expect(() => service.readyUpdateInstall()).toThrow()
    mocks.squirrel.emit('update-downloaded')
    expect(service.appUpdateState()).toEqual({ phase: 'ready', version: '0.1.2' })
  })
})
