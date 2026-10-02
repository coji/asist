import JSZip from 'jszip'
import { vi } from 'vitest'

/**
 * Excel workbooks written part by part for the tests of the Excel viewer, and a fetch that serves a file by ranges
 * as asist-file does: a 206 with the bytes of the range and a Content-Range that gives the file's length, a suffix
 * range for the last bytes, and the whole file for a request without a range.
 */

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export interface SheetSpec {
  name: string
  /** The content of <sheetData>, or a whole worksheet part when it starts with <?xml. */
  data: string
}

/** A worksheet part around the rows, as Excel writes one, with a dimension that claims the whole grid. */
export const worksheet = (data: string): string =>
  `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="A1:XFD1048576"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${data}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`

/**
 * A workbook of the sheets in their order. `strings` are the items of the shared strings, each the content of an
 * <si>; `styles` the content of the styles part. The sheets are written first and stored, so that each one's rows
 * lie in the file as they were written, and the other parts after them, deflated unless `store` asks for every
 * part to be stored.
 */
export async function workbookOf({ sheets, strings, styles, store = false }: { sheets: SheetSpec[]; strings?: string[]; styles?: string; store?: boolean }): Promise<Uint8Array> {
  const zip = new JSZip()
  const options = { createFolders: false, ...(store ? { compression: 'STORE' as const } : {}) }
  sheets.forEach(({ data }, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, data.startsWith('<?xml') ? data : worksheet(data), { ...options, compression: 'STORE' }))
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`, options)
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`, options)
  zip.file(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr/><sheets>${sheets.map(({ name }, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    options
  )
  const relationships = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
  if (styles !== undefined) relationships.push(`<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`)
  if (strings !== undefined) relationships.push(`<Relationship Id="rIdStrings" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/>`)
  zip.file('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`, options)
  if (styles !== undefined) zip.file('xl/styles.xml', `${XML}<styleSheet xmlns="${NS}">${styles}</styleSheet>`, options)
  if (strings !== undefined) {
    zip.file('xl/sharedStrings.xml', `${XML}<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((item) => `<si>${item}</si>`).join('')}</sst>`, options)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** Gives the size the central directory declares for an entry of a zip without a comment, as a huge sheet would declare it. */
export function declareSize(file: Uint8Array, name: string, size: number): Uint8Array {
  const out = file.slice()
  const view = new DataView(out.buffer)
  const decoder = new TextDecoder()
  for (let at = view.getUint32(out.length - 22 + 16, true); at < out.length - 22; ) {
    const nameLength = view.getUint16(at + 28, true)
    if (decoder.decode(out.subarray(at + 46, at + 46 + nameLength)) === name) {
      view.setUint32(at + 24, size, true)
      return out
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  throw new Error(`no ${name} in the zip`)
}

/** Serves the file to fetch by ranges and keeps the first and last byte of every range it sent. */
export function serveByRanges(file: Uint8Array): { ranges: Array<[number, number]> } {
  const served = { ranges: [] as Array<[number, number]> }
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')
    if (!range) {
      served.ranges.push([0, file.length - 1])
      return new Response(file.slice(), { status: 200 })
    }
    const start = range[1] === '' ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = range[1] === '' || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    served.ranges.push([start, end])
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
  return served
}

/** Where a text first lies in a file, which a stored entry writes as it is. */
export function offsetOf(file: Uint8Array, text: string): number {
  const at = Buffer.from(file).indexOf(Buffer.from(text))
  if (at === -1) throw new Error(`${text} is not in the file`)
  return at
}
