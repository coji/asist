// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { FileViewer } from '@/panels/viewers'
import { highlightLines, languageFor, splitHighlightedHtml } from '@/panels/viewers/CodeViewer'
import { childCount, openByDefault, parseData, summaryOf, typeOf } from '@/panels/viewers/DataViewer'
import { parseNotebook, sanitizeHtml, stripAnsi } from '@/panels/viewers/NotebookViewer'
import { DEMO_CODE_ITEMS, DEMO_FETCH_TS, DEMO_NOTEBOOK, DEMO_NOTEBOOK_JSON, DEMO_RESULTS_JSON } from '@/demo/fixtures/files-code'
import { useToastStore } from '@/state/stores'

/**
 * The code, data and notebook viewers: the pure logic (picking the language, the json tree, the ipynb cells) and
 * the rendering in a card and in the focus view (line numbers, opening and closing the tree, the number of cells).
 */

const t = createTranslator('ja-JP')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, { api: { openExternal: vi.fn(async () => {}) } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const itemOf = (name: string, kind: FileItem['kind'], text: string): FileItem => ({ path: `/tmp/${name}`, name, kind, sizeBytes: text.length, text })

async function render(item: FileItem, mode: 'card' | 'focus'): Promise<HTMLElement> {
  await act(async () => {
    root.render(
      <div className="card" data-size={mode === 'focus' ? 'focus' : 'l'}>
        <FileViewer item={item} mode={mode} size={mode === 'focus' ? 'focus' : 'l'} />
      </div>
    )
  })
  return container.querySelector<HTMLElement>('.fv-frame')!
}

describe('code: language and highlighting', () => {
  it.each([
    ['app.ts', 'typescript'],
    ['App.tsx', 'typescript'],
    ['index.mjs', 'javascript'],
    ['main.py', 'python'],
    ['Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['config.toml', 'ini'],
    ['page.html', 'xml'],
    ['README.md', 'markdown'],
    ['notes.unknownext', null],
    ['LICENSE', null],
    ['/Users/me/repo/src/app.ts', 'typescript'],
    ['C:\\Users\\me\\repo\\Dockerfile', 'dockerfile'],
    ['C:\\Users\\me\\make.d\\LICENSE', null]
  ])('%s → %s', (name, language) => {
    expect(languageFor(name)).toBe(language)
  })

  it('closes and reopens a span that runs across several lines at each line break', () => {
    const lines = splitHighlightedHtml('<span class="hljs-comment">/* a\nb */</span> x')
    expect(lines).toEqual(['<span class="hljs-comment">/* a</span>', '<span class="hljs-comment">b */</span> x'])
  })

  it('marks the keywords when a language is known and returns escaped plain lines when it is not', () => {
    const [line] = highlightLines('const x = 1 < 2', 'typescript')
    expect(line).toContain('class="hljs-keyword">const</span>')
    expect(line).toContain('&lt;')
    expect(highlightLines('a < b\nc', null)).toEqual(['a &lt; b', 'c'])
  })

  it('numbers the first 60 lines in a card and shows every line in the focus view', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n')
    const card = await render(itemOf('long.ts', 'code', long), 'card')
    expect(card.querySelectorAll('.fv-code-line')).toHaveLength(60)
    expect([...card.querySelectorAll('.fv-code-no')].map((el) => el.textContent).slice(0, 3)).toEqual(['1', '2', '3'])
    expect(card.querySelector('.fv-note')?.textContent).toBe(t('files.viewer.moreLines', { count: 20 }))
    expect(card.querySelector('.fv-code-line .hljs-keyword')?.textContent).toBe('const')
    const focus = await render(itemOf('long.ts', 'code', long), 'focus')
    expect(focus.querySelectorAll('.fv-code-line')).toHaveLength(80)
    expect(focus.querySelector('.fv-note')).toBeNull()
  })

  it('highlights comments and strings in the sample TypeScript file, which is about 40 lines long', async () => {
    const card = await render(itemOf('fetch-pricing.ts', 'code', DEMO_FETCH_TS), 'focus')
    expect(card.querySelectorAll('.fv-code-line').length).toBeGreaterThanOrEqual(40)
    expect(card.querySelector('.hljs-comment')).not.toBeNull()
    expect(card.querySelector('.hljs-string')).not.toBeNull()
  })
})

describe('markdown: links', () => {
  it('opens a web or mail link outside the app, says so when it cannot, and keeps any other link as its text', async () => {
    const openExternal = vi.fn(async (_url: string) => {})
    Object.assign(window, { api: { openExternal } })
    useToastStore.setState({ toasts: [] })
    const text = 'See [the site](https://example.com/a), [mail](mailto:team@example.com), [a sibling](notes.md) and [a script](javascript:alert(1)).'
    const frame = await render(itemOf('links.md', 'markdown', text), 'focus')
    const links = [...frame.querySelectorAll<HTMLAnchorElement>('.fv-doc a')]
    expect(links.map((a) => a.textContent)).toEqual(['the site', 'mail'])
    expect(frame.querySelector('.fv-doc')?.textContent).toContain('a sibling and a script.')

    await act(async () => links[0].click())
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a')
    openExternal.mockRejectedValueOnce(new Error(errorText('app.links.refused', { url: 'mailto:team@example.com' })))
    await act(async () => links[1].click())
    await act(async () => {})
    expect(useToastStore.getState().toasts).toMatchObject([
      { kind: 'error', title: t('app.links.openFailed'), body: t('app.links.refused', { url: 'mailto:team@example.com' }) }
    ])
  })
})

describe('data: the json tree', () => {
  it('parses json, turns jsonl into an array of lines, and returns the reason when it is broken', () => {
    expect(parseData('{"a":[1,2]}', 'x.json')).toEqual({ ok: true, value: { a: [1, 2] } })
    expect(parseData('{"a":1}\n\n{"a":2}\n', 'x.jsonl')).toEqual({ ok: true, value: [{ a: 1 }, { a: 2 }] })
    const broken = parseData('{"a":', 'x.json')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error).not.toBe('')
  })

  it('reports the type, the number of children and the summary', () => {
    expect(typeOf(null)).toBe('null')
    expect(typeOf([])).toBe('array')
    expect(typeOf({})).toBe('object')
    expect(typeOf('a')).toBe('string')
    expect(childCount({ a: 1, b: 2 })).toBe(2)
    expect(childCount([1, 2, 3])).toBe(3)
    expect(childCount('abc')).toBe(0)
    expect(summaryOf([1, 2, 3])).toBe('[3]')
    expect(summaryOf({ a: 1 })).toBe('{1}')
  })

  it('collapses from depth 2 in a card and opens everything in the focus view', () => {
    expect(openByDefault(0, 'card')).toBe(true)
    expect(openByDefault(1, 'card')).toBe(true)
    expect(openByDefault(2, 'card')).toBe(false)
    expect(openByDefault(5, 'focus')).toBe(true)
  })

  it('renders the tree, opens and closes a node from its key, and marks each value with its type', async () => {
    const item = itemOf('results.json', 'data', DEMO_RESULTS_JSON)
    const card = await render(item, 'card')
    const rootNode = card.querySelector('.fv-data-tree > .fv-data-node')!
    expect(rootNode.getAttribute('data-open')).toBe('true')
    // services, at depth 1, is open, while its elements at depth 2 are collapsed.
    const services = [...card.querySelectorAll<HTMLElement>('.fv-data-node[data-type="array"]')].find((el) => el.querySelector('.fv-data-key')?.textContent === 'services')!
    expect(services.getAttribute('data-open')).toBe('true')
    expect(services.querySelector('.fv-data-count')?.textContent).toBe('[3]')
    const first = services.querySelector<HTMLElement>('.fv-data-children > .fv-data-node')!
    expect(first.getAttribute('data-open')).toBe('false')
    expect(first.querySelector('.fv-data-children')).toBeNull()
    await act(async () => first.querySelector<HTMLButtonElement>('.fv-data-toggle')!.click())
    expect(first.getAttribute('data-open')).toBe('true')
    expect(first.querySelector('.fv-data-value[data-type="string"]')?.textContent).toBe('"A"')
    expect(first.querySelector('.fv-data-value[data-type="number"]')?.textContent).toBe('20')
    expect(first.querySelector('.fv-data-value[data-type="boolean"]')?.textContent).toBe('true')
    await act(async () => first.querySelector<HTMLButtonElement>('.fv-data-toggle')!.click())
    expect(first.getAttribute('data-open')).toBe('false')
    expect(card.querySelector('.fv-data-value[data-type="null"]')?.textContent).toBe('null')

    const focus = await render(item, 'focus')
    expect(focus.querySelectorAll('.fv-data-node[data-open="false"]')).toHaveLength(0)
    expect(focus.querySelector('.fv-data-value[data-type="number"]')).not.toBeNull()
  })

  it('shows the reason in red for broken json and renders it as highlighted code', async () => {
    const card = await render(itemOf('broken.json', 'data', '{"a": [1, 2,\n'), 'card')
    expect(card.querySelector('.fv-note[data-tone="error"]')?.textContent).toContain('JSON として読めません')
    expect(card.querySelector('.fv-code')?.getAttribute('data-language')).toBe('json')
    expect(card.querySelector('.fv-data-tree')).toBeNull()
  })

  it('does not parse yaml and renders it as highlighted code', async () => {
    const card = await render(itemOf('settings.yaml', 'data', 'retry:\n  count: 3\n'), 'card')
    expect(card.querySelector('.fv-code')?.getAttribute('data-language')).toBe('yaml')
    expect(card.querySelectorAll('.fv-code-line')).toHaveLength(3)
    expect(card.querySelector('.hljs-attr')?.textContent).toBe('retry:')
  })
})

describe('notebook: cells and outputs', () => {
  it('reads the cells in order and sorts the outputs by kind', () => {
    const parsed = parseNotebook(DEMO_NOTEBOOK_JSON)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.language).toBe('python')
    expect(parsed.cells.map((cell) => cell.type)).toEqual(['markdown', 'code', 'code', 'markdown', 'code'])
    expect(parsed.cells[1].executionCount).toBe(1)
    expect(parsed.cells[1].source).toContain('pd.read_csv')
    expect(parsed.cells[1].outputs).toEqual([{ kind: 'stream', name: 'stdout', text: expect.stringContaining('0.571429') }])
    expect(parsed.cells[2].outputs.map((o) => o.kind)).toEqual(['text', 'image'])
    const image = parsed.cells[2].outputs[1]
    if (image.kind === 'image') expect(image.data.startsWith('iVBOR')).toBe(true)
    const error = parsed.cells[4].outputs[0]
    expect(error.kind).toBe('error')
    if (error.kind === 'error') {
      expect(error.ename).toBe('KeyError')
      expect(error.traceback).not.toContain('')
      expect(error.traceback).toContain('KeyError')
    }
  })

  it('reports a failure when there are no cells and accepts a source given as a plain string', () => {
    expect(parseNotebook('{"a":1}')).toEqual({ ok: false, error: null })
    const broken = parseNotebook('not json')
    expect(broken.ok).toBe(false)
    expect(broken.ok ? null : broken.error).toBeTypeOf('string')
    const parsed = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x = 1', outputs: [{ output_type: 'execute_result', data: { 'text/html': ['<b>1</b>'], 'text/plain': ['1'] } }] }] }))
    if (parsed.ok) {
      expect(parsed.cells[0].source).toBe('x = 1')
      expect(parsed.cells[0].outputs).toEqual([{ kind: 'html', html: '<b>1</b>' }])
    }
  })

  it('strips ANSI codes and lets only tables and text decoration through in HTML', () => {
    expect(stripAnsi('[0;31mKeyError[0m: x')).toBe('KeyError: x')
    const html = sanitizeHtml('<style>td{color:red}</style><table border="1" class="dataframe"><tr><td colspan="2" onclick="x()">a</td></tr></table><script>alert(1)</script><a href="javascript:x" style="x">l</a><a href="https://example.com">ok</a><a href="mailto:team@example.com">mail</a>')
    expect(html).toBe('<table><tbody><tr><td colspan="2">a</td></tr></tbody></table>l<a href="https://example.com">ok</a><a href="mailto:team@example.com">mail</a>')
  })

  it('draws the first 3 cells in a card and every cell with its outputs in the focus view', async () => {
    const item = DEMO_CODE_ITEMS.find((entry) => entry.kind === 'notebook')!
    const card = await render(item, 'card')
    expect(card.querySelectorAll('.fv-nb-cell')).toHaveLength(3)
    expect(card.querySelector('.fv-nb-cell[data-type="markdown"] h1')?.textContent).toBe('料金の分析')
    expect(card.querySelector('.fv-nb-cell[data-type="code"] .fv-nb-count')?.textContent).toBe('[1]')
    expect(card.querySelector('.fv-nb-cell[data-type="code"] .hljs-keyword')?.textContent).toBe('import')
    expect(card.querySelector('.fv-nb-output[data-kind="stream"]')?.textContent).toContain('0.571429')
    expect(card.querySelector<HTMLImageElement>('.fv-nb-output[data-kind="image"] img')?.src.startsWith('data:image/png;base64,iVBOR')).toBe(true)
    expect(card.querySelector('.fv-note')?.textContent).toBe(`他 ${DEMO_NOTEBOOK.cells.length - 3} セル`)
    const focus = await render(item, 'focus')
    expect(focus.querySelectorAll('.fv-nb-cell')).toHaveLength(DEMO_NOTEBOOK.cells.length)
    expect(focus.querySelector('.fv-nb-output[data-kind="error"]')?.textContent).toContain("KeyError: '無料枠'")
    expect(focus.querySelector('.fv-nb-output[data-kind="error"]')?.textContent).not.toContain('[0;31m')
  })
})
