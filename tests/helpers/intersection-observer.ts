/**
 * An IntersectionObserver for happy-dom, which lays nothing out and whose own observer never reports. It computes
 * an intersection as a browser does (the W3C Intersection Observer, "compute the intersection"), from the boxes
 * the test gives the elements through getBoundingClientRect: the target's box is clipped by each ancestor between
 * it and the root whose overflow is not visible, then by the root's box grown by rootMargin, where the window
 * stands in for a missing root. A target that touches the grown box counts as intersecting, as in a browser.
 * `LayoutIntersectionObserver.update()` stands for a frame: every observer reports the targets whose state
 * changed, and a target observed since the last frame always.
 */

interface Box {
  top: number
  right: number
  bottom: number
  left: number
}

const observers = new Set<LayoutIntersectionObserver>()

function boxOf(element: Element): Box {
  const { top, right, bottom, left } = element.getBoundingClientRect()
  return { top, right, bottom, left }
}

/** happy-dom gives an overflow nobody set as '' rather than its initial value, visible. */
const clips = (overflow: string): boolean => overflow !== '' && overflow !== 'visible'

function intersect(a: Box, b: Box): Box | null {
  const box = { top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom), left: Math.max(a.left, b.left) }
  return box.top <= box.bottom && box.left <= box.right ? box : null
}

/** The four sides of a rootMargin written as in CSS, in px or in % of the root's height (top, bottom) and width. */
function grow(box: Box, margin: string): Box {
  const values = margin.trim().split(/\s+/)
  const [top, right = top, bottom = top, left = right] = values
  const height = box.bottom - box.top
  const width = box.right - box.left
  const length = (value: string, of: number): number => (value.endsWith('%') ? (parseFloat(value) / 100) * of : parseFloat(value))
  return {
    top: box.top - length(top, height),
    right: box.right + length(right, width),
    bottom: box.bottom + length(bottom, height),
    left: box.left - length(left, width)
  }
}

export class LayoutIntersectionObserver {
  readonly root: Element | null
  readonly rootMargin: string
  readonly thresholds = [0]
  private readonly targets = new Map<Element, boolean | undefined>()

  constructor(
    private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>, observer: LayoutIntersectionObserver) => void,
    options: { root?: Element | null; rootMargin?: string } = {}
  ) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    observers.add(this)
  }

  observe(target: Element): void {
    if (!this.targets.has(target)) this.targets.set(target, undefined)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
    observers.delete(this)
  }

  takeRecords(): [] {
    return []
  }

  private intersects(target: Element): boolean {
    let box: Box | null = boxOf(target)
    let node = target.parentElement
    for (; box && node && node !== this.root; node = node.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(node)
      if (clips(overflowX) || clips(overflowY)) box = intersect(box, boxOf(node))
    }
    if (!box || node !== this.root) return false
    const root = this.root ? boxOf(this.root) : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
    return intersect(box, grow(root, this.rootMargin)) !== null
  }

  private update(): void {
    const entries: Array<{ target: Element; isIntersecting: boolean }> = []
    for (const [target, before] of this.targets) {
      const isIntersecting = this.intersects(target)
      if (isIntersecting === before) continue
      this.targets.set(target, isIntersecting)
      entries.push({ target, isIntersecting })
    }
    if (entries.length > 0) this.callback(entries, this)
  }

  /** A frame: each observer reports what changed. */
  static update(): void {
    for (const observer of [...observers]) observer.update()
  }

  /** How many elements the observers still watch, which a page or a view that is gone leaves out. */
  static watched(): number {
    return [...observers].reduce((sum, observer) => sum + observer.targets.size, 0)
  }

  /** Forgets every observer, between tests. */
  static reset(): void {
    observers.clear()
  }
}
