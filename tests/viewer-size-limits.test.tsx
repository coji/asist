// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TEXT_BYTES, WHOLE_READ_LIMIT, type FileItem, type FileKind } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'
import { setPdfLoader } from '@/panels/viewers/PdfViewer'

/**
 * The viewers that read a whole file into the page and parse it there. A file larger than its kind's limit is not
 * read at all, and the viewer says it is too large to show here; the card's own button shows it in Finder or File
 * Explorer. fetch and the PDF loader are replaced, so a read shows up as a call to one of them.
 */

const t = createTranslator('ja-JP')
const WHOLE_KINDS: FileKind[] = ['docx', 'pptx', 'pdf']
const itemOf = (kind: FileKind, sizeBytes: number): FileItem => ({ path: `/tmp/big.${kind}`, name: `big.${kind}`, kind, sizeBytes, url: `/demo-files/big.${kind}` })

let container: HTMLDivElement
let root: Root
const fetch = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))
const loadPdf = vi.fn(async () => {
  throw new Error('missing')
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('AudioContext', class { decodeAudioData = vi.fn(async () => ({ numberOfChannels: 0, getChannelData: () => new Float32Array() })); close = async (): Promise<void> => {} })
  fetch.mockClear()
  loadPdf.mockClear()
  setPdfLoader(loadPdf)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setPdfLoader(null)
  vi.unstubAllGlobals()
})

/** Renders the viewer with a new key, so that each item starts from its own read, and lets that read begin. */
let mounts = 0
async function render(item: FileItem, size: 'l' | 'focus' = 'l'): Promise<HTMLElement> {
  await act(async () => {
    root.render(<FileViewer key={mounts++} item={item} mode={size === 'focus' ? 'focus' : 'card'} size={size} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const reads = (): number => fetch.mock.calls.length + loadPdf.mock.calls.length

describe('the size limit of a viewer that reads the whole file', () => {
  it.each(WHOLE_KINDS)('does not read a %s file far larger than any viewer could parse, in the card or the focus view, and says it is too large', async (kind) => {
    for (const size of ['l', 'focus'] as const) {
      const view = await render(itemOf(kind, 2 ** 40), size)
      expect(reads()).toBe(0)
      expect(view.textContent).toContain(t('files.viewer.tooLarge'))
    }
  })

  it.each(WHOLE_KINDS)('reads a %s file at its limit and not one a byte larger', async (kind) => {
    const limit = WHOLE_READ_LIMIT[kind]!
    await render(itemOf(kind, limit))
    expect(reads()).toBe(1)
    const view = await render(itemOf(kind, limit + 1))
    expect(reads()).toBe(1)
    expect(view.textContent).toContain(t('files.viewer.tooLarge'))
  })

  it('says a notebook too long to travel whole is too large to show, rather than parsing its beginning', async () => {
    const notebook = { ...itemOf('notebook', MAX_TEXT_BYTES + 1), text: '{"cells": [', truncated: true }
    const view = await render(notebook)
    expect(view.textContent).toContain(t('files.viewer.tooLarge'))
  })

  it('plays a recording over the limit and leaves only its waveform unread', async () => {
    const limit = WHOLE_READ_LIMIT.audio!
    const audio = itemOf('audio', limit)
    await render(audio)
    expect(fetch).toHaveBeenCalledTimes(1)
    const view = await render({ ...audio, sizeBytes: limit + 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(view.querySelector('audio')?.getAttribute('src')).toBe(audio.url)
    expect(view.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('skipped')
  })
})
