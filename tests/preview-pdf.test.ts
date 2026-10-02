import { deflateSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import openPdf from '@/preview/methods/pdf'
import { writePdf } from './helpers/pdf-file'

/**
 * The PDF of the preview page, opened by pdf.js and drawn with @napi-rs/canvas, pdf.js's own canvas in Node. The
 * file is served as asist-file answers a Range request, counting the bytes it sends, so that a test sees how much of
 * the file a view reads. pdf.js's legacy build stands in for the one the page loads: the same parser and renderer,
 * with the polyfills Node 22 needs, since the other calls Map.prototype.getOrInsertComputed, which Node 22 lacks.
 */

vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))

const URL = 'asist-file:///Users/me/manual.pdf'
const MB = 1024 * 1024

let sent = 0
/** The status each range is answered with from now on, in place of its bytes. */
let failWith: number | null = null

function serve(file: Uint8Array): void {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (failWith !== null) return new Response(null, { status: failWith })
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range ? Math.min(Number(range[2]), file.length - 1) : file.length - 1
    if (!range || start > end) {
      sent += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(start, end + 1)
    sent += body.length
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
}

beforeAll(async () => {
  // pdf.js runs its worker in the same thread once the worker's module is loaded, as it does wherever Node runs it.
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
})

const documents: Array<{ close?(): void }> = []
afterEach(() => {
  for (const document of documents.splice(0)) document.close?.()
  sent = 0
  failWith = null
  vi.unstubAllGlobals()
})

/** A bitmap as the page would get it, with the canvas's pixels copied, since the canvas is given up once it is made. */
interface Bitmap {
  width: number
  height: number
  /** The red, green and blue of a pixel. */
  pixel(x: number, y: number): number[]
}

async function open(file: Uint8Array) {
  serve(file)
  vi.stubGlobal('createImageBitmap', async (canvas: HTMLCanvasElement): Promise<Bitmap> => {
    const { width, height } = canvas
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height)
    return { width, height, pixel: (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)] }
  })
  const document = await openPdf(URL)
  documents.push(document)
  return document.methods
}

/** A manual of 1,000 pages, a photo on every fifth, as Chrome prints one: 38 MB. */
const manual = writePdf({ pages: 1000, textBytes: 8000, pictureEvery: 5, picture: { width: 224, height: 224 } })

describe('a PDF in the preview page', () => {
  it('reads less than a megabyte of a 1,000-page PDF to open it and draw page 1 in a card', async () => {
    expect(manual.length).toBeGreaterThan(30 * MB)
    const pdf = await open(manual)
    const summary = pdf.summary()
    expect(summary).toEqual({ pageCount: 1000, title: undefined, firstPage: { width: 595, height: 842 } })
    const bitmap = (await pdf.draw({ id: 1, number: 1, scale: 0.6 })) as unknown as Bitmap
    expect(bitmap).toMatchObject({ width: Math.round(595 * 0.6), height: Math.round(842 * 0.6) })
    // The photo is drawn, and with it everything page 1 needs was read.
    expect(bitmap.pixel(178, 171)).not.toEqual([255, 255, 255])
    // Nor does it read on while the card shows the page.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sent).toBeLessThan(1 * MB)
  })

  it('reads a page far into the document without reading the pages before it', async () => {
    const pdf = await open(manual)
    await pdf.draw({ id: 1, number: 1, scale: 0.6 })
    const opened = sent
    await pdf.draw({ id: 2, number: 700, scale: 1 })
    expect(sent - opened).toBeLessThan(0.5 * MB)
  })

  it('draws a page without decoding a picture of more than 100 megapixels on it', async () => {
    // A black mask of 10,001 x 10,000 pixels, 12 MB decoded and 400 MB once drawn, but 12 KB in the file.
    const width = 10_001
    const height = 10_000
    const mask = { entries: '/ImageMask true /BitsPerComponent 1 /Filter /FlateDecode', bytes: deflateSync(new Uint8Array(Math.ceil(width / 8) * height)) }
    const pdf = await open(writePdf({ pages: 1, textBytes: 0, pictureEvery: 1, picture: { width, height, stream: mask } }))
    const bitmap = (await pdf.draw({ id: 1, number: 1, scale: 1 })) as unknown as Bitmap
    expect(bitmap).toMatchObject({ width: 595, height: 842 })
    // The middle of where the mask would cover is left as white paper.
    expect(bitmap.pixel(297, 285)).toEqual([255, 255, 255])
  })

  it('gives no bitmap for a drawing released before it is done', async () => {
    const pdf = await open(manual)
    const drawing = pdf.draw({ id: 1, number: 2, scale: 1 })
    pdf.release(1)
    expect(await drawing).toBeNull()
  })

  it('fails a drawing whose range cannot be read, rather than leaving it waiting', async () => {
    const pdf = await open(manual)
    failWith = 500
    await expect(pdf.draw({ id: 1, number: 500, scale: 1 })).rejects.toThrow(errorKey('files.errors.loadFailed', { status: 500 }))
  })

  it('fails a drawing when the file was written again since it was opened', async () => {
    const pdf = await open(manual)
    serve(writePdf({ pages: 999, textBytes: 8000, pictureEvery: 5, picture: { width: 224, height: 224 } }))
    await expect(pdf.draw({ id: 1, number: 500, scale: 1 })).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
  })
})
