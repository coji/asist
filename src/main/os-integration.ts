import { isBackgroundJob, isJobTerminal } from '@shared/job-status'
import {
  app,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type BrowserWindow,
  type NativeImage
} from 'electron'
import { IpcChannel, type HotkeyStatus } from '@shared/ipc'
import * as agent from './services/agent'
import * as live from './services/live'
import { errorText } from '@shared/i18n/error-text'
import { errorMessage, t } from './services/i18n'
import { platformCapabilities } from './services/platform'
import { getSettings } from './services/settings'
import type { OsFamily } from '@shared/platform'
import macosTrayIcon from './assets/tray/macos-template.png?inline'
import windowsTrayIcon16 from './assets/tray/windows-16.png?inline'
import windowsTrayIcon20 from './assets/tray/windows-20.png?inline'
import windowsTrayIcon24 from './assets/tray/windows-24.png?inline'
import windowsTrayIcon32 from './assets/tray/windows-32.png?inline'

/**
 * How the app lives in the OS: a resident tray item, the global hotkey, the OS's notifications and a
 * window that only hides when it is closed, so that the user never has to open the app to reach it.
 * Quitting waits until the agents have stopped.
 */

const TRAY_ICONS: Record<OsFamily, () => NativeImage> = {
  // An 18x18 template of the orb, only black and alpha, which the menu bar recolours for light and dark.
  macos: () => {
    const icon = nativeImage.createFromDataURL(macosTrayIcon)
    icon.setTemplateImage(true)
    return icon
  },
  // The coloured logo, one size for each display scale, from which Windows picks the one for the screen.
  windows: () => {
    const icon = nativeImage.createEmpty()
    const sizes: [number, string][] = [[1, windowsTrayIcon16], [1.25, windowsTrayIcon20], [1.5, windowsTrayIcon24], [2, windowsTrayIcon32]]
    for (const [scaleFactor, dataURL] of sizes) icon.addRepresentation({ scaleFactor, dataURL })
    return icon
  }
}

let tray: Tray | null = null
let hotkey: HotkeyStatus = 'off'
let buildTrayMenu: () => void = () => {}

const notify = (title: string, body: string): boolean => {
  if (!Notification.isSupported()) return false
  new Notification({ title, body: body.slice(0, 180), silent: false }).show()
  return true
}

// Only a quit closes the window, and only once every agent the app owns has stopped, so that none keeps
// writing to a worktree after the app is gone. When one cannot be stopped the quit is cancelled and the app
// stays as it was: the window still hides when closed, and a later quit tries again.
let quitApproved = false
let stoppingAgents = false
/** The install of a staged update that the quit under way ends with in place of app.quit(). */
let pendingInstall: (() => void) | null = null

/**
 * Stops every agent, then quits: with app.quit(), or with `install`, the install of a staged update, which
 * closes the windows itself and so has to be approved before it starts. A quit asked for while the agents are
 * stopping joins the one under way, and an install asked for then becomes how that one ends.
 */
export function quitAfterAgentsStop(install?: () => void): void {
  if (install) pendingInstall = install
  if (stoppingAgents) return
  stoppingAgents = true
  void agent.shutdown().then(
    async () => {
      // The live engine records the usage of its open session as it closes it. The session ends with the
      // app either way, so a failure to close it does not hold the quit.
      await live.stop().catch((error: unknown) => console.error('live stop failed:', error))
      quitApproved = true
      if (pendingInstall) pendingInstall()
      else app.quit()
    },
    (error: unknown) => {
      stoppingAgents = false
      pendingInstall = null
      dialog.showErrorBox(t('app.startup.agentStopFailed'), errorMessage(error))
    }
  )
}

export function setupOsIntegration(window: BrowserWindow): void {
  app.on('before-quit', (event) => {
    if (quitApproved) return
    event.preventDefault()
    quitAfterAgentsStop()
  })
  window.on('close', (e) => {
    if (quitApproved) return
    e.preventDefault()
    window.hide()
  })

  const showWindow = (): void => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  tray = new Tray(TRAY_ICONS[platformCapabilities().os]())
  tray.setToolTip('ASIST')
  // The menu is built again whenever the interface language changes, because its labels are fixed once set.
  buildTrayMenu = (): void =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('app.tray.show'), click: showWindow },
        {
          label: t('app.tray.toggleMic'),
          click: () => {
            showWindow()
            window.webContents.send(IpcChannel.ToggleMic, undefined)
          }
        },
        { type: 'separator' },
        { label: t('app.tray.quit'), role: 'quit' }
      ])
    )
  buildTrayMenu()
  tray.on('click', showWindow)

  const accelerator = platformCapabilities().hotkey
  const registerHotkey = (): void => {
    globalShortcut.unregister(accelerator)
    hotkey = 'off'
    if (!getSettings().globalHotkey) return
    const ok = globalShortcut.register(accelerator, () => {
      if (window.isVisible() && window.isFocused()) {
        window.hide()
      } else {
        showWindow()
        // A microphone that is off when the window is called up is turned on; the renderer decides that.
        window.webContents.send(IpcChannel.HotkeyMic, undefined)
      }
    })
    hotkey = ok ? 'registered' : 'failed'
    if (!ok) console.warn(`global hotkey ${accelerator} registration failed`)
  }
  registerHotkey()
  hotkeyRefresher = registerHotkey
  app.on('will-quit', () => globalShortcut.unregisterAll())

  const notified = new Set<string>()
  agent.events.on('event', (event) => {
    if (event.type !== 'update') return
    const job = event.job
    if (isBackgroundJob(job) || !isJobTerminal(job.status) || notified.has(job.id)) return
    notified.add(job.id)
    if (window.isVisible() && window.isFocused()) return
    if (job.status === 'done') notify(t('app.notify.jobDone'), job.title)
    else if (job.status === 'error') notify(t('app.notify.jobFailed'), job.title)
  })
}

let hotkeyRefresher: (() => void) | null = null

/** Words the tray menu again, after the interface language changed. */
export function refreshTrayMenu(): void {
  buildTrayMenu()
}

/** Re-registers the hotkey after a settings change. A call before setup does nothing. */
export function refreshHotkey(): void {
  hotkeyRefresher?.()
}

/** Whether the hotkey is off in the settings, registered, or refused because another application holds it. */
export const hotkeyStatus = (): HotkeyStatus => hotkey

/** A notification raised by the renderer, for instance when a timer runs out. */
export function notifyFromRenderer(title: string, body: string): void {
  if (!notify(title, body)) throw new Error(errorText('app.notify.unsupported'))
}
