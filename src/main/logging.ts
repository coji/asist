import { app, type BrowserWindow } from 'electron'
import { isAppPage } from '@shared/app-page'
import { installAppLog } from './services/app-log'
import { revealedApiKeys } from './services/api-key-secrets'

/**
 * Runs as the second dependency of index.ts, so that the console output of every service loaded after it,
 * and any failure during loading, still reaches the file. The directory is the macOS standard
 * ~/Library/Logs/<app name>/, which Console.app also shows.
 */
const log = installAppLog(app.getPath('logs'), revealedApiKeys)

app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') console.error(`child process gone: ${details.type} ${details.name ?? ''} reason=${details.reason} exit=${details.exitCode}`)
})

/**
 * Records the warnings and errors of the app's page. Info is too noisy to be worth keeping. A frame inside
 * the page, such as the map or a document on the files card, runs code the app did not write, and one that
 * prints in a loop could use up the day's log before main's own errors are written, so only the page's main
 * frame is recorded.
 */
export function logRenderer(window: BrowserWindow, appPage: string): void {
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    if (event.frame.parent !== null || !isAppPage(event.frame.url, appPage)) return
    const where = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''
    log.write(event.level === 'error' ? 'error' : 'warn', 'renderer', [`${event.message}${where}`])
  })
}
