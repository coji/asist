import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRange } from '../src/shared/byte-range'
import { allowedPath, type PathSystem } from '../src/main/services/file-preview'
import { PREVIEW_ORIGIN } from '../src/shared/preview-page'

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

  it('reads a server in a Windows URL as a share that is refused before anything on it is asked when no allowed folder is on it', async () => {
    const { filePathFromUrl } = await load()
    const realpath = vi.fn((target: string) => target)
    const disk: PathSystem = { path: path.win32, realpath }
    const roots = ['C:\\Users\\me', '\\\\nas\\team\\reports']
    for (const url of ['asist-file://attacker.example/share/a.png', 'asist-file://nas/other/a.pdf']) {
      const requested = filePathFromUrl(url, { windows: true })
      expect(requested).not.toBeNull()
      expect(allowedPath(requested!, roots, disk)).toBeNull()
    }
    // The roots themselves may be resolved, to learn the share a mapped drive stands for.
    expect(realpath.mock.calls.map(([asked]) => asked).filter((asked) => !roots.includes(asked))).toEqual([])
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

  it('reads back a file on a share of the server named localhost, which a file:// URL takes for this machine', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const windows = { windows: true }
    for (const file of ['\\\\localhost\\C$\\proj\\a.png', '\\\\LocalHost\\team\\C# notes\\大川俊介 100%.png']) {
      expect([file, filePathFromUrl(fileUrl(file, windows), windows)]).toEqual([file, file])
    }
    const page = fileUrl('\\\\localhost\\C$\\proj\\index.html', windows)
    expect(filePathFromUrl(new URL('img/a.png', page).href, windows)).toBe('\\\\localhost\\C$\\proj\\img\\a.png')
    expect(filePathFromUrl('asist-file://localhost/Users/me/a.png', MACOS)).toBe('/Users/me/a.png')
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
  it('turns bytes=a-b, bytes=a- and bytes=-n into a start and an end', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('returns null for an invalid range, so the whole file is served', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=50-10', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })

  it('finds no byte of an empty file, and serves the empty file whole when its last bytes are asked for', async () => {
    const { fileUrl } = await load()
    expect(parseRange('bytes=-100', 0)).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'empty.mp3'), '')
    const response = await serve(folder, fileUrl(path.join(folder, 'empty.mp3')), 'bytes=-100')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})

/**
 * Whether a CORS check lets a page of the origin read the response, and the named response headers when given:
 * Access-Control-Allow-Origin names the origin, and the headers are among those it exposes.
 */
function corsLets(response: Response, origin: string, exposed: string[] = []): boolean {
  const listed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/)
  return response.headers.get('access-control-allow-origin') === origin && exposed.every((name) => listed.includes(name.toLowerCase()))
}

describe('the preview page reading a file by ranges', () => {
  it('answers the preflight of a suffix range and lets the preview page alone read where the range sits', async () => {
    const { fileUrl, handleFileScheme } = await load()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'book.docx'), Buffer.alloc(100_000, 1))
    electron.handle.mockClear()
    handleFileScheme(() => [folder])
    const handler = electron.handle.mock.calls[0][1] as (request: { method: string; url: string; headers: Headers }) => Response
    const url = fileUrl(path.join(folder, 'book.docx'))

    const preflight = handler({ method: 'OPTIONS', url, headers: new Headers({ origin: PREVIEW_ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' }) })
    expect(preflight.ok).toBe(true)
    expect(corsLets(preflight, PREVIEW_ORIGIN)).toBe(true)
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(/\s*,\s*/)).toContain('range')

    const response = handler({ method: 'GET', url, headers: new Headers({ origin: PREVIEW_ORIGIN, range: 'bytes=-65577' }) })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 34423-99999/100000')
    expect(corsLets(response, PREVIEW_ORIGIN, ['Content-Range'])).toBe(true)
    // An HTML page shown in the files card has an opaque origin, which CORS writes as null.
    expect(corsLets(response, 'null')).toBe(false)
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

/** The whole policy as a map of directive to its exact list of sources, so a source added anywhere is caught. */
async function documentDirectives(filePath: string, rules: { windows?: boolean }): Promise<Map<string, string[]>> {
  const { contentHeaders } = await load()
  return directives(contentHeaders(filePath, rules)['Content-Security-Policy'])
}

describe('the policy a document is served with', () => {
  it('admits exactly the document\'s own folder and the data it carries, and nothing else, in every directive', async () => {
    const { ownFolderSource } = await load()
    const own = ownFolderSource('/r/reports/q3/index.html', MACOS)
    const policy = await documentDirectives('/r/reports/q3/index.html', MACOS)
    expect(policy.get('sandbox')).toEqual(['allow-scripts'])
    expect(policy.get('default-src')).toEqual(["'none'"])
    expect(policy.get('script-src')).toEqual([own, "'unsafe-inline'", "'unsafe-eval'", 'blob:'])
    expect(policy.get('style-src')).toEqual([own, "'unsafe-inline'"])
    expect(policy.get('img-src')).toEqual([own, 'data:', 'blob:'])
    expect(policy.get('font-src')).toEqual([own, 'data:'])
    expect(policy.get('media-src')).toEqual([own, 'data:', 'blob:'])
    expect(policy.get('connect-src')).toEqual(["'none'"])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('worker-src')).toEqual(['blob:'])
    expect(policy.get('form-action')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'none'"])
  })

  it('does not reach a sibling folder of the page, only the page\'s own folder and below it', async () => {
    const { ownFolderSource } = await load()
    const own = ownFolderSource('/r/reports/q3/index.html', MACOS)
    const sibling = ownFolderSource('/r/photos/x.html', MACOS)
    const policy = await documentDirectives('/r/reports/q3/index.html', MACOS)
    for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
      const sources = policy.get(directive) ?? []
      expect(sources).toContain(own)
      expect(sources.some((source) => source.startsWith(sibling.slice(0, -1)))).toBe(false)
    }
    // The sibling's source is a different folder, not a prefix of the page's own.
    expect(own.startsWith(sibling)).toBe(false)
  })

  it('names the folder as the file is served, with a space in a name escaped', async () => {
    const { ownFolderSource } = await load()
    const own = ownFolderSource('/r/My Report/index.html', MACOS)
    expect(own).toBe('asist-file://*/r/My%20Report/')
    expect((await documentDirectives('/r/My Report/index.html', MACOS)).get('img-src')).toContain(own)
  })

  it('confines a Windows page to its own drive folder or share, with one trailing slash at a volume or share root', async () => {
    const { ownFolderSource } = await load()
    const WIN = { windows: true }
    // A drive path has no host in its URL, so the source stands '*' in for it; a share keeps its server.
    expect(ownFolderSource('C:\\Users\\me\\r\\page.html', WIN)).toBe('asist-file://*/C:/Users/me/r/')
    expect(ownFolderSource('\\\\nas\\team\\reports\\page.html', WIN)).toBe('asist-file://nas/team/reports/')
    // A page at the root of a drive or a share ends in exactly one slash, so its own files still match.
    expect(ownFolderSource('C:\\page.html', WIN)).toBe('asist-file://*/C:/')
    expect(ownFolderSource('\\\\nas\\team\\page.html', WIN)).toBe('asist-file://nas/team/')
    expect(ownFolderSource('/page.html', MACOS)).toBe('asist-file://*/')
  })

  it('carries the policy on every document a browser runs scripts in, such as an SVG, but not on a subresource', async () => {
    const { contentHeaders, ownFolderSource } = await load()
    for (const name of ['/r/report.html', '/r/INDEX.HTM', '/r/pic.svg']) {
      const headers = contentHeaders(name, MACOS)
      expect(directives(headers['Content-Security-Policy']).get('script-src')).toEqual([
        ownFolderSource(name, MACOS),
        "'unsafe-inline'",
        "'unsafe-eval'",
        'blob:'
      ])
    }
    // A script, stylesheet or image the page loads is not a document and carries no policy of its own.
    for (const name of ['/r/chart.js', '/r/style.css', '/r/own.png']) {
      expect(contentHeaders(name, MACOS)['Content-Security-Policy']).toBeUndefined()
    }
  })

  it('sandboxes the document with scripts only, whatever frame loads it', async () => {
    const policy = await documentDirectives('/r/report.html', MACOS)
    const sandbox = policy.get('sandbox') ?? []
    expect(sandbox).toContain('allow-scripts')
    for (const flag of ESCAPING_FLAGS) expect(sandbox).not.toContain(flag)
  })

  it('keeps the local path out of the Referer and turns off the browser\'s implicit prefetching of its links', async () => {
    const { contentHeaders } = await load()
    expect(contentHeaders('/r/report.html', MACOS)['Referrer-Policy']).toBe('no-referrer')
    expect(contentHeaders('/r/report.html', MACOS)['X-DNS-Prefetch-Control']).toBe('off')
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
