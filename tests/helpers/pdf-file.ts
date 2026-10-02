/**
 * PDFs for the tests of the PDF viewer, with a page tree balanced with eight pages under each node, as Chrome's
 * "Save as PDF" writes one: each page's content stream and picture in page order, then the page tree, the font and
 * the catalog, and a cross-reference table at the end. A page is A4 with lines of text in a standard font, and a
 * picture on every `pictureEvery`-th page, starting with page 1, 515 pt wide from 40 pt in and 300 pt up, as raw
 * RGB that no decoder has to read unless the picture says otherwise.
 */

export interface PdfPicture {
  width: number
  height: number
  /** The entries of the image's dictionary besides its size, and the bytes of its stream: raw RGB when not given. */
  stream?: { entries: string; bytes: Uint8Array }
}

export interface PdfLayout {
  pages: number
  /** About how many bytes of text each page's content stream holds. */
  textBytes: number
  pictureEvery?: number
  picture?: PdfPicture
}

/** The pages under each node of the page tree, as Skia writes it. */
const FAN_OUT = 8
const A4 = '[0 0 595 842]'

const encoder = new TextEncoder()

/** Bytes that differ from page to page, so that nothing in the file repeats where a reader could share it. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed * 2654435761 + 1
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[i] = state >>> 24
  }
  return out
}

function textOf(page: number, bytes: number): string {
  const lines = [`BT /F1 10 Tf 40 800 Td 12 TL (Page ${page}) Tj`]
  let length = lines[0].length
  for (let line = 0; length < bytes; line++) {
    const text = `(${'The quarterly figures for line ' + line + ' of page ' + page + ' are within the plan.'}) '`
    lines.push(text)
    length += text.length + 1
  }
  lines.push('ET')
  return lines.join('\n')
}

export function writePdf({ pages, textBytes, pictureEvery = 0, picture = { width: 64, height: 64 } }: PdfLayout): Uint8Array {
  // Object numbers: 1 the catalog, 2 the font, then three for each page (its content, its picture, itself), then
  // the nodes of the page tree from the leaves up.
  const catalog = 1
  const font = 2
  const contentOf = (index: number): number => 3 + index * 3
  const pictureOf = (index: number): number => 4 + index * 3
  const pageOf = (index: number): number => 5 + index * 3
  let next = 3 + pages * 3
  const levels: Array<Array<{ number: number; kids: number[]; count: number }>> = []
  let below = Array.from({ length: pages }, (_, index) => ({ number: pageOf(index), count: 1 }))
  do {
    const level: Array<{ number: number; kids: number[]; count: number }> = []
    for (let i = 0; i < below.length; i += FAN_OUT) {
      const kids = below.slice(i, i + FAN_OUT)
      level.push({ number: next++, kids: kids.map((kid) => kid.number), count: kids.reduce((sum, kid) => sum + kid.count, 0) })
    }
    levels.push(level)
    below = level
  } while (below.length > 1)
  const root = below[0].number
  const parentOf = new Map<number, number>()
  for (const level of levels) for (const node of level) for (const kid of node.kids) parentOf.set(kid, node.number)

  const chunks: Uint8Array[] = []
  const offsets = new Map<number, number>()
  let length = 0
  const write = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (number: number, body: string): void => {
    offsets.set(number, length)
    write(`${number} 0 obj\n${body}\nendobj\n`)
  }
  const stream = (number: number, dictionary: string, bytes: Uint8Array): void => {
    offsets.set(number, length)
    write(`${number} 0 obj\n<< ${dictionary} /Length ${bytes.length} >>\nstream\n`)
    write(bytes)
    write('\nendstream\nendobj\n')
  }

  write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  for (let index = 0; index < pages; index++) {
    const withPicture = pictureEvery > 0 && index % pictureEvery === 0
    let content = textOf(index + 1, textBytes)
    if (withPicture) content = `q 515 0 0 ${Math.round((515 * picture.height) / picture.width)} 40 300 cm /Im1 Do Q\n${content}`
    stream(contentOf(index), '', encoder.encode(content))
    if (withPicture) {
      const { entries, bytes } = picture.stream ?? { entries: '/ColorSpace /DeviceRGB /BitsPerComponent 8', bytes: noise(picture.width * picture.height * 3, index) }
      stream(pictureOf(index), `/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} ${entries}`, bytes)
    }
    const xobjects = withPicture ? ` /XObject << /Im1 ${pictureOf(index)} 0 R >>` : ''
    object(
      pageOf(index),
      `<< /Type /Page /Parent ${parentOf.get(pageOf(index))} 0 R /MediaBox ${A4} /Resources << /Font << /F1 ${font} 0 R >>${xobjects} >> /Contents ${contentOf(index)} 0 R >>`
    )
  }
  for (const level of levels) {
    for (const node of level) {
      const parent = parentOf.get(node.number)
      object(node.number, `<< /Type /Pages${parent ? ` /Parent ${parent} 0 R` : ''} /Kids [${node.kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${node.count} >>`)
    }
  }
  object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  object(catalog, `<< /Type /Catalog /Pages ${root} 0 R >>`)

  // A number with no object, such as the picture of a page without one, is listed as free.
  const xref = length
  const entries = ['0000000000 65535 f ']
  for (let number = 1; number < next; number++) {
    const offset = offsets.get(number)
    entries.push(offset === undefined ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `)
  }
  write(`xref\n0 ${next}\n${entries.join('\n')}\ntrailer\n<< /Size ${next} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const file = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    file.set(chunk, at)
    at += chunk.length
  }
  return file
}
