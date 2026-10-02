import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import { createPreviewClient, type PreviewFile, type PreviewFrame } from '../src/renderer/src/panels/viewers/preview-client'
import { servePreview, type OpenPreviewDocument } from '../src/renderer/src/preview/serve'
import openEcho, { closed, failOnce, kept, opened } from './fixtures/preview-methods/echo'

const ja = createTranslator('ja-JP')
const kinds = import.meta.glob<{ default: OpenPreviewDocument }>('./fixtures/preview-methods/*.ts')

/** A file of its own for each test, since a frame a test ended may still close its documents during the next. */
let fileNumber = 0
const newFile = (): PreviewFile => ({ url: `asist-file:///Users/me/${++fileNumber}.pdf`, sizeBytes: 1000, modifiedAt: 1_790_000_000_000 })

/**
 * Starts frames as the app does, each with the preview page served on a channel of its own, and keeps the page's
 * end of each so that a test can end the frame the way a crash does, which closes that end.
 */
function frames() {
  const started: Array<{ page: MessagePort; removed: boolean }> = []
  const start = (): PreviewFrame => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, kinds)
    const frame = { page: port2, removed: false }
    started.push(frame)
    return {
      port: port1,
      gone: new Promise((resolve) => port1.addEventListener('close', () => resolve())),
      remove: () => {
        frame.removed = true
      }
    }
  }
  return { started, client: createPreviewClient(start) }
}

/** Lets the client settle the handles a render gave up, which it does after the render. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  // The page's side looks for bitmaps among what it returns, and Node has none.
  vi.stubGlobal('ImageBitmap', class {})
})
afterEach(() => vi.unstubAllGlobals())

describe('the preview frame', () => {
  it('fails the requests a frame that dies has not answered, with an error a viewer can show, and starts a new frame for the next request', async () => {
    const { started, client } = frames()
    const file = newFile()
    const { url } = file
    const document = client.open<typeof openEcho>('echo', file)
    await document.call('echo', { text: 'up' })
    const waiting = document.call('wait', undefined)
    started[0].page.close()
    const error = await waiting.catch((thrown: Error) => thrown)
    expect(readErrorText(String((error as Error).message), 'ja-JP')).toBe(ja('files.errors.previewStopped'))
    expect(started[0].removed).toBe(true)

    expect(await document.call('echo', { text: 'again' })).toEqual({ url, text: 'again' })
    expect(started).toHaveLength(2)
    // The new frame opened the document again, since the one that died took its documents with it.
    expect(opened.get(url)).toBe(2)
    document.release()
  })

  it('removes the frame once no document is open, and starts a new one for the next document', async () => {
    const { started, client } = frames()
    const [a, b] = [newFile(), newFile()]
    const first = client.open<typeof openEcho>('echo', a)
    await first.call('echo', { text: 'a' })
    first.release()
    await settled()
    expect(started[0].removed).toBe(true)
    await vi.waitFor(() => expect(closed.get(a.url)).toBe(1))

    const second = client.open<typeof openEcho>('echo', b)
    expect(await second.call('echo', { text: 'b' })).toEqual({ url: b.url, text: 'b' })
    expect(started).toHaveLength(2)
    second.release()
  })

  it('keeps one document for each file, which the card and the focus view share until both let it go', async () => {
    const { started, client } = frames()
    const file = newFile()
    const { url } = file
    const card = client.open<typeof openEcho>('echo', file)
    const focus = client.open<typeof openEcho>('echo', file)
    await Promise.all([card.call('echo', { text: 'card' }), focus.call('echo', { text: 'focus' })])
    expect(opened.get(url)).toBe(1)

    card.release()
    await settled()
    await focus.call('echo', { text: 'still open' })
    expect([opened.get(url), closed.get(url), started[0].removed]).toEqual([1, undefined, false])

    // A view that gives the document up while another takes it in the same render keeps it open.
    focus.release()
    const next = client.open<typeof openEcho>('echo', file)
    await settled()
    await next.call('echo', { text: 'next' })
    expect([opened.get(url), closed.get(url), started.length]).toEqual([1, undefined, 1])

    next.release()
    await settled()
    expect(started[0].removed).toBe(true)
    await vi.waitFor(() => expect(closed.get(url)).toBe(1))
  })

  it('reaches a method of a kind registered through import.meta.glob, and moves the buffers of its result rather than copying them', async () => {
    const { client } = frames()
    const document = client.open<typeof openEcho>('echo', newFile())
    const { pages } = await document.call('bytes', { length: 4 })
    expect([...pages[0].bytes]).toEqual([7, 7, 7, 7])
    expect(kept.buffer?.byteLength).toBe(0)
    document.release()
  })

  it('answers with an array as long as the shared strings of a large sheet', async () => {
    const { client } = frames()
    const document = client.open<typeof openEcho>('echo', newFile())
    const numbers = await document.call('numbers', { count: 200_000 })
    expect([numbers.length, numbers[199_999]]).toEqual([200_000, 199_999])
    document.release()
  })

  it('opens a document whose opening failed again for the next request, while a view still holds it', async () => {
    const { client } = frames()
    const file = newFile()
    failOnce(file.url)
    const card = client.open<typeof openEcho>('echo', file)
    await expect(card.call('echo', { text: 'card' })).rejects.toThrow(`could not open ${file.url}`)
    const focus = client.open<typeof openEcho>('echo', file)
    expect(await focus.call('echo', { text: 'focus' })).toEqual({ url: file.url, text: 'focus' })
    card.release()
    focus.release()
  })

  it('gives a file written again since its card opened a document of its own', async () => {
    const { client } = frames()
    const before = newFile()
    const after = { ...before, sizeBytes: 2000, modifiedAt: before.modifiedAt! + 60_000 }
    const old = client.open<typeof openEcho>('echo', before)
    await old.call('echo', { text: 'old' })
    const rewritten = client.open<typeof openEcho>('echo', after)
    await rewritten.call('echo', { text: 'new' })
    expect(opened.get(before.url)).toBe(2)
    old.release()
    rewritten.release()
  })
})
