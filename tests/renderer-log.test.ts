import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({ write: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => '/unused', on: vi.fn() } }))
vi.mock('../src/main/services/app-log', () => ({ installAppLog: () => ({ write: mocks.write }) }))
vi.mock('../src/main/services/api-key-secrets', () => ({ revealedApiKeys: () => [] }))

const APP_PAGE = 'file:///Applications/ASIST.app/Contents/Resources/app.asar/out/renderer/index.html'

/** A frame of the window: the app page's main frame, or a frame inside it showing another page. */
function frame(url: string, inside: boolean) {
  return { url, parent: inside ? { url: APP_PAGE, parent: null } : null }
}

/** Starts logging the window's page and returns a way to make one of its frames print an error. */
async function watchedWindow() {
  const { logRenderer } = await import('../src/main/logging')
  const webContents = new EventEmitter()
  logRenderer({ webContents } as unknown as BrowserWindow, APP_PAGE)
  return (from: ReturnType<typeof frame>) =>
    webContents.emit('console-message', { level: 'error', message: 'failed', sourceId: from.url, lineNumber: 1, frame: from })
}

beforeEach(() => {
  vi.resetModules()
  mocks.write.mockClear()
})

describe("the renderer's console output in the app log", () => {
  it("writes the errors of the app page's main frame", async () => {
    const printError = await watchedWindow()
    printError(frame(`${APP_PAGE}#/settings`, false))
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })

  it("leaves out what the map's iframe and a document shown in a frame print, so they cannot use up the day's log", async () => {
    const printError = await watchedWindow()
    printError(frame('https://www.google.com/maps/embed/v1/place', true))
    printError(frame('asist-file:///Users/me/asist-jobs/report/index.html', true))
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
