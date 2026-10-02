import './environment'
import { logRenderer } from './logging'
import { app, BrowserWindow, dialog, nativeImage, protocol, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import dns from 'node:dns'

// undici's happy-eyeballs tries IPv6 first and reports a false ETIMEDOUT on a network with no IPv6
// route, which broke connections to hosts such as open-meteo, so it is disabled in favour of IPv4.
net.setDefaultAutoSelectFamily?.(false)
dns.setDefaultResultOrder('ipv4first')
import { registerIpc } from './ipc'
import { notify, quitAfterAgentsStop, setupOsIntegration } from './os-integration'
import * as asr from './services/asr'
import * as tts from './services/tts'
import * as aizuchi from './services/aizuchi'
import * as aizuchiClassifier from './services/aizuchi-classifier'
import * as watchdog from './services/watchdog'
import { initJobReporting } from './services/brain/job-reporting'
import { compactionJob, initMaintenance } from './services/maintenance'
import * as memory from './services/memory'
import { initAppUpdates, installAfterFailedStart, installFailure, updatesItself, versionAfterFailedStart } from './services/app-update'
import { initMemoryCuration } from './services/memory-curation'
import { allowedFileRoots } from './services/agent'
import { FILE_SCHEME, fileScheme, handleFileScheme } from './file-protocol'
import { handlePreviewScheme, previewScheme, type RendererSource } from './preview-protocol'
import { errorMessageIn, translatorIn } from './services/i18n'
import { platformCapabilities } from './services/platform'
import { getSettings } from './services/settings'
import type { UiLocale } from '@shared/i18n'
import { initMail } from './services/mail'
import { isAppPage } from '@shared/app-page'
import { isExternalLink } from '@shared/external-link'
import { windowChrome } from './window-chrome'
import { watchAppPage } from './page-lifetime'

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
/** What a start that failed asks the launch after its quit to do instead of starting: update the app, and nothing else. */
const UPDATE_AFTER_FAILED_START = '--update-after-failed-start'
// asist-file://, which the files card fetches images, documents, audio and video over, and asist-preview://,
// which serves the page its viewers parse files in, have to be registered before whenReady, and in one call,
// since Electron takes only one.
protocol.registerSchemesAsPrivileged([fileScheme, previewScheme])

/** The permissions the app's own page asks for: the microphone, copying a job's text, and a video in full screen. */
const PAGE_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * Where the renderer's pages come from. A development launch takes them from electron-vite's server; a packaged
 * app always takes them from inside its package, whatever its environment says.
 */
function rendererSource(): RendererSource {
  const server = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  return server ? { server } : { folder: path.join(__dirname, '../renderer') }
}

/** The page the window shows, and the only page trusted with the preload bridge. */
function appPageUrl(): string {
  const source = rendererSource()
  return 'server' in source ? source.server : pathToFileURL(path.join(source.folder, 'index.html')).href
}

function createWindow(): void {
  const chrome = windowChrome(platformCapabilities().os)
  const appPage = appPageUrl()
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

  // A document served from an allowed folder (the HTML page the files card shows, and any SVG, XML or
  // other document a frame could be pointed at) is a fixed view of one file: it never navigates its own
  // frame. Its sandboxed scripts could otherwise move the frame to a file in another folder, or to a
  // document type served without the confining policy, or to a remote URL built from what they read, so a
  // navigation out of a frame that already shows such a document is refused here, where the policy cannot
  // reach. The frame's first load, from about:blank to the file, and the map card's Google frame, whose
  // document is not served from this scheme, are left alone.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (event.frame?.url.startsWith(`${FILE_SCHEME}:`)) event.preventDefault()
  })

  // Electron grants every permission by default, including to the map's iframe.
  const { session } = mainWindow.webContents
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl, appPage))
  })
  session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl ?? '', appPage)
  )

  watchAppPage(mainWindow, appPage)
  logRenderer(mainWindow, appPage)
  registerIpc(mainWindow, appPage)
  setupOsIntegration(mainWindow)

  void mainWindow.loadURL(appPage)
}

/**
 * The interface language of what a failed start shows. It is read from the settings file, and a settings file
 * that cannot be read is one of the failures reported here, so a failing read leaves the text in the language
 * the messages are written in rather than leaving no window at all.
 */
function startupLocale(): UiLocale {
  try {
    return getSettings().uiLocale
  } catch {
    return 'ja-JP'
  }
}

/**
 * Calls `listener` whenever ASIST is launched again while this process runs: on macOS a launch from Finder, the
 * Dock or Spotlight reaches the running app as activate and starts no second process, and any other launch
 * starts one that quits on the single-instance lock and reaches this one as second-instance.
 */
function onLaunchedAgain(listener: () => void): () => void {
  app.on('activate', listener)
  app.on('second-instance', listener)
  return () => {
    app.off('activate', listener)
    app.off('second-instance', listener)
  }
}

/**
 * Shows why the start failed, then quits as any quit does, which stops everything the start had started. A
 * release that cannot start is fixed only by a newer one, which an app that fails at every start would otherwise
 * never receive, so a build that updates itself starts again after the quit, in a launch that only updates.
 */
function quitAfterFailedStart(error: unknown): void {
  const locale = startupLocale()
  dialog.showErrorBox(translatorIn(locale)('app.startup.launchFailed'), errorMessageIn(locale, error))
  if (updatesItself()) app.relaunch({ args: [...process.argv.slice(1), UPDATE_AFTER_FAILED_START] })
  // A service that started before the failure may have started an agent, the memory curation, so this quit goes
  // through the gate that stops it. When an agent does not stop, the gate shows why and the app stays, with no
  // window or tray to quit from, holding the single-instance lock, so launching ASIST again tries the quit again.
  onLaunchedAgain(() => quitAfterAgentsStop())
  quitAfterAgentsStop()
}

/**
 * The launch that only updates, which a start that failed asks for: it checks for a newer version, and installs
 * and starts it when there is one; otherwise it quits. It opens no window and starts no service, so nothing of the
 * app runs, listens or speaks meanwhile, and a notification is all that tells the user a download is under way.
 */
async function updateAfterFailedStart(): Promise<void> {
  const locale = startupLocale()
  const text = translatorIn(locale)
  let stopNotice = (): void => undefined
  try {
    // Windows shows a notification only from an app that has its identity.
    windowChrome(platformCapabilities().os).prepare()
    const version = await versionAfterFailedStart()
    if (version !== null) {
      const notice = (): void => void notify(text('app.startup.launchFailed'), text('app.startup.updating', { version }))
      notice()
      stopNotice = onLaunchedAgain(notice)
      quitAfterAgentsStop(await installAfterFailedStart())
      await installFailure()
    }
  } catch (error) {
    stopNotice()
    console.error('app update after a failed start:', error)
    dialog.showErrorBox(text('app.startup.updateFailed'), errorMessageIn(locale, error))
  }
  app.quit()
}

if (!hasSingleInstanceLock) {
  // Two processes updating the same userData notify a timer twice and lose JSON updates, so the second
  // one quits.
  app.quit()
} else if (process.argv.includes(UPDATE_AFTER_FAILED_START)) {
  void app.whenReady().then(updateAfterFailedStart)
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
    // An OS or CPU the app is not built for stops the launch before any service starts. The app's menu and its
    // identity come next, before anything else that can fail.
    windowChrome(platformCapabilities().os).prepare()
    // Reading the settings first keeps a broken file from starting any service; the original file is kept
    // and the place to fix is shown.
    getSettings()
    handleFileScheme(allowedFileRoots)
    handlePreviewScheme(rendererSource(), appPageUrl())

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

    initJobReporting()
    initMaintenance([compactionJob])
    // Mail connects to the accounts in the settings and starts fetching; a failure shows up on the
    // settings screen and in the conversation.
    initMail()
    // Memory builds its index from the files and watches for a curation job being merged. The worker
    // starts only when semantic search is on.
    memory.ensureLoaded()
    initMemoryCuration()

    // The window and the voice open only once the services have started, so that a service that fails to start
    // leaves no page under its error, where the page would load, turn the microphone on and wait to show itself.
    createWindow()
    // The sidecars are warmed up here, and a failure does not stop the app from starting.
    watchdog.checkAfter(asr.ensureServer().catch((error) => console.error('speech recognition failed to start:', error)))
    watchdog.checkAfter(tts.ensureEngine().then(() => aizuchi.getBank()).catch((error) => console.error('TTS preparation failed:', error)))
    // The aizuchi classifier stays resident when it is prepared and aizuchi are wanted; without it no
    // aizuchi plays at the head of a turn.
    if (aizuchiClassifier.wanted(getSettings())) void aizuchiClassifier.ensureStarted()
    void memory.startEmbeddingIfEnabled().catch((err) => console.error('memory embedding:', err))
    initAppUpdates()

    // The window only hides when it is closed and is destroyed only by a quit, so it is never created a second
    // time, which would register the IPC handlers again.
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    })
  }).catch((error: unknown) => quitAfterFailedStart(error))
}

app.on('window-all-closed', () => {
  app.quit()
})
