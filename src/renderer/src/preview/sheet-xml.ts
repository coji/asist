import { errorKey } from '@shared/i18n/error-key'

/**
 * The parts of an xlsx workbook as the Excel viewer reads them in the preview iframe. A sheet's XML stays as bytes
 * with an index of where each row starts, and only the rows on screen are decoded and parsed; the shared strings
 * stay as bytes in the same way, with an index of where each string starts. The small parts (the workbook, its
 * relationships and the styles) are parsed whole. Element names are matched by their local name, since a writer
 * may give the SpreadsheetML namespace a prefix, as the Open XML SDK's x: does.
 */

type Bytes = Uint8Array<ArrayBuffer>

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const COLON = 0x3a
const EQUALS = 0x3d
const DOUBLE_QUOTE = 0x22
const SINGLE_QUOTE = 0x27
const LETTER_A = 0x41
const LETTER_Z = 0x5a
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

const ascii = (name: string): Uint8Array => new TextEncoder().encode(name)
const SHEET_DATA = ascii('sheetData')
const ROW = ascii('row')
const CELL = ascii('c')
const VALUE = ascii('v')
const INLINE_STRING = ascii('is')
const SHARED_STRINGS = ascii('sst')
const STRING_ITEM = ascii('si')
const R = ascii('r')

const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))

const isSpace = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d

/** Where the name of a tag that starts at `from` ends. */
function nameEnd(xml: Bytes, from: number): number {
  let at = from
  while (at < xml.length) {
    const byte = xml[at]
    if (byte === GT || byte === SLASH || isSpace(byte)) break
    at++
  }
  return at
}

/** Whether the name between from and to is `local`, alone or after a prefix. */
function named(xml: Bytes, from: number, to: number, local: Uint8Array): boolean {
  const start = to - local.length
  if (start < from || (start > from && xml[start - 1] !== COLON)) return false
  for (let i = 0; i < local.length; i++) if (xml[start + i] !== local[i]) return false
  return true
}

/**
 * The value of one attribute of the tag whose name ends at `from`, as where it starts and ends, or null when the
 * tag has none. A value can hold a >, which XML allows unescaped, so the attributes are read one by one.
 */
function attribute(xml: Bytes, from: number, wanted: Uint8Array): [number, number] | null {
  let at = from
  for (;;) {
    while (at < xml.length && isSpace(xml[at])) at++
    if (at >= xml.length) throw damaged()
    if (xml[at] === GT || xml[at] === SLASH) return null
    const nameStart = at
    while (at < xml.length && xml[at] !== EQUALS && !isSpace(xml[at])) at++
    const nameStop = at
    while (at < xml.length && isSpace(xml[at])) at++
    if (xml[at] !== EQUALS) throw damaged()
    at++
    while (at < xml.length && isSpace(xml[at])) at++
    const quote = xml[at]
    if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) throw damaged()
    const valueStart = at + 1
    at = xml.indexOf(quote, valueStart)
    if (at === -1) throw damaged()
    if (nameStop - nameStart === wanted.length && named(xml, nameStart, nameStop, wanted)) return [valueStart, at]
    at++
  }
}

/** A row's number from 0, read from its r attribute, which counts from 1. */
function rowNumber(xml: Bytes, [start, end]: [number, number]): number {
  let number = 0
  for (let at = start; at < end; at++) {
    const byte = xml[at]
    if (byte < DIGIT_0 || byte > DIGIT_9) throw damaged()
    number = number * 10 + byte - DIGIT_0
  }
  if (number < 1) throw damaged()
  return number - 1
}

/** A cell's column from 0, read from the letters of its r attribute. */
function columnNumber(xml: Bytes, [start, end]: [number, number]): number {
  let number = 0
  let at = start
  for (; at < end && xml[at] >= LETTER_A && xml[at] <= LETTER_Z; at++) number = number * 26 + xml[at] - LETTER_A + 1
  if (at === start) throw damaged()
  return number - 1
}

/** The rows and columns between the first and the last cell that holds a value, counted from 0. */
export interface UsedRange {
  firstRow: number
  lastRow: number
  firstColumn: number
  lastColumn: number
}

/** Where each row of a sheet lies in its XML, in the order of their numbers. */
export interface RowIndex {
  /** Each row's number, from 0. */
  numbers: Uint32Array
  /** Where each row's element starts and where the next one, or the end of the sheet's data, starts. */
  starts: Uint32Array
  ends: Uint32Array
  /**
   * The range of the cells with a value. The range a sheet declares in its dimension cannot stand in for it: a
   * 16 KB file can declare A1:XFD1048576.
   */
  used: UsedRange | null
}

/** A growing list of numbers kept in a typed array, so that a million rows cost four bytes each. */
class Numbers {
  values = new Uint32Array(4096)
  length = 0
  push(value: number): void {
    if (this.length === this.values.length) {
      const grown = new Uint32Array(this.values.length * 2)
      grown.set(this.values)
      this.values = grown
    }
    this.values[this.length++] = value
  }
  done(): Uint32Array {
    return this.values.slice(0, this.length)
  }
}

/**
 * Indexes the rows of a worksheet's XML in one pass over its bytes, without decoding them. A row without an r
 * attribute follows the one before it, and so does a cell without one. A cell holds a value when it has a <v>
 * with content or an inline string, as SheetJS counts one.
 */
export function indexRows(xml: Bytes): RowIndex {
  const numbers = new Numbers()
  const starts = new Numbers()
  let inData = false
  let end = -1
  let row = -1
  let column = -1
  let ascending = true
  let used: UsedRange | null = null
  for (let at = xml.indexOf(LT); at !== -1; at = xml.indexOf(LT, at + 1)) {
    if (xml[at + 1] === SLASH) {
      if (inData && named(xml, at + 2, nameEnd(xml, at + 2), SHEET_DATA)) {
        end = at
        break
      }
      continue
    }
    const nameStop = nameEnd(xml, at + 1)
    if (!inData) {
      if (!named(xml, at + 1, nameStop, SHEET_DATA)) continue
      // An empty sheet can write its data as <sheetData/>.
      if (xml[nameStop] === SLASH || xml[xml.indexOf(GT, nameStop) - 1] === SLASH) break
      inData = true
      continue
    }
    if (named(xml, at + 1, nameStop, ROW)) {
      const r = attribute(xml, nameStop, R)
      const next = r ? rowNumber(xml, r) : row + 1
      if (next <= row) ascending = false
      row = next
      column = -1
      numbers.push(row)
      starts.push(at)
    } else if (named(xml, at + 1, nameStop, CELL)) {
      const r = attribute(xml, nameStop, R)
      column = r ? columnNumber(xml, r) : column + 1
    } else if (named(xml, at + 1, nameStop, VALUE) || named(xml, at + 1, nameStop, INLINE_STRING)) {
      // <v/> and <v></v> hold nothing.
      const isValue = named(xml, at + 1, nameStop, VALUE)
      if (isValue && (xml[nameStop] === SLASH || (xml[nameStop] === GT && xml[nameStop + 1] === LT && xml[nameStop + 2] === SLASH))) continue
      if (row < 0 || column < 0) throw damaged()
      if (!used) used = { firstRow: row, lastRow: row, firstColumn: column, lastColumn: column }
      else {
        if (row < used.firstRow) used.firstRow = row
        if (row > used.lastRow) used.lastRow = row
        if (column < used.firstColumn) used.firstColumn = column
        if (column > used.lastColumn) used.lastColumn = column
      }
    }
  }
  if (inData && end === -1) throw damaged()
  const rowNumbers = numbers.done()
  const rowStarts = starts.done()
  const rowEnds = new Uint32Array(rowStarts.length)
  for (let i = 0; i < rowStarts.length; i++) rowEnds[i] = i + 1 < rowStarts.length ? rowStarts[i + 1] : end
  if (ascending) return { numbers: rowNumbers, starts: rowStarts, ends: rowEnds, used }
  // Excel writes the rows in order, and a writer that does not is put in order here, the first of two rows with
  // one number first.
  const order = Array.from(rowNumbers.keys()).sort((a, b) => rowNumbers[a] - rowNumbers[b] || a - b)
  return {
    numbers: Uint32Array.from(order, (i) => rowNumbers[i]),
    starts: Uint32Array.from(order, (i) => rowStarts[i]),
    ends: Uint32Array.from(order, (i) => rowEnds[i]),
    used
  }
}

/** The positions in the index of the rows numbered from `from` up to `to`, which may be fewer: an empty row has no element. */
export function rowsWithin(index: RowIndex, from: number, to: number): { first: number; last: number } {
  let low = 0
  let high = index.numbers.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (index.numbers[middle] < from) low = middle + 1
    else high = middle
  }
  let last = low
  while (last < index.numbers.length && index.numbers[last] < to) last++
  return { first: low, last }
}

/** Where each string of the shared strings part lies in its XML. */
export interface StringIndex {
  starts: Uint32Array
  ends: Uint32Array
}

/** Indexes the <si> items of the shared strings part in one pass over its bytes. */
export function indexStrings(xml: Bytes): StringIndex {
  const starts = new Numbers()
  let inTable = false
  let end = -1
  for (let at = xml.indexOf(LT); at !== -1; at = xml.indexOf(LT, at + 1)) {
    if (xml[at + 1] === SLASH) {
      if (inTable && named(xml, at + 2, nameEnd(xml, at + 2), SHARED_STRINGS)) {
        end = at
        break
      }
      continue
    }
    const nameStop = nameEnd(xml, at + 1)
    if (!inTable) {
      inTable = named(xml, at + 1, nameStop, SHARED_STRINGS)
      continue
    }
    if (named(xml, at + 1, nameStop, STRING_ITEM)) starts.push(at)
  }
  if (!inTable) throw damaged()
  // A table with no strings can be written as <sst/>.
  if (end === -1) end = xml.length
  const itemStarts = starts.done()
  const itemEnds = new Uint32Array(itemStarts.length)
  for (let i = 0; i < itemStarts.length; i++) itemEnds[i] = i + 1 < itemStarts.length ? itemStarts[i + 1] : end
  return { starts: itemStarts, ends: itemEnds }
}

const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([\da-fA-F]+));/g
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
/** The escape OOXML writes a character that XML cannot hold with, such as _x000D_ for a carriage return. */
const OOXML_ESCAPE = /_x([\da-fA-F]{4})_/g

/** The text of XML character data or an attribute value, with its references and OOXML's escapes undone, as SheetJS does. */
export function unescapeXml(text: string): string {
  if (!text.includes('&') && !text.includes('_x')) return text
  return text
    .replace(ENTITY, (_, name: string | undefined, decimal: string | undefined, hex: string | undefined) =>
      name ? NAMED_ENTITIES[name] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex!, 16))
    )
    .replace(OOXML_ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** The attributes of a tag, by their local names. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, name, double, single] of tag.matchAll(ATTRIBUTE)) found.set(name.slice(name.indexOf(':') + 1), unescapeXml(double ?? single))
  return found
}

/** Every start tag of an element of this local name, self-closing or not, as its attributes. */
function tags(xml: string, local: string): Array<Map<string, string>> {
  const tag = new RegExp(`<(?:[\\w.-]+:)?${local}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'g')
  return Array.from(xml.matchAll(tag), ([, inside]) => attributes(inside))
}

/** The content of the first element of this local name, or null. */
function element(xml: string, local: string): string | null {
  const found = new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s(?:[^>"']|"[^"]*"|'[^']*')*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}\\s*>)`).exec(xml)
  return found ? (found[1] ?? '') : null
}

const PHONETIC_RUN = /<(?:[\w.-]+:)?rPh(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>)/g
const TEXT = /<(?:[\w.-]+:)?t(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>)/g

/**
 * The text of a string item, a shared string's <si> or a cell's <is>: its <t>, or the <t> of each of its runs,
 * without the phonetic guides (<rPh>) that Japanese Excel writes beside a name.
 */
export function itemText(xml: string): string {
  let text = ''
  for (const [, part] of xml.replace(PHONETIC_RUN, '').matchAll(TEXT)) text += part ?? ''
  return unescapeXml(text)
}

/** A cell as its XML writes it, before its value is looked up and formatted. */
export interface RawCell {
  column: number
  /** The t attribute: s for a shared string, inlineStr, str, b, e, d, or n (also when it is missing). */
  type: string
  /** The index of its format in the styles' cellXfs, when it names one. */
  style: number | undefined
  /** The content of its <v>, still escaped; undefined when it has none. */
  value: string | undefined
  /** The content of its <is>, for an inline string. */
  inline: string | undefined
}

const CELL_ELEMENT = /<(?:[\w.-]+:)?c(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/g

/** The cells of one row's XML, each in the column its r attribute names or after the cell before it. */
export function parseCells(row: string): RawCell[] {
  const cells: RawCell[] = []
  let column = -1
  for (const [, inside, content = ''] of row.matchAll(CELL_ELEMENT)) {
    const found = attributes(inside)
    const r = found.get('r')
    if (r === undefined) column += 1
    else {
      const letters = /^[A-Z]+/.exec(r)
      if (!letters) throw damaged()
      column = [...letters[0]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
    }
    const style = found.get('s')
    const value = element(content, 'v')
    const inline = element(content, 'is')
    cells.push({
      column,
      type: found.get('t') ?? 'n',
      style: style === undefined ? undefined : Number(style),
      value: value === null || value === '' ? undefined : value,
      inline: inline ?? undefined
    })
  }
  return cells
}

/** The sheets of a workbook in their order, with the relationship that names each one's part, and its date system. */
export function parseWorkbook(xml: string): { sheets: Array<{ name: string; id: string }>; date1904: boolean } {
  const sheets = tags(xml, 'sheet').map((found) => {
    const name = found.get('name')
    const id = found.get('id')
    if (name === undefined || id === undefined) throw damaged()
    return { name, id }
  })
  const date1904 = tags(xml, 'workbookPr').some((found) => ['1', 'true'].includes(found.get('date1904') ?? ''))
  return { sheets, date1904 }
}

/** A part's relationships: what each Id points at and the type of the relationship. */
export function parseRelationships(xml: string): Array<{ id: string; type: string; target: string }> {
  return tags(xml, 'Relationship').flatMap((found) => {
    const id = found.get('Id')
    const type = found.get('Type')
    const target = found.get('Target')
    // A link to something outside the package, such as a hyperlink's web page, names no part.
    if (id === undefined || type === undefined || target === undefined || found.get('TargetMode') === 'External') return []
    return [{ id, type, target }]
  })
}

/**
 * A relationship's target as the name of a part in the zip, from the folder of the part that holds the
 * relationship. Part names inside a zip are URIs, written with / on every OS, so they are joined as such.
 */
export function resolvePart(folder: string, target: string): string {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/** The folder of a part and the name of the part that holds its relationships. */
export function relationshipsOf(part: string): { folder: string; relationships: string } {
  const slash = part.lastIndexOf('/')
  const folder = part.slice(0, slash + 1)
  return { folder, relationships: `${folder}_rels/${part.slice(slash + 1)}.rels` }
}

/** The number formats of a workbook: those it defines by id, and the format id of each cell format, by index. */
export interface Styles {
  formats: Record<number, string>
  cellFormats: number[]
}

export function parseStyles(xml: string): Styles {
  const formats: Record<number, string> = {}
  for (const found of tags(element(xml, 'numFmts') ?? '', 'numFmt')) {
    const id = Number(found.get('numFmtId'))
    const code = found.get('formatCode')
    if (Number.isInteger(id) && code !== undefined) formats[id] = code
  }
  const cellFormats = tags(element(xml, 'cellXfs') ?? '', 'xf').map((found) => Number(found.get('numFmtId') ?? 0))
  return { formats, cellFormats }
}
