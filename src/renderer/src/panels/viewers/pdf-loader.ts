import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { errorText } from '@shared/i18n/error-text'
import type { PdfDocument, PdfLoader, PdfPage } from './pdf-types'

/**
 * Opens a PDF with pdf.js. PdfViewer imports this module dynamically, so pdf.js itself (about 450KB) and its
 * worker (about 1.2MB) are loaded only when a PDF is opened for the first time. The worker is served as an
 * asset through vite's `?url`, which holds both in electron-vite's build and in the demo's vite. The CSP in
 * index.html allows it through `worker-src 'self' blob:`.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const loadPdf: PdfLoader = async (url: string): Promise<PdfDocument> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(errorText('files.errors.loadFailed', { status: response.status }))
  const task = pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) })
  try {
    const doc = await task.promise
    const { info } = await doc.getMetadata()
    const rawTitle = (info as { Title?: unknown }).Title
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined
    return {
      pageCount: doc.numPages,
      title,
      async page(number: number): Promise<PdfPage> {
        const page = await doc.getPage(number)
        const base = page.getViewport({ scale: 1 })
        return {
          width: base.width,
          height: base.height,
          async render(canvas, scale) {
            const context = canvas.getContext('2d')
            if (!context) throw new Error(errorText('files.errors.pdfCanvasUnavailable'))
            await page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale }) }).promise
          }
        }
      },
      destroy() {
        void task.destroy()
      }
    }
  } catch (error) {
    // getDocument starts a worker of its own, holding the file's bytes, that only the task's destroy ends. A
    // document that fails to open, such as a broken one or one asking for a password, never reaches the viewer
    // that would destroy it.
    void task.destroy()
    throw error
  }
}
