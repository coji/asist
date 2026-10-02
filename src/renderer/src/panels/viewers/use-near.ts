import { createContext, useCallback, useContext, useEffect, useState, type RefObject } from 'react'

/**
 * The box that scrolls a viewer's content: the Frame's own box in a card, and the focus card in the focus view,
 * where the Frame grows with its content. Outside both, the window scrolls.
 */
export const ScrollRoot = createContext<RefObject<HTMLElement | null> | null>(null)

/**
 * How far past each edge of the scrolling box an element still counts as near: one screen, as a share of the
 * box. The observer is rooted at the box, because one rooted at the window clips an element by the box before
 * the margin applies, so that a page hidden below the focus card was never near before it came into view.
 */
const NEAR_MARGIN = '100%'

/** Told whether the element is near, once when it is first measured and again each time that changes. */
export type NearReport = (near: boolean) => void

/** One observer per scrolling box, shared by every element watched in it; null stands for the window. */
const watchers = new Map<HTMLElement | null, { observer: IntersectionObserver; reports: Map<Element, NearReport> }>()

function watch(root: HTMLElement | null, element: Element, report: NearReport): () => void {
  let watcher = watchers.get(root)
  if (!watcher) {
    const reports = new Map<Element, NearReport>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) reports.get(entry.target)?.(entry.isIntersecting)
      },
      { root, rootMargin: NEAR_MARGIN }
    )
    watcher = { observer, reports }
    watchers.set(root, watcher)
  }
  const { observer, reports } = watcher
  reports.set(element, report)
  observer.observe(element)
  return () => {
    observer.unobserve(element)
    reports.delete(element)
    if (reports.size > 0) return
    observer.disconnect()
    watchers.delete(root)
  }
}

/**
 * Watches elements the component did not render itself, such as the pictures inside a document's HTML: the
 * returned function starts watching one element in the component's scrolling box and returns what stops it. It
 * is called from an effect, once every ref of the commit is attached, the scrolling box's included.
 */
export function useNearWatch(): (element: Element, report: NearReport) => () => void {
  const root = useContext(ScrollRoot)
  return useCallback((element, report) => watch(root === null ? null : root.current, element, report), [root])
}

/**
 * Whether the element lies within one screen of what its scrolling box shows, kept up to date as the box
 * scrolls and the content around the element moves. The ref points at an element that stays mounted as long as
 * the component does.
 */
export function useNear(ref: RefObject<Element | null>): boolean {
  const watchNear = useNearWatch()
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    return watchNear(element, setNear)
  }, [ref, watchNear])
  return near
}
