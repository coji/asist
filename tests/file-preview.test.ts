import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// readFileItem writes the reason a file could not be read in the language of the interface.
const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-file-preview-'))
})

import { createTranslator } from '@shared/i18n'
import { allowedPath, classifyFile, fileItem, listDirectory, MAX_DIRECTORY_ENTRIES, readFileItem, type PathSystem } from '../src/main/services/file-preview'
import { filesLayout, formatBytes, isHtmlPage, MAX_TEXT_BYTES } from '../src/shared/files'

describe('isHtmlPage', () => {
  it('takes .html and .htm in any case as a page, and nothing else', () => {
    expect(['/a/report.html', '/a/INDEX.HTM', '/a/b.c/page.htm'].every(isHtmlPage)).toBe(true)
    expect(['/a/page.xhtml', '/a/html', '/a/report.html.md', '/a/html.d/notes.txt'].some(isHtmlPage)).toBe(false)
  })
})

describe('classifyFile', () => {
  it('decides the kind of a file from its extension', () => {
    expect(classifyFile('/a/report.md')).toBe('markdown')
    expect(classifyFile('/a/chart.PNG')).toBe('image')
    expect(classifyFile('/a/data.json')).toBe('data')
    expect(classifyFile('/a/rows.csv')).toBe('table')
    expect(classifyFile('/a/script.py')).toBe('code')
    expect(classifyFile('/a/Dockerfile')).toBe('code')
    expect(classifyFile('/a/deck.pptx')).toBe('pptx')
    expect(classifyFile('/a/clip.mov')).toBe('video')
    expect(classifyFile('/a/note.ipynb')).toBe('notebook')
    expect(classifyFile('/a/binary.wasm')).toBe('binary')
    expect(classifyFile('/a/noext')).toBe('binary')
  })
})

describe('allowedPath, the path check of show_files, asist-file:// and Reveal in Finder', () => {
  const roots = ['/Users/x/asist-jobs', '/Users/x/repo']

  it('allows only paths under an allowed root', () => {
    expect(allowedPath('/Users/x/asist-jobs/20260718-job/report.md', roots)).not.toBeNull()
    expect(allowedPath('/Users/x/repo/src/index.ts', roots)).not.toBeNull()
    expect(allowedPath('/Users/x/repo', roots)).not.toBeNull()
  })

  it('rejects paths outside the roots and sensitive paths', () => {
    expect(allowedPath('/Users/x/.ssh/id_rsa', roots)).toBeNull()
    expect(allowedPath('/etc/passwd', roots)).toBeNull()
  })

  it('rejects traversal through `..`', () => {
    expect(allowedPath('/Users/x/asist-jobs/../.ssh/id_rsa', roots)).toBeNull()
    expect(allowedPath('/Users/x/repo/../../etc/passwd', roots)).toBeNull()
  })

  it('rejects a directory whose name merely starts with an allowed root', () => {
    expect(allowedPath('/Users/x/repo-evil/secret.txt', roots)).toBeNull()
  })

  it('rejects a relative path and an empty root', () => {
    expect(allowedPath('report.md', roots)).toBeNull()
    expect(allowedPath('/Users/x/repo/a.ts', [''])).toBeNull()
  })

  it('refuses a symbolic link inside a root that points outside it', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'root'))
    mkdirSync(path.join(base, 'secret'))
    writeFileSync(path.join(base, 'secret', 'id_rsa'), 'key')
    symlinkSync(path.join(base, 'secret'), path.join(base, 'root', 'link'))
    expect(allowedPath(path.join(base, 'root', 'link', 'id_rsa'), [path.join(base, 'root')])).toBeNull()
  })

  it('allows a path under a root that is itself reached through a symbolic link', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'real'))
    writeFileSync(path.join(base, 'real', 'report.md'), '# report')
    symlinkSync(path.join(base, 'real'), path.join(base, 'alias'))
    expect(allowedPath(path.join(base, 'real', 'report.md'), [path.join(base, 'alias')])).not.toBeNull()
    expect(allowedPath(path.join(base, 'alias', 'not-yet.md'), [path.join(base, 'real')])).not.toBeNull()
  })

  it('matches a root whose Japanese name is written in the other normalization form as the disk matches names', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'プロジェクト資料'.normalize('NFC')))
    writeFileSync(path.join(base, 'プロジェクト資料'.normalize('NFC'), 'report.pdf'), 'x')
    const written = path.join(base, 'プロジェクト資料'.normalize('NFD'), 'report.pdf')
    // APFS matches names regardless of their Unicode normalization, while NTFS keeps the two forms as two
    // different names, so on Windows the other form names a folder that does not exist.
    const sameFolder = process.platform !== 'win32'
    expect(existsSync(written)).toBe(sameFolder)
    expect(allowedPath(written, [path.join(base, 'プロジェクト資料'.normalize('NFC'))]) !== null).toBe(sameFolder)
    expect(allowedPath(path.join(base, 'プロジェクト資料'.normalize('NFC'), 'report.pdf'), [path.join(base, 'プロジェクト資料'.normalize('NFD'))]) !== null).toBe(sameFolder)
  })

  it('allows a file inside a root when only the letter case differs, as the disk matches names', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'Reports'))
    writeFileSync(path.join(base, 'Reports', 'a.pdf'), 'x')
    expect(allowedPath(path.join(base, 'reports', 'a.pdf'), [path.join(base, 'Reports')])).not.toBeNull()
    expect(allowedPath(path.join(base, 'Reports-old', 'a.pdf'), [path.join(base, 'reports')])).toBeNull()
  })

  it('decides on the file the OS opens when a .. follows a symbolic link, and returns that file to read', () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-roots-')))
    mkdirSync(path.join(base, 'root', 'docs'), { recursive: true })
    mkdirSync(path.join(base, 'outside', 'sub'), { recursive: true })
    writeFileSync(path.join(base, 'root', 'secret.txt'), 'inside')
    writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside')
    writeFileSync(path.join(base, 'root', 'report.md'), '# report')
    symlinkSync(path.join(base, 'outside', 'sub'), path.join(base, 'root', 'link'))
    const root = path.join(base, 'root')
    const roots = [root]
    expect(allowedPath(root + '/docs/../report.md', roots)).toBe(path.join(root, 'report.md'))
    // As text, root/link/../secret.txt is root/secret.txt. macOS follows the link first and opens
    // outside/secret.txt, while Windows removes "link/.." from the path as text before it looks at the disk.
    if (process.platform === 'win32') {
      expect(readFileSync(root + '/link/../secret.txt', 'utf8')).toBe('inside')
      expect(allowedPath(root + '/link/../secret.txt', roots)).toBe(path.join(root, 'secret.txt'))
      expect(allowedPath(root + '/link/../missing.txt', roots)).toBe(path.join(root, 'missing.txt'))
      expect(allowedPath(root + '/gone/../report.md', roots)).toBe(path.join(root, 'report.md'))
    } else {
      expect(readFileSync(root + '/link/../secret.txt', 'utf8')).toBe('outside')
      expect(allowedPath(root + '/link/../secret.txt', roots)).toBeNull()
      expect(allowedPath(root + '/link/../missing.txt', roots)).toBeNull()
      expect(allowedPath(root + '/gone/../report.md', roots)).toBeNull()
    }
  })

  it('returns the file as the disk spells it, which is the path that is read', () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-roots-')))
    mkdirSync(path.join(base, 'Reports'))
    writeFileSync(path.join(base, 'Reports', 'a.pdf'), 'x')
    expect(allowedPath(path.join(base, 'reports', 'a.pdf'), [base])).toBe(path.join(base, 'Reports', 'a.pdf'))
    expect(allowedPath(path.join(base, 'Reports', 'not-yet.pdf'), [base])).toBe(path.join(base, 'Reports', 'not-yet.pdf'))
  })

  it('allows the files under the other roots when one root cannot be resolved because its parent is unreadable', () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-roots-')))
    mkdirSync(path.join(base, 'past', 'job'), { recursive: true })
    mkdirSync(path.join(base, 'now'))
    writeFileSync(path.join(base, 'now', 'report.md'), '# report')
    chmodSync(path.join(base, 'past'), 0o000)
    try {
      const roots = [path.join(base, 'past', 'job'), path.join(base, 'now')]
      expect(allowedPath(path.join(base, 'now', 'report.md'), roots)).toBe(path.join(base, 'now', 'report.md'))
      expect(allowedPath(path.join(base, 'elsewhere.md'), roots)).toBeNull()
    } finally {
      chmodSync(path.join(base, 'past'), 0o700)
    }
  })

  it('allows every path on the disk when its root folder, "/" or "C:\\", is an allowed root', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    writeFileSync(path.join(base, 'a.txt'), 'x')
    const top = path.parse(base).root
    expect(allowedPath(path.join(base, 'a.txt'), [top])).not.toBeNull()
    expect(allowedPath(path.join(top, 'etc', 'hosts'), [top])).not.toBeNull()
  })
})

/**
 * A Windows disk holding the given files and the folders above them. A name is found in any letter case and
 * comes back as it was asked for, which is what makes the comparison with a root depend on letter case. Every
 * lookup is recorded.
 */
function windowsDisk(...files: string[]): PathSystem & { asked: string[] } {
  const stored = new Set<string>()
  for (const file of files) {
    for (let p = path.win32.normalize(file); !stored.has(p.toLowerCase()); p = path.win32.dirname(p)) stored.add(p.toLowerCase())
  }
  const asked: string[] = []
  return {
    path: path.win32,
    asked,
    realpath: (target) => {
      asked.push(target)
      const resolved = path.win32.resolve(target)
      if (!stored.has(resolved.toLowerCase())) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
      return resolved
    }
  }
}

describe('allowedPath with the Windows rules', () => {
  const disk = windowsDisk('C:\\Users\\me\\asist-jobs\\20260927-job\\report.md', 'C:\\Users\\me\\.ssh\\id_rsa', 'C:\\Users\\me\\asist-jobs-evil\\secret.txt')
  const roots = ['C:\\Users\\me\\asist-jobs']

  it('allows a file under a root whichever separator and letter case each is written in', () => {
    expect(allowedPath('C:\\Users\\me\\asist-jobs\\20260927-job\\report.md', roots, disk)).toBe('C:\\Users\\me\\asist-jobs\\20260927-job\\report.md')
    expect(allowedPath('c:/users/me/ASIST-JOBS/20260927-job/report.md', roots, disk)).not.toBeNull()
    expect(allowedPath('C:\\Users\\me\\asist-jobs\\20260927-job\\not-yet.md', ['c:/users/me/asist-jobs/'], disk)).not.toBeNull()
  })

  it('refuses a path outside the roots, a folder whose name only begins like a root, and a .. that climbs out', () => {
    expect(allowedPath('C:\\Users\\me\\.ssh\\id_rsa', roots, disk)).toBeNull()
    expect(allowedPath('C:\\Users\\me\\asist-jobs-evil\\secret.txt', roots, disk)).toBeNull()
    expect(allowedPath('C:\\Users\\me\\asist-jobs\\..\\.ssh\\id_rsa', roots, disk)).toBeNull()
  })

  it('refuses a path relative to a folder or to the current drive', () => {
    expect(allowedPath('asist-jobs\\20260927-job\\report.md', roots, disk)).toBeNull()
    expect(allowedPath('C:asist-jobs\\20260927-job\\report.md', roots, disk)).toBeNull()
    expect(allowedPath('\\Users\\me\\asist-jobs\\20260927-job\\report.md', roots, disk)).toBeNull()
  })

  it('refuses an alternate data stream of a file under a root', () => {
    expect(allowedPath('C:\\Users\\me\\asist-jobs\\20260927-job\\report.md:hidden', roots, disk)).toBeNull()
    expect(allowedPath('C:\\Users\\me\\asist-jobs\\20260927-job\\report.md::$DATA', roots, disk)).toBeNull()
  })

  it('never asks a server that holds no allowed root about a path, and allows a file on the share of a root', () => {
    const share = windowsDisk('C:\\Users\\me\\notes.md', '\\\\nas\\team\\reports\\q3.pdf')
    expect(allowedPath('\\\\attacker.example\\share\\a.png', ['C:\\Users\\me', '\\\\nas\\team\\reports'], share)).toBeNull()
    expect(share.asked.some((asked) => asked.includes('attacker'))).toBe(false)
    expect(allowedPath('\\\\NAS\\team\\reports\\q3.pdf', ['\\\\nas\\team\\reports'], share)).not.toBeNull()
  })
})

describe('readFileItem', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-files-'))
  const toUrl = (p: string): string => `asist-file://${p}`

  it('includes the text of a text file and, beyond the limit, keeps only the beginning and sets truncated', () => {
    const file = path.join(dir, 'long.md')
    writeFileSync(file, 'x'.repeat(MAX_TEXT_BYTES + 10))
    const item = readFileItem(file, toUrl)
    expect(item.kind).toBe('markdown')
    expect(item.truncated).toBe(true)
    expect(item.text).toHaveLength(MAX_TEXT_BYTES)
    expect(item.url).toBeUndefined()
  })

  it('keeps a short text as is and reports its size and modification time', () => {
    const file = path.join(dir, 'short.txt')
    writeFileSync(file, 'hello\nworld')
    const item = readFileItem(file, toUrl)
    expect(item).toMatchObject({ kind: 'text', text: 'hello\nworld', sizeBytes: 11, truncated: false })
    expect(item.modifiedAt).toBeGreaterThan(0)
  })

  it('passes images, documents, audio, video and archives by URL instead of by text', () => {
    const file = path.join(dir, 'dot.png')
    writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    const item = readFileItem(file, toUrl)
    expect(item).toMatchObject({ kind: 'image', url: `asist-file://${file}`, sizeBytes: 8 })
    expect(item.text).toBeUndefined()
  })

  it('passes an HTML page both as its source text and by URL, and other code by text alone', () => {
    const page = path.join(dir, 'report.HTML')
    writeFileSync(page, '<h1>レポート</h1>')
    expect(readFileItem(page, toUrl)).toMatchObject({ text: '<h1>レポート</h1>', url: `asist-file://${page}` })
    const script = path.join(dir, 'chart.js')
    writeFileSync(script, 'draw()')
    const item = readFileItem(script, toUrl)
    expect(item.text).toBe('draw()')
    expect(item.url).toBeUndefined()
  })

  it('lists the contents of a folder with directories first and hidden files left out', () => {
    const folder = path.join(dir, 'folder')
    mkdirSync(path.join(folder, 'sub'), { recursive: true })
    writeFileSync(path.join(folder, 'b.csv'), 'a,b')
    writeFileSync(path.join(folder, 'a.md'), '# a')
    writeFileSync(path.join(folder, '.hidden'), '')
    const item = readFileItem(folder, toUrl)
    expect(item.kind).toBe('directory')
    expect(item.entries?.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['directory:sub', 'markdown:a.md', 'table:b.csv'])
    expect(listDirectory(folder)).toHaveLength(3)
  })

  it('lists only the first entries of a crowded folder and says how many it holds', () => {
    const folder = path.join(dir, 'crowded')
    mkdirSync(folder)
    const count = MAX_DIRECTORY_ENTRIES + 5
    for (let i = 0; i < count; i++) writeFileSync(path.join(folder, `file-${i}.txt`), '')
    writeFileSync(path.join(folder, '.hidden'), '')
    const item = readFileItem(folder, toUrl)
    expect(item.entries).toHaveLength(MAX_DIRECTORY_ENTRIES)
    expect(item.entryCount).toBe(count)
  })
})

describe('fileItem, the check and the read of one path of show_files', () => {
  const t = createTranslator('ja-JP')
  const toUrl = (p: string): string => `asist-file://${p}`
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-file-item-')))
  const root = path.join(base, 'root')
  mkdirSync(root)

  it('returns an item carrying an error for a missing path instead of throwing', () => {
    expect(fileItem(path.join(root, 'missing.txt'), [root], toUrl)).toMatchObject({ name: 'missing.txt', error: t('files.errors.missing') })
  })

  it('reports a path that runs through a file as missing', () => {
    writeFileSync(path.join(root, 'plain.md'), 'x')
    expect(fileItem(path.join(root, 'plain.md', 'sub'), [root], toUrl)).toMatchObject({ error: t('files.errors.missing') })
  })

  // A file or folder whose mode refuses the process stands in for what macOS keeps behind its privacy settings,
  // which it refuses with EPERM where the mode gives EACCES. Root and Windows read them all.
  describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a place the OS refuses', () => {
    const locked: string[] = []
    const lock = (target: string, mode: number): string => {
      chmodSync(target, mode)
      locked.push(target)
      return target
    }
    afterAll(() => {
      for (const target of locked) chmodSync(target, 0o755)
    })

    it('words the refusal the same way whether the OS refuses to resolve, open or list the path', () => {
      writeFileSync(path.join(root, 'secret.md'), 'secret')
      const file = lock(path.join(root, 'secret.md'), 0o000)
      mkdirSync(path.join(root, 'unlisted'))
      const folder = lock(path.join(root, 'unlisted'), 0o311)
      mkdirSync(path.join(root, 'closed'))
      writeFileSync(path.join(root, 'closed', 'inside.md'), 'x')
      lock(path.join(root, 'closed'), 0o000)
      for (const target of [file, folder, path.join(root, 'closed', 'inside.md')]) {
        expect(fileItem(target, [root], toUrl), target).toMatchObject({ error: t('files.errors.denied') })
      }
    })

    it('answers a path under no root as outside the roots even when the OS refuses to resolve it', () => {
      mkdirSync(path.join(base, 'elsewhere'))
      writeFileSync(path.join(base, 'elsewhere', 'b.md'), 'x')
      lock(path.join(base, 'elsewhere'), 0o000)
      expect(fileItem(path.join(base, 'elsewhere', 'b.md'), [root], toUrl)).toMatchObject({ error: t('files.errors.outsideRoots') })
    })
  })
})

describe('the pure logic of files', () => {
  it('lays out one file as single, several images as gallery, and a mixture as list', () => {
    const image = { path: '/a.png', name: 'a.png', kind: 'image' as const, sizeBytes: 1 }
    const md = { path: '/a.md', name: 'a.md', kind: 'markdown' as const, sizeBytes: 1 }
    expect(filesLayout([md])).toBe('single')
    expect(filesLayout([image, { ...image, path: '/b.png' }])).toBe('gallery')
    expect(filesLayout([image, md])).toBe('list')
    // An item that could not be read does not count when deciding on the gallery layout.
    expect(filesLayout([image, { ...image, path: '/b.png' }, { ...md, error: 'x' }])).toBe('gallery')
  })

  it('formats a size in bytes, kilobytes and megabytes', () => {
    expect(formatBytes(120)).toBe('120B')
    expect(formatBytes(48 * 1024)).toBe('48KB')
    expect(formatBytes(2.3 * 1024 * 1024)).toBe('2.3MB')
  })
})
