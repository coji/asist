import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isFullPath } from '../src/main/services/full-path'

describe('isFullPath', () => {
  it('takes only a path that names a drive or a share for a full Windows path', () => {
    for (const folder of ['C:\\proj', 'c:/proj/', '\\\\nas\\team\\proj', '\\\\nas\\team', '//nas/team/proj']) {
      expect([folder, isFullPath(folder, path.win32)]).toEqual([folder, true])
    }
    for (const folder of ['C:', 'C:proj', '\\proj', '/proj', 'proj', '\\\\nas', '\\\\nas\\']) {
      expect([folder, isFullPath(folder, path.win32)]).toEqual([folder, false])
    }
  })

  it('takes no device or namespace path for a full Windows path, whatever it names after the prefix', () => {
    for (const folder of ['\\\\?\\C:\\proj', '\\\\?\\UNC\\other\\share\\a.png', '//?/UNC/other/share', '\\\\.\\C:\\proj', '\\\\.\\pipe\\x', '\\??\\UNC\\other\\share\\a.png', '\\??\\C:\\proj']) {
      expect([folder, isFullPath(folder, path.win32)]).toEqual([folder, false])
    }
  })

  it('takes every absolute POSIX path and no relative one', () => {
    for (const folder of ['/', '/Users/me/proj', '//Users/me']) expect([folder, isFullPath(folder, path.posix)]).toEqual([folder, true])
    for (const folder of ['proj', './proj', '~/proj', '']) expect([folder, isFullPath(folder, path.posix)]).toEqual([folder, false])
  })
})
