import { app, Menu, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { WindowControlColors } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'

/**
 * The frame of the main window on each OS. The page draws its own top bar on both: macOS keeps its traffic
 * lights over the left of it, and Windows draws its minimize, maximize and close buttons over the right
 * of it, where the page reads their place from the titlebar-area-* CSS environment variables.
 */
export interface WindowChrome {
  frame: Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'>
  /** Runs before the window opens. */
  prepare: () => void
  /** Colours the buttons the OS draws over the page in the current theme. */
  paintControls: (window: BrowserWindow, colors: WindowControlColors) => void
}

/** The appId of electron-builder.yml, which the installer gives the Start menu shortcut. */
const APP_USER_MODEL_ID = 'com.nyosegawa.asist'

/**
 * The buttons' background, left clear so that the theme's background picture shows behind them. The
 * symbols start clear as well, until the page has sent the theme's colour, rather than in the system's
 * dark colour over a dark picture.
 */
const CLEAR = '#00000000'

const CHROMES: Record<OsFamily, WindowChrome> = {
  macos: {
    frame: { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } },
    prepare: () => {},
    // macOS draws the traffic lights in its own colours.
    paintControls: () => {}
  },
  windows: {
    frame: { titleBarStyle: 'hidden', titleBarOverlay: { color: CLEAR, symbolColor: CLEAR } },
    prepare: () => {
      // Electron's default menu (File, Edit, View, Window) is hidden with the title bar but still opens
      // with Alt. Copy and paste in a text field work without it.
      Menu.setApplicationMenu(null)
      // Windows shows a notification only from an app whose ID matches the one on its Start menu shortcut,
      // and groups the window under the pinned shortcut by the same ID.
      app.setAppUserModelId(APP_USER_MODEL_ID)
    },
    paintControls: (window, { symbol }) => window.setTitleBarOverlay({ color: CLEAR, symbolColor: symbol })
  }
}

/** The frame of the main window on this OS. */
export const windowChrome = (os: OsFamily): WindowChrome => CHROMES[os]
