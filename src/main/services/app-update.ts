import { app, autoUpdater as squirrel } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import mitt from 'mitt'
import { autoUpdater } from 'electron-updater'
import { AppUpdateController, afterStaging, type AppUpdateState, type Updater } from '@shared/app-update'
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

export function initAppUpdates(): void {
  if (controller || !app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, FEED))) return
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
