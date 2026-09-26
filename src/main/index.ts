import './environment'
import { logRenderer } from './logging'
import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import dns from 'node:dns'

// undici's happy-eyeballs tries IPv6 first and reports a false ETIMEDOUT on a network with no IPv6
// route, which broke connections to hosts such as open-meteo, so it is disabled in favour of IPv4.
net.setDefaultAutoSelectFamily?.(false)
dns.setDefaultResultOrder('ipv4first')
import { registerIpc } from './ipc'
import { setupOsIntegration } from './os-integration'
import * as asr from './services/asr'
import { clearTemporaryAudio } from './services/mlx-asr'
import * as tts from './services/tts'
import * as aizuchi from './services/aizuchi'
import * as aizuchiClassifier from './services/aizuchi-classifier'
import { initJobReporting } from './services/brain/job-reporting'
import { compactionJob, initMaintenance } from './services/maintenance'
import * as memory from './services/memory'
import { initMemoryCuration } from './services/memory-curation'
import { allowedFileRoots } from './services/agent'
import { handleFileScheme, registerFileScheme } from './file-protocol'
import { errorMessage, t } from './services/i18n'
import { platformCapabilities } from './services/platform'
import { getSettings } from './services/settings'
import { createTranslator } from '@shared/i18n'
import { initMail } from './services/mail'
import { isAppPage } from '@shared/app-page'
import { isExternalLink } from '@shared/external-link'
import { windowChrome } from './window-chrome'

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
// asist-file://, which the files card fetches images, documents, audio and video over, has to be
// registered before whenReady.
registerFileScheme()

/** The permissions the app's own page asks for: the microphone, copying a job's text, and a video in full screen. */
const PAGE_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])

function createWindow(): void {
  const chrome = windowChrome(platformCapabilities().os)
  chrome.prepare()
  const rendererFile = path.join(__dirname, '../renderer/index.html')
  const appPage = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererFile).href
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'ASIST',
    backgroundColor: '#05070F',
    ...chrome.frame,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // A Google link inside the map card's iframe, such as the one that opens the larger map, goes to the
  // default browser instead of a window inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The preload bridge is exposed to whatever page this window shows, so the window never leaves the
  // app's page: a link clicked in a document or a file dropped on the window would otherwise hand the
  // whole API to that page. A web or mail link opens in its own app instead.
  mainWindow.webContents.on('will-navigate', (event) => {
    if (isAppPage(event.url, appPage)) return
    event.preventDefault()
    if (isExternalLink(event.url)) void shell.openExternal(event.url)
  })

  // Electron grants every permission by default, including to the map's iframe.
  const { session } = mainWindow.webContents
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl, appPage))
  })
  session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl ?? '', appPage)
  )

  logRenderer(mainWindow)
  registerIpc(mainWindow, appPage)
  setupOsIntegration(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(rendererFile)
  }
}

/**
 * The interface language is read from the settings file, and a settings file that cannot be read is one
 * of the failures reported here, so a failing read leaves the dialog in the language the messages are
 * written in rather than leaving no window at all.
 */
function showStartupFailure(error: unknown): void {
  try {
    dialog.showErrorBox(t('app.startup.launchFailed'), errorMessage(error))
  } catch {
    const title = createTranslator('ja-JP')('app.startup.launchFailed')
    dialog.showErrorBox(title, error instanceof Error ? error.message : String(error))
  }
}

if (!hasSingleInstanceLock) {
  // Two processes updating the same userData notify a timer twice and lose JSON updates, so the second
  // one quits.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    // A development launch uses the same image as the packaged app rather than Electron's default icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build/icon.png'))
      if (icon.isEmpty()) throw new Error('cannot load build/icon.png')
      app.dock?.setIcon(icon)
    }
    // An OS or CPU the app is not built for stops the launch before any service starts.
    platformCapabilities()
    // Reading the settings first keeps a broken file from starting any service; the original file is kept
    // and the place to fix is shown.
    getSettings()
    handleFileScheme(allowedFileRoots)

    // In self-test mode the whole pipeline runs against the real services and the app then exits.
    if (process.env.ASIST_SELFTEST === '1') {
      void import('./services/selftest').then(async ({ runSelfTest }) => {
        const failed = await runSelfTest().catch((err) => {
          console.error('selftest crashed:', err)
          return 99
        })
        app.exit(failed)
      })
      return
    }

    createWindow()

    // The sidecars are warmed up here, and a failure does not stop the app from starting. No
    // transcription has started yet, so any recording in the temporary folder is left from an earlier run.
    try {
      clearTemporaryAudio()
    } catch (error) {
      console.error('could not remove the leftover recordings:', error)
    }
    void asr.ensureServer()
    void tts.ensureEngine().then(() => aizuchi.getBank()).catch((error) => console.error('TTS preparation failed:', error))
    // The aizuchi classifier stays resident when it is prepared and aizuchi are wanted; without it no
    // aizuchi plays at the head of a turn.
    if (aizuchiClassifier.wanted(getSettings())) void aizuchiClassifier.ensureStarted()
    initJobReporting()
    initMaintenance([compactionJob])
    // Mail connects to the accounts in the settings and starts fetching; a failure shows up on the
    // settings screen and in the conversation.
    initMail()
    // Memory builds its index from the files and watches for a curation job being merged. The worker
    // starts only when semantic search is on.
    memory.ensureLoaded()
    initMemoryCuration()
    void memory.startEmbeddingIfEnabled().catch((err) => console.error('memory embedding:', err))

    // The window only hides when it is closed and is destroyed only by a quit, so it is never created a second
    // time, which would register the IPC handlers again.
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    })
  }).catch((error: unknown) => {
    showStartupFailure(error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
