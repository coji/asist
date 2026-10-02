// @vitest-environment happy-dom
import React, { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelSpec } from '@shared/ipc'
import type { CardContext, CardDefinition } from '@/panels/shell/card'
import { Frame } from '@/panels/viewers/Frame'
import { ScrollRoot, useNear, useNearWatch } from '@/panels/viewers/use-near'
import { FocusCard } from '@/ui/FocusOverlay'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * The watcher for "within a screen of the view", which PDF pages, slides and Word pictures use to draw only what
 * the user is about to see. The pages are drawn by a card shown in the app's own focus card. The boxes of the
 * focus card and the pages are given here, since happy-dom lays nothing out and loads no CSS, and an observer
 * that computes intersections as a browser does stands in for the browser's.
 */

const cards = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/panels/registry', () => ({ cardDefinition: (type: string) => cards.get(type) }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  vi.unstubAllGlobals()
})

function Page({ index }: { index: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNear(ref)
  return <div ref={ref} className="page" data-index={index} data-near={near ? 'true' : undefined} />
}

const pages = (count: number): React.JSX.Element[] => Array.from({ length: count }, (_, i) => <Page key={i} index={i} />)

/** A document whose HTML arrives as a string, as mammoth's does, with its pictures watched one by one. */
function Html({ html }: { html: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const watchNear = useNearWatch()
  useEffect(() => {
    const stops = [...ref.current!.querySelectorAll<HTMLElement>('.page')].map((picture) =>
      watchNear(picture, (near) => {
        if (near) picture.dataset.near = 'true'
        else delete picture.dataset.near
      })
    )
    return () => stops.forEach((stop) => stop())
  }, [html, watchNear])
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}

cards.set('pages', { kicker: 'PAGES', Body: ({ spec }: CardContext) => <Frame mode="focus" size="focus">{pages(spec.props.count as number)}</Frame> } satisfies CardDefinition)
cards.set('document', { kicker: 'DOC', Body: ({ spec }: CardContext) => <Html html={spec.props.html as string} /> } satisfies CardDefinition)

const specOf = (type: string, props: Record<string, unknown>): PanelSpec => ({ key: type, type, slot: 'left', state: 'ready', props, createdAt: 0, updatedAt: 0 })

/** Puts an element at a place in the window, from top to bottom, as the layout would. */
function place(element: Element, top: () => number, height: number): void {
  element.getBoundingClientRect = () => {
    const at = top()
    return { top: at, bottom: at + height, left: 0, right: 760, width: 760, height, x: 0, y: at } as DOMRect
  }
}

/**
 * Lays the focus card out as main.css does: 600 px shown from y = 100 of the window, scrolling and clipping what
 * lies past it, with each page 500 px tall.
 */
function layOutFocus(scrolled: () => number): void {
  const card = container.querySelector<HTMLElement>('.panel-focus')!
  card.style.overflowY = 'auto'
  place(card, () => 100, 600)
  for (const page of container.querySelectorAll<HTMLElement>('.page')) place(page, () => 100 + Number(page.dataset.index) * 500 - scrolled(), 500)
}

/** Lets the observers report, as a browser does after a frame. */
const frame = (): Promise<void> => act(async () => LayoutIntersectionObserver.update())

const nearPages = (): number[] => [...container.querySelectorAll<HTMLElement>('.page[data-near]')].map((page) => Number(page.dataset.index))

describe('the near-view watcher', () => {
  it('reports a page in the focus card as near while it is still hidden below what the card shows, and as no longer near a screen away', async () => {
    await act(async () => root.render(<FocusCard spec={specOf('pages', { count: 10 })} onClose={() => {}} />))
    let scrolled = 0
    layOutFocus(() => scrolled)
    await frame()
    // Page 2 starts 400 px below what the card shows.
    expect(nearPages()).toEqual([0, 1, 2])

    scrolled = 1500
    await frame()
    expect(nearPages()).toEqual([1, 2, 3, 4, 5])
  })

  it('watches elements that arrive inside HTML the component did not render itself', async () => {
    const html = Array.from({ length: 6 }, (_, i) => `<img class="page" data-index="${i}" alt="">`).join('')
    await act(async () => root.render(<FocusCard spec={specOf('document', { html })} onClose={() => {}} />))
    layOutFocus(() => 0)
    await frame()
    expect(nearPages()).toEqual([0, 1, 2])
  })

  it('stops watching a page that is removed, and every page once the focus card closes', async () => {
    await act(async () => root.render(<FocusCard spec={specOf('pages', { count: 10 })} onClose={() => {}} />))
    layOutFocus(() => 0)
    await frame()
    expect(LayoutIntersectionObserver.watched()).toBe(10)
    await act(async () => root.render(<FocusCard spec={specOf('pages', { count: 7 })} onClose={() => {}} />))
    expect(LayoutIntersectionObserver.watched()).toBe(7)
    await act(async () => root.render(<></>))
    expect(LayoutIntersectionObserver.watched()).toBe(0)
  })

  it('watches the box of a card, which scrolls inside the card, rather than the box around the card', async () => {
    function Outer(): React.JSX.Element {
      const outer = useRef<HTMLDivElement>(null)
      return (
        <div ref={outer} className="outer" style={{ overflowY: 'auto' }}>
          <ScrollRoot.Provider value={outer}>
            <Frame mode="card" size="l">
              {pages(6)}
            </Frame>
          </ScrollRoot.Provider>
        </div>
      )
    }
    await act(async () => root.render(<Outer />))
    place(container.querySelector('.outer')!, () => 0, 2000)
    place(container.querySelector('.fv-scroll')!, () => 0, 420)
    for (const page of container.querySelectorAll<HTMLElement>('.page')) place(page, () => Number(page.dataset.index) * 300, 300)
    await frame()
    expect(nearPages()).toEqual([0, 1, 2])
  })
})
