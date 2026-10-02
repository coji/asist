import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import mammoth from 'mammoth/mammoth.browser.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import { openZip } from '@/preview/zip-ranges'
import { fileUrl, handleFileScheme } from '../src/main/file-protocol'
import { longTempFolder } from './helpers/temp'

/**
 * The zip reader of the preview iframe. Most tests serve the file as asist-file answers a Range request: a 206
 * with the bytes of the range, cut at the end of the file, and a Content-Range that gives the file's length; a
 * suffix range for the last bytes; and a 200 with the whole file for a range that holds none of its bytes. The
 * server counts the bytes it sends. One test serves the file through asist-file's own handler.
 */

const electron = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle } }))

const URL = 'asist-file:///tmp/a.docx'
/** The size of a picture, which is four times the 64 KB a reader takes from the end of the file first. */
const PICTURE = 256 * 1024

let sent = 0

function serve(file: Uint8Array): void {
  sent = 0
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')
    const suffix = range?.[1] === ''
    const start = !range ? 0 : suffix ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = !range || suffix || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    if (!range || start > end) {
      sent += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(start, end + 1)
    sent += body.length
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** A zip as Office writes one: the entries alone, without an entry for each folder. */
async function zipOf(files: Record<string, Uint8Array | string>, options: { store?: string[]; comment?: string; streamFiles?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { compression: options.store?.includes(name) ? 'STORE' : 'DEFLATE', createFolders: false })
  }
  return zip.generateAsync({ type: 'uint8array', comment: options.comment, streamFiles: options.streamFiles })
}

/** Changes the central directory record of one entry of a zip without a comment, as an unusual writer would write it. */
function patchCentral(file: Uint8Array, name: string, patch: (record: DataView) => void): Uint8Array {
  const out = file.slice()
  const view = new DataView(out.buffer)
  for (let at = view.getUint32(out.length - 22 + 16, true); ; ) {
    const nameLength = view.getUint16(at + 28, true)
    const length = 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (text(out.subarray(at + 46, at + 46 + nameLength)) === name) {
      patch(new DataView(out.buffer, at, length))
      return out
    }
    at += length
  }
}

/** Every entry of a zip as JSZip reads it, which is what this reader is held to. */
async function contentsByJSZip(file: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(file)
  const names = Object.keys(zip.files)
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await zip.file(name)!.async('string')])))
}

async function contentsByRanges(file: Uint8Array): Promise<Record<string, string>> {
  serve(file)
  const zip = await openZip(URL)
  return Object.fromEntries(await Promise.all([...zip.entries.keys()].map(async (name) => [name, text(await zip.read(name))])))
}

/**
 * A zip written the way a ZIP64 writer writes one: every size and offset of the central directory in its ZIP64
 * field, a ZIP64 field in each local header too, and the counts in the ZIP64 end record. `declared` overrides
 * the size the central directory gives an entry, as a huge sheet would declare it.
 */
function zip64Of(files: Array<{ name: string; content: Uint8Array; declared?: number }>): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const { name, content, declared } of files) {
    const rawName = new TextEncoder().encode(name)
    const data = deflateRawSync(content)
    const local = new DataView(new ArrayBuffer(30 + rawName.length + 20))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 45, true)
    local.setUint16(8, 8, true)
    local.setUint32(14, crc32(content), true)
    local.setUint32(18, 0xffffffff, true)
    local.setUint32(22, 0xffffffff, true)
    local.setUint16(26, rawName.length, true)
    local.setUint16(28, 20, true)
    new Uint8Array(local.buffer).set(rawName, 30)
    local.setUint16(30 + rawName.length, 0x0001, true)
    local.setUint16(32 + rawName.length, 16, true)
    local.setBigUint64(34 + rawName.length, BigInt(content.length), true)
    local.setBigUint64(42 + rawName.length, BigInt(data.length), true)
    const record = new DataView(new ArrayBuffer(46 + rawName.length + 28))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 45, true)
    record.setUint16(6, 45, true)
    record.setUint16(10, 8, true)
    record.setUint32(16, crc32(content), true)
    record.setUint32(20, 0xffffffff, true)
    record.setUint32(24, 0xffffffff, true)
    record.setUint16(28, rawName.length, true)
    record.setUint16(30, 28, true)
    record.setUint32(42, 0xffffffff, true)
    new Uint8Array(record.buffer).set(rawName, 46)
    record.setUint16(46 + rawName.length, 0x0001, true)
    record.setUint16(48 + rawName.length, 24, true)
    record.setBigUint64(50 + rawName.length, BigInt(declared ?? content.length), true)
    record.setBigUint64(58 + rawName.length, BigInt(data.length), true)
    record.setBigUint64(66 + rawName.length, BigInt(offset), true)
    parts.push(new Uint8Array(local.buffer), data)
    central.push(new Uint8Array(record.buffer))
    offset += local.byteLength + data.length
  }
  const centralLength = central.reduce((sum, record) => sum + record.length, 0)
  const ends = new DataView(new ArrayBuffer(56 + 20 + 22))
  ends.setUint32(0, 0x06064b50, true)
  ends.setBigUint64(4, 44n, true)
  ends.setUint16(12, 45, true)
  ends.setUint16(14, 45, true)
  ends.setBigUint64(24, BigInt(files.length), true)
  ends.setBigUint64(32, BigInt(files.length), true)
  ends.setBigUint64(40, BigInt(centralLength), true)
  ends.setBigUint64(48, BigInt(offset), true)
  ends.setUint32(56, 0x07064b50, true)
  ends.setBigUint64(64, BigInt(offset + centralLength), true)
  ends.setUint32(72, 1, true)
  ends.setUint32(76, 0x06054b50, true)
  ends.setUint16(84, 0xffff, true)
  ends.setUint16(86, 0xffff, true)
  ends.setUint32(88, 0xffffffff, true)
  ends.setUint32(92, 0xffffffff, true)
  return Buffer.concat([...parts, ...central, new Uint8Array(ends.buffer)])
}

const SHEETS = [
  { name: 'xl/workbook.xml', content: new TextEncoder().encode('<workbook/>') },
  { name: 'xl/worksheets/sheet1.xml', content: new TextEncoder().encode('<sheetData><row r="1"/></sheetData>'.repeat(100)) },
  { name: 'xl/worksheets/sheet2.xml', content: new TextEncoder().encode('<sheetData/>'), declared: 5 * 2 ** 30 }
]

describe('reading a zip by ranges', () => {
  it('reads one entry without reading the others', async () => {
    const pictures = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`word/media/image${i}.png`, randomBytes(PICTURE)]))
    const file = await zipOf({ 'word/document.xml': '<w:document>本文</w:document>'.repeat(200), ...pictures }, { store: Object.keys(pictures) })
    serve(file)
    const zip = await openZip(URL)
    expect([...zip.entries.keys()]).toEqual(['word/document.xml', ...Object.keys(pictures)])
    expect(zip.entries.get('word/media/image3.png')).toMatchObject({ size: PICTURE, compressedSize: PICTURE })
    expect(sent).toBeLessThan(PICTURE)

    sent = 0
    expect(pictures['word/media/image3.png'].equals(await zip.read('word/media/image3.png'))).toBe(true)
    expect(text(await zip.read('word/document.xml'))).toBe('<w:document>本文</w:document>'.repeat(200))
    // The picture and the document, and nothing of the seven other pictures.
    expect(sent).toBeLessThan(PICTURE * 1.5)
  })

  it('reads a central directory that the end of the file it reads first does not hold', async () => {
    // 1,500 entries take about 105 KB of central directory.
    const files = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`ppt/slides/slide${i}.xml`, `<p:sld>${i}</p:sld>`]))
    const file = await zipOf(files)
    serve(file)
    const zip = await openZip(URL)
    expect(zip.entries.size).toBe(1500)
    expect(text(await zip.read('ppt/slides/slide0.xml'))).toBe('<p:sld>0</p:sld>')
    expect(text(await zip.read('ppt/slides/slide1499.xml'))).toBe('<p:sld>1499</p:sld>')
  })

  it('takes the sizes, offsets and counts a ZIP64 zip keeps in its ZIP64 fields and records', async () => {
    serve(zip64Of(SHEETS))
    const zip = await openZip(URL)
    expect([...zip.entries.keys()]).toEqual(SHEETS.map(({ name }) => name))
    // A size past 4 GB is known before anything of the entry is read, so a viewer can refuse it.
    expect(zip.entries.get('xl/worksheets/sheet2.xml')!.size).toBe(5 * 2 ** 30)
    expect(text(await zip.read('xl/workbook.xml'))).toBe('<workbook/>')
    expect(await zip.read('xl/worksheets/sheet1.xml')).toEqual(SHEETS[1].content)
  })

  it('reads what JSZip reads of a zip with a comment, with bytes after its end, or with bytes in front of it, ZIP64 included', async () => {
    const files = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': '<sheetData/>'.repeat(50) }
    const plain = await zipOf(files)
    const newline = new Uint8Array([10])
    const expected = await contentsByJSZip(plain)
    for (const comment of ['exported', 'c'.repeat(65_535)]) {
      const commented = await zipOf(files, { comment })
      expect(await contentsByRanges(commented)).toEqual(expected)
    }
    expect(await contentsByRanges(Buffer.concat([plain, newline]))).toEqual(expected)
    expect(await contentsByRanges(Buffer.concat([plain, new Uint8Array(512)]))).toEqual(expected)
    expect(await contentsByRanges(Buffer.concat([newline, plain]))).toEqual(expected)
    expect(await contentsByJSZip(Buffer.concat([newline, plain]))).toEqual(expected)

    serve(Buffer.concat([newline, zip64Of(SHEETS)]))
    const zip = await openZip(URL)
    expect(text(await zip.read('xl/workbook.xml'))).toBe('<workbook/>')
  })

  it('reads the entries of a zip written with data descriptors, whose local headers leave the sizes out', async () => {
    const files = { 'word/document.xml': '<w:document/>'.repeat(100), 'word/media/image1.png': randomBytes(1000), 'word/styles.xml': '<w:styles/>' }
    const file = await zipOf(files, { store: ['word/media/image1.png'], streamFiles: true })
    serve(file)
    const zip = await openZip(URL)
    expect(text(await zip.read('word/styles.xml'))).toBe('<w:styles/>')
    expect(files['word/media/image1.png'].equals(await zip.read('word/media/image1.png'))).toBe(true)
    const slim = await JSZip.loadAsync(await zip.slimmed((name) => name.startsWith('word/media/')), { checkCRC32: true })
    expect(await slim.file('word/document.xml')!.async('string')).toBe(files['word/document.xml'])
    expect(await slim.file('word/media/image1.png')!.async('string')).toBe('word/media/image1.png')
  })

  it('reads a deflated entry with no compressed bytes and a size of 0 as empty, as JSZip does', async () => {
    const name = new TextEncoder().encode('xl/calcChain.xml')
    const local = new DataView(new ArrayBuffer(30 + name.length))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(8, 8, true)
    local.setUint16(26, name.length, true)
    new Uint8Array(local.buffer).set(name, 30)
    const central = new DataView(new ArrayBuffer(46 + name.length))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(10, 8, true)
    central.setUint16(28, name.length, true)
    new Uint8Array(central.buffer).set(name, 46)
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, 1, true)
    end.setUint16(10, 1, true)
    end.setUint32(12, central.byteLength, true)
    end.setUint32(16, local.byteLength, true)
    const file = Buffer.concat([new Uint8Array(local.buffer), new Uint8Array(central.buffer), new Uint8Array(end.buffer)])
    expect(await contentsByRanges(file)).toEqual(await contentsByJSZip(file))
  })

  it('reads a zip served by asist-file, and the file as it is after it was saved again', async () => {
    const folder = longTempFolder('asist-zip-')
    try {
      handleFileScheme(() => [folder])
      const handler = electron.handle.mock.calls[0][1] as (request: { url: string; headers: Headers }) => Response
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => handler({ url, headers: new Headers(init?.headers) }))
      const target = path.join(folder, 'report.docx')
      // The document is stored ahead of 100 KB of picture, so that reading it asks the file again.
      const picture = randomBytes(100_000)
      const version = (body: string): Promise<Uint8Array> =>
        zipOf({ 'word/document.xml': body, 'word/media/image1.png': picture }, { store: ['word/document.xml', 'word/media/image1.png'] })
      writeFileSync(target, await version('<w:document>初版</w:document>'))
      const first = await openZip(fileUrl(target))
      expect(text(await first.read('word/document.xml'))).toBe('<w:document>初版</w:document>')

      writeFileSync(target, await version('<w:document>保存し直した版</w:document>'))
      // What was opened before the save no longer matches the file, and the file opened again reads as it is now.
      await expect(first.read('word/document.xml')).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
      const again = await openZip(fileUrl(target))
      expect(text(await again.read('word/document.xml'))).toBe('<w:document>保存し直した版</w:document>')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('a zip that cannot be read', () => {
  const damaged = errorKey('files.errors.zipDamaged')

  it('fails on a file cut short, on one that is no zip, and on an empty one', async () => {
    const file = await zipOf({ 'word/document.xml': randomBytes(200_000) })
    serve(file.slice(0, Math.floor(file.length / 2)))
    await expect(openZip(URL)).rejects.toThrow(damaged)
    serve(new TextEncoder().encode(`%PDF-1.7\n${'0'.repeat(1000)}\n%%EOF\n`))
    await expect(openZip(URL)).rejects.toThrow(damaged)
    serve(new Uint8Array(0))
    await expect(openZip(URL)).rejects.toThrow(damaged)
  })

  it('fails on a central directory said to be past where it is, and on an entry whose data is not deflate', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>'.repeat(100), 'word/styles.xml': '<w:styles/>' })
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    const end = file.length - 22
    const wrongOffset = file.slice()
    new DataView(wrongOffset.buffer).setUint32(end + 16, view.getUint32(end + 16, true) + 1000, true)
    serve(wrongOffset)
    await expect(openZip(URL)).rejects.toThrow(damaged)

    // A first byte of 0xff marks a final block of the reserved type 3, which no deflate stream has.
    const broken = file.slice()
    broken[30 + view.getUint16(26, true) + view.getUint16(28, true)] = 0xff
    serve(broken)
    const zip = await openZip(URL)
    await expect(zip.read('word/document.xml')).rejects.toThrow(damaged)
    expect(text(await zip.read('word/styles.xml'))).toBe('<w:styles/>')
  })

  it('fails on an entry that inflates to more or to less than its declared size', async () => {
    const file = await zipOf({ 'xl/sharedStrings.xml': 'x'.repeat(100_000) })
    for (const declared of [1000, 200_000]) {
      serve(patchCentral(file, 'xl/sharedStrings.xml', (record) => record.setUint32(24, declared, true)))
      const zip = await openZip(URL)
      await expect(zip.read('xl/sharedStrings.xml')).rejects.toThrow(damaged)
    }
  })

  it('names an entry that is encrypted or compressed by a method other than storing and deflate', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>' })
    const unsupported = errorKey('files.errors.zipEntryUnsupported', { path: 'word/document.xml' })
    serve(patchCentral(file, 'word/document.xml', (record) => record.setUint16(8, record.getUint16(8, true) | 1, true)))
    await expect((await openZip(URL)).read('word/document.xml')).rejects.toThrow(unsupported)
    // 12 is bzip2.
    serve(patchCentral(file, 'word/document.xml', (record) => record.setUint16(10, 12, true)))
    await expect((await openZip(URL)).read('word/document.xml')).rejects.toThrow(unsupported)
  })

  it('says the file changed when it is another length by the time an entry is read, and gives the HTTP status of a refusal', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>'.repeat(10_000), 'word/styles.xml': '<w:styles/>' }, { store: ['word/document.xml'] })
    serve(file)
    const zip = await openZip(URL)
    serve(Buffer.concat([file, new Uint8Array(100)]))
    await expect(zip.read('word/document.xml')).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
    serve(file.slice(0, 100))
    await expect(zip.read('word/document.xml')).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    await expect(openZip(URL)).rejects.toThrow(errorKey('files.errors.loadFailed', { status: 403 }))
  })

  it('names an entry the zip does not have', async () => {
    serve(await zipOf({ 'word/document.xml': '<w:document/>' }))
    const zip = await openZip(URL)
    await expect(zip.read('word/styles.xml')).rejects.toThrow(errorKey('files.errors.zipEntryMissing', { path: 'word/styles.xml' }))
  })
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
/** A paragraph holding one picture, as Word writes it, which refers to the picture's file through rel. */
const drawing = (rel: string, name: string): string =>
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
  `<wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="${name}" descr="${name}"/>` +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

/** A docx with two paragraphs and two pictures. */
async function docxWithPictures(): Promise<{ file: Uint8Array; original: JSZip }> {
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      `<w:document ${W} ${R}><w:body><w:p><w:r><w:t>調査の結果</w:t></w:r></w:p>${drawing('rId5', '図1')}<w:p><w:r><w:t>次の段落</w:t></w:r></w:p>${drawing('rId6', '写真')}</w:body></w:document>`,
    'word/media/image1.png': randomBytes(PICTURE),
    'word/media/photo.jpeg': randomBytes(PICTURE),
    'word/_rels/document.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.jpeg"/></Relationships>',
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'
  }
  const file = await zipOf(files, { store: ['word/media/image1.png', 'word/media/photo.jpeg'] })
  return { file, original: await JSZip.loadAsync(file) }
}

describe('the slimmed zip', () => {
  const isPicture = (name: string): boolean => name.startsWith('word/media/')

  it('keeps every other entry as it was, replaces each chosen entry by its path, and reads none of the chosen ones', async () => {
    const { file, original } = await docxWithPictures()
    serve(file)
    const zip = await openZip(URL)
    sent = 0
    const slim = await JSZip.loadAsync(await zip.slimmed(isPicture), { checkCRC32: true })
    expect(sent).toBeLessThan(PICTURE)
    expect(Object.keys(slim.files)).toEqual(Object.keys(original.files))
    for (const name of Object.keys(original.files)) {
      const content = await slim.file(name)!.async('uint8array')
      if (isPicture(name)) expect(text(content)).toBe(name)
      else expect(content).toEqual(await original.file(name)!.async('uint8array'))
    }
  })

  it('writes an entry it is given with that content, stored, and reads neither the entries it is given nor those it stubs', async () => {
    const { file, original } = await docxWithPictures()
    serve(file)
    const zip = await openZip(URL)
    const document = new TextEncoder().encode('<w:document>先頭だけ</w:document>')
    sent = 0
    const slim = await JSZip.loadAsync(await zip.slimmed(isPicture, new Map([['word/document.xml', document]])), { checkCRC32: true })
    // Only the entries neither given nor stubbed are read, and they are small.
    expect(sent).toBeLessThan(4096)
    expect(Object.keys(slim.files)).toEqual(Object.keys(original.files))
    expect(await slim.file('word/document.xml')!.async('string')).toBe('<w:document>先頭だけ</w:document>')
    expect(await slim.file('word/media/photo.jpeg')!.async('string')).toBe('word/media/photo.jpeg')
    expect(await slim.file('docProps/core.xml')!.async('string')).toBe(await original.file('docProps/core.xml')!.async('string'))
  })

  it('is read by mammoth, which writes each picture as a reference to its path', async () => {
    const { file } = await docxWithPictures()
    serve(file)
    const slim = await (await openZip(URL)).slimmed(isPicture)
    const { value } = await mammoth.convertToHtml({ arrayBuffer: slim.buffer })
    expect([...value.matchAll(/<p>([^<]+)<\/p>/g)].map((match) => match[1])).toEqual(['調査の結果', '次の段落'])
    const images = [...value.matchAll(/<img [^>]*src="data:([^;]+);base64,([^"]+)"/g)].map((match) => ({
      type: match[1],
      path: Buffer.from(match[2], 'base64').toString('utf8')
    }))
    expect(images).toEqual([
      { type: 'image/png', path: 'word/media/image1.png' },
      { type: 'image/jpeg', path: 'word/media/photo.jpeg' }
    ])
  })

  it('refuses to keep an entry whose size does not fit the zip it writes, rather than write the size cut short', async () => {
    serve(zip64Of(SHEETS))
    const zip = await openZip(URL)
    await expect(zip.slimmed(() => false)).rejects.toThrow(errorKey('files.viewer.tooLarge'))
    const slim = await JSZip.loadAsync(await zip.slimmed((name) => name === 'xl/worksheets/sheet2.xml'), { checkCRC32: true })
    expect(await slim.file('xl/workbook.xml')!.async('string')).toBe('<workbook/>')
  })
})
