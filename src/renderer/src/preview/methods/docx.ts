import '../set-immediate'
import mammoth from 'mammoth/mammoth.browser.js'
import { errorKey } from '@shared/i18n/error-key'
import { DOCX_ID_PREFIX } from '@/panels/viewers/docx-html'
import type { PreviewDocument } from '../serve'
import { openZip, type RangedZip } from '../zip-ranges'

/**
 * Word (docx) in the preview page. mammoth turns the document into HTML here, on a copy of the zip in which every
 * file but the XML parts is replaced by its own path (zip-ranges' slimmed zip): mammoth meets each picture as a
 * reference, which it writes into the HTML as a data URL of the path, and the viewer asks for the picture once it
 * comes within a screen of the view. A card shows the head, the first blocks of the body; the focus view shows the
 * head first and then the whole document, which it mounts a piece at a time.
 *
 * mammoth reads the zip with the JSZip it bundles, which hands data on 16 KB at a time and waits for a
 * setTimeout(0) between two steps where it finds no setImmediate; Chromium holds such a nested timeout for at
 * least 4 ms. With its photos, a 300-page report with 100 photos (61 MB) takes 8,498 of these steps and 24 s to
 * convert, and 3.2 s with a setImmediate defined (headless Chrome on an M5, 2026-10-02). The page has one
 * (set-immediate.ts), and without its pictures the same report is 1.1 MB of XML, which converts in about 0.1 s.
 */

type Bytes = Uint8Array<ArrayBuffer>

/** The parts mammoth reads are XML; everything else, pictures, fonts and embedded files among them, is replaced by its path. */
const XML_PART = /\.(?:xml|rels)$/i

/**
 * The most XML a document may declare, its parts together, before the viewer says it is too large to show here
 * rather than read any of it. A 300-page report holds 1.1 MB, so this stops only a file far beyond anything
 * written by hand. Every part is inflated to no more than its declared size and handed to mammoth stored, since
 * mammoth's JSZip inflates without comparing what it gets with the size the zip declares.
 */
const MAX_XML_BYTES = 128 * 1024 * 1024

/** How many blocks of the body the head holds: paragraphs, tables, and content controls such as a table of contents. */
const HEAD_BLOCKS = 40

/** How much HTML a piece of the whole document holds, about what the focus view mounts in one frame. */
const PIECE_CHARS = 48_000

const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

export interface DocxHead {
  /** mammoth's HTML of the first HEAD_BLOCKS blocks of the body. */
  html: string
  /** Whether the body goes on past them. */
  more: boolean
}

export interface DocxPicture {
  /** The picture, no wider than the width it was asked for. */
  bitmap: ImageBitmap
  /** The picture's own size, which the document gives it unless the column is narrower. */
  width: number
  height: number
}

function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | null = null
  return () => (made ??= make())
}

/**
 * The main part, found as mammoth finds it: the first target of the package's officeDocument relationship that
 * exists, or word/document.xml.
 */
function mainPart(parts: ReadonlyMap<string, Bytes>): string {
  const rels = parts.get('_rels/.rels')
  const relationships = rels ? [...new DOMParser().parseFromString(new TextDecoder().decode(rels), 'application/xml').getElementsByTagName('Relationship')] : []
  const targets = relationships.filter((rel) => rel.getAttribute('Type') === OFFICE_DOCUMENT).map((rel) => (rel.getAttribute('Target') ?? '').replace(/^\//, ''))
  return targets.find((target) => parts.has(target)) ?? 'word/document.xml'
}

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const QUESTION = 0x3f
const BANG = 0x21
const DASH = 0x2d
const BRACKET = 0x5b
const QUOTE = 0x22
const APOSTROPHE = 0x27

/** Where `marker` next ends at or after `from`, or -1. */
function endOf(xml: Bytes, from: number, marker: string): number {
  const first = marker.charCodeAt(0)
  for (let at = xml.indexOf(first, from); at !== -1; at = xml.indexOf(first, at + 1)) {
    let i = 1
    while (i < marker.length && xml[at + i] === marker.charCodeAt(i)) i++
    if (i === marker.length) return at + marker.length
  }
  return -1
}

/** Where a start tag that begins at `at` ends, past a `>` inside a quoted attribute value. */
function startTagEnd(xml: Bytes, at: number): number {
  let quote = 0
  for (let i = at + 1; i < xml.length; i++) {
    const byte = xml[i]
    if (quote !== 0) {
      if (byte === quote) quote = 0
    } else if (byte === QUOTE || byte === APOSTROPHE) quote = byte
    else if (byte === GT) return i + 1
  }
  return -1
}

/** The qualified name of the tag that begins at `at`, a `/` of an end tag left out. Names in Office XML are ASCII. */
function nameAt(xml: Bytes, at: number): string {
  let start = at + 1
  if (xml[start] === SLASH) start++
  let end = start
  while (end < xml.length && xml[end] > 0x20 && xml[end] !== SLASH && xml[end] !== GT) end++
  return String.fromCharCode(...xml.subarray(start, end))
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/**
 * The main part cut after `blocks` children of its body, closed again, or null when the body has no more than that.
 * It reads the tags of the bytes as they come, up to the first block it leaves out, rather than parsing the whole
 * part. The section properties that end a body are not a block. A part it cannot read is left to mammoth whole.
 */
function cutBody(xml: Bytes, blocks: number): Bytes | null {
  // The qualified names of the open elements, the document's first and its body's second.
  const open: string[] = []
  let depth = 0
  let counted = 0
  let cutAt = -1
  const inBody = (): boolean => depth === 2 && localName(open[1]) === 'body'
  const isBlock = (name: string): boolean => localName(name) !== 'sectPr'
  for (let at = xml.indexOf(LT); at !== -1; ) {
    const next = xml[at + 1]
    let end: number
    if (next === QUESTION || next === BANG) {
      end = endOf(xml, at, next === QUESTION ? '?>' : xml[at + 2] === DASH ? '-->' : xml[at + 2] === BRACKET ? ']]>' : '>')
    } else if (next === SLASH) {
      end = endOf(xml, at, '>')
      depth--
      if (depth === 1 && localName(open[1]) === 'body') return null
      if (inBody() && isBlock(open[2]) && ++counted === blocks) cutAt = end
    } else {
      end = startTagEnd(xml, at)
      if (end === -1) return null
      const name = nameAt(xml, at)
      const block = inBody() && isBlock(name)
      if (block && cutAt !== -1) {
        const closing = new TextEncoder().encode(`</${open[1]}></${open[0]}>`)
        const cut = new Uint8Array(cutAt + closing.length)
        cut.set(xml.subarray(0, cutAt))
        cut.set(closing, cutAt)
        return cut
      }
      if (xml[end - 2] === SLASH) {
        if (block && ++counted === blocks) cutAt = end
      } else {
        open[depth] = name
        depth++
      }
    }
    if (end === -1) return null
    at = xml.indexOf(LT, end)
  }
  return null
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** mammoth's HTML cut between its top-level elements into pieces of about PIECE_CHARS characters. */
function piecesOf(html: string): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const node of new DOMParser().parseFromString(html, 'text/html').body.childNodes) {
    piece += node instanceof Element ? node.outerHTML : escapeText(node.textContent ?? '')
    if (piece.length < PIECE_CHARS) continue
    pieces.push(piece)
    piece = ''
  }
  if (piece !== '') pieces.push(piece)
  return pieces
}

/**
 * Decodes a picture and scales it down to `width` pixels when it is wider, so that the page that draws it holds no
 * more than it shows.
 */
async function picture(zip: RangedZip, { path, width }: { path: string; width: number }): Promise<DocxPicture> {
  const decoded = await createImageBitmap(new Blob([await zip.read(path)]), { imageOrientation: 'from-image' })
  const size = { width: decoded.width, height: decoded.height }
  if (size.width <= width) return { bitmap: decoded, ...size }
  const height = Math.max(1, Math.round((size.height * width) / size.width))
  const bitmap = await createImageBitmap(decoded, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  decoded.close()
  return { bitmap, ...size }
}

export default async function openDocx(url: string) {
  const zip = await openZip(url)
  const parts = [...zip.entries.values()].filter(({ name }) => XML_PART.test(name))
  if (parts.reduce((sum, { size }) => sum + size, 0) > MAX_XML_BYTES) throw new Error(errorKey('files.viewer.tooLarge'))
  const names = new Set(parts.map(({ name }) => name))
  const read = once(async () => new Map(await Promise.all(parts.map(async ({ name }) => [name, await zip.read(name)] as const))))
  const convert = async (contents: ReadonlyMap<string, Bytes>): Promise<string> => {
    const slim = await zip.slimmed((name) => !names.has(name), contents)
    return (await mammoth.convertToHtml({ arrayBuffer: slim.buffer }, { idPrefix: DOCX_ID_PREFIX })).value
  }
  const head = once(async (): Promise<DocxHead> => {
    const contents = await read()
    const main = mainPart(contents)
    const xml = contents.get(main)
    const cut = xml && cutBody(xml, HEAD_BLOCKS)
    if (!cut) return { html: await convert(contents), more: false }
    return { html: await convert(new Map(contents).set(main, cut)), more: true }
  })
  const whole = once(async () => piecesOf(await convert(await read())))
  return {
    methods: {
      head: () => head(),
      /** The whole document as pieces of HTML, in order. */
      whole: () => whole(),
      picture: (args: { path: string; width: number }) => picture(zip, args)
    }
  } satisfies PreviewDocument
}
