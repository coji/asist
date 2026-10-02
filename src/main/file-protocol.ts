import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { protocol } from 'electron'
import { allowedPath } from './services/file-preview'

/**
 * Serves files under an allowed folder to the renderer as asist-file:// URLs, which carry the path the way a
 * file:// URL does: asist-file:///Users/me/a.png, asist-file:///C:/Users/me/a.png, and on a Windows network
 * share asist-file://nas/team/a.png, whose host is the server. The files card fetches its images, PDFs,
 * Office documents, audio and video over this URL rather than carrying bytes in its props, and loads an HTML
 * page from it so that the page's relative links resolve to the files next to it. Range requests are
 * answered so that video and audio can seek. Permission is checked on every request, because a job adds new
 * working directories as it goes.
 */

export const FILE_SCHEME = 'asist-file'

/**
 * The options of Node's pathToFileURL and fileURLToPath. Tests pass { windows: true } to check the Windows
 * form on any OS; the app leaves them out, which means the rules of the OS it runs on.
 */
type UrlRules = { windows?: boolean }

const windowsRules = (rules?: UrlRules): boolean => rules?.windows ?? path.sep === '\\'

const DRIVE = /^[A-Za-z]:$/

/**
 * The server a file:// URL takes for this machine and leaves out, so that \\localhost\C$\a.png comes out of
 * pathToFileURL as file:///C$/a.png, a path on no drive. On Windows it is also a server whose shares a drive can be
 * mapped to, so an asist-file:// URL keeps it as its host, which a URL of its own scheme leaves as it is.
 */
const LOCALHOST = 'localhost'

/**
 * The URL of an absolute path. Every character of a name that is not plain is escaped, so that a # or ? in a
 * file name stays part of the path; only the drive letter's colon is left as file:// URLs write it.
 */
export function fileUrl(filePath: string, rules?: UrlRules): string {
  const { host, pathname } = pathToFileURL(filePath, rules)
  const names = pathname.split('/').map((name, index) => (index === 1 && DRIVE.test(name) ? name : encodeURIComponent(decodeURIComponent(name))))
  // The server of a share that pathToFileURL left out, which is LOCALHOST, is taken from the path.
  const server = host || (windowsRules(rules) ? (/^[\\/]{2}([^\\/]+)[\\/]/.exec(filePath)?.[1] ?? '') : '')
  return `${FILE_SCHEME}://${server}${names.join('/')}`
}

/** Has to be called before app.whenReady. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  // The header's charset overrides a page's own meta charset. Agents write UTF-8, and a page without a
  // meta charset would otherwise be decoded as windows-1252 and its Japanese garbled.
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8'
}

/**
 * The policy a document served from an allowed folder is given, confined to the folder the document is in,
 * which holds even where the document is loaded without the files card's sandboxed iframe. `sandbox
 * allow-scripts` gives the document an opaque origin, so it cannot reach the app's page or the preload
 * bridge. Every source that loads is the document's own folder and the data the document itself carries
 * (`data:` and `blob:`, which are made from what it already holds), never another folder and never a remote
 * host, so the document cannot read a file the folder does not hold, and `connect-src 'none'` with no remote
 * source anywhere leaves it no way to send out what it does read: no fetch, no beacon, no WebSocket, no
 * request to a remote script, style, image or font, and no frame, form or navigation that could carry bytes.
 * `blob:` closes nothing (a blob is the document's own bytes, and a worker started from one inherits this
 * policy), so it is allowed where a page builds images, audio or a worker from its own data. A scheme-wide
 * `asist-file:` source would reach every allowed folder, so each source names the one folder.
 */
export function documentPolicy(filePath: string, rules?: UrlRules): string {
  const own = ownFolderSource(filePath, rules)
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${own} 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

/**
 * The folder the document is in, as a CSP source that matches that folder and everything below it. A CSP
 * host-source needs a host, but an asist-file:// URL for a local path has none (the path carries the whole
 * location), so `*` stands in for the empty host and the path still confines the source to the one folder; a
 * Windows share keeps its server as the host. fileUrl escapes each name the way the file is served, so a
 * folder whose name holds a space or a '#' still matches. The path already ends in a slash at a volume or
 * share root, so the trailing slash the source needs is added only when it is missing.
 */
export function ownFolderSource(filePath: string, rules?: UrlRules): string {
  // dirname follows the same rules as the rest of the path: Windows on Windows, or when a test asks for it.
  const parent = (windowsRules(rules) ? path.win32 : path.posix).dirname(filePath)
  const url = new URL(fileUrl(parent, rules))
  // One trailing slash, so the source matches the folder and everything below it. A volume or share root
  // comes back with a slash already, which would otherwise double it and match nothing.
  const folder = url.pathname.replace(/\/*$/, '/')
  return `${FILE_SCHEME}://${url.host || '*'}${folder}`
}

/**
 * The media types a browser renders as a document and runs scripts in, so that a frame navigated to one is
 * confined like the page the files card opened. SVG scripts run only when the SVG is the document, never
 * when it is drawn by an <img>, where the policy's fetch directives do not apply.
 */
const DOCUMENT_TYPES = ['text/html', 'image/svg+xml']

/**
 * The headers that depend on the file. A document also keeps its local path out of the Referer of any
 * request it makes, and turns off the browser's implicit DNS prefetching of the links it holds, which the
 * content security policy does not reach. An explicit `<link rel="dns-prefetch">` the document itself adds
 * still resolves its host; Electron exposes no way to stop that for one frame, and it is the one channel a
 * confined document keeps, able to carry a hostname out but nothing a page reads back. A `rel="preconnect"`
 * does nothing, because Electron does not act on a renderer's preconnect request on its own.
 */
export function contentHeaders(filePath: string, rules?: UrlRules): Record<string, string> {
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  if (!DOCUMENT_TYPES.some((documentType) => type.startsWith(documentType))) return { 'Content-Type': type }
  return {
    'Content-Type': type,
    'Content-Security-Policy': documentPolicy(filePath, rules),
    'Referrer-Policy': 'no-referrer',
    'X-DNS-Prefetch-Control': 'off'
  }
}

/**
 * Takes the absolute path out of the URL, as fileURLToPath does for the file:// URL with the same host and
 * path, so that every URL fileUrl writes reads back as its path. A host is the server of a Windows share, and
 * macOS refuses every host but localhost, which file:// takes for this machine. A share is not checked here:
 * allowedPath refuses a server that holds no allowed folder before asking the disk, since resolving a path on
 * a server hands it the user's credentials. An escaped separator is refused. Every other escape is decoded,
 * because a page's relative link may escape a reserved character, such as %2C for a comma.
 */
export function filePathFromUrl(url: string, rules?: UrlRules): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${FILE_SCHEME}:` || !parsed.pathname.startsWith('/')) return null
  // A path on a server starts with the name of a share; \\server\ alone names no place on it.
  if (parsed.host !== '' && !/^\/[^/]+/.test(parsed.pathname)) return null
  // A file:// URL takes a raw backslash for a separator, while in an asist-file:// URL it belongs to the
  // name, so it is escaped before the path is carried over.
  const pathname = parsed.pathname.replace(/\\/g, '%5C')
  try {
    if (windowsRules(rules) && parsed.host.toLowerCase() === LOCALHOST) {
      // file:// would drop this host, so the path on the share is read as file:// reads one below a drive.
      return `\\\\${parsed.host}${fileURLToPath(`file:///C:${pathname}`, rules).slice('C:'.length)}`
    }
    return fileURLToPath(`file://${parsed.host}${pathname}`, rules)
  } catch {
    return null
  }
}

/**
 * Turns a Range header of the form `bytes=a-b`, `bytes=a-` or `bytes=-n` (the last n bytes) into [start, end]
 * within the file, or null when no byte of the file is in it.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  const suffix = m[1] === ''
  const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1])
  const end = suffix || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start > end ? null : { start, end }
}

/** Has to be called after app.whenReady. allowedRoots is read per request, because a new job adds roots. */
export function handleFileScheme(allowedRoots: () => string[]): void {
  protocol.handle(FILE_SCHEME, (request) => {
    const requested = filePathFromUrl(request.url)
    const filePath = requested === null ? null : allowedPath(requested, allowedRoots())
    if (filePath === null) return new Response('forbidden', { status: 403 })
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })
    const range = parseRange(request.headers.get('range'), stat.size)
    const headers: Record<string, string> = {
      ...contentHeaders(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
      headers['Content-Length'] = String(range.end - range.start + 1)
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
    }
    headers['Content-Length'] = String(stat.size)
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, { status: 200, headers })
  })
}
