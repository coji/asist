import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setAppUserModelId: vi.fn(), setApplicationMenu: vi.fn() }))

vi.mock('electron', () => ({
  app: { setAppUserModelId: mocks.setAppUserModelId },
  Menu: { setApplicationMenu: mocks.setApplicationMenu }
}))

import { windowChrome } from '../src/main/window-chrome'

describe('the window on Windows', () => {
  it('runs under the ID the installer gives the Start menu shortcut, without which Windows shows no notification', () => {
    const appId = /^appId: (\S+)$/m.exec(fs.readFileSync('electron-builder.yml', 'utf8'))?.[1]
    windowChrome('windows').prepare()
    expect(mocks.setAppUserModelId).toHaveBeenCalledWith(appId)
  })
})
