import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { registerIpc } from '../src/main/ipc'
import { longTempFolder } from './helpers/temp'

/**
 * The files card's "Show in Finder" (or File Explorer), through the IPC handler main registers for it. Electron is
 * replaced by a stand-in that keeps the handlers, and the services that registering starts are replaced too.
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  showItemInFolder: vi.fn(),
  roots: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere', isPackaged: false, on: vi.fn() },
  dialog: {},
  ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => mocks.handlers.set(channel, listener) },
  shell: { showItemInFolder: mocks.showItemInFolder }
}))
vi.mock('../src/main/services/agent', async () => {
  const { default: mitt } = await import('mitt')
  return { events: mitt(), allowedFileRoots: () => mocks.roots }
})
vi.mock('../src/main/services/watchdog', () => ({ start: vi.fn() }))
vi.mock('../src/main/services/timers', async () => {
  const { default: mitt } = await import('mitt')
  return { events: mitt(), init: vi.fn() }
})

const PAGE = 'file:///app/out/renderer/index.html'
const webContents = { send: vi.fn() }
let root: string
let outside: string

beforeAll(() => {
  registerIpc({ webContents, isDestroyed: () => false } as never, PAGE)
})
beforeEach(() => {
  root = longTempFolder('asist-reveal-')
  outside = longTempFolder('asist-reveal-outside-')
  mocks.roots = [root]
  mocks.showItemInFolder.mockReset()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

/** Asks main to show target the way the files card does. */
async function reveal(target: string): Promise<unknown> {
  const event = { sender: webContents, senderFrame: { parent: null, url: PAGE } }
  return mocks.handlers.get(IpcChannel.RevealPath)!(event, target)
}

describe('showing a file of the files card in Finder or File Explorer', () => {
  it('shows a file under an allowed folder', async () => {
    const file = path.join(root, 'report.md')
    fs.writeFileSync(file, '# report')
    await reveal(file)
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('fails for a file no allowed folder holds any more, rather than doing nothing', async () => {
    const file = path.join(outside, 'report.md')
    fs.writeFileSync(file, '# report')
    await expect(reveal(file)).rejects.toThrow(new Error(errorText('files.errors.outsideRoots')))
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('fails for a file that was removed after the card showed it, which the OS would ignore without a word', async () => {
    await expect(reveal(path.join(root, 'removed.md'))).rejects.toThrow(new Error(errorText('files.errors.missing')))
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  // A folder whose mode refuses the process stands in for what macOS keeps behind its privacy settings. Root and
  // Windows read it all.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails for a file the OS refuses with the reason the files card gives it, not the OS error',
    async () => {
      const folder = path.join(root, 'locked')
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, 'report.md'), '# report')
      fs.chmodSync(folder, 0o000)
      try {
        await expect(reveal(path.join(folder, 'report.md'))).rejects.toThrow(new Error(errorText('files.errors.denied')))
      } finally {
        fs.chmodSync(folder, 0o755)
      }
      expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    }
  )
})
