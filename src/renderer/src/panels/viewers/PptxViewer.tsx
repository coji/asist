import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FileItem } from '@shared/files'
import type openPptx from '@/preview/methods/pptx'
import type { PptxDeck } from '@/preview/methods/pptx'
import type { PptxFrame, PptxShape, PptxSize } from '@/preview/pptx-model'
import { Frame } from './Frame'
import { openPreviewDocument, type PreviewHandle } from './preview-client'
import type { Viewer } from './types'
import { useNear } from './use-near'
import './PptxViewer.css'
import { displayError } from '@/display-error'
import { translate, useT } from '@/i18n'

/**
 * PowerPoint (pptx) drawn as slide boxes. The preview page reads the file by ranges and parses it
 * (preview/methods/pptx.ts). Here every slide gets a box of the slide's shape, and a slide's shapes are read and
 * drawn only while the box is within a screen of the view. The shapes are placed by their share of the slide, and a
 * font size is a share of the slide width (cqw), so the look holds when the box changes width. A picture is decoded
 * in the preview page at the size it is drawn and shown on a canvas, which lets go of it when its slide leaves. A
 * card shows the first slide and the number of slides, while the focus view stacks them all with their numbers.
 */

type PptxHandle = PreviewHandle<typeof openPptx>

type Opened = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: PptxDeck; handle: PptxHandle }

/** Opens the file in the preview page, where the card and the focus view of one file share its document. */
function useDeck({ url, sizeBytes, modifiedAt }: FileItem): Opened {
  const [opened, setOpened] = useState<Opened>({ status: 'loading' })
  useEffect(() => {
    if (!url) {
      setOpened({ status: 'error', message: translate('files.viewer.urlMissing') })
      return
    }
    setOpened({ status: 'loading' })
    const handle = openPreviewDocument<typeof openPptx>('pptx', { url, sizeBytes, modifiedAt })
    let current = true
    handle.call('deck', undefined).then(
      (deck) => current && setOpened({ status: 'ready', deck, handle }),
      (error) => current && setOpened({ status: 'error', message: displayError(error) })
    )
    return () => {
      current = false
      handle.release()
    }
  }, [url, sizeBytes, modifiedAt])
  return opened
}

/** The width of the box in CSS pixels as it is laid out, which a transform, such as the focus view's opening, leaves alone. */
function useLaidOutWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Turns a shape's font size from pt into a share of the slide width (cqw). The slide is cx EMU wide, which is cx / 12700 pt. */
export const fontSizeCqw = (sizePt: number, size: PptxSize): number => (sizePt / (size.cx / 12700)) * 100

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`
const placed = (frame: PptxFrame): React.CSSProperties => ({ left: percent(frame.x), top: percent(frame.y), width: percent(frame.w), height: percent(frame.h) })

/** Where a picture without a position of its own is drawn: fitted inside the whole slide. */
const WHOLE_SLIDE: PptxFrame = { x: 0, y: 0, w: 1, h: 1 }

function TextShape({ shape, size }: { shape: Extract<PptxShape, { kind: 'text' }>; size: PptxSize }): React.JSX.Element {
  return (
    <div
      className="fv-pptx-text"
      style={shape.frame ? placed(shape.frame) : undefined}
      data-placed={shape.frame ? 'true' : undefined}
      data-placeholder={shape.placeholder ?? undefined}
    >
      {shape.paragraphs.map((para, i) => (
        <p
          key={i}
          className="fv-pptx-para"
          data-bullet={para.bullet ? 'true' : undefined}
          style={{ fontSize: `${fontSizeCqw(para.sizePt, size).toFixed(3)}cqw`, fontWeight: para.bold ? 600 : undefined, marginLeft: para.level ? `${para.level * 1.5}em` : undefined }}
        >
          {para.text}
        </p>
      ))}
    </div>
  )
}

/**
 * A picture on a canvas, asked of the preview page at the size its box takes on the screen. The canvas shows the
 * bitmap it is given without a copy, and lets go of it when the picture is taken off the slide; a bitmap that
 * arrives after that is closed at once.
 */
function Picture({
  shape,
  slide,
  handle,
  onError
}: {
  shape: Extract<PptxShape, { kind: 'picture' }>
  slide: { width: number; height: number }
  handle: PptxHandle
  onError: (message: string) => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null)
  const [undecodable, setUndecodable] = useState(false)
  const frame = shape.frame ?? WHOLE_SLIDE
  const width = Math.round(slide.width * frame.w * devicePixelRatio)
  const height = Math.round(slide.height * frame.h * devicePixelRatio)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || width < 1 || height < 1) return
    let current = true
    let shown = false
    handle.call('picture', { path: shape.target, width, height }).then(
      (bitmap) => {
        if (!current) {
          bitmap?.close()
          return
        }
        if (!bitmap) {
          setUndecodable(true)
          return
        }
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap)
        shown = true
      },
      (error) => current && onError(displayError(error))
    )
    return () => {
      current = false
      if (shown) canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(null)
    }
  }, [handle, shape.target, width, height, onError])
  if (undecodable) return null
  return <canvas ref={ref} className="fv-pptx-picture" style={placed(frame)} data-placed="true" />
}

function Slide({ index, deck, handle, number }: { index: number; deck: PptxDeck; handle: PptxHandle; number?: number }): React.JSX.Element {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const near = useNear(box)
  const width = useLaidOutWidth(box)
  const [shapes, setShapes] = useState<PptxShape[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The shapes of a slide are a few kilobytes, so a slide read once keeps them, and only its pictures go when it
  // leaves. A slide that failed is not read again each time it comes near, since a damaged part fails the same way.
  useEffect(() => {
    if (!near || shapes || error !== null) return
    let current = true
    handle.call('slide', { index }).then(
      (read) => current && setShapes(read),
      (thrown) => current && setError(displayError(thrown))
    )
    return () => {
      current = false
    }
  }, [near, shapes, error, handle, index])
  const { cx, cy } = deck.size
  const slide = { width, height: (width * cy) / cx }
  return (
    <figure className="fv-pptx-figure">
      <div ref={box} className="fv-pptx-slide" style={{ aspectRatio: `${cx} / ${cy}` }}>
        {near &&
          shapes?.map((shape, i) =>
            shape.kind === 'picture' ? (
              <Picture key={i} shape={shape} slide={slide} handle={handle} onError={setError} />
            ) : (
              <TextShape key={i} shape={shape} size={deck.size} />
            )
          )}
      </div>
      {error !== null && (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.pptxFailed', { message: error })}
        </p>
      )}
      {number !== undefined && <figcaption className="fv-pptx-number">{number}</figcaption>}
    </figure>
  )
}

export const PptxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const opened = useDeck(item)
  if (opened.status !== 'ready') {
    return (
      <Frame mode={mode} size={size}>
        {opened.status === 'loading' ? (
          <p className="fv-note">{t('files.viewer.loading')}</p>
        ) : (
          <p className="fv-note" data-tone="error">
            {t('files.viewer.pptxFailed', { message: opened.message })}
          </p>
        )}
      </Frame>
    )
  }
  const { deck, handle } = opened
  if (deck.slideCount === 0) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note">{t('files.viewer.pptxEmpty')}</p>
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size} className="fv-pptx">
      {mode === 'card' ? (
        <>
          <Slide index={0} deck={deck} handle={handle} />
          <p className="fv-note">
            {deck.slideCount > 1 ? t('files.viewer.pptxCountMore', { count: deck.slideCount }) : t('files.viewer.pptxCount', { count: deck.slideCount })}
          </p>
        </>
      ) : (
        Array.from({ length: deck.slideCount }, (_, i) => <Slide key={i} index={i} deck={deck} handle={handle} number={i + 1} />)
      )}
    </Frame>
  )
}
