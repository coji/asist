import * as XLSX from 'xlsx/dist/xlsx.mini.min.js'
import { errorKey } from '@shared/i18n/error-key'
import type { OpenPreviewDocument } from '../serve'
import {
  indexRows,
  indexStrings,
  itemText,
  parseCells,
  parseRelationships,
  parseStyles,
  parseWorkbook,
  relationshipsOf,
  resolvePart,
  rowsWithin,
  unescapeXml,
  type RawCell,
  type RowIndex,
  type StringIndex
} from '../sheet-xml'
import { openZip, type RangedZip } from '../zip-ranges'

/**
 * An Excel workbook (xlsx, xlsm) in the preview iframe. It reads the workbook, its relationships, the styles, the
 * shared strings and the sheet the viewer shows through the zip reader by ranges, and no other sheet. The sheet's
 * XML is kept as bytes with an index of where each row starts (sheet-xml.ts), and each request parses only the rows
 * it asks for; switching to another sheet lets go of the one before. On the 50,000-row sheet of the viewer budget
 * scene (19 MB of XML) the iframe held 21 MB for the sheet, its bytes and their index, where SheetJS's parsed sheet
 * held 40 MB in its dense form and the first rows took four times as long to show (headless Chrome on an Apple M5,
 * 2026-10-02).
 */

type Bytes = Uint8Array<ArrayBuffer>

/** A cell as the viewer draws it: the text Excel's number format gives it, and whether it is a number. */
export interface SheetCell {
  text: string
  numeric: boolean
}

/**
 * A sheet as the viewer lays it out: the first row with a value is the header, and the rows below it down to the
 * last with a value are counted, each from the first column with a value. A sheet whose XML or shared strings are
 * over PART_LIMIT is not read and is reported as too large.
 */
export type SheetSummary = { shows: 'rows'; header: string[]; rowCount: number; columnCount: number } | { shows: 'tooLarge' }

/**
 * The largest part of a workbook that is read, by the size the zip's directory gives before any of it is read: far
 * beyond a real sheet, of which 50,000 rows of sales records are 18 MB of XML, and still within what the iframe can
 * hold while it indexes it.
 */
export const PART_LIMIT = 256 * 1024 * 1024

/**
 * The columns a row carries, from the first with a value. The focus view scrolls sideways as well as down, so
 * this is how far it is worth scrolling rather than what fits: the focus frame is 850px wide at window size l and
 * the demo sheet's columns are 136 to 200px (measured 2026-09-26), so 50 columns are about eight frames across.
 */
export const SHOWN_COLUMNS = 50

const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))

/** SheetJS's number formatter, which its types leave as any. */
const SSF: {
  format(format: number, value: number, options: { table: Record<number, string>; date1904: boolean }): string
  get_table(): Record<number, string>
} = XLSX.SSF

/** The relationship types end in the same name in the transitional and the strict schema. */
const isType = (type: string, name: string): boolean => type.endsWith(`/${name}`)

interface LoadedSheet {
  xml: Bytes
  index: RowIndex
}

interface SharedStrings {
  xml: Bytes
  index: StringIndex
}

const decoder = new TextDecoder()

/** Whether a part is over PART_LIMIT. A part the zip does not have is not, and reading it says it is missing. */
const tooLarge = (zip: RangedZip, part: string): boolean => (zip.entries.get(part)?.size ?? 0) > PART_LIMIT

async function readText(zip: RangedZip, part: string): Promise<string> {
  if (tooLarge(zip, part)) throw new Error(errorKey('files.viewer.tooLarge'))
  return decoder.decode(await zip.read(part))
}

/**
 * An ISO 8601 date, which a cell of type d holds, as an Excel date serial in the workbook's date system. A date
 * without a zone is the time on the sheet's clock, as Excel writes it, so it is counted as UTC. As in Excel and
 * SheetJS, a day before 1 March 1900 counts the 29 February 1900 that never was.
 */
function dateSerial(iso: string, date1904: boolean): number {
  const time = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(iso) || !iso.includes('T') ? iso : `${iso}Z`)
  if (Number.isNaN(time)) throw damaged()
  const days = (time - Date.UTC(1899, 11, 30)) / 86_400_000
  if (date1904) return days - 1462
  return days < 61 ? days - 1 : days
}

const openXlsx = async (url: string) => {
  const zip = await openZip(url)
  const packageRelationships = parseRelationships(await readText(zip, '_rels/.rels'))
  const officeDocument = packageRelationships.find(({ type }) => isType(type, 'officeDocument'))
  if (!officeDocument) throw damaged()
  const workbookPart = resolvePart('', officeDocument.target)
  const { folder, relationships } = relationshipsOf(workbookPart)
  const [workbook, workbookRelationships] = await Promise.all([readText(zip, workbookPart).then(parseWorkbook), readText(zip, relationships).then(parseRelationships)])
  const partOf = (type: string): string | null => {
    const found = workbookRelationships.find((relationship) => isType(relationship.type, type))
    return found ? resolvePart(folder, found.target) : null
  }
  const sheetParts = workbook.sheets.map(({ id }) => {
    const found = workbookRelationships.find((relationship) => relationship.id === id)
    if (!found) throw damaged()
    return resolvePart(folder, found.target)
  })
  const stringsPart = partOf('sharedStrings')
  const stylesPart = partOf('styles')
  const styles = stylesPart ? parseStyles(await readText(zip, stylesPart)) : { formats: {}, cellFormats: [] }
  // The format codes SSF looks an id up in: Excel's built-in ones and this workbook's own, kept per workbook
  // rather than loaded into SSF's table, which every workbook open in the iframe shares.
  const formatTable = { ...SSF.get_table(), ...styles.formats }

  let strings: Promise<SharedStrings | null> | null = null
  /** The shared strings, read and indexed once, or null for a workbook that has none. */
  function sharedStrings(): Promise<SharedStrings | null> {
    if (strings) return strings
    const reading = stringsPart ? zip.read(stringsPart).then((xml) => ({ xml, index: indexStrings(xml) })) : Promise.resolve(null)
    strings = reading
    // Strings that failed to load are not kept, so that the next request reads them again.
    reading.catch(() => {
      if (strings === reading) strings = null
    })
    return reading
  }
  let current: { sheet: number; loading: Promise<LoadedSheet | null> } | null = null

  /** The sheet, read and indexed once while it is the one shown, or null when it is too large to read. */
  function load(sheet: number): Promise<LoadedSheet | null> {
    if (current?.sheet === sheet) return current.loading
    const part = sheetParts[sheet]
    if (part === undefined) throw new Error(`the workbook has no sheet ${sheet}`)
    const loading =
      tooLarge(zip, part) || (stringsPart !== null && tooLarge(zip, stringsPart))
        ? Promise.resolve(null)
        : Promise.all([zip.read(part), sharedStrings()]).then(([xml]) => ({ xml, index: indexRows(xml) }))
    current = { sheet, loading }
    // A sheet that failed to load is not kept, so that the next request reads it again.
    loading.catch(() => {
      if (current?.loading === loading) current = null
    })
    return loading
  }

  function sharedString(table: SharedStrings | null, value: string): string {
    const position = Number(value)
    if (!table || !Number.isInteger(position) || position < 0 || position >= table.index.starts.length) throw damaged()
    return itemText(decoder.decode(table.xml.subarray(table.index.starts[position], table.index.ends[position])))
  }

  function formatNumber(value: number, style: number | undefined): string {
    const formatId = style === undefined ? 0 : (styles.cellFormats[style] ?? 0)
    return SSF.format(formatId, value, { table: formatTable, date1904: workbook.date1904 })
  }

  /** A cell's value as SheetJS reads it, and as its format shows it. */
  function cellOf(cell: RawCell, table: SharedStrings | null): SheetCell {
    switch (cell.type) {
      case 's':
        return { text: cell.value === undefined ? '' : sharedString(table, cell.value), numeric: false }
      case 'inlineStr':
        return { text: cell.inline === undefined ? '' : itemText(cell.inline), numeric: false }
      case 'str':
      case 'e':
        return { text: cell.value === undefined ? '' : unescapeXml(cell.value), numeric: false }
      case 'b':
        return { text: cell.value === undefined ? '' : ['1', 'true'].includes(cell.value) ? 'TRUE' : 'FALSE', numeric: false }
      case 'd':
        return cell.value === undefined ? { text: '', numeric: false } : { text: formatNumber(dateSerial(cell.value, workbook.date1904), cell.style), numeric: true }
      default: {
        if (cell.value === undefined) return { text: '', numeric: false }
        const value = Number(cell.value)
        if (Number.isNaN(value)) throw damaged()
        return { text: formatNumber(value, cell.style), numeric: true }
      }
    }
  }

  /** The rows numbered from `from` up to `to`, each with the columns from `firstColumn`, empty rows included. */
  async function rowsOf(loaded: LoadedSheet, from: number, to: number, firstColumn: number, columns: number): Promise<SheetCell[][]> {
    const table = await sharedStrings()
    const { first, last } = rowsWithin(loaded.index, from, to)
    const empty = (): SheetCell[] => Array.from({ length: columns }, () => ({ text: '', numeric: false }))
    const rows = Array.from({ length: to - from }, empty)
    for (let position = first; position < last; position++) {
      const row = rows[loaded.index.numbers[position] - from]
      const xml = decoder.decode(loaded.xml.subarray(loaded.index.starts[position], loaded.index.ends[position]))
      for (const cell of parseCells(xml)) {
        const column = cell.column - firstColumn
        if (column >= 0 && column < columns) row[column] = cellOf(cell, table)
      }
    }
    return rows
  }

  const shownColumns = (loaded: LoadedSheet): number => {
    const { used } = loaded.index
    return used ? Math.min(used.lastColumn - used.firstColumn + 1, SHOWN_COLUMNS) : 0
  }

  return {
    methods: {
      sheets: (): string[] => workbook.sheets.map(({ name }) => name),

      async sheet(sheet: number): Promise<SheetSummary> {
        const loaded = await load(sheet)
        if (!loaded) return { shows: 'tooLarge' }
        const { used } = loaded.index
        if (!used) return { shows: 'rows', header: [], rowCount: 0, columnCount: 0 }
        const [header] = await rowsOf(loaded, used.firstRow, used.firstRow + 1, used.firstColumn, shownColumns(loaded))
        return {
          shows: 'rows',
          header: header.map((cell) => cell.text),
          rowCount: used.lastRow - used.firstRow,
          columnCount: used.lastColumn - used.firstColumn + 1
        }
      },

      /** Rows below the header, counted from 0 at the first of them, as many as there are up to `count`. */
      async rows({ sheet, from, count }: { sheet: number; from: number; count: number }): Promise<SheetCell[][]> {
        const loaded = await load(sheet)
        if (!loaded?.index.used) return []
        const { used } = loaded.index
        const start = used.firstRow + 1 + from
        const end = Math.min(start + count, used.lastRow + 1)
        return end > start ? rowsOf(loaded, start, end, used.firstColumn, shownColumns(loaded)) : []
      }
    },
    close(): void {
      current = null
      strings = null
    }
  }
}

export default openXlsx satisfies OpenPreviewDocument
