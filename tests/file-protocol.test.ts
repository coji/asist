import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { allowedPath, type PathSystem } from '../src/main/services/file-preview'

const electron = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle } }))

const load = () => import('../src/main/file-protocol')
/** The URL rules of macOS, for the tests that write a macOS path on any OS. */
const MACOS = { windows: false }

/** Registers the handler for the folder and returns what it answers for a URL and a Range header. */
async function serve(folder: string, url: string, range?: string): Promise<Response> {
  const { handleFileScheme } = await load()
  electron.handle.mockClear()
  handleFileScheme(() => [folder])
  const handler = electron.handle.mock.calls[0][1] as (request: { url: string; headers: Headers }) => Response
  return handler({ url, headers: new Headers(range ? { range } : {}) })
}

describe('asist-file:// URLs and paths', () => {
  it('turns an absolute path into a URL and reads the same path back, including Japanese characters and spaces', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const path = '/Users/me/Application Support/asist/memory/pages/大川俊介.md'
    const url = fileUrl(path, MACOS)
    expect(url.startsWith('asist-file:///Users/me/')).toBe(true)
    expect(filePathFromUrl(url, MACOS)).toBe(path)
    expect(filePathFromUrl(`${url}?t=1`, MACOS)).toBe(path)
  })

  it('rejects other schemes and relative paths', async () => {
    const { filePathFromUrl } = await load()
    expect(filePathFromUrl('file:///etc/passwd')).toBeNull()
    expect(filePathFromUrl('asist-file:a.png')).toBeNull()
  })

  it('refuses a URL that names a server on macOS', async () => {
    const { filePathFromUrl } = await load()
    expect(filePathFromUrl('asist-file://nas/team/a.pdf', MACOS)).toBeNull()
    expect(filePathFromUrl('asist-file://attacker.example/etc/passwd', MACOS)).toBeNull()
  })

  it('reads a server in a Windows URL as a share that is refused before the disk is asked when no allowed folder is on it', async () => {
    const { filePathFromUrl } = await load()
    const disk: PathSystem = { path: path.win32, realpath: vi.fn((target: string) => target) }
    for (const url of ['asist-file://attacker.example/share/a.png', 'asist-file://nas/other/a.pdf']) {
      const requested = filePathFromUrl(url, { windows: true })
      expect(requested).not.toBeNull()
      expect(allowedPath(requested!, ['C:\\Users\\me', '\\\\nas\\team\\reports'], disk)).toBeNull()
    }
    expect(disk.realpath).not.toHaveBeenCalled()
  })

  it('refuses a Windows URL that names a server but no share on it, which allowedPath would take for a root without a drive', async () => {
    const { filePathFromUrl } = await load()
    for (const url of ['asist-file://attacker.example/', 'asist-file://nas/team/..', 'asist-file://nas//team/a.pdf']) {
      expect([url, filePathFromUrl(url, { windows: true })]).toEqual([url, null])
    }
  })

  it('keeps a #, a ? or a % in a file name as part of the path rather than a fragment or a query', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    for (const file of ['/Users/me/Documents/C# notes.pdf', '/Users/me/Documents/why?.png', '/Users/me/Documents/Issue #12.png', '/Users/me/Documents/100%.png']) {
      const url = new URL(fileUrl(file, MACOS))
      expect([url.hash, url.search]).toEqual(['', ''])
      expect(filePathFromUrl(url.href, MACOS)).toBe(file)
    }
  })

  it('reads the file a page names in a relative link with its reserved characters escaped', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const page = fileUrl('/r/report.html', MACOS)
    expect(filePathFromUrl(new URL('Q1%2C%20Q2.png', page).href, MACOS)).toBe('/r/Q1, Q2.png')
    expect(filePathFromUrl(new URL('C%23.png', page).href, MACOS)).toBe('/r/C#.png')
  })

  it('writes a macOS path as it always has, escaping every character of a name that is not plain', async () => {
    const { fileUrl } = await load()
    expect(fileUrl('/Users/me/Q1, Q2 (draft).png', { windows: false })).toBe('asist-file:///Users/me/Q1%2C%20Q2%20(draft).png')
  })

  it('writes a Windows path with its drive letter as file:// does and reads the same path back', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const windows = { windows: true }
    for (const file of ['C:\\Users\\me\\Documents\\大川俊介.md', 'D:\\work\\C# notes\\why?.png', 'C:\\Users\\me\\100%.png', 'C:\\r\\Q1, Q2.pdf']) {
      const url = fileUrl(file, windows)
      expect([file, filePathFromUrl(url, windows)]).toEqual([file, file])
      expect([file, new URL(url).hash, new URL(url).search]).toEqual([file, '', ''])
    }
    expect(fileUrl('C:\\Users\\me\\a b.png', windows)).toBe('asist-file:///C:/Users/me/a%20b.png')
  })

  it('reads back a file on a Windows network share from the URL it writes for it, and the files a page there links to', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const windows = { windows: true }
    for (const file of ['\\\\nas\\team\\reports\\q3.pdf', '\\\\nas\\team\\C# notes\\大川俊介 100%.png']) {
      expect([file, filePathFromUrl(fileUrl(file, windows), windows)]).toEqual([file, file])
    }
    const page = fileUrl('\\\\nas\\team\\reports\\index.html', windows)
    expect(filePathFromUrl(new URL('img/Q1%2C%20Q2.png', page).href, windows)).toBe('\\\\nas\\team\\reports\\img\\Q1, Q2.png')
  })

  it('reads the file a Windows page names in a relative link, and refuses a path without a drive or with an escaped separator', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const windows = { windows: true }
    const page = fileUrl('C:\\r\\report.html', windows)
    expect(filePathFromUrl(new URL('img/Q1%2C%20Q2.png', page).href, windows)).toBe('C:\\r\\img\\Q1, Q2.png')
    expect(filePathFromUrl('asist-file:///Users/me/a.png', windows)).toBeNull()
    expect(filePathFromUrl('asist-file:///C:/r/sub/..%5Csecret.txt', windows)).toBeNull()
    expect(filePathFromUrl('asist-file:///C:/r/sub/..%2Fsecret.txt', windows)).toBeNull()
  })

  it('refuses a file outside the folder that an escaped .. reaches through a symbolic link', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    const root = path.join(base, 'root')
    mkdirSync(root)
    mkdirSync(path.join(base, 'outside', 'sub'), { recursive: true })
    writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside')
    writeFileSync(path.join(root, 'secret.txt'), 'inside')
    symlinkSync(path.join(base, 'outside', 'sub'), path.join(root, 'link'))
    const { fileUrl } = await load()
    // %2F keeps the .. inside one segment for the URL parser, and the path decodes to root/link/../secret.txt.
    const response = await serve(root, `${fileUrl(root)}/link/..%2Fsecret.txt`)
    expect(response.status).toBe(403)
    expect((await serve(root, fileUrl(path.join(root, 'secret.txt')))).status).toBe(200)
  })

  it('serves a file whose name holds a # from the URL the files card is given', async () => {
    const { fileUrl } = await load()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'C# notes.txt'), 'notes')
    const response = await serve(folder, fileUrl(path.join(folder, 'C# notes.txt')))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('notes')
  })
})

describe('the Range header that video and audio use to seek', () => {
  it('turns bytes=a-b, bytes=a- and bytes=-n into a start and an end', async () => {
    const { parseRange } = await load()
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('returns null for an invalid range, so the whole file is served', async () => {
    const { parseRange } = await load()
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=50-10', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })

  it('finds no byte of an empty file, and serves the empty file whole when its last bytes are asked for', async () => {
    const { fileUrl, parseRange } = await load()
    expect(parseRange('bytes=-100', 0)).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'empty.mp3'), '')
    const response = await serve(folder, fileUrl(path.join(folder, 'empty.mp3')), 'bytes=-100')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})

/** Splits a Content-Security-Policy value into its directives, each with its list of sources or flags. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name, values])
  )
}

/** The sandbox flags that would let a page reach the app, move its window, open windows or send forms. */
const ESCAPING_FLAGS = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals'
]

describe('the headers an HTML page is served with', () => {
  it('sandboxes the page with scripts only, whatever frame loads it', async () => {
    const { contentHeaders } = await load()
    for (const name of ['/r/report.html', '/r/INDEX.HTM']) {
      const sandbox = directives(contentHeaders(name)['Content-Security-Policy']).get('sandbox')
      expect(sandbox).toContain('allow-scripts')
      for (const flag of ESCAPING_FLAGS) expect(sandbox).not.toContain(flag)
    }
  })

  it('lets the page read no local file, embed no frame and submit no form', async () => {
    const { contentHeaders } = await load()
    const policy = directives(contentHeaders('/r/report.html')['Content-Security-Policy'])
    expect(policy.get('default-src')).toEqual(["'none'"])
    expect(policy.get('connect-src')).toEqual(['https:'])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
  })

  it('keeps the local path out of the Referer of the remote resources a page loads', async () => {
    const { contentHeaders } = await load()
    expect(contentHeaders('/r/report.html')['Referrer-Policy']).toBe('no-referrer')
  })

  it('serves the stylesheet and script next to a page with types a browser applies and runs', async () => {
    const { contentHeaders } = await load()
    expect(contentHeaders('/r/report.css')['Content-Type']).toMatch(/^text\/css/)
    expect(contentHeaders('/r/chart.js')['Content-Type']).toMatch(/^text\/javascript/)
  })
})

describe("the app page's frame-src", () => {
  it('admits no source that would show any remote site inside the app', () => {
    const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    const frameSources = directives(policy).get('frame-src') ?? []
    expect(frameSources).toContain('asist-file:')
    for (const wide of ['*', 'https:', 'http:', 'data:', 'blob:', "'self'", 'file:']) expect(frameSources).not.toContain(wide)
  })
})
