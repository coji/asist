import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { stepsFor } from '../scripts/resources/targets.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { UNUSED, matchesUnused, unusedFiles } from '../scripts/resources/git-windows.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { stampCurrent, writeStamp } from '../scripts/resources/shared.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { prepareNativeMacos } from '../scripts/resources/native-macos.mjs'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'asist-prepare-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('choosing what to prepare', () => {
  it('stops on a platform the app is not built for instead of preparing nothing', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'arm64']]) {
      expect(() => stepsFor('test', platform, arch)).toThrow(`${platform} ${arch}`)
    }
  })

  it('stops on a purpose it does not know', () => {
    expect(() => stepsFor('release', 'darwin', 'arm64')).toThrow(/release/)
  })
})

describe('the parts of MinGit that are removed', () => {
  it('removes the files of a listed folder and of a pattern, and keeps everything else', () => {
    const files = ['mingw64/doc/gcm/README.md', 'mingw64/doc/gcm/LICENSE', 'mingw64/bin/Avalonia.Base.dll', 'mingw64/bin/zlib1.dll', 'mingw64/docs.txt']
    expect(unusedFiles(files, ['mingw64/doc', /^mingw64\/bin\/Avalonia(\..+)?\.dll$/])).toEqual([
      'mingw64/bin/Avalonia.Base.dll',
      'mingw64/doc/gcm/LICENSE',
      'mingw64/doc/gcm/README.md'
    ])
  })

  it('stops when a listed part is missing, so a new MinGit is reviewed before it ships', () => {
    expect(() => unusedFiles(['mingw64/bin/git.exe'], ['mingw64/bin/scalar.exe'])).toThrow('mingw64/bin/scalar.exe')
  })

  it('never removes git, the sh its scripts and hooks run in, the scripts, the libraries git loads or a license', () => {
    const needed = [
      'mingw64/bin/git.exe',
      'mingw64/bin/git-upload-pack.exe',
      'mingw64/bin/git-receive-pack.exe',
      'mingw64/bin/zlib1.dll',
      'mingw64/bin/libiconv-2.dll',
      'mingw64/bin/libintl-8.dll',
      'mingw64/bin/libpcre2-8-0.dll',
      'mingw64/libexec/git-core/git-submodule',
      'mingw64/libexec/git-core/git-sh-setup',
      'mingw64/share/git-core/templates/description',
      'usr/bin/sh.exe',
      'usr/bin/msys-2.0.dll',
      'usr/bin/sed.exe',
      'LICENSE.txt',
      'mingw64/share/licenses/zlib/LICENSE',
      'usr/share/licenses/openssh/LICENCE'
    ]
    for (const file of needed) expect(UNUSED.filter((entry: string | RegExp) => matchesUnused(entry, file)), file).toEqual([])
  })
})

describe('the version stamp of a prepared tool', () => {
  it('is current for the same version and module content, whatever the times a cache restored', () => {
    const module = path.join(dir, 'tool.mjs')
    const stamp = path.join(dir, 'VERSION')
    fs.writeFileSync(module, "const VERSION = '1.2.3'\n")
    writeStamp(stamp, '1.2.3', module)
    fs.utimesSync(stamp, new Date(1_000_000), new Date(1_000_000))
    fs.utimesSync(module, new Date(3_000_000), new Date(3_000_000))
    expect(stampCurrent(stamp, '1.2.3', module)).toBe(true)
    expect(stampCurrent(stamp, '1.2.4', module)).toBe(false)
    expect(stampCurrent(path.join(dir, 'missing'), '1.2.3', module)).toBe(false)

    fs.writeFileSync(module, "const VERSION = '1.2.3'\nconst FLAGS = ['-O2']\n")
    expect(stampCurrent(stamp, '1.2.3', module)).toBe(false)
  })
})

describe('the Swift helpers', () => {
  it('removes the helpers built into resources/native before they moved, which Git no longer ignores', () => {
    const helpers = path.join(dir, 'native', 'macos')
    fs.mkdirSync(helpers, { recursive: true })
    const later = new Date(Date.now() + 60_000)
    for (const source of ['asist-mic.swift', 'asist-calendar.swift', 'calendar-info.plist']) fs.writeFileSync(path.join(helpers, source), '')
    for (const name of ['asist-mic', 'asist-calendar']) {
      fs.writeFileSync(path.join(helpers, name), 'current')
      fs.utimesSync(path.join(helpers, name), later, later)
      fs.writeFileSync(path.join(dir, 'native', name), 'old')
    }
    prepareNativeMacos({ resources: dir })
    expect(fs.readdirSync(path.join(dir, 'native')).sort()).toEqual(['macos'])
    expect(fs.readFileSync(path.join(helpers, 'asist-mic'), 'utf8')).toBe('current')
  })
})

// Signals to a process group are POSIX; on Windows Ctrl-C reaches Node alone and needs no group.
describe.runIf(process.platform !== 'win32')('the temporary folder of a preparation', () => {
  it('is removed when Ctrl-C ends the preparation during a blocking build', async () => {
    const shared = pathToFileURL(path.resolve('scripts/resources/shared.mjs')).href
    const script = `
      import { execFileSync } from 'node:child_process'
      import fs from 'node:fs'
      import { withTemporaryDir } from '${shared}'
      await withTemporaryDir('asist-interrupted-', async (dir) => {
        fs.writeSync(1, dir + '\\n')
        execFileSync('sh', ['-c', 'echo building; exec sleep 30'], { stdio: ['ignore', 'inherit', 'ignore'] })
      })
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    while (!output.includes('building')) output += String((await once(child.stdout!, 'data'))[0])
    const folder = output.split('\n')[0]
    expect(fs.existsSync(folder)).toBe(true)
    // Ctrl-C in a terminal reaches the whole foreground group: Node and the build it waits for.
    process.kill(-child.pid!, 'SIGINT')
    await once(child, 'exit')
    expect(fs.existsSync(folder)).toBe(false)
  })
})
