import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { aizuchiReview } from './aizuchi-clips/review-api.mjs'
import { PREVIEW_PAGE_HOST } from '../src/renderer/src/demo/routes'
import { PREVIEW_PAGE, PREVIEW_POLICY } from '../src/shared/preview-page'

// Runs the renderer alone in a plain browser, which is the demo mode. Electron is not started.

const root = resolve(import.meta.dirname, '..')

/**
 * The demo shell shows each sample in an iframe from its own origin, and a sample's viewers load the preview
 * page from PREVIEW_PAGE_HOST. The app's CSP in index.html allows neither, so both are added while the demo is
 * served; the app's CSP itself is left alone. main sends the preview page's policy as a header with every
 * response of its origin, so the demo does the same for every response to PREVIEW_PAGE_HOST. The page reads
 * the demo's files, and the development server's client in it connects, over its own origin rather than
 * asist-file:, so that policy gets its own origin as well.
 */
const FRAME_SRC = 'frame-src https://www.google.com'
const CONNECT_SRC = 'connect-src asist-file:'
if (!PREVIEW_POLICY.includes(CONNECT_SRC)) throw new Error(`プレビューのページの CSP に ${CONNECT_SRC} がありません。demo で開けません`)
const DEMO_PREVIEW_POLICY = PREVIEW_POLICY.replace(CONNECT_SRC, `${CONNECT_SRC} 'self'`)
const demoPolicies: Plugin = {
  name: 'asist-demo-csp',
  transformIndexHtml(html, { path }) {
    if (path === `/${PREVIEW_PAGE}`) return html
    if (!html.includes(FRAME_SRC)) throw new Error(`${path} の CSP に ${FRAME_SRC} がありません。demo のフレームが iframe を開けません`)
    return html.replace(FRAME_SRC, `frame-src 'self' http://${PREVIEW_PAGE_HOST}:* https://www.google.com`)
  },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (new URL(`http://${request.headers.host}`).hostname === PREVIEW_PAGE_HOST) response.setHeader('Content-Security-Policy', DEMO_PREVIEW_POLICY)
      next()
    })
  }
}
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  // .env is read from the repository root, as electron-vite does for the app, with the same renderer prefixes.
  envDir: root,
  envPrefix: ['VITE_', 'RENDERER_VITE_'],
  // Sample files only the demo uses, such as the images of the files card. They stay out of the real build.
  publicDir: resolve(root, 'src/renderer/demo-public'),
  resolve: {
    alias: {
      '@': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  },
  // The aizuchi review page (/aizuchi) reads and writes the clips under resources/aizuchi through it.
  plugins: [react(), tailwindcss(), demoPolicies, aizuchiReview(root)],
  server: { port: 5174, strictPort: true }
})
