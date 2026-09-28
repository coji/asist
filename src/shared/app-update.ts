/**
 * Where the automatic update of the app stands, as the about page shows it. `off` is a build that does not
 * come from a release (a development run, or a local `dist:mac` or `dist:win`), which has no feed to update
 * from. An update is downloaded in the background and installed when the app next quits: by Squirrel.Mac on
 * macOS, and by the NSIS installer, run without a window, on Windows.
 */
export type AppUpdateState =
  | { phase: 'off' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: number }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; message: string }

/** The part of electron-updater's autoUpdater the controller uses, so that a test can stand in for it. */
export interface Updater {
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

/** The part of Electron's own autoUpdater, Squirrel.Mac, that reports an update staged for install. */
export interface NativeUpdater {
  on(event: 'update-downloaded', listener: () => void): unknown
}

/**
 * electron-updater reports update-downloaded once it has fetched the zip, before it hands the zip to
 * Squirrel.Mac, and macOS installs at quit only what Squirrel has fetched and verified: a quit one second
 * after the event installed nothing (electron-updater 6.8.9, 2026-09-25). This updater passes
 * update-downloaded on only once both have reported it, so "ready" means the next quit installs it.
 */
export function afterStaging(updater: Updater, native: NativeUpdater): Updater {
  const downloaded: ((info: { version: string }) => void)[] = []
  let version: string | null = null
  let staged = false
  const settle = (): void => {
    if (version === null || !staged) return
    const info = { version }
    version = null
    staged = false
    for (const listener of downloaded) listener(info)
  }
  updater.on('update-available', () => {
    version = null
    staged = false
  })
  updater.on('update-downloaded', (info) => {
    version = info.version
    settle()
  })
  native.on('update-downloaded', () => {
    staged = true
    settle()
  })
  return {
    on(event: string, listener: never): unknown {
      if (event === 'update-downloaded') return downloaded.push(listener)
      return (updater.on as (event: string, listener: never) => unknown)(event, listener)
    },
    checkForUpdates: () => updater.checkForUpdates(),
    quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => updater.quitAndInstall(isSilent, isForceRunAfter)
  } as Updater
}

/**
 * Follows the updater's events and keeps one state. A check while one is running, while a version is
 * downloading or once one is waiting to be installed would only start the same download again, so it is
 * skipped.
 */
export class AppUpdateController {
  private current: AppUpdateState = { phase: 'checking' }

  constructor(
    private readonly updater: Updater,
    private readonly options: { now: () => number; onChange: (state: AppUpdateState) => void }
  ) {
    updater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    updater.on('update-not-available', () => this.set({ phase: 'current', checkedAt: options.now() }))
    updater.on('update-available', (info) => this.set({ phase: 'downloading', version: info.version, percent: 0 }))
    updater.on('download-progress', (progress) => {
      if (this.current.phase !== 'downloading') return
      this.set({ ...this.current, percent: Math.floor(progress.percent) })
    })
    updater.on('update-downloaded', (info) => this.set({ phase: 'ready', version: info.version }))
    updater.on('error', (error) => this.set({ phase: 'failed', message: error.message }))
  }

  get state(): AppUpdateState {
    return this.current
  }

  check(): void {
    const { phase } = this.current
    if (phase === 'downloading' || phase === 'ready') return
    // A failed check also emits 'error', which is where the state and the log take it from, so the
    // rejection itself carries nothing more.
    this.updater.checkForUpdates().catch(() => undefined)
  }

  /**
   * Quits, installs the downloaded version and starts the app again, instead of installing at the next quit.
   * The NSIS updater runs the installer with its window unless told to be silent, and a silent installer
   * starts the app again only when told to; Squirrel.Mac ignores both and always starts it again.
   */
  install(): void {
    if (this.current.phase !== 'ready') throw new Error(`no update is ready to install (${this.current.phase})`)
    this.updater.quitAndInstall(true, true)
  }

  private set(state: AppUpdateState): void {
    this.current = state
    this.options.onChange(state)
  }
}
