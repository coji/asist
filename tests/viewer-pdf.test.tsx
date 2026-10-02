// @vitest-environment happy-dom
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'
import { FRAME_MAX_HEIGHT } from '@/panels/viewers/Frame'
import { cardPageHeight, fitToHeight, fitToWidth, noteText, PdfViewer } from '@/panels/viewers/PdfViewer'
import { ScrollRoot } from '@/panels/viewers/use-near'
import type { PageSize, PdfSummary } from '@/preview/methods/pdf'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * The PDF viewer: the page size calculations, and what it asks of the document in the preview page and shows,
 * in a card and in a focus view that scrolls. The document is a fake that answers as the preview page's does
 * (preview/methods/pdf.ts), since pdf.js cannot draw under happy-dom; the boxes of the focus view and its pages
 * are given here, since happy-dom lays nothing out.
 */

const t = createTranslator('ja-JP')
const A4: PageSize = { width: 595, height: 842 }
const LANDSCAPE: PageSize = { width: 842, height: 595 }
/** The width happy-dom is made to report for the viewer's box, and the width a page gets inside its padding. */
const BOX_WIDTH = 600
const PAGE_WIDTH = BOX_WIDTH - 20

const preview = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/panels/viewers/preview-client', () => ({ openPreviewDocument: (...args: unknown[]) => preview.open(...args) }))

/** A document in the preview page, which counts what the viewer asks of it. */
function fakePdf({ pageCount, title, sizes = {}, failing = {} }: { pageCount: number; title?: string; sizes?: Record<number, PageSize>; failing?: Record<number, string> }) {
  const drawings = new Map<number, number>()
  const drawn: Array<{ number: number; scale: number }> = []
  let released = false
  const document = {
    /** The requests made after the viewer let go of the document, which the preview client refuses. */
    afterRelease: 0,
    /** The pages whose drawings the viewer still holds. */
    held: () => [...new Set(drawings.values())].sort((a, b) => a - b),
    drawn,
    sized: vi.fn(),
    call: vi.fn(async (method: string, args: never): Promise<unknown> => {
      if (released) document.afterRelease += 1
      if (method === 'summary') return { pageCount, title, firstPage: sizes[1] ?? A4 } satisfies PdfSummary
      if (method === 'size') {
        document.sized(args)
        return sizes[args] ?? A4
      }
      if (method === 'draw') {
        const { id, number, scale } = args as { id: number; number: number; scale: number }
        if (failing[number]) throw new Error(failing[number])
        drawings.set(id, number)
        drawn.push({ number, scale })
        const size = sizes[number] ?? A4
        return { width: Math.round(size.width * scale), height: Math.round(size.height * scale), close: vi.fn() }
      }
      if (method === 'release') {
        drawings.delete(args)
        return undefined
      }
      throw new Error(`no method ${method}`)
    }),
    release: vi.fn(() => {
      released = true
    })
  }
  return document
}

let container: HTMLDivElement
let root: Root
const shown = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  // happy-dom measures 0 and has no bitmaprenderer context.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => BOX_WIDTH })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { transferFromImageBitmap: (bitmap: unknown) => shown(this, bitmap) } as never
  })
  shown.mockClear()
  preview.open.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const item: FileItem = { path: '/Users/me/report.pdf', name: 'report.pdf', kind: 'pdf', sizeBytes: 95_000_000, modifiedAt: 1_790_000_000_000, url: 'asist-file:///Users/me/report.pdf' }

/** Lets the document's answers reach the viewer and the effects they start run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** A frame: the near-view watcher reports, and what it reports is drawn. */
const frame = async (): Promise<void> => {
  await act(async () => LayoutIntersectionObserver.update())
  await settle()
}

function Focus({ file }: { file: FileItem }): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <div ref={scroller} className="scroller" style={{ overflowY: 'auto' }}>
      <ScrollRoot.Provider value={scroller}>
        <PdfViewer item={file} mode="focus" size="focus" />
      </ScrollRoot.Provider>
    </div>
  )
}

/** Places an element at a place in the window, from top to bottom, as the layout would. */
function place(element: Element, top: () => number, height: number): void {
  element.getBoundingClientRect = () => {
    const at = top()
    return { top: at, bottom: at + height, left: 0, right: BOX_WIDTH, width: BOX_WIDTH, height, x: 0, y: at } as DOMRect
  }
}

/** The height of an A4 page across the width, with its number under it and the gap to the next. */
const PAGE_STEP = fitToWidth(A4, PAGE_WIDTH).height + 30

/** Lays the focus view out as the focus card does: 680 px shown from y = 100 of the window, the pages one under another. */
function layOutFocus(scrolled: () => number): void {
  place(container.querySelector('.scroller')!, () => 100, 680)
  for (const page of container.querySelectorAll<HTMLElement>('.fv-pdf-page')) {
    const index = Number(page.dataset.page) - 1
    place(page, () => 100 + 40 + index * PAGE_STEP - scrolled(), PAGE_STEP - 10)
  }
}

const pagesWithCanvas = (): number[] => [...container.querySelectorAll<HTMLElement>('.fv-pdf-page')].filter((page) => page.querySelector('canvas')).map((page) => Number(page.dataset.page))

describe('page size', () => {
  it('keeps the aspect ratio for the height when a page is fitted to the width', () => {
    const box = fitToWidth(A4, 400)
    expect(box.width).toBe(400)
    expect(box.height).toBeCloseTo((842 / 595) * 400)
    expect(box.scale).toBeCloseTo(400 / 595)
  })

  it('fits a portrait page by its height and a landscape page by its width when both bounds apply', () => {
    const tall = fitToHeight(A4, 400, 300)
    expect(tall.height).toBe(300)
    expect(tall.width).toBeCloseTo((595 / 842) * 300)
    const wide = fitToHeight(LANDSCAPE, 400, 300)
    expect(wide.width).toBe(400)
    expect(wide.height).toBeCloseTo((595 / 842) * 400)
  })

  it('keeps the first page of a card under the Frame maximum and lowers it further when there is a note', () => {
    for (const size of ['l', 'm', 's'] as const) {
      expect(cardPageHeight(size, false)).toBeLessThan(FRAME_MAX_HEIGHT[size])
      expect(cardPageHeight(size, true)).toBeLessThan(cardPageHeight(size, false))
    }
  })

  it('builds the note from the title and the page count, hiding the count for a single page in a card', () => {
    expect(noteText({ pageCount: 1 }, 'card', t)).toBe('')
    expect(noteText({ pageCount: 3 }, 'card', t)).toBe(t('files.viewer.pdfPages', { count: 3 }))
    expect(noteText({ pageCount: 1, title: '議事録' }, 'card', t)).toBe('議事録')
    expect(noteText({ pageCount: 1, title: '議事録' }, 'focus', t)).toBe(`議事録 · ${t('files.viewer.pdfPages', { count: 1 })}`)
  })
})

describe('the PDF card', () => {
  it('opens the file by its version and draws page 1 alone, at devicePixelRatio pixels of the box that fits the card', async () => {
    const pdf = fakePdf({ pageCount: 1000, title: '製品マニュアル' })
    preview.open.mockReturnValue(pdf)
    await act(async () => root.render(<PdfViewer item={item} mode="card" size="m" />))
    await settle()
    expect(preview.open).toHaveBeenCalledWith('pdf', { url: item.url, sizeBytes: item.sizeBytes, modifiedAt: item.modifiedAt })
    expect(container.querySelector('.fv-note')?.textContent).toBe(`製品マニュアル · ${t('files.viewer.pdfPages', { count: 1000 })}`)
    const box = fitToHeight(A4, PAGE_WIDTH, cardPageHeight('m', true))
    expect(pdf.drawn).toEqual([{ number: 1, scale: box.scale * 2 }])
    expect(pdf.sized).not.toHaveBeenCalled()
    const canvas = container.querySelector('canvas')!
    expect(shown).toHaveBeenCalledWith(canvas, expect.objectContaining({ width: Math.round(A4.width * box.scale * 2) }))
    expect(canvas.style.height).toBe(`${box.height}px`)
  })

  it('opens a PDF of any size, in the card and the focus view, rather than saying it is too large', async () => {
    const huge = { ...item, sizeBytes: 2 ** 40 }
    for (const mode of ['card', 'focus'] as const) {
      preview.open.mockReturnValue(fakePdf({ pageCount: 3 }))
      await act(async () => root.render(<FileViewer key={mode} item={huge} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />))
      await settle()
      expect(container.textContent).not.toContain(t('files.viewer.tooLarge'))
      expect(container.querySelector('.fv-pdf-page')).not.toBeNull()
    }
    expect(preview.open).toHaveBeenCalledTimes(2)
  })

  it('shows a note while the document opens and the reason in red when it does not', async () => {
    let reject!: (error: Error) => void
    preview.open.mockReturnValue({ call: () => new Promise((_, r) => (reject = r)), release: vi.fn() })
    await act(async () => root.render(<PdfViewer item={item} mode="card" size="l" />))
    expect(container.querySelector('.fv-note')?.textContent).toBe(t('files.viewer.loading'))
    await act(async () => reject(new Error('Invalid PDF structure.')))
    expect(container.querySelector('.fv-note[data-tone="error"]')?.textContent).toBe('Invalid PDF structure.')
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('lets go of the document when the viewer goes, without asking anything of a document it has given up', async () => {
    const pdf = fakePdf({ pageCount: 3 })
    preview.open.mockReturnValue(pdf)
    await act(async () => root.render(<PdfViewer item={item} mode="card" size="l" />))
    await settle()
    await act(async () => root.render(<div />))
    await settle()
    expect(pdf.release).toHaveBeenCalledTimes(1)
    expect(pdf.afterRelease).toBe(0)
  })
})

describe('the PDF focus view', () => {
  it('keeps a canvas only for the pages within a screen of the view, and releases each page that leaves, while it pages through the document', async () => {
    const pdf = fakePdf({ pageCount: 60 })
    preview.open.mockReturnValue(pdf)
    await act(async () => root.render(<Focus file={item} />))
    await settle()
    let scrolled = 0
    layOutFocus(() => scrolled)
    await frame()
    const most = { canvases: 0 }
    // Paging down a screen at a time through half of the document, and back up to the top.
    const positions = [...Array.from({ length: 40 }, (_, i) => i * 680), ...Array.from({ length: 8 }, (_, i) => (7 - i) * 3400)]
    for (const position of positions) {
      scrolled = position
      await frame()
      // The pages within a screen above and below what the view shows, 680 px each way.
      const near = Array.from({ length: 60 }, (_, i) => i + 1).filter((number) => {
        const top = 40 + (number - 1) * PAGE_STEP - scrolled
        return top + PAGE_STEP - 10 >= -680 && top <= 680 + 680
      })
      expect(pagesWithCanvas()).toEqual(near)
      expect(pdf.held()).toEqual(near)
      most.canvases = Math.max(most.canvases, near.length)
    }
    // A page is 830 px tall and the region near the view 2,040 px, which three or four pages cover.
    expect(most.canvases).toBeLessThanOrEqual(4)
    expect(new Set(pdf.drawn.map((drawing) => drawing.number)).size).toBeGreaterThan(30)
  })

  it('lays out a page not yet measured at the size of page 1 and gives it its own size once it is near', async () => {
    const pdf = fakePdf({ pageCount: 20, sizes: { 3: LANDSCAPE } })
    preview.open.mockReturnValue(pdf)
    await act(async () => root.render(<Focus file={item} />))
    await settle()
    const blank = container.querySelector<HTMLElement>('.fv-pdf-page[data-page="3"] .fv-pdf-blank')!
    expect(parseFloat(blank.style.height)).toBeCloseTo(fitToWidth(A4, PAGE_WIDTH).height)
    expect(pdf.sized).not.toHaveBeenCalledWith(3)
    // Page 2 in view, page 3 below it within a screen.
    layOutFocus(() => PAGE_STEP)
    await frame()
    expect(pdf.sized).toHaveBeenCalledWith(3)
    const canvas = container.querySelector<HTMLElement>('.fv-pdf-page[data-page="3"] canvas')!
    expect(parseFloat(canvas.style.height)).toBeCloseTo(fitToWidth(LANDSCAPE, PAGE_WIDTH).height)
    expect(pdf.drawn.find((drawing) => drawing.number === 3)?.scale).toBeCloseTo(fitToWidth(LANDSCAPE, PAGE_WIDTH).scale * 2)
  })

  it('shows the reason in place of a page it could not draw and draws the pages around it', async () => {
    const pdf = fakePdf({ pageCount: 3, failing: { 2: '画像が壊れています' } })
    preview.open.mockReturnValue(pdf)
    await act(async () => root.render(<Focus file={item} />))
    await settle()
    // Page 2 in view, with the pages before and after it within a screen.
    layOutFocus(() => PAGE_STEP)
    await frame()
    const second = container.querySelector('.fv-pdf-page[data-page="2"]')!
    expect(second.querySelector('.fv-note[data-tone="error"]')?.textContent).toBe(t('files.viewer.pdfPageFailed', { number: 2, message: '画像が壊れています' }))
    expect(pagesWithCanvas()).toEqual([1, 3])
  })
})
