// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'

/**
 * The HTML viewer: the page runs in a frame that cannot reach the app, the source is one tab away, and a
 * page that cannot be fetched shows the error instead. The frame cannot be navigated away (the main
 * process refuses that, covered in file-protocol tests), so the viewer offers no way to open a link.
 */

const t = createTranslator('ja-JP')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const ESCAPING_FLAGS = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals'
]

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>x</h1>', { status: 200 })))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const PAGE: FileItem = {
  path: '/jobs/report/index.html',
  name: 'index.html',
  kind: 'code',
  sizeBytes: 40,
  text: '<!doctype html>\n<h1>レポート</h1>\n<script src="chart.js"></script>',
  url: 'asist-file:///jobs/report/index.html'
}

async function render(item: FileItem): Promise<void> {
  await act(async () => {
    root.render(
      <div className="card" data-size="l">
        <FileViewer item={item} mode="card" size="l" />
      </div>
    )
  })
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe')
const tab = (key: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === t(key))!

describe('html: the rendered page', () => {
  it('loads the page from its own URL in a frame that may run scripts but cannot reach the app', async () => {
    await render(PAGE)
    const page = frame()
    expect(page?.getAttribute('src')).toBe(PAGE.url)
    const flags = page?.getAttribute('sandbox')?.split(/\s+/) ?? []
    expect(flags).toContain('allow-scripts')
    for (const flag of ESCAPING_FLAGS) expect(flags).not.toContain(flag)
    expect(tab('files.viewer.htmlPage').getAttribute('aria-selected')).toBe('true')
  })

  it('shows the highlighted source on the other tab and the page again on the first', async () => {
    await render(PAGE)
    await act(async () => tab('files.viewer.htmlSource').click())
    expect(frame()).toBeNull()
    expect(container.querySelectorAll('.fv-code-line')).toHaveLength(3)
    expect(container.querySelector('.fv-code-text .hljs-tag')).not.toBeNull()
    await act(async () => tab('files.viewer.htmlPage').click())
    expect(frame()?.getAttribute('src')).toBe(PAGE.url)
  })

  it('shows the error and no page when the page cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    await render(PAGE)
    expect(frame()).toBeNull()
    expect(container.querySelector('[data-tone="error"]')?.textContent).toBe(t('files.errors.loadFailed', { status: 403 }))
  })

  it('shows the error and no page when the item has no URL', async () => {
    await render({ ...PAGE, url: undefined })
    expect(frame()).toBeNull()
    expect(container.querySelector('[data-tone="error"]')?.textContent).toBe(t('files.viewer.urlMissing'))
  })

  it('leaves other code, such as a script, to the code viewer without tabs', async () => {
    await render({ ...PAGE, path: '/jobs/report/chart.js', name: 'chart.js', text: 'draw()', url: undefined })
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.querySelector('.fv-code-line')?.textContent).toContain('draw()')
  })

  it('offers no control that opens a URL, so a link the page built cannot be followed from the card', async () => {
    await render(PAGE)
    expect(container.querySelector('a[href]')).toBeNull()
    expect(container.querySelector('.card-actions')).toBeNull()
    expect(container.querySelector('.card-action')).toBeNull()
  })
})
