import { errorKey } from '@shared/i18n/error-key'

/**
 * Turns a pptx into the form needed to draw it: the shapes of each slide and where they sit. There is no good
 * library for this, so the XML inside the zip is read here.
 * - The order of the slides comes from sldIdLst in ppt/presentation.xml and its rels, not from the numbers
 *   in the file names.
 * - A shape's position is a:xfrm in EMU divided by the slide size, a share between 0 and 1, which the
 *   drawing side places as a percentage.
 * - A placeholder without an xfrm inherits its position from the same placeholder in the layout, and then
 *   from the master.
 * - Font sizes are in pt. Where a size is missing, the default for that kind of placeholder is used, which
 *   is the typical value found in the master's txStyles.
 * A shape inside a group (p:grpSp) is read as it is, without the group's transform applied.
 */
const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main'
} as const

export interface PptxFrame {
  x: number
  y: number
  w: number
  h: number
}
export interface PptxParagraph {
  text: string
  level: number
  bullet: boolean
  sizePt: number
  bold: boolean
}
export type PptxShape =
  | { kind: 'text'; frame: PptxFrame | null; placeholder: string | null; paragraphs: PptxParagraph[] }
  | { kind: 'picture'; frame: PptxFrame | null; target: string }
export interface PptxSize {
  cx: number
  cy: number
}

const TITLE_TYPES = new Set(['title', 'ctrTitle'])
/** The size in pt used where none is given, following Office's default master: 44 for a title, 28/24/20 for body levels, 18 otherwise. */
const DEFAULT_SIZE_PT = { title: 44, subTitle: 24, body: [28, 24, 20, 18, 18], other: 18 } as const

const parseXml = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error) throw new Error(errorKey('files.errors.xmlUnreadable', { detail: error.textContent?.slice(0, 80) ?? '' }))
  return doc
}
const childrenNS = (el: Element, ns: string, name: string): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === ns)
const firstNS = (el: Element, ns: string, name: string): Element | undefined => childrenNS(el, ns, name)[0]
/**
 * Collects descendants by namespace and name. getElementsByTagNameNS does not work in happy-dom, so the tree
 * is walked on localName and namespaceURI instead. A null ns ignores the namespace, which rels need: they use
 * the default namespace and happy-dom does not carry it into namespaceURI.
 */
function findAll(el: Element | Document, ns: string | null, name: string): Element[] {
  const found: Element[] = []
  const walk = (node: Element | Document): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue
      const element = child as Element
      if (element.localName === name && (ns === null || element.namespaceURI === ns)) found.push(element)
      walk(element)
    }
  }
  walk(el)
  return found
}
const descendantNS = (el: Element | Document, ns: string, name: string): Element | undefined => findAll(el, ns, name)[0]

/** Maps each Id in a rels file to its Target, left as the relative path. */
export function parseRels(xml: string): Map<string, string> {
  const doc = parseXml(xml)
  const map = new Map<string, string>()
  for (const rel of findAll(doc, null, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) map.set(id, target)
  }
  return map
}

/** Turns a relative path into a path inside the zip: ../media/image1.png from ppt/slides becomes ppt/media/image1.png. */
export function resolveTarget(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

export function parsePresentation(xml: string): { size: PptxSize; slideRelIds: string[] } {
  const doc = parseXml(xml)
  const sldSz = descendantNS(doc, NS.p, 'sldSz')
  const cx = Number(sldSz?.getAttribute('cx'))
  const cy = Number(sldSz?.getAttribute('cy'))
  if (!(cx > 0 && cy > 0)) throw new Error(errorKey('files.errors.slideSizeMissing'))
  // A sldId carries both id and r:id, and happy-dom collapses attributes that share a localName and drops
  // r:id. Only the order is needed here, so these elements are picked out of the raw string; Office always
  // writes the prefixes p and r.
  const slideRelIds = Array.from(xml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g), (match) => match[1])
  return { size: { cx, cy }, slideRelIds }
}

function frameOf(spPr: Element | undefined, size: PptxSize): PptxFrame | null {
  const xfrm = spPr && firstNS(spPr, NS.a, 'xfrm')
  const off = xfrm && firstNS(xfrm, NS.a, 'off')
  const ext = xfrm && firstNS(xfrm, NS.a, 'ext')
  if (!off || !ext) return null
  return {
    x: Number(off.getAttribute('x')) / size.cx,
    y: Number(off.getAttribute('y')) / size.cy,
    w: Number(ext.getAttribute('cx')) / size.cx,
    h: Number(ext.getAttribute('cy')) / size.cy
  }
}

interface Placeholder {
  type: string | null
  idx: string | null
}
const placeholderOf = (sp: Element): Placeholder | null => {
  const ph = descendantNS(sp, NS.p, 'ph')
  if (!ph) return null
  return { type: ph.getAttribute('type'), idx: ph.getAttribute('idx') }
}

/** The placeholder positions of a layout or a master, which can be looked up by idx as well as by type. */
export function placeholderFrames(xml: string, size: PptxSize): Map<string, PptxFrame> {
  const doc = parseXml(xml)
  const frames = new Map<string, PptxFrame>()
  for (const sp of findAll(doc, NS.p, 'sp')) {
    const ph = placeholderOf(sp)
    const frame = frameOf(firstNS(sp, NS.p, 'spPr'), size)
    if (!ph || !frame) continue
    if (ph.idx !== null && !frames.has(`idx:${ph.idx}`)) frames.set(`idx:${ph.idx}`, frame)
    const type = ph.type ?? 'body'
    if (!frames.has(`type:${type}`)) frames.set(`type:${type}`, frame)
  }
  return frames
}

function inheritedFrame(ph: Placeholder, inherited: readonly Map<string, PptxFrame>[]): PptxFrame | null {
  const keys = [
    ...(ph.idx !== null ? [`idx:${ph.idx}`] : []),
    `type:${ph.type ?? 'body'}`,
    ...(ph.type === 'ctrTitle' ? ['type:title'] : []),
    ...(ph.type === 'subTitle' ? ['type:body'] : [])
  ]
  for (const frames of inherited) {
    for (const key of keys) {
      const frame = frames.get(key)
      if (frame) return frame
    }
  }
  return null
}

function paragraphsOf(txBody: Element, ph: Placeholder | null): PptxParagraph[] {
  const isTitle = ph !== null && TITLE_TYPES.has(ph.type ?? '')
  const isBody = ph !== null && !isTitle && ph.type !== 'subTitle'
  return childrenNS(txBody, NS.a, 'p').map((p) => {
    const pPr = firstNS(p, NS.a, 'pPr')
    const level = Number(pPr?.getAttribute('lvl') ?? 0)
    const bullet = pPr && (firstNS(pPr, NS.a, 'buChar') || firstNS(pPr, NS.a, 'buAutoNum')) ? true : pPr && firstNS(pPr, NS.a, 'buNone') ? false : isBody
    const runs = Array.from(p.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === NS.a)
    let text = ''
    let sizePt = 0
    let bold = false
    for (const run of runs) {
      if (run.localName === 'br') {
        text += '\n'
        continue
      }
      if (run.localName !== 'r' && run.localName !== 'fld') continue
      text += firstNS(run, NS.a, 't')?.textContent ?? ''
      const rPr = firstNS(run, NS.a, 'rPr')
      if (!sizePt && rPr?.getAttribute('sz')) sizePt = Number(rPr.getAttribute('sz')) / 100
      if (rPr?.getAttribute('b') === '1') bold = true
    }
    if (!sizePt) {
      sizePt = isTitle ? DEFAULT_SIZE_PT.title : ph?.type === 'subTitle' ? DEFAULT_SIZE_PT.subTitle : isBody ? DEFAULT_SIZE_PT.body[Math.min(level, 4)] : DEFAULT_SIZE_PT.other
    }
    return { text, level, bullet, sizePt, bold: bold || isTitle }
  })
}

/**
 * The shapes of one slide. rels maps r:embed to the path of an image, and inherited holds the placeholder
 * positions of the layout and the master, where the earlier entry wins. The shapes keep the order of the
 * spTree, and a text shape with no text is dropped.
 */
export function parseSlide(xml: string, size: PptxSize, rels: Map<string, string>, inherited: readonly Map<string, PptxFrame>[] = []): PptxShape[] {
  const doc = parseXml(xml)
  const shapes: PptxShape[] = []
  const walk = (tree: Element): void => {
    for (const el of Array.from(tree.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === NS.p)) {
      if (el.localName === 'grpSp') {
        walk(el)
      } else if (el.localName === 'sp') {
        const ph = placeholderOf(el)
        const txBody = firstNS(el, NS.p, 'txBody')
        const paragraphs = txBody ? paragraphsOf(txBody, ph) : []
        if (!paragraphs.some((para) => para.text.trim())) continue
        const frame = frameOf(firstNS(el, NS.p, 'spPr'), size) ?? (ph ? inheritedFrame(ph, inherited) : null)
        shapes.push({ kind: 'text', frame, placeholder: ph?.type ?? (ph ? 'body' : null), paragraphs })
      } else if (el.localName === 'pic') {
        const blip = descendantNS(el, NS.a, 'blip')
        const embed = blip?.getAttribute('r:embed')
        const target = embed ? rels.get(embed) : undefined
        if (!target) continue
        shapes.push({ kind: 'picture', frame: frameOf(firstNS(el, NS.p, 'spPr'), size), target })
      }
    }
  }
  const spTree = descendantNS(doc, NS.p, 'spTree')
  if (spTree) walk(spTree)
  return shapes
}
