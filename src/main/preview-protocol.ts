import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol, type CustomScheme } from 'electron'
import { PREVIEW_FILES, PREVIEW_ORIGIN, PREVIEW_PAGE, PREVIEW_POLICY } from '@shared/preview-page'

/**
 * Serves the preview page (src/renderer/preview.html), in whose unseen iframe the files card's viewers do their
 * heavy work, on asist-preview://app/. The scheme serves that page and the files its scripts load, and nothing
 * else: not the app's page, whose origin would then hold the app's code without its CSP, and not the user's
 * files, which the preview page reads over asist-file:// like the app's page does.
 */

/**
 * Where the renderer's pages come from, as main decides it for the app's page: electron-vite's server in a
 * development launch, the built folder otherwise.
 */
export type RendererSource = { server: string } | { folder: string }

const ORIGIN = new URL(PREVIEW_ORIGIN)

/**
 * The privileges of asist-preview://, registered before app.whenReady together with the other schemes. A
 * standard scheme gives the page an origin of its own, which is what puts its frame in a process of its own,
 * and resolves its relative URLs; a secure one lets it use what only a secure context has, such as WebCodecs.
 */
export const previewScheme: CustomScheme = {
  scheme: ORIGIN.protocol.slice(0, -1),
  privileges: { standard: true, secure: true, codeCache: true }
}

/** Answers a request for a path under the origin, or null when the path is not one of the preview page's files. */
type Serve = (url: URL) => Promise<Response | null>

function fromFolder(folder: string): Serve {
  // The renderer's build writes the list (scripts/preview-files.ts). A build without it cannot show the
  // preview page, so the start fails here rather than at the first file opened.
  const files = new Set(JSON.parse(fs.readFileSync(path.join(folder, PREVIEW_FILES), 'utf8')) as string[])
  return async (url) => {
    const name = url.pathname.slice(1)
    return files.has(name) ? net.fetch(pathToFileURL(path.join(folder, name)).href) : null
  }
}

function fromServer(server: string): Serve {
  const { origin } = new URL(server)
  return async (url) => {
    // A path that starts with // names another host once it is resolved against the server.
    const target = new URL(`${url.pathname}${url.search}`, server)
    if (target.origin !== origin) return null
    const response = await net.fetch(target.href)
    // Vite answers a path it has no file for with the app's page, so a page passes only as the preview page.
    const page = response.headers.get('content-type')?.startsWith('text/html') ?? false
    return page && url.pathname !== `/${PREVIEW_PAGE}` ? null : response
  }
}

/**
 * The source that names the app's page in frame-ancestors. A packaged page is a file, which CSP names by its
 * scheme alone, and only the app's page is ever shown from a file in the window.
 */
function appPageSource(appPage: string): string {
  const url = new URL(appPage)
  return url.protocol === 'file:' ? 'file:' : url.origin
}

/**
 * Has to be called after app.whenReady. Every response carries the page's policy, which a worker the page starts
 * takes from its own script's response. frame-ancestors, which only a header can carry, lets the app's page
 * alone embed the page, so that a frame of a remote site, such as the map card's, cannot ask it to read the
 * user's files.
 */
export function handlePreviewScheme(source: RendererSource, appPage: string): void {
  const serve = 'server' in source ? fromServer(source.server) : fromFolder(source.folder)
  const policy = `${PREVIEW_POLICY}; frame-ancestors ${appPageSource(appPage)}`
  protocol.handle(previewScheme.scheme, async (request) => {
    const url = new URL(request.url)
    // Node gives a URL of a scheme it does not know no origin, so the origin is compared by its parts.
    const response = url.protocol === ORIGIN.protocol && url.host === ORIGIN.host ? await serve(url) : null
    if (response === null) return new Response('not found', { status: 404 })
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', policy)
    return new Response(response.body, { status: response.status, headers })
  })
}
