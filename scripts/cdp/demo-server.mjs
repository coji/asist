import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

/**
 * Serves the demo of the checkout this script lives in, on a port the OS picks, for one run of a script.
 * Every run owns its server, so runs in several worktrees at once never share a port and never capture
 * another checkout's code. `npm run demo` keeps the fixed port 5174 for a person and the browser pane.
 *
 * Vite reads a port of 0 as unset and falls back to 5173, so it cannot be asked for a free port itself.
 * It runs in middleware mode instead, on an HTTP server that is already listening on the port the OS gave,
 * which leaves no moment in which two runs could pick the same number.
 *
 * Once the demo has served its CSS, the process stays alive after close() with nothing left in its
 * handles, while a run that served only scripts exits within two seconds (measured 2026-09-23). A script
 * that starts the demo therefore ends its own process when the run is done.
 */

const CONFIG = fileURLToPath(new URL('../vite.demo.config.mts', import.meta.url))
/**
 * The parser the app's asist-file scheme answers a Range header with. It is TypeScript, which Vite loads here;
 * Node itself would load it too, but with a warning on every run, since package.json does not say its type.
 */
const BYTE_RANGE = fileURLToPath(new URL('../../src/shared/byte-range.ts', import.meta.url))

/** Where the files of the folder given to startDemo are served, by their names, on the demo's own origin. */
export const SERVED_FILES_PATH = '/served-files/'

/**
 * Starts the demo and returns its origin, such as http://localhost:51234, and a function that stops it. With
 * `files`, a folder, the files directly in it are also served under SERVED_FILES_PATH, the way the app serves a
 * file the files card shows: by ranges, and never from the browser's cache. Vite's own /@fs refuses a file
 * outside the checkout, such as one in a temporary folder, and lets the browser cache what it serves.
 */
export async function startDemo({ files } = {}) {
  const httpServer = http.createServer()
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, 'localhost', resolve)
  })
  const vite = await createServer({
    configFile: CONFIG,
    logLevel: 'error',
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server: httpServer } }
  })
  const served = files ? serveFolder(files, (await vite.ssrLoadModule(BYTE_RANGE)).parseRange) : null
  httpServer.on('request', (req, res) => {
    if (served && req.url.startsWith(SERVED_FILES_PATH)) void served(req, res)
    else vite.middlewares(req, res)
  })
  const { port } = httpServer.address()
  return {
    origin: `http://localhost:${port}`,
    close: async () => {
      await vite.close()
      // A keep-alive connection a client left open would otherwise keep the process running after the run.
      httpServer.closeAllConnections()
      await new Promise((resolve) => httpServer.close(() => resolve()))
    }
  }
}

const TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip'
}

/**
 * The largest body read in one read and sent with its headers, instead of streamed. It keeps a range to one
 * read of the disk; Node's server already turns off Nagle's algorithm on its sockets, so the writes themselves
 * cost no waiting. From a page in headless Chrome on an M5 on 2026-10-02, a 64 KB range took 0.4 ms here and
 * 0.8 ms from Vite's /@fs, and a 4 MB range 1.7 ms and 2.5 ms (medians of 40). A larger body is streamed and
 * never held in memory whole.
 */
const ONE_READ_LIMIT = 64 * 1024 * 1024

/**
 * Answers a GET or HEAD for a file directly in the folder as the app's asist-file scheme does
 * (src/main/file-protocol.ts): one range by its parser, `parseRange` of src/shared/byte-range.ts, or the whole
 * file when no byte of it is asked for.
 */
export function serveFolder(folder, parseRange) {
  return async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(SERVED_FILES_PATH.length))
      if (name !== path.basename(name) || name.startsWith('.')) {
        res.writeHead(404).end()
        return
      }
      const file = path.join(folder, name)
      const { size } = await stat(file)
      const headers = {
        'Content-Type': TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
      const range = parseRange(req.headers.range ?? null, size)
      const { start, end } = range ?? { start: 0, end: size - 1 }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      const status = range ? 206 : 200
      const length = end - start + 1
      headers['Content-Length'] = length
      if (req.method === 'HEAD') {
        res.writeHead(status, headers).end()
        return
      }
      if (length > ONE_READ_LIMIT) {
        res.writeHead(status, headers)
        // pipeline closes the file when the browser drops the request, as an <audio> does once it has enough.
        // That rejects it, and so would a failed read; with the headers sent, either can only cut the response
        // short, which pipeline has already done and the browser sees.
        await pipeline(createReadStream(file, { start, end }), res).catch(() => {})
        return
      }
      const body = Buffer.allocUnsafe(length)
      const handle = await open(file, 'r')
      try {
        await handle.read(body, 0, length, start)
      } finally {
        await handle.close()
      }
      res.writeHead(status, headers).end(body)
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end(String(error.message))
    }
  }
}
