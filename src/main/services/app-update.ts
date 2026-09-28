import { app, autoUpdater as squirrel } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import mitt from 'mitt'
import { autoUpdater } from 'electron-updater'
import { AppUpdateController, afterStaging, type AppUpdateState } from '@shared/app-update'

/**
 * electron-builder writes app-update.yml, the address of the releases, only into a build with a dmg or zip
 * target, which is what scripts/release.mjs makes. The local `dist:mac` build has none, and updating it
 * from a release would replace a build of unreleased code.
 */
const FEED = 'app-update.yml'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const events = mitt<{ changed: AppUpdateState }>()

let controller: AppUpdateController | null = null

export function appUpdateState(): AppUpdateState {
  return controller?.state ?? { phase: 'off' }
}

export function initAppUpdates(): void {
  if (controller || !app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, FEED))) return
  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  controller = new AppUpdateController(afterStaging(autoUpdater, squirrel), {
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
