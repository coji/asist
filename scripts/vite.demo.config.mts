import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { aizuchiReview } from './aizuchi-clips/review-api.mjs'

// Runs the renderer alone in a plain browser, which is the demo mode. Electron is not started.

const root = resolve(import.meta.dirname, '..')

/**
 * The demo shell shows each sample in an iframe from its own origin. The app's CSP in index.html allows an
 * iframe only for Google Maps, so the demo's own origin is added while the demo is served. The app's CSP
 * itself is left alone.
 */
const FRAME_SRC = 'frame-src https://www.google.com'
const allowOwnFrames = {
  name: 'asist-demo-frame-src',
  transformIndexHtml(html: string): string {
    if (!html.includes(FRAME_SRC)) throw new Error(`index.html の CSP に ${FRAME_SRC} がありません。demo のフレームが iframe を開けません`)
    return html.replace(FRAME_SRC, `frame-src 'self' https://www.google.com`)
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
  plugins: [react(), tailwindcss(), allowOwnFrames, aizuchiReview(root)],
  server: { port: 5174, strictPort: true }
})
