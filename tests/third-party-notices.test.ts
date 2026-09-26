import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { declaredLicense, packageSections, productionPackageDirs, renderNotices } from '../scripts/third-party-notices.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { UNUSED, matchesUnused } from '../scripts/resources/git-windows.mjs'

let root: string

/** The paths below the bundled git that the notices name, as they are written, relative to the resources folder. */
function gitLicensePaths(notices: string): string[] {
  return notices.match(/\bgit\/[\w./-]*\w/g) ?? []
}

/** A package folder under the temporary node_modules, with its package.json and any other files. */
function writePackage(key: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = path.join(root, key)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'asist-notices-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('third-party notices', () => {
  it('reads the license in each form package.json has used', () => {
    expect(declaredLicense({ license: 'MIT' })).toBe('MIT')
    expect(declaredLicense({ license: { type: 'BSD-3-Clause' } })).toBe('BSD-3-Clause')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0')
    expect(declaredLicense({})).toBeNull()
  })

  it('stops when a package that reaches the app declares no license', () => {
    const dir = writePackage('node_modules/mystery', { name: 'mystery', version: '1.0.0' })
    expect(() => packageSections([dir])).toThrow(/mystery@1\.0\.0/)
  })

  it('carries the text of every license and notice file, once per name and version', () => {
    const a = writePackage('node_modules/a', { name: 'a', version: '1.0.0', license: 'Apache-2.0' }, { LICENSE: 'apache text', NOTICE: 'notice text', 'index.js': '' })
    const nested = writePackage('node_modules/b/node_modules/a', { name: 'a', version: '1.0.0', license: 'Apache-2.0' }, { LICENSE: 'apache text' })
    const sections = packageSections([a, nested])
    expect(sections).toEqual([{ id: 'a@1.0.0', license: 'Apache-2.0', files: ['apache text', 'notice text'] }])
    expect(renderNotices('own license', sections, 'darwin')).toContain('notice text')
  })

  it('points to git licenses that the git prepared on this machine carries', () => {
    const named = gitLicensePaths(renderNotices('own license', [], process.platform))
    expect(named.length).toBeGreaterThan(0)
    for (const file of named) expect(fs.existsSync(path.join(process.cwd(), 'resources', ...file.split('/'))), file).toBe(true)
  })

  it('points on Windows only to git licenses that stay when the unused parts of MinGit are removed', () => {
    const named = gitLicensePaths(renderNotices('own license', [], 'win32'))
    expect(named.length).toBeGreaterThan(0)
    for (const file of named) {
      const inMinGit = file.slice('git/'.length)
      expect(UNUSED.filter((entry: string | RegExp) => matchesUnused(entry, inMinGit)), file).toEqual([])
    }
  })

  it('stops for a platform whose bundled programs it does not know', () => {
    expect(() => renderNotices('own license', [], 'linux')).toThrow(/linux/)
  })

  it('skips a package.json that only marks the module type of a subfolder', () => {
    const marker = writePackage('node_modules/c/esm', { type: 'module' })
    expect(packageSections([marker])).toEqual([])
  })

  it('takes the production packages of the lockfile and leaves out development ones', () => {
    writePackage('node_modules/runtime', { name: 'runtime', version: '1.0.0', license: 'MIT' })
    writePackage('node_modules/tool', { name: 'tool', version: '1.0.0', license: 'MIT' })
    writePackage('node_modules/either', { name: 'either', version: '1.0.0', license: 'MIT' })
    const lock = {
      packages: {
        '': { name: 'asist' },
        'node_modules/runtime': {},
        'node_modules/tool': { dev: true },
        'node_modules/either': { devOptional: true },
        'node_modules/not-installed': { optional: true }
      }
    }
    expect(productionPackageDirs(lock, root)).toEqual([path.join(root, 'node_modules/runtime')])
  })
})
