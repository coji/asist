import { isExternalLink } from '@shared/external-link'

/**
 * The HTML of a Word document as the page takes it from the preview page. Only the allowed elements and
 * attributes are kept: mammoth's output carries the meaning of the document (headings, paragraphs, lists, tables,
 * emphasis, pictures) and brings no colors or spacing with it. The page does not take the preview page's word for
 * any of it, since that page parses the user's files in a process of its own, and what reaches it from there is
 * treated as the file itself.
 */

/**
 * mammoth writes the bookmarks and notes of the document as ids with this prefix, which keeps them apart
 * from the ids and the global names of the app's own page the document is drawn into.
 */
export const DOCX_ID_PREFIX = 'docx-'

/** The class of a picture's place in the document, a canvas the viewer draws the picture into once it is near. */
export const PICTURE_CLASS = 'fv-doc-picture'

/** The elements that are kept. Any other element is unwrapped and its content kept, while a dropped tag goes with its content. */
const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'sup',
  'sub',
  'br',
  'a',
  'blockquote',
  'pre',
  'code'
])
const DROPPED_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed'])

/**
 * The attributes kept per element. The value is checked as well: href must be a link the app opens or a
 * place in the document, and an id one of the document's own.
 */
const ALLOWED_ATTRS: Record<string, Record<string, (value: string) => boolean>> = {
  a: { href: (value) => isExternalLink(value) || value.startsWith(`#${DOCX_ID_PREFIX}`), id: (value) => value.startsWith(DOCX_ID_PREFIX) },
  li: { id: (value) => value.startsWith(DOCX_ID_PREFIX) },
  td: { colspan: (value) => /^\d+$/.test(value), rowspan: (value) => /^\d+$/.test(value) },
  th: { colspan: (value) => /^\d+$/.test(value), rowspan: (value) => /^\d+$/.test(value) }
}

/**
 * The path inside the zip that a picture's data URL holds: the preview page hands mammoth each picture as a file
 * whose content is its path, and mammoth writes that content as base64. Null for any other source.
 */
function picturePath(src: string | null): string | null {
  const encoded = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src ?? '')?.[1]
  if (!encoded) return null
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
}

function cleanNode(node: Node, out: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(child.textContent ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    const tag = element.tagName.toLowerCase()
    if (DROPPED_TAGS.has(tag)) continue
    if (tag === 'img') {
      const path = picturePath(element.getAttribute('src'))
      if (path === null) continue
      const canvas = document.createElement('canvas')
      canvas.className = PICTURE_CLASS
      canvas.dataset.picture = path
      canvas.setAttribute('role', 'img')
      const alt = element.getAttribute('alt')
      if (alt) canvas.setAttribute('aria-label', alt)
      out.appendChild(canvas)
      continue
    }
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(element, out)
      continue
    }
    const clean = document.createElement(tag)
    const allowed = ALLOWED_ATTRS[tag]
    if (allowed) {
      for (const [name, accept] of Object.entries(allowed)) {
        const value = element.getAttribute(name)
        if (value !== null && accept(value)) clean.setAttribute(name, value)
      }
    }
    // A link the viewer cannot follow, such as javascript:, keeps its text but is not drawn as a link.
    if (tag === 'a' && !clean.hasAttributes()) {
      cleanNode(element, out)
      continue
    }
    cleanNode(element, clean)
    out.appendChild(clean)
  }
}

/**
 * The nodes of the page's own document that a piece of mammoth's HTML stands for, with each picture as an empty
 * canvas that names it. The HTML is parsed in a document of its own, where nothing it holds runs or loads.
 */
export function cleanDocxHtml(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const out = document.createDocumentFragment()
  cleanNode(parsed.body, out)
  return out
}
