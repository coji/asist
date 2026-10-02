import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_FILES } from '../src/shared/preview-page'
import { longTempFolder } from './helpers/temp'

const electron = vi.hoisted(() => ({ handle: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ protocol: { handle: electron.handle }, net: { fetch: electron.fetch } }))

/** What Electron's net.fetch answers for a file: the bytes on disk, or 404 for a file that is not there. */
async function fetchFile(url: string): Promise<Response> {
  const file = fileURLToPath(url)
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 })
}

/** The preview page's files in the built renderer below, as the build lists them (tests/preview-files.test.ts). */
const PREVIEW_PAGE_FILES = ['preview.html', 'assets/preview.js', 'assets/shared.js', 'assets/pdf.js', 'assets/pdf-worker.js', 'assets/decoder.wasm']

/** A built renderer: the app's page and the preview page with what each loads, and the list of the preview page's files. */
function builtRenderer(): string {
  const folder = longTempFolder('asist-preview-')
  const appFiles = ['index.html', 'assets/index.js', 'assets/index.css', 'assets/app-only.js', 'assets/asr-worker.js']
  for (const name of [...PREVIEW_PAGE_FILES, ...appFiles]) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true })
    fs.writeFileSync(path.join(folder, name), name)
  }
  fs.writeFileSync(path.join(folder, PREVIEW_FILES), JSON.stringify(PREVIEW_PAGE_FILES))
  return folder
}

/** Registers the handler for a renderer source and returns what it answers for a URL. */
async function handler(source: { server: string } | { folder: string }, appPage: string): Promise<(url: string) => Promise<Response>> {
  const { handlePreviewScheme } = await import('../src/main/preview-protocol')
  electron.handle.mockClear()
  electron.fetch.mockClear()
  handlePreviewScheme(source, appPage)
  const handle = electron.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
  return (url) => handle(new Request(url))
}

/** The directives of a Content-Security-Policy value, each with its sources. */
function directives(policy: string | null): Map<string, string[]> {
  return new Map(
    (policy ?? '')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name, values])
  )
}

/**
 * Whether the policy confines whatever it governs, a worker included, to running the page's own scripts and
 * reading over asist-file:, with nothing that could load from or send to another host.
 */
function confines(policy: string | null): boolean {
  const rules = directives(policy)
  const fetches = [...rules].filter(([name]) => name.endsWith('-src'))
  return (
    rules.get('default-src')?.join(' ') === "'none'" &&
    rules.get('connect-src')?.join(' ') === 'asist-file:' &&
    rules.get('script-src')?.join(' ') === "'self'" &&
    fetches.every(([name]) => ['default-src', 'connect-src', 'script-src'].includes(name))
  )
}

describe('asist-preview:// in a packaged app', () => {
  const appPage = 'file:///Applications/ASIST.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('serves the files the build lists for the preview page, each under the policy that keeps a worker from sending anything out', async () => {
    electron.fetch.mockImplementation(fetchFile)
    const serve = await handler({ folder: builtRenderer() }, appPage)
    for (const name of PREVIEW_PAGE_FILES) {
      const response = await serve(`asist-preview://app/${name}`)
      expect([name, response.status, await response.text()]).toEqual([name, 200, name])
      expect([name, confines(response.headers.get('content-security-policy'))]).toEqual([name, true])
      expect(directives(response.headers.get('content-security-policy')).get('frame-ancestors')).toEqual(['file:'])
    }
  })

  it('refuses the app page, what only the app page loads, the list, a path out of the folder and another host', async () => {
    electron.fetch.mockImplementation(fetchFile)
    const serve = await handler({ folder: builtRenderer() }, appPage)
    for (const url of [
      'asist-preview://app/index.html',
      'asist-preview://app/assets/index.js',
      'asist-preview://app/assets/index.css',
      'asist-preview://app/assets/app-only.js',
      'asist-preview://app/assets/asr-worker.js',
      `asist-preview://app/${PREVIEW_FILES}`,
      'asist-preview://app/assets/../../main/index.js',
      'asist-preview://app/%2e%2e/main/index.js',
      'asist-preview://other/preview.html'
    ]) {
      expect([url, (await serve(url)).status]).toEqual([url, 404])
    }
    expect(electron.fetch.mock.calls.map(([url]) => url)).toEqual([])
  })
})

describe('asist-preview:// in a development launch', () => {
  const server = 'http://localhost:5173/'

  /** What electron-vite's server answers: a module for a script, and the app's page for any other path. */
  function devServer(url: string): Response {
    const { pathname } = new URL(url)
    if (pathname === '/preview.html') return new Response('<script type="module" src="/src/preview/main.ts"></script>', { headers: { 'Content-Type': 'text/html' } })
    if (pathname.endsWith('.ts')) return new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } })
    return new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } })
  }

  it('passes the preview page and its modules on from the server, under the page policy and embedded only by the server', async () => {
    electron.fetch.mockImplementation(async (url: string) => devServer(url))
    const serve = await handler({ server }, server)
    const page = await serve('asist-preview://app/preview.html')
    expect(await page.text()).toContain('/src/preview/main.ts')
    expect(confines(page.headers.get('content-security-policy'))).toBe(true)
    expect(directives(page.headers.get('content-security-policy')).get('frame-ancestors')).toEqual(['http://localhost:5173'])
    const module = await serve('asist-preview://app/src/preview/main.ts?t=1')
    expect(module.status).toBe(200)
    expect(confines(module.headers.get('content-security-policy'))).toBe(true)
    expect(electron.fetch).toHaveBeenLastCalledWith('http://localhost:5173/src/preview/main.ts?t=1')
  })

  it('refuses the app page, whether asked for by name or by a path the server answers with it', async () => {
    electron.fetch.mockImplementation(async (url: string) => devServer(url))
    const serve = await handler({ server }, server)
    for (const url of ['asist-preview://app/index.html', 'asist-preview://app/', 'asist-preview://app/settings']) {
      expect([url, (await serve(url)).status]).toEqual([url, 404])
    }
  })

  it('refuses a path that would name another host once resolved against the server, and never fetches it', async () => {
    electron.fetch.mockImplementation(async (url: string) => devServer(url))
    const serve = await handler({ server }, server)
    expect((await serve('asist-preview://app//attacker.example/payload.js')).status).toBe(404)
    expect(electron.fetch).not.toHaveBeenCalled()
  })
})
