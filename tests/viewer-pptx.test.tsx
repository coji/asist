// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { parsePresentation, parseRels, parseSlide, placeholderFrames, resolveTarget } from '@/preview/pptx-model'
import { FileViewer } from '@/panels/viewers'
import { fontSizeCqw } from '@/panels/viewers/PptxViewer'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * The PowerPoint viewer. Turning pptx XML into shapes and positions runs on string fixtures. The rendering runs the
 * preview page's PowerPoint kind in the test itself, in place of the iframe, with the file served by ranges as
 * asist-file serves it: a server counts the bytes it sends. happy-dom decodes no picture and draws no canvas, so a
 * decoded picture is a bitmap that remembers whether it was closed, and a canvas remembers the bitmap it shows.
 * Nothing is laid out either: a slide is placed in the window by the test, and an observer that computes
 * intersections as a browser does tells the viewer which slides are near.
 */

vi.mock('@/panels/viewers/preview-client', async () => {
  const { default: openPptx } = await import('@/preview/methods/pptx')
  return {
    // The document's methods are called directly, and a bitmap reaches the viewer as the real channel moves it:
    // the same object, which the viewer then owns.
    openPreviewDocument: (_kind: string, file: { url: string }) => {
      const opening = openPptx(file.url)
      return {
        call: async (method: string, args: never) => ((await opening).methods as Record<string, (args: never) => unknown>)[method](args),
        release: () => undefined
      }
    }
  }
})

const t = createTranslator('ja-JP')
const DEMO_DIR = resolve('src/renderer/demo-public')
const demoItem = DEMO_OFFICE_ITEMS.find((office) => office.kind === 'pptx')!

/** The files the server answers for, by URL. */
const files = new Map<string, Uint8Array>()
let sent = 0

/** A decoded picture: its size, and whether it was closed or handed to a canvas. */
class FakeBitmap {
  closed = false
  shown = false
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    bitmaps.push(this)
  }
  close(): void {
    this.closed = true
  }
}
let bitmaps: FakeBitmap[] = []
/** The bitmap each canvas shows. */
const shownBy = new Map<HTMLCanvasElement, FakeBitmap | null>()
/** The size a photo decodes to before it is scaled. */
const PHOTO = { width: 2400, height: 1600 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  sent = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const file = files.get(url) ?? new Uint8Array(readFileSync(resolve(DEMO_DIR, `.${url}`)))
    const range = /^bytes=(\d*)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')
    const suffix = range?.[1] === ''
    const start = !range ? 0 : suffix ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = !range || suffix || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    if (!range) {
      sent += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(start, end + 1)
    sent += body.length
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
  bitmaps = []
  shownBy.clear()
  vi.stubGlobal('ImageBitmap', FakeBitmap)
  vi.stubGlobal('createImageBitmap', async (source: Blob | FakeBitmap, options?: ImageBitmapOptions) =>
    source instanceof FakeBitmap ? new FakeBitmap(options!.resizeWidth!, options!.resizeHeight!) : new FakeBitmap(PHOTO.width, PHOTO.height)
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    if (type !== 'bitmaprenderer') return null
    return {
      transferFromImageBitmap: (bitmap: FakeBitmap | null) => {
        if (bitmap) bitmap.shown = true
        shownBy.set(this, bitmap)
      }
    } as unknown as ImageBitmapRenderingContext
  })
  // A slide 712 px wide in the focus view, as at window size l.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 712 })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  files.clear()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  LayoutIntersectionObserver.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Lets the observers report, as a browser does after a frame. */
const frame = (): Promise<void> => act(async () => LayoutIntersectionObserver.update())

/** Waits, letting the preview's reads and the viewer's renders run, until the check passes. */
async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check()
      return
    } catch (error) {
      if (i >= 100) throw error
    }
    await act(async () => new Promise((r) => setTimeout(r, 10)))
  }
}

async function render(item: FileItem, mode: 'card' | 'focus'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />)
  })
  await until(() => expect(container.querySelector('.fv-pptx-slide')).not.toBeNull())
  return container.querySelector<HTMLElement>('.fv-frame')!
}

/**
 * Lays the focus view's slides out down the window, each half a window tall with a gap, `scrolled` pixels down.
 * The watcher counts a slide within one window above or below the window as near.
 */
function layOutSlides(scrolled: () => number): void {
  const screen = window.innerHeight
  container.querySelectorAll<HTMLElement>('.fv-pptx-slide').forEach((slide, index) => {
    slide.getBoundingClientRect = () => {
      const top = 10 + (index * screen) / 2 - scrolled()
      return { top, bottom: top + screen / 2 - 10, left: 0, right: 712, width: 712, height: screen / 2 - 10, x: 0, y: top } as DOMRect
    }
  })
}

const slideIndex = (element: Element): number => [...container.querySelectorAll('.fv-pptx-figure')].indexOf(element.closest('.fv-pptx-figure')!)

/** The slides whose text is drawn, by index. */
const drawnSlides = (): number[] => [...container.querySelectorAll('.fv-pptx-figure')].flatMap((figure, index) => (figure.querySelector('.fv-pptx-para') ? [index] : []))

/** The slides whose picture a canvas shows, by index, and whether any bitmap is held where no canvas on the page shows it. */
function heldPictures(): { slides: number[]; elsewhere: number } {
  const slides = [...shownBy].flatMap(([canvas, bitmap]) => (bitmap && canvas.isConnected ? [slideIndex(canvas)] : [])).sort((a, b) => a - b)
  const offPage = [...shownBy].filter(([canvas, bitmap]) => bitmap && !canvas.isConnected).length
  const loose = bitmaps.filter((bitmap) => !bitmap.closed && !bitmap.shown).length
  return { slides, elsewhere: offPage + loose }
}

const PPT_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
const SIZE = { cx: 12192000, cy: 6858000 }
/** The size of a slide's photo, four times the 64 KB a reader takes from the end of the file first. */
const PICTURE = 256 * 1024

/**
 * A deck of 16:9 slides, each with a title and a photo of PICTURE bytes stored as it is, in the order a writer puts
 * them: presentation.xml first, then each slide followed by its photo. A slide given as null is listed in
 * presentation.xml and missing from the file.
 */
async function deckOf(slides: Array<string | null>): Promise<Uint8Array> {
  const zip = new JSZip()
  const options = { createFolders: false }
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')
  zip.file('ppt/presentation.xml', `<p:presentation ${PPT_NS}><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SIZE.cx}" cy="${SIZE.cy}"/></p:presentation>`, options)
  const rels = slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="slides/slide${i + 1}.xml"/>`).join('')
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships ${RELS_NS}>${rels}</Relationships>`, options)
  slides.forEach((title, i) => {
    if (title === null) return
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld ${PPT_NS}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="1371600"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
        <p:pic><p:nvPicPr><p:cNvPr id="3" name="P"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="1371600"/><a:ext cx="6096000" cy="4064000"/></a:xfrm></p:spPr></p:pic>
      </p:spTree></p:cSld></p:sld>`,
      options
    )
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<Relationships ${RELS_NS}><Relationship Id="rId2" Type="x" Target="../media/image${i + 1}.jpeg"/></Relationships>`, options)
    zip.file(`ppt/media/image${i + 1}.jpeg`, randomBytes(PICTURE), { ...options, compression: 'STORE' })
  })
  return zip.generateAsync({ type: 'uint8array' })
}

async function serveDeck(name: string, slides: Array<string | null>): Promise<FileItem> {
  const url = `asist-file:///Users/me/${name}`
  const file = await deckOf(slides)
  files.set(url, file)
  return { path: `/Users/me/${name}`, name, kind: 'pptx', sizeBytes: file.length, url }
}

const titles = (count: number): string[] => Array.from({ length: count }, (_, i) => `スライド ${i + 1}`)

describe('pptx XML into slide shapes', () => {
  it('orders the slides by the r:id entries of sldIdLst resolved through the rels, not by the file name', () => {
    const presentation = `<p:presentation ${PPT_NS}><p:sldIdLst><p:sldId id="1" r:id="rId3"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`
    const rels = `<Relationships ${RELS_NS}><Relationship Id="rId2" Type="x" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x" Target="slides/slide2.xml"/></Relationships>`
    const parsed = parsePresentation(presentation)
    expect(parsed.size).toEqual({ cx: 9144000, cy: 6858000 })
    const map = parseRels(rels)
    expect(parsed.slideRelIds.map((id) => resolveTarget('ppt', map.get(id)!))).toEqual(['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
    expect(resolveTarget('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png')
  })

  it('turns EMU positions into fractions of the slide size and reads bullets, paragraph levels and font sizes', () => {
    const slide = `<p:sld ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="1371600"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:rPr sz="3600"/><a:t>表題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>一つ目</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr sz="2000"/><a:t>二つ目</a:t></a:r><a:br/><a:r><a:t>続き</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>点なし</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="4" name="empty"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="5" name="P"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr></p:pic>
    </p:spTree></p:cSld></p:sld>`
    const shapes = parseSlide(slide, SIZE, new Map([['rId2', '../media/image1.png']]))
    expect(shapes).toEqual([
      {
        kind: 'text',
        placeholder: 'title',
        frame: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
        paragraphs: [{ text: '表題', level: 0, bullet: false, sizePt: 36, bold: true }]
      },
      {
        kind: 'text',
        placeholder: 'body',
        frame: { x: 0, y: 0, w: 0.5, h: 0.5 },
        paragraphs: [
          { text: '一つ目', level: 0, bullet: true, sizePt: 28, bold: false },
          { text: '二つ目\n続き', level: 1, bullet: true, sizePt: 20, bold: false },
          { text: '点なし', level: 0, bullet: false, sizePt: 28, bold: false }
        ]
      },
      { kind: 'picture', frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, target: '../media/image1.png' }
    ])
    // 36 pt as a fraction of the 960 pt slide width is 3.75cqw.
    expect(fontSizeCqw(36, SIZE)).toBeCloseTo(3.75)
  })

  it('inherits the position of a placeholder without an xfrm from the layout, then from the master', () => {
    const layout = `<p:sldLayout ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="1371600"/><a:ext cx="12192000" cy="1371600"/></a:xfrm></p:spPr></p:sp>
    </p:spTree></p:cSld></p:sldLayout>`
    const master = `<p:sldMaster ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="3429000"/><a:ext cx="12192000" cy="3429000"/></a:xfrm></p:spPr></p:sp>
    </p:spTree></p:cSld></p:sldMaster>`
    const slide = `<p:sld ${PPT_NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="S"/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>副題</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="4" name="X"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>位置なし</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`
    const inherited = [placeholderFrames(layout, SIZE), placeholderFrames(master, SIZE)]
    const shapes = parseSlide(slide, SIZE, new Map(), inherited)
    expect(shapes.map((shape) => shape.frame)).toEqual([
      { x: 0, y: 0.2, w: 1, h: 0.2 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
      null
    ])
  })
})

describe('PowerPoint viewer rendering with the demo file', () => {
  it('shows the first slide and the count in a card and every numbered slide in the focus view, placing shapes by fraction', async () => {
    const card = await render(demoItem, 'card')
    await frame()
    await until(() => expect(card.querySelector('.fv-pptx-text[data-placeholder="ctrTitle"]')).not.toBeNull())
    expect(card.querySelectorAll('.fv-pptx-slide')).toHaveLength(1)
    expect(card.querySelector('.fv-scroll > .fv-note')?.textContent).toContain(t('files.viewer.pptxCountMore', { count: 3 }))
    // The title of the first slide has no xfrm and inherits its position from the layout.
    const title = card.querySelector<HTMLElement>('.fv-pptx-text[data-placeholder="ctrTitle"]')!
    expect(title.textContent).toBe('競合サービスの比較')
    expect(title.style.top).toBe('16.37%')
    expect(title.style.width).toBe('75.00%')

    const focus = await render(demoItem, 'focus')
    layOutSlides(() => 0)
    await frame()
    await until(() => expect(heldPictures().slides).toEqual([2]))
    const slides = focus.querySelectorAll('.fv-pptx-slide')
    expect(slides).toHaveLength(3)
    expect([...focus.querySelectorAll('.fv-pptx-number')].map((el) => el.textContent)).toEqual(['1', '2', '3'])
    const bullets = [...slides[1].querySelectorAll<HTMLElement>('.fv-pptx-para[data-bullet="true"]')]
    expect(bullets.map((p) => p.textContent)).toEqual(['個人で使うなら C で足りる', '5 人以上のチームは B 一択', '同時接続の上限が決め手', 'A は年払いの割引で C と差が縮まる'])
    expect(bullets[2].style.marginLeft).toBe('1.5em')
    const picture = slides[2].querySelector<HTMLCanvasElement>('canvas.fv-pptx-picture')!
    expect(picture.style.left).toBe('12.50%')
    expect(picture.style.width).toBe('50.00%')
  })
})

describe('what the PowerPoint viewer reads and keeps', () => {
  it('reads the end of the zip, presentation.xml and the first slide with its picture for the card, however large the file', async () => {
    const item = await serveDeck('deck.pptx', titles(30))
    expect(item.sizeBytes).toBeGreaterThan(30 * PICTURE)
    const card = await render({ ...item, sizeBytes: 2 ** 40 }, 'card')
    await frame()
    await until(() => expect(heldPictures().slides).toEqual([0]))
    expect(card.querySelector('.fv-pptx-para')?.textContent).toBe('スライド 1')
    expect(card.querySelector('.fv-scroll > .fv-note')?.textContent).toContain(t('files.viewer.pptxCountMore', { count: 30 }))
    // The 64 KB at the end hold the central directory, and one picture more would pass the bound.
    expect(sent).toBeLessThan(64 * 1024 + 1.5 * PICTURE)
  })

  it('draws the slides within a screen of the view, and lets go of a slide picture when the slide leaves', async () => {
    const item = await serveDeck('deck.pptx', titles(10))
    await render(item, 'focus')
    let scrolled = 0
    layOutSlides(() => scrolled)
    await frame()
    await until(() => expect(heldPictures()).toEqual({ slides: [0, 1, 2, 3], elsewhere: 0 }))
    expect(drawnSlides()).toEqual([0, 1, 2, 3])
    // A picture is decoded to the box it is drawn in, half of the 712 px slide at the window's pixel ratio.
    const shown = bitmaps.filter((bitmap) => bitmap.shown)
    expect(shown.map((bitmap) => bitmap.width)).toEqual(Array(4).fill(Math.round(356 * devicePixelRatio)))

    scrolled = 3.2 * window.innerHeight
    await frame()
    await until(() => expect(heldPictures()).toEqual({ slides: [4, 5, 6, 7, 8, 9], elsewhere: 0 }))
    expect(drawnSlides()).toEqual([4, 5, 6, 7, 8, 9])
  })

  it('shows the error of a slide missing from the file at that slide, in the interface language, and draws the others', async () => {
    const item = await serveDeck('deck.pptx', ['一枚目', null, '三枚目'])
    const focus = await render(item, 'focus')
    layOutSlides(() => 0)
    await frame()
    await until(() => expect(drawnSlides()).toEqual([0, 2]))
    const errors = [...focus.querySelectorAll('.fv-note[data-tone="error"]')]
    expect(errors.map((note) => [slideIndex(note), note.textContent])).toEqual([
      [1, t('files.viewer.pptxFailed', { message: t('files.errors.zipEntryMissing', { path: 'ppt/slides/slide2.xml' }) })]
    ])
  })
})
