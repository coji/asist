import type { BrowserWindow } from 'electron'
import * as nativeMic from './services/native-mic'
import * as live from './services/live'

/**
 * The life of the app's page in the main window. The page is replaced when a reload commits, from the View
 * menu that macOS keeps or after a crash; a navigation to any other page is refused by will-navigate before
 * it commits.
 */

/** A page that crashes again this soon after it was loaded again for a crash would crash in a loop, so it is left down. */
const CRASH_RELOAD_INTERVAL_MS = 60_000

let pagesShown = 0

/**
 * Whether the page in the window is the first one the app has shown since it started. Only that page is a
 * launch: a page loaded again after a reload or a crash starts with the microphone off, even when the
 * microphone is set to turn on at launch, because the user may have turned it off and the window may be
 * hidden.
 */
export function isLaunchPage(): boolean {
  return pagesShown === 1
}

/**
 * Stops what main runs for the page in the window: the microphone helper and the live engine the page
 * started. The page that replaces it knows nothing of them, so they would go on capturing, speaking job
 * reports and running a billed session behind it.
 */
function stopPageWork(): void {
  nativeMic.stop()
  void live.stop().catch((error) => console.error('live stop failed:', error))
}

/** Follows the page in the window: what the old page started stops when it is replaced, and a crashed page is loaded again. */
export function watchAppPage(window: BrowserWindow, appPage: string): void {
  window.webContents.on('did-navigate', () => {
    pagesShown++
    stopPageWork()
  })
  let crashReloadedAt = -Infinity
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`renderer process gone: reason=${details.reason} exit=${details.exitCode}`)
    stopPageWork()
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    if (Date.now() - crashReloadedAt < CRASH_RELOAD_INTERVAL_MS) {
      console.error('the page is left down, because it crashed again soon after it was loaded again')
      return
    }
    crashReloadedAt = Date.now()
    void window.loadURL(appPage)
  })
}
