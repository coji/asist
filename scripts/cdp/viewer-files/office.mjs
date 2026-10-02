import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { photo } from './photos.mjs'
import { escapeXml, heading, paragraph, pick, random, sentence, title } from './text.mjs'
import { zipWriter } from './zip.mjs'

/**
 * Word, PowerPoint and Excel files written part by part, with the parts Office writes and the viewers read. The
 * styles and numbering of the Word file, and the master, layout and theme of the deck, are those of the demo's
 * own samples.
 */

const SAMPLES = new URL('../../../src/renderer/demo-public/demo-files/office/', import.meta.url)
/** The demo's own Office samples whose parts the generated files reuse. */
export const OFFICE_TEMPLATES = { deck: new URL('slides.pptx', SAMPLES), report: new URL('report.docx', SAMPLES) }
const sample = async (template, part) => (await JSZip.loadAsync(await readFile(template))).file(part).async('string')

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (list) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
const contentTypes = (overrides) =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`)
    .join('')}</Types>`

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

/** A deck of `slides` slides at 16:9: a photo with notes beside it on five slides in six, bullets on the sixth. */
export async function writePptx(client, file, { slides }) {
  const next = random(slides)
  const zip = zipWriter(file)
  const overrides = [
    ['/ppt/presentation.xml', 'presentationml.presentation.main+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml'],
    ['/ppt/theme/theme1.xml', 'theme+xml']
  ]
  for (let i = 1; i <= slides; i++) overrides.push([`/ppt/slides/slide${i}.xml`, 'presentationml.slide+xml'])
  zip.add('[Content_Types].xml', contentTypes(overrides))
  zip.add('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]))
  const slideIds = Array.from({ length: slides }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
  zip.add(
    'ppt/presentation.xml',
    `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${REL}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  )
  zip.add(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ...Array.from({ length: slides }, (_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`]),
      [`rId${slides + 2}`, 'theme', 'theme/theme1.xml']
    ])
  )
  for (const part of ['ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', 'ppt/theme/theme1.xml']) {
    zip.add(part, await sample(OFFICE_TEMPLATES.deck, part))
  }
  const run = (text, size, bold = false) => `<a:r><a:rPr lang="ja-JP" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${escapeXml(text)}</a:t></a:r>`
  const shape = (id, name, [x, y, cx, cy], body, ph = '') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`
  for (let i = 1; i <= slides; i++) {
    const withPhoto = i % 6 !== 0
    const titleShape = shape(2, 'Title 1', [838200, 365125, 10515600, 1325563], `<a:p><a:pPr><a:buNone/></a:pPr>${run(`${i}. ${title(next)}`, 3600, true)}</a:p>`, '<p:ph type="title"/>')
    let content
    if (withPhoto) {
      const notes = Array.from({ length: 3 }, () => `<a:p><a:pPr><a:buChar char="•"/></a:pPr>${run(sentence(next), 1800)}</a:p>`).join('')
      content =
        `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="838200" y="1690688"/><a:ext cx="6400800" cy="4267200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
        shape(4, 'TextBox 3', [7467600, 1690688, 3886200, 4267200], notes)
    } else {
      const bullets = Array.from({ length: 6 }, (_, k) => `<a:p><a:pPr lvl="${k % 3 === 2 ? 1 : 0}"/>${run(sentence(next), k % 3 === 2 ? 2000 : 2400)}</a:p>`).join('')
      content = shape(3, 'Content Placeholder 2', [838200, 1825625, 10515600, 4351338], bullets, '<p:ph idx="1"/>')
    }
    zip.add(
      `ppt/slides/slide${i}.xml`,
      `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${REL}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${titleShape}${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    )
    zip.add(
      `ppt/slides/_rels/slide${i}.xml.rels`,
      rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(withPhoto ? [['rId2', 'image', `../media/image${i}.jpeg`]] : [])])
    )
    if (withPhoto) zip.add(`ppt/media/image${i}.jpeg`, await photo(client, 'slide', 10_000 + i))
  }
  zip.close()
}

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

/**
 * A report of about `pages` A4 pages: a chapter every ten pages, a heading and about a thousand characters of
 * prose a page, a bulleted list every five pages, a table every seven and a photo every three.
 */
export async function writeDocx(client, file, { pages }) {
  const next = random(pages + 1)
  const zip = zipWriter(file)
  zip.add(
    '[Content_Types].xml',
    contentTypes([
      ['/word/document.xml', 'wordprocessingml.document.main+xml'],
      ['/word/styles.xml', 'wordprocessingml.styles+xml'],
      ['/word/numbering.xml', 'wordprocessingml.numbering+xml']
    ])
  )
  zip.add('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]))
  zip.add('word/styles.xml', await sample(OFFICE_TEMPLATES.report, 'word/styles.xml'))
  zip.add('word/numbering.xml', await sample(OFFICE_TEMPLATES.report, 'word/numbering.xml'))
  const text = (value) => `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`
  const styled = (style, value) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${text(value)}</w:p>`
  const body = []
  const images = []
  for (let page = 1; page <= pages; page++) {
    if (page % 10 === 1) body.push(styled('Heading1', heading(next, Math.ceil(page / 10))))
    body.push(styled('Heading2', `${page}. ${title(next)}`))
    const withPhoto = page % 3 === 1
    for (let i = 0; i < (withPhoto ? 5 : 7); i++) body.push(`<w:p>${text(paragraph(next, 4))}</w:p>`)
    if (withPhoto) {
      images.push(page)
      const id = `rId${images.length + 2}`
      const [cx, cy] = [5400000, 4050000]
      body.push(
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${images.length}" name="Picture ${images.length}" descr="${escapeXml(sentence(next))}"/><a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}"><pic:nvPicPr><pic:cNvPr id="${images.length}" name="photo${page}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      )
    }
    if (page % 5 === 0) {
      for (let i = 0; i < 4; i++) body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${text(sentence(next))}</w:p>`)
    }
    if (page % 7 === 0) {
      const cell = (value) => `<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/></w:tcPr><w:p>${text(value)}</w:p></w:tc>`
      const rows = [['年度', '東日本', '西日本', '海外', '合計'], ...Array.from({ length: 5 }, (_, i) => [String(2021 + i), ...Array.from({ length: 4 }, () => Math.floor(next() * 90_000).toLocaleString('en-US'))])]
      body.push(
        `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="1800"/>'.repeat(5)}</w:tblGrid>${rows.map((row) => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`
      )
    }
  }
  zip.add(
    'word/document.xml',
    `${XML}<w:document xmlns:w="${NS_W}" xmlns:r="${REL}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  )
  zip.add(
    'word/_rels/document.xml.rels',
    rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'], ...images.map((page, i) => [`rId${i + 3}`, 'image', `media/image${page}.jpeg`])])
  )
  for (const page of images) zip.add(`word/media/image${page}.jpeg`, await photo(client, 'document', 20_000 + page))
  zip.close()
}

const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REGIONS = ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州']
const PEOPLE = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本']
const PRODUCTS = Array.from({ length: 200 }, (_, i) => [`P-${1000 + i}`, `${['業務用', '家庭用', '携帯用', '大型', '小型'][i % 5]}${['ポンプ', 'フィルター', 'ケーブル', 'センサー', 'バッテリー', 'ライト', 'ファン', 'スイッチ'][i % 8]} ${String.fromCharCode(65 + (i % 26))}${i}`, 800 + ((i * 7919) % 40) * 250])
const HEADER = ['日付', '伝票番号', '地域', '店舗', '商品コード', '商品名', '数量', '単価', '金額', '担当者', '備考']
const COLUMNS = 'ABCDEFGHIJK'

/**
 * A workbook of sales records, one row per sale, as an accounting system exports them: a date, a slip number, the
 * region, shop, product and person as strings shared across the workbook, the quantity and price as numbers, the
 * amount as a formula with its cached value, and a note on one row in ten. A sheet of 50,000 rows is 18,980,063
 * bytes of XML. `sheets` lists each sheet's name and number of rows.
 */
export function writeXlsx(file, { sheets }) {
  const next = random(sheets.reduce((sum, sheet) => sum + sheet.rows, 0))
  const strings = new Map()
  const shared = (value) => {
    if (!strings.has(value)) strings.set(value, strings.size)
    return strings.get(value)
  }
  const zip = zipWriter(file)
  zip.add(
    '[Content_Types].xml',
    contentTypes([
      ['/xl/workbook.xml', 'spreadsheetml.sheet.main+xml'],
      ['/xl/styles.xml', 'spreadsheetml.styles+xml'],
      ['/xl/sharedStrings.xml', 'spreadsheetml.sharedStrings+xml'],
      ...sheets.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, 'spreadsheetml.worksheet+xml'])
    ])
  )
  zip.add('_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']]))
  zip.add(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="${NS_S}" xmlns:r="${REL}"><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
  )
  zip.add(
    'xl/_rels/workbook.xml.rels',
    rels([
      ...sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]),
      [`rId${sheets.length + 1}`, 'styles', 'styles.xml'],
      [`rId${sheets.length + 2}`, 'sharedStrings', 'sharedStrings.xml']
    ])
  )
  zip.add(
    'xl/styles.xml',
    `${XML}<styleSheet xmlns="${NS_S}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="游ゴシック"/></font><font><b/><sz val="11"/><name val="游ゴシック"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`
  )
  let slip = 0
  sheets.forEach((sheet, index) => {
    const rows = [`<row r="1">${HEADER.map((name, c) => `<c r="${COLUMNS[c]}1" t="s" s="3"><v>${shared(name)}</v></c>`).join('')}</row>`]
    // 2025-01-01 as an Excel date serial.
    const firstDay = 45658 - (sheets.length - 1 - index) * 365
    for (let r = 2; r <= sheet.rows + 1; r++) {
      const [code, name, price] = pick(next, PRODUCTS)
      const quantity = 1 + Math.floor(next() * 48)
      const region = Math.floor(next() * REGIONS.length)
      const cells = [
        `<c r="A${r}" s="1"><v>${firstDay + Math.floor(((r - 2) / sheet.rows) * 365)}</v></c>`,
        `<c r="B${r}" t="s"><v>${shared(`S${String(++slip).padStart(8, '0')}`)}</v></c>`,
        `<c r="C${r}" t="s"><v>${shared(REGIONS[region])}</v></c>`,
        `<c r="D${r}" t="s"><v>${shared(`${REGIONS[region]}${1 + Math.floor(next() * 5)}号店`)}</v></c>`,
        `<c r="E${r}" t="s"><v>${shared(code)}</v></c>`,
        `<c r="F${r}" t="s"><v>${shared(name)}</v></c>`,
        `<c r="G${r}"><v>${quantity}</v></c>`,
        `<c r="H${r}" s="2"><v>${price}</v></c>`,
        `<c r="I${r}" s="2"><f>G${r}*H${r}</f><v>${quantity * price}</v></c>`,
        `<c r="J${r}" t="s"><v>${shared(pick(next, PEOPLE))}</v></c>`,
        ...(next() < 0.1 ? [`<c r="K${r}" t="s"><v>${shared(sentence(next))}</v></c>`] : [])
      ]
      rows.push(`<row r="${r}">${cells.join('')}</row>`)
    }
    zip.add(
      `xl/worksheets/sheet${index + 1}.xml`,
      `${XML}<worksheet xmlns="${NS_S}" xmlns:r="${REL}"><dimension ref="A1:K${sheet.rows + 1}"/><sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="12" customWidth="1"/><col min="6" max="6" width="24" customWidth="1"/><col min="11" max="11" width="40" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`
    )
  })
  const items = [...strings.keys()].map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('')
  zip.add('xl/sharedStrings.xml', `${XML}<sst xmlns="${NS_S}" count="${strings.size}" uniqueCount="${strings.size}">${items}</sst>`)
  zip.close()
}
