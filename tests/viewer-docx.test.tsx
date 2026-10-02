// @vitest-environment happy-dom
import { createTranslator } from '@shared/i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { sanitizeDocxHtml } from '@/panels/viewers/DocxViewer'
import { FileViewer } from '@/panels/viewers'
import { useToastStore } from '@/state/stores'

/**
 * The Word viewer. Cleaning the HTML runs on string fixtures, while the rendering reads the real demo file in place
 * of fetch and checks the DOM.
 */

const t = createTranslator('ja-JP')
const DEMO_DIR = resolve('src/renderer/demo-public')
const itemOf = (kind: FileItem['kind']): FileItem => DEMO_OFFICE_ITEMS.find((item) => item.kind === kind)!

let container: HTMLDivElement
let root: Root
const openExternal = vi.fn(async (_url: string) => {})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = readFileSync(resolve(DEMO_DIR, `.${url}`))
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  })
  vi.stubGlobal('window', Object.assign(window, { api: { openExternal } }))
  openExternal.mockClear()
  useToastStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Renders the viewer and waits until it has finished loading. */
async function render(item: FileItem, mode: 'card' | 'focus'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />)
  })
  for (let i = 0; i < 50 && container.textContent?.includes(t('files.viewer.loading')); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  }
  return container.querySelector<HTMLElement>('.fv-frame')!
}

describe('cleaning the docx HTML', () => {
  it('drops script and on* attributes, keeps only the allowed elements, and removes unsafe links and images', () => {
    const html =
      '<h1 onclick="x()">題</h1><script>alert(1)</script><p style="color:red">本文 <strong>太字</strong> <span class="a">囲み</span></p>' +
      '<a href="javascript:alert(1)">危険</a><a href="https://example.com/a">安全</a>' +
      '<img src="https://evil/x.png"><img src="data:image/png;base64,AAAA" alt="図">' +
      '<table><tr><td colspan="2" bgcolor="red">セル</td></tr></table><iframe></iframe>'
    const out = sanitizeDocxHtml(html)
    expect(out).toBe(
      '<h1>題</h1><p>本文 <strong>太字</strong> 囲み</p>危険<a href="https://example.com/a">安全</a><img><img src="data:image/png;base64,AAAA" alt="図"><table><tbody><tr><td colspan="2">セル</td></tr></tbody></table>'
    )
  })

  it('keeps mail links, links to places in the document and the ids they point to, but no id of the page around it', () => {
    const html =
      '<a href="mailto:team@example.com">mail</a><a href="#docx-_Toc1">toc</a><a id="docx-_Toc1"></a>' +
      '<ol><li id="docx-footnote-1">note</li></ol><a href="#root">app</a><p id="root">page</p><a href="file:///etc/passwd">file</a>'
    expect(sanitizeDocxHtml(html)).toBe(
      '<a href="mailto:team@example.com">mail</a><a href="#docx-_Toc1">toc</a><a id="docx-_Toc1"></a>' +
      '<ol><li id="docx-footnote-1">note</li></ol>app<p>page</p>file'
    )
  })
})

describe('Word viewer rendering with the demo file', () => {
  it('renders the headings, emphasis, lists and tables of a docx into .fv-doc and opens links in the browser', async () => {
    const frame = await render(itemOf('docx'), 'card')
    const doc = frame.querySelector('.fv-doc')!
    expect(doc.querySelector('h1')?.textContent).toBe('競合サービスの比較')
    expect(doc.querySelector('strong')?.textContent).toBe('差が大きいのは同時接続数の上限')
    expect([...doc.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['料金と無料枠の有無', '同時接続の上限', 'サポートの応答時間'])
    expect(doc.querySelectorAll('table tr')).toHaveLength(3)
    expect(doc.querySelectorAll('table tr:first-child td')).toHaveLength(3)
    expect(doc.querySelector('script, style, [onclick]')).toBeNull()
  })

  /** A docx with a table of contents entry, a link to a removed bookmark and a mail link. */
  async function linkedDocx(): Promise<void> {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:team@example.com" TargetMode="External"/></Relationships>')
    const link = (attributes: string, text: string): string => `<w:p><w:hyperlink ${attributes}><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
      link('w:anchor="_Toc1"', 'Findings') + link('w:anchor="_Toc9"', 'Removed section') + link('r:id="rId1"', 'Write to us') +
      '<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>The findings</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p></w:body></w:document>')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }))
  }

  /** happy-dom lays nothing out, so a box that scrolls is given its overflow, its sizes and its place here. */
  function scrollable(box: HTMLElement, top: number): void {
    box.style.overflowY = 'auto'
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 400 })
    box.getBoundingClientRect = () => ({ top }) as DOMRect
  }

  const anchorIn = (frame: HTMLElement, text: string): HTMLElement => [...frame.querySelectorAll<HTMLElement>('.fv-doc a')].find((a) => a.textContent === text)!
  const bookmarkAt = (frame: HTMLElement, top: number): void => {
    frame.querySelector<HTMLElement>('.fv-doc [id="docx-_Toc1"]')!.getBoundingClientRect = () => ({ top }) as DOMRect
  }

  it('scrolls the focus view to a place in the document, opens a mail link outside the app, and says so when either cannot be followed', async () => {
    await linkedDocx()
    const frame = await render({ ...itemOf('docx'), url: '/linked.docx' }, 'focus')
    // In the focus view the frame shows the whole document, and the view around it scrolls.
    scrollable(container, 100)
    bookmarkAt(frame, 400)

    await act(async () => anchorIn(frame, 'Findings').click())
    expect(container.scrollTop).toBe(300)
    expect(frame.querySelector<HTMLElement>('.fv-scroll')!.scrollTop).toBe(0)
    await act(async () => anchorIn(frame, 'Removed section').click())
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error', title: t('files.viewer.anchorMissing') }])
    expect(openExternal).not.toHaveBeenCalled()

    const refused = errorText('app.links.refused', { url: 'mailto:team@example.com' })
    openExternal.mockRejectedValueOnce(new Error(`Error invoking remote method 'open-external': Error: ${refused}`))
    await act(async () => anchorIn(frame, 'Write to us').click())
    expect(openExternal).toHaveBeenCalledWith('mailto:team@example.com')
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error', title: t('app.links.openFailed'), body: t('app.links.refused', { url: 'mailto:team@example.com' })
    })
  })

  it('scrolls only the frame of a card to a place in the document, leaving the boxes around the card', async () => {
    await linkedDocx()
    const frame = await render({ ...itemOf('docx'), url: '/linked.docx' }, 'card')
    const scroller = frame.querySelector<HTMLElement>('.fv-scroll')!
    scrollable(scroller, 100)
    scrollable(container, 0)
    bookmarkAt(frame, 400)
    await act(async () => anchorIn(frame, 'Findings').click())
    expect(scroller.scrollTop).toBe(300)
    expect(container.scrollTop).toBe(0)
  })

  it('shows the reason in red for a file it cannot read', async () => {
    const frame = await render({ ...itemOf('docx'), url: '/demo-files/office/slides.pptx' }, 'card')
    expect(frame.querySelector('.fv-note[data-tone="error"]')?.textContent).toContain('Word を読めません')
  })
})
