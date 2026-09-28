import { describe, expect, it } from 'vitest'
import { existingRelease, missingWindowsFiles, withFileDigest } from '../scripts/release.mjs'

describe('scripts/release.mjs', () => {
  it('rewrites the digest of the stapled dmg and leaves the zip that electron-updater installs as it is', () => {
    const yml = [
      'version: 0.1.0',
      'files:',
      '  - url: ASIST-0.1.0-arm64-mac.zip',
      '    sha512: zipDigest==',
      '    size: 316374268',
      '  - url: ASIST-0.1.0-arm64.dmg',
      '    sha512: dmgBefore==',
      '    size: 317852614',
      'path: ASIST-0.1.0-arm64-mac.zip',
      'sha512: zipDigest==',
      "releaseDate: '2026-09-25T06:12:56.053Z'",
      ''
    ].join('\n')
    expect(withFileDigest(yml, 'ASIST-0.1.0-arm64.dmg', 'dmgAfter==', 317860000)).toBe(
      yml.replace('dmgBefore==', 'dmgAfter==').replace('317852614', '317860000')
    )
  })

  it('refuses a feed that does not list the file', () => {
    expect(() => withFileDigest('version: 0.1.0\nfiles: []\n', 'ASIST-0.1.0-arm64.dmg', 'x', 1)).toThrow()
  })

  it('keeps a draft with the Mac files alone from being published until every Windows file is on it', () => {
    const mac = ['ASIST-arm64.dmg', 'ASIST-0.1.1-arm64-mac.zip', 'ASIST-0.1.1-arm64-mac.zip.blockmap', 'latest-mac.yml', 'git-2.55.0.tar.xz']
    const windows = ['ASIST-Setup-x64.exe', 'ASIST-Setup-x64.exe.blockmap', 'latest.yml']
    expect(missingWindowsFiles(mac)).toHaveLength(4)
    expect(missingWindowsFiles([...mac, ...windows])).toHaveLength(1)
    expect(missingWindowsFiles([...mac, ...windows, 'git-for-windows-2.55.0.windows.5.tar.gz'])).toEqual([])
  })

  it('offers to finish a draft left by a stopped release from its own commit, which a published release never is', () => {
    const commit = '9f492244e781efc261b263ce9cfd429483c465f4'
    const draft = existingRelease('v0.1.1', { isDraft: true, targetCommitish: commit })
    expect(draft).toContain(`-f tag=v0.1.1 -f commit=${commit}`)
    expect(draft).toContain('gh release edit v0.1.1 --repo nyosegawa/asist --draft=false')
    expect(existingRelease('v0.1.0', { isDraft: false, targetCommitish: commit })).not.toContain('gh workflow run')
  })
})
