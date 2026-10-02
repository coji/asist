import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ windows: false, feed: true, updater: null as unknown as FakeUpdater, squirrel: null as unknown as EventEmitter }))

class FakeUpdater extends EventEmitter {
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('node:fs', () => ({ default: { existsSync: () => mocks.feed } }))
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
async function load(os: 'macos' | 'windows'): Promise<typeof import('../src/main/services/app-update')> {
  mocks.windows = os === 'windows'
  mocks.updater = new FakeUpdater()
  mocks.squirrel = new EventEmitter()
  return await import('../src/main/services/app-update')
}

async function start(os: 'macos' | 'windows'): Promise<typeof import('../src/main/services/app-update')> {
  const service = await load(os)
  service.initAppUpdates()
  return service
}

/** Whether a promise has settled by now, without waiting for it. */
function settledYet(promise: Promise<unknown>): () => boolean {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  return () => settled
}

/** What the NSIS updater and electron-updater's zip download on macOS both report for a finished download. */
function downloaded(version: string): void {
  mocks.updater.emit('update-available', { version })
  mocks.updater.emit('update-downloaded', { version })
}

beforeEach(() => {
  vi.resetModules()
  mocks.feed = true
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

describe('the update after a start that failed', () => {
  it('does not check in a build that does not update itself', async () => {
    mocks.feed = false
    const service = await load('macos')
    await expect(service.versionAfterFailedStart()).resolves.toBeNull()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('gives up a check that never answers, so that the app still quits', async () => {
    const service = await load('macos')
    const version = service.versionAfterFailedStart()
    mocks.updater.emit('checking-for-update')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await expect(version).resolves.toBeNull()
  })

  it('waits on a download as long as it receives, and gives up one that has stopped', async () => {
    const service = await load('windows')
    const version = service.versionAfterFailedStart()
    mocks.updater.emit('update-available', { version: '0.1.2' })
    await expect(version).resolves.toBe('0.1.2')
    const install = service.installAfterFailedStart()
    const settled = settledYet(install)
    for (let second = 1; second <= 30 * 60; second++) {
      await vi.advanceTimersByTimeAsync(1000)
      mocks.updater.emit('download-progress', { percent: (second / (30 * 60)) * 99 })
    }
    expect(settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await expect(install).rejects.toThrow()
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('gives up a differential download that reached 100 % and stalls once it starts over in full', async () => {
    const service = await load('windows')
    const version = service.versionAfterFailedStart()
    mocks.updater.emit('update-available', { version: '0.1.2' })
    await version
    const givenUp = expect(service.installAfterFailedStart()).rejects.toThrow()
    mocks.updater.emit('download-progress', { percent: 100 })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await givenUp
  })

  it('leaves nothing to install at the quit once it has given up a download, even if the download then finishes', async () => {
    const service = await load('windows')
    const version = service.versionAfterFailedStart()
    mocks.updater.emit('update-available', { version: '0.1.2' })
    await version
    const givenUp = expect(service.installAfterFailedStart()).rejects.toThrow()
    expect(mocks.updater.autoInstallOnAppQuit).toBe(true)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await givenUp
    mocks.updater.emit('update-downloaded', { version: '0.1.2' })
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
  })

  it('waits for Squirrel.Mac to stage a downloaded version however long it takes, then installs it and starts it', async () => {
    const service = await load('macos')
    const version = service.versionAfterFailedStart()
    mocks.updater.emit('update-available', { version: '0.1.2' })
    await version
    const install = service.installAfterFailedStart()
    const settled = settledYet(install)
    mocks.updater.emit('download-progress', { percent: 100 })
    mocks.updater.emit('update-downloaded', { version: '0.1.2' })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(settled()).toBe(false)
    mocks.squirrel.emit('update-downloaded')
    ;(await install)()
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })
})
