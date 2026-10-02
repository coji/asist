// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FRAME_MAX_HEIGHT } from '@/panels/viewers/Frame'
import { cardPageHeight, fitToHeight, fitToWidth, noteText, pageRange, PdfViewer, setPdfLoader } from '@/panels/viewers/PdfViewer'
import type { PdfDocument, PdfPage } from '@/panels/viewers/pdf-types'

/**
 * The PDF viewer: the page size calculations, and the DOM while loading, after a failure and after rendering.
 * pdf.js cannot draw under happy-dom, so the loader (setPdfLoader) is replaced and pdf.js is never imported.
 */

const t = createTranslator('ja-JP')
const A4 = { width: 595, height: 842 }

// The loader's own test replaces pdf.js, whose getDocument it watches; the viewer's tests never import either.
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdfjs.getDocument }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
const LANDSCAPE = { width: 842, height: 595 }

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

  it('draws only the first page in a card and every page in the focus view', () => {
    expect(pageRange(12, 'card')).toEqual([1])
    expect(pageRange(3, 'focus')).toEqual([1, 2, 3])
    expect(pageRange(0, 'focus')).toEqual([])
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

describe('PdfViewer rendering', () => {
  let container: HTMLDivElement
  let root: Root
  const rendered: Array<{ number: number; scale: number; canvas: HTMLCanvasElement }> = []
  const destroyed = vi.fn()

  const fakeDoc = (pageCount: number, title?: string): PdfDocument => ({
    pageCount,
    title,
    async page(number): Promise<PdfPage> {
      return {
        ...A4,
        async render(canvas, scale) {
          rendered.push({ number, scale, canvas })
        }
      }
    },
    destroy: destroyed
  })
  const item: FileItem = { path: '/tmp/a.pdf', name: 'a.pdf', kind: 'pdf', sizeBytes: 10, url: '/demo-files/pdf/a.pdf' }

  beforeEach(() => {
    rendered.length = 0
    destroyed.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // happy-dom measures 0, so the shell is made to report a width of 600px.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
    vi.stubGlobal('devicePixelRatio', 2)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
        observe(): void {
          // The element counts as visible right away.
          this.callback([{ isIntersecting: true }])
        }
        disconnect(): void {}
      }
    )
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    setPdfLoader(null)
    vi.unstubAllGlobals()
  })

  const render = async (mode: 'card' | 'focus', size: 'l' | 'm' | 's' | 'focus'): Promise<HTMLDivElement> => {
    await act(async () => root.render(<PdfViewer item={item} mode={mode} size={size} />))
    return container
  }
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('shows a note while loading and the reason in red when it fails', async () => {
    let reject!: (error: Error) => void
    setPdfLoader(() => new Promise((_, r) => (reject = r)))
    const el = await render('card', 'l')
    expect(el.querySelector('.fv-note')?.textContent).toBe(t('files.viewer.loading'))
    expect(el.querySelector('.fv-note')?.getAttribute('data-tone')).toBeNull()
    await act(async () => reject(new Error('壊れています')))
    expect(el.querySelector('.fv-note[data-tone="error"]')?.textContent).toBe('壊れています')
    expect(el.querySelector('canvas')).toBeNull()
  })

  it('draws only the first page in a card at devicePixelRatio pixels and notes the title and the page count', async () => {
    setPdfLoader(async () => fakeDoc(3, '議事録'))
    const el = await render('card', 'm')
    await settle()
    expect(el.querySelector('.fv-note')?.textContent).toBe(`議事録 · ${t('files.viewer.pdfPages', { count: 3 })}`)
    expect(el.querySelectorAll('.fv-pdf-page')).toHaveLength(1)
    expect(el.querySelector('.fv-pdf-num')).toBeNull()
    expect(rendered).toHaveLength(1)
    const { canvas, scale } = rendered[0]
    const box = fitToHeight(A4, 600 - 20, cardPageHeight('m', true))
    expect(canvas.width).toBe(Math.round(box.width * 2))
    expect(canvas.height).toBe(Math.round(box.height * 2))
    expect(scale).toBeCloseTo(box.scale * 2)
    expect(canvas.style.height).toBe(`${box.height}px`)
  })

  it('lays out every page in the focus view, draws each one as it becomes visible, and numbers them', async () => {
    setPdfLoader(async () => fakeDoc(3))
    const el = await render('focus', 'focus')
    await settle()
    expect(el.querySelector('.fv-note')?.textContent).toBe(t('files.viewer.pdfPages', { count: 3 }))
    expect(el.querySelectorAll('.fv-pdf-page')).toHaveLength(3)
    expect([...el.querySelectorAll('.fv-pdf-num')].map((n) => n.textContent)).toEqual(['1 / 3', '2 / 3', '3 / 3'])
    expect(rendered.map((r) => r.number)).toEqual([1, 2, 3])
    expect(rendered[0].canvas.style.width).toBe('580px')
  })

  it('shows the reason in place of a page it could not draw', async () => {
    const doc = fakeDoc(2)
    doc.page = async (number) => ({ ...A4, render: async () => { if (number === 2) throw new Error('画像が壊れています') } })
    setPdfLoader(async () => doc)
    const el = await render('focus', 'focus')
    await settle()
    await settle()
    const second = el.querySelector('.fv-pdf-page[data-page="2"]')!
    expect(second.querySelector('.fv-note[data-tone="error"]')?.textContent).toContain('画像が壊れています')
    expect(el.querySelector('.fv-pdf-page[data-page="1"] canvas')).not.toBeNull()
  })

  it('closes the document when the viewer is unmounted', async () => {
    setPdfLoader(async () => fakeDoc(1))
    await render('card', 'l')
    await settle()
    await act(async () => root.render(<div />))
    expect(destroyed).toHaveBeenCalledTimes(1)
  })
})

describe('loadPdf', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    pdfjs.getDocument.mockReset()
  })

  // pdf.js starts a worker for every document it is given no worker for, and only the loading task's destroy ends
  // it, holding the bytes of the file until then.
  it.each([
    ['a document that does not open, such as one asking for a password', () => Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' }))],
    ['a document whose metadata cannot be read', () => Promise.resolve({ getMetadata: () => Promise.reject(new Error('bad xref')) })]
  ])('ends the loading task, and with it the worker, for %s', async (_case, opened) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]))))
    const destroy = vi.fn(async () => {})
    pdfjs.getDocument.mockImplementation(() => {
      const promise = opened()
      promise.catch(() => {})
      return { promise, destroy }
    })
    const { loadPdf } = await import('@/panels/viewers/pdf-loader')
    await expect(loadPdf('asist-file:///Users/me/statement.pdf')).rejects.toThrow()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
