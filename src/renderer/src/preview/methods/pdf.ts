import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, RenderingCancelledException, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { errorKey } from '@shared/i18n/error-key'
import { fetchRange, readRange, type Bytes } from '../ranges'
import type { OpenPreviewDocument } from '../serve'

/**
 * A PDF in the preview page. pdf.js reads the file in ranges as it needs them and reads nothing ahead, so a card
 * reads the file's cross-reference table, its page tree down to page 1, and what page 1 draws, and the focus view
 * reads the pages near what it shows. Each page is drawn into a bitmap the viewer shows; pdf.js keeps the page's
 * decoded pictures and its operator list until the viewer releases the drawing.
 *
 * pdf.js needs nothing beyond the page's policy: its worker is one of the page's own scripts, the ranges reach it
 * from the page, and an embedded font is loaded from its bytes. It is given no wasmUrl, so pictures in JBIG2, CCITT
 * fax or JPEG 2000, which pdf.js decodes with WebAssembly alone, are left out.
 */

GlobalWorkerOptions.workerSrc = workerUrl

/** The length of each range read, which is also pdf.js's own unit of what it has read. */
const RANGE_BYTES = 64 * 1024

/**
 * The most pixels a picture may have for pdf.js to decode it. pdf.js reads a larger one's bytes with the rest of its
 * object, but draws the page without decoding it. Decoded, a picture of 100 megapixels takes 400 MB, while a scan of
 * an A3 page at 600 dpi has 70 megapixels.
 */
const MAX_PICTURE_PIXELS = 100_000_000

/** The size of a page in pt, turned as the page is shown. */
export interface PageSize {
  width: number
  height: number
}

export interface PdfSummary {
  pageCount: number
  /** The Title from the PDF's metadata, undefined when there is none. */
  title?: string
  /** Page 1's size, which the viewer gives the pages whose own size it does not know yet. */
  firstPage: PageSize
}

/**
 * pdf.js's factory of canvases, which its types leave as Object: a canvas of the page in a browser, and one of
 * @napi-rs/canvas in Node, where the tests draw.
 */
interface CanvasFactory {
  create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }
  destroy(made: { canvas: HTMLCanvasElement | null }): void
}

/**
 * pdf.js's source of the file's bytes. It asks for each range it lacks and waits for it without a way to hear that
 * the range failed, so a failure goes to `fail`, which ends every request of the document that waits.
 */
class FileRanges extends PDFDataRangeTransport {
  readonly #url: string
  readonly #reading = new AbortController()
  readonly #fail: (error: unknown) => void

  constructor(url: string, size: number, start: Bytes, fail: (error: unknown) => void) {
    super(size, start)
    this.#url = url
    this.#fail = fail
  }

  override requestDataRange(begin: number, end: number): void {
    readRange(this.#url, begin, end, this.length, this.#reading.signal).then((bytes) => this.onDataRange(begin, bytes), this.#fail)
  }

  override abort(): void {
    this.#reading.abort()
  }
}

/** A drawing the viewer holds, by the id it gave it. */
interface Drawing {
  number: number
  page?: PDFPageProxy
  task?: RenderTask
  released: boolean
}

const sizeOf = (page: PDFPageProxy): PageSize => {
  const { width, height } = page.getViewport({ scale: 1 })
  return { width, height }
}

const openPdf = async (url: string) => {
  // The first range holds the file's header and tells its length; pdf.js reads the rest as it needs it.
  const first = await fetchRange(url, `bytes=0-${RANGE_BYTES - 1}`)
  // asist-file answers a range with no byte of the file only for an empty file.
  if (!first) throw new Error(errorKey('files.viewer.pdfFailed'))
  let fail!: (error: unknown) => void
  const failed = new Promise<never>((_, reject) => (fail = reject))
  failed.catch(() => undefined)
  const ranges = new FileRanges(url, first.size, first.bytes, fail)
  /** A request of pdf.js's, ended by a range that failed rather than left waiting for it. */
  const settled = <T>(request: Promise<T>): Promise<T> => Promise.race([request, failed])
  const task = getDocument({
    range: ranges,
    rangeChunkSize: RANGE_BYTES,
    disableAutoFetch: true,
    disableStream: true,
    maxImageSize: MAX_PICTURE_PIXELS,
    // pdf.js hands a JPEG to the browser's ImageDecoder by default, and the pictures it decoded stayed in the
    // frame's compositor cache after their pages were released: 266 MB in the frame's process after paging through
    // 120 screens of a 200-page report with a photo on every other page, and none with pdf.js's own decoder (Chrome
    // 154, 2026-10-02). That one runs in pdf.js's worker as well, and drew a page with a photo of 1,600 x 1,200
    // about 0.2 s later (the built preview page in Electron 43.7.7 on an M5, 2026-10-02).
    isImageDecoderSupported: false
  })
  try {
    const doc = await settled(task.promise)
    const { info } = await settled(doc.getMetadata())
    const rawTitle = (info as { Title?: unknown }).Title
    const summary: PdfSummary = {
      pageCount: doc.numPages,
      title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined,
      firstPage: sizeOf(await settled(doc.getPage(1)))
    }
    const canvases = doc.canvasFactory as CanvasFactory
    const drawings = new Map<number, Drawing>()

    return {
      methods: {
        summary: (): PdfSummary => summary,

        size: async (number: number): Promise<PageSize> => sizeOf(await settled(doc.getPage(number))),

        /**
         * Draws a page at a scale (pt to pixels) into a bitmap, or gives null when the drawing was released before
         * it was done. The id is the viewer's own, unique among the drawings of the document.
         */
        draw: async ({ id, number, scale }: { id: number; number: number; scale: number }): Promise<ImageBitmap | null> => {
          const drawing: Drawing = { number, released: false }
          drawings.set(id, drawing)
          const page = await settled(doc.getPage(number))
          drawing.page = page
          if (drawing.released) return null
          const viewport = page.getViewport({ scale })
          const made = canvases.create(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)))
          try {
            drawing.task = page.render({ canvas: made.canvas, viewport })
            await settled(drawing.task.promise)
            return await createImageBitmap(made.canvas)
          } catch (error) {
            if (error instanceof RenderingCancelledException) return null
            throw error
          } finally {
            canvases.destroy(made)
          }
        },

        /**
         * Lets go of a drawing: one still running stops, and once no drawing holds its page, the page lets go of its
         * decoded pictures and operator list, which it would otherwise keep for as long as the document is open.
         */
        release: (id: number): void => {
          const drawing = drawings.get(id)
          if (!drawing) return
          drawings.delete(id)
          drawing.released = true
          drawing.task?.cancel()
          if (![...drawings.values()].some((other) => other.number === drawing.number)) drawing.page?.cleanup()
        }
      },
      close() {
        void task.destroy()
      }
    }
  } catch (error) {
    // The loading task's worker holds what it read until the task is destroyed, and a document that fails to open,
    // such as a broken one or one asking for a password, never reaches the viewer that would close it.
    void task.destroy()
    throw error
  }
}

export default openPdf satisfies OpenPreviewDocument
