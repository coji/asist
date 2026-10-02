// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { sheetToRows } from '@/panels/viewers/XlsxViewer'
import { FileViewer } from '@/panels/viewers'

/**
 * The Excel viewer. Turning a sheet into rows runs on object fixtures, while the rendering reads the real demo file
 * in place of fetch and checks the DOM.
 */

const t = createTranslator('ja-JP')
const DEMO_DIR = resolve('src/renderer/demo-public')
const item = DEMO_OFFICE_ITEMS.find((office) => office.kind === 'xlsx')!

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = readFileSync(resolve(DEMO_DIR, `.${url}`))
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  })
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
async function render(file: FileItem, mode: 'card' | 'focus'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer item={file} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />)
  })
  for (let i = 0; i < 50 && container.textContent?.includes(t('files.viewer.loading')); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  }
  return container.querySelector<HTMLElement>('.fv-frame')!
}

describe('an xlsx sheet into rows', () => {
  it('takes the first row as the header, marks only numeric cells as numeric, and uses the formatted text', () => {
    const sheet = {
      '!ref': 'A1:C3',
      A1: { t: 's', v: '氏名' },
      B1: { t: 's', v: '数' },
      C1: { t: 's', v: '日付' },
      A2: { t: 's', v: 'A' },
      B2: { t: 'n', v: 1234.5, w: '1,234.5' },
      C2: { t: 'd', v: new Date(2026, 8, 1), w: '2026/9/1' },
      A3: { t: 's', v: 'B' },
      B3: { t: 'n', v: 7 }
    }
    expect(sheetToRows('表', sheet)).toEqual({
      name: '表',
      header: ['氏名', '数', '日付'],
      rows: [
        [
          { text: 'A', numeric: false },
          { text: '1,234.5', numeric: true },
          { text: '2026/9/1', numeric: false }
        ],
        [
          { text: 'B', numeric: false },
          { text: '7', numeric: true },
          { text: '', numeric: false }
        ]
      ],
      rowCount: 2,
      columnCount: 3
    })
    expect(sheetToRows('空', {})).toEqual({ name: '空', header: [], rows: [], rowCount: 0, columnCount: 0 })
  })

  it('builds only the cells between the first and the last value, whatever range the file declares', () => {
    // A 16 KB file can declare A1:XFD1048576, and SheetJS keeps that as !ref. A smaller part of such a range
    // keeps this test short on a build that walks the declared range.
    const sheet = { '!ref': 'A1:XFD40', A1: { t: 's', v: '氏名' }, B1: { t: 's', v: '数' }, A2: { t: 's', v: 'A' }, B2: { t: 'n', v: 3, w: '3' } }
    expect(sheetToRows('表', sheet)).toEqual({
      name: '表',
      header: ['氏名', '数'],
      rows: [[{ text: 'A', numeric: false }, { text: '3', numeric: true }]],
      rowCount: 1,
      columnCount: 2
    })
  })

  it('builds only the first rows of a long sheet, in order, and counts all of them', () => {
    const sheet: Record<string, unknown> = { '!ref': 'A1:A1201', A1: { t: 's', v: '番号' } }
    for (let r = 2; r <= 1201; r++) sheet[`A${r}`] = { t: 'n', v: r - 1 }
    const rows = sheetToRows('表', sheet)
    expect(rows.rowCount).toBe(1200)
    expect(rows.rows.length).toBeLessThan(rows.rowCount)
    expect(rows.rows.map(([cell]) => cell.text)).toEqual(Array.from({ length: rows.rows.length }, (_, i) => String(i + 1)))
  })

  it('builds only the first columns of a sheet with a value far to the right, and counts all of them', () => {
    const sheet = { '!ref': 'A1:XFD2', A1: { t: 's', v: '氏名' }, XFD1: { t: 's', v: '端' }, A2: { t: 's', v: 'A' }, XFD2: { t: 'n', v: 1 } }
    const rows = sheetToRows('表', sheet)
    expect(rows.columnCount).toBe(16_384)
    expect(rows.header.length).toBeLessThan(rows.columnCount)
    expect(rows.header[0]).toBe('氏名')
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toHaveLength(rows.header.length)
    expect(rows.rows[0][0]).toEqual({ text: 'A', numeric: false })
  })
})

describe('Excel viewer rendering with the demo file', () => {
  it('switches sheets from the tabs and builds a table with a header row and right-aligned numbers', async () => {
    const frame = await render(item, 'card')
    const tabs = [...frame.querySelectorAll<HTMLButtonElement>('.fv-xlsx-tabs button')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['料金', 'ヒアリング'])
    expect(tabs[0].dataset.current).toBe('true')
    expect([...frame.querySelectorAll('.fv-table thead th')].map((th) => th.textContent)).toEqual(['サービス', '月額(USD)', '同時接続', '無料枠', '更新日'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(6)
    expect(frame.querySelector('.fv-table tbody td:nth-child(2)')?.getAttribute('data-numeric')).toBe('true')
    expect(frame.querySelector('.fv-table tbody td:nth-child(1)')?.getAttribute('data-numeric')).toBeNull()
    await act(async () => tabs[1].click())
    expect([...frame.querySelectorAll('.fv-table thead th')].map((th) => th.textContent)).toEqual(['日付', '相手', 'メモ'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(3)
  })
})
