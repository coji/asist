import { app, autoUpdater as squirrel } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import mitt from 'mitt'
import { autoUpdater } from 'electron-updater'
import { AppUpdateController, afterStaging, type AppUpdateState, type Updater } from '@shared/app-update'
import { errorText } from '@shared/i18n/error-text'
import { platformCapabilities } from './platform'

/**
 * electron-builder writes app-update.yml, the address of the releases, only into a build that has a publish
 * setting and an updatable target. On macOS that is a build with a dmg or zip target, which only
 * scripts/release.mjs makes; on Windows it is the NSIS installer built with the GitHub setting that only the
 * release workflow passes. A local `dist:mac` or `dist:win` has none, and updating it from a release would
 * replace a build of unreleased code.
 */
const FEED = 'app-update.yml'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How long a start that failed waits on a check that has not answered, or on a download that has received
 * nothing, before it quits without the update. electron-updater's own timeout waits for a `socket` event that
 * the requests of Electron's net never emit (electron-updater 6.8.9, Electron 43.7.7), so it never gives up on a
 * stalled connection, and an app that shows nothing would stay alive while the single-instance lock refuses
 * every later launch. A check against GitHub answered in about a second (2026-10-02), and electron-updater
 * reports a download's progress every second while bytes arrive.
 */
const FAILED_START_STALL_MS = 30_000

export const events = mitt<{ changed: AppUpdateState }>()

let controller: AppUpdateController | null = null

export function appUpdateState(): AppUpdateState {
  return controller?.state ?? { phase: 'off' }
}

/**
 * The updater whose update-downloaded means that the next quit installs the version. The NSIS updater reports
 * it once the installer is on disk and matches latest.yml, and runs that installer itself when the app quits,
 * so on Windows its own event already means it.
 */
function installableUpdater(): Updater {
  return platformCapabilities().os === 'macos' ? afterStaging(autoUpdater, squirrel) : autoUpdater
}

/** Whether this build updates itself from the releases, which only a build made for a release does. */
export function updatesItself(): boolean {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, FEED))
}

export function initAppUpdates(): void {
  if (controller || !updatesItself()) return
  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // A release carries only the full installer. Left false, the NSIS updater warns about a web installer on
  // every download.
  autoUpdater.disableWebInstaller = true
  controller = new AppUpdateController(installableUpdater(), {
    now: Date.now,
    onChange: (state) => {
      if (state.phase === 'failed') console.error('app update failed:', state.message)
      events.emit('changed', state)
    }
  })
  controller.check()
  setInterval(() => controller?.check(), CHECK_INTERVAL_MS)
}

/**
 * The install of the downloaded version, checked now so that the about page hears why it cannot start.
 * Installing quits the app, so the caller runs it through the same gate as any other quit.
 */
export function readyUpdateInstall(): () => void {
  const ready = controller
  if (!ready) throw new Error('automatic updates are off in this build')
  if (ready.state.phase !== 'ready') throw new Error(`no update is ready to install (${ready.state.phase})`)
  return () => ready.install()
}

/**
 * The newer version the launch that only updates after a failed start installs, or null when this build does not
 * update, the running version is the latest, or the check fails or stalls. That launch starts nothing else, so
 * the updater starts here.
 */
export async function versionAfterFailedStart(): Promise<string | null> {
  initAppUpdates()
  const state = await settledState((state) => state.phase !== 'checking')
  return 'version' in state ? state.version : null
}

/** The install of the version found after a failed start, once it is downloaded. Throws why the download failed or stalled. */
export async function installAfterFailedStart(): Promise<() => void> {
  const state = await settledState((state) => state.phase !== 'checking' && state.phase !== 'downloading' && state.phase !== 'staging')
  if (state.phase === 'failed') throw new Error(state.message)
  return readyUpdateInstall()
}

/**
 * Throws why the install of a version that was ready failed after it began: Squirrel.Mac can report an error
 * where it would quit into the new version, and electron-updater then only reports it. When the install works,
 * the app quits before this settles.
 */
export async function installFailure(): Promise<never> {
  const state = await settledState((state) => state.phase === 'failed')
  throw new Error(state.phase === 'failed' ? state.message : state.phase)
}

/**
 * The first state of the update that `settled` accepts, the current one included. A check or a download that
 * hears nothing for FAILED_START_STALL_MS ends as a failure, whatever percentage it has reached: a differential
 * download that reaches 100 % and then fails its checksum starts over in full. Staging is not cut short, since
 * Squirrel.Mac reports nothing while it unpacks and verifies the version and reads no network.
 */
function settledState(settled: (state: AppUpdateState) => boolean): Promise<AppUpdateState> {
  return new Promise((resolve) => {
    let stall: ReturnType<typeof setTimeout> | undefined
    const finish = (state: AppUpdateState): void => {
      clearTimeout(stall)
      events.off('changed', follow)
      resolve(state)
    }
    const follow = (state: AppUpdateState): void => {
      clearTimeout(stall)
      if (settled(state)) return finish(state)
      if (state.phase !== 'checking' && state.phase !== 'downloading') return
      stall = setTimeout(() => {
        console.error(`app update after a failed start: nothing received for ${FAILED_START_STALL_MS / 1000} s (${state.phase})`)
        // electron-updater goes on with a download the app gave up on, and would install it at the quit without
        // starting ASIST, on Windows by the NSIS installer and on macOS by handing it to Squirrel.Mac.
        autoUpdater.autoInstallOnAppQuit = false
        finish({ phase: 'failed', message: errorText('app.startup.updateStalled') })
      }, FAILED_START_STALL_MS)
    }
    events.on('changed', follow)
    follow(appUpdateState())
  })
}
