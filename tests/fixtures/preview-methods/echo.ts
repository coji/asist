import type { OpenPreviewDocument } from '../../../src/renderer/src/preview/serve'

/**
 * A kind of the preview page for the tests of its channel, found by import.meta.glob as the app's kinds are. It
 * counts the documents it opens and closes, hands over a buffer it also keeps, returns as many numbers as it is
 * asked for, can fail to open a file once, and can leave a request unanswered.
 */

/** How many times a document of each URL was opened and closed. */
export const opened = new Map<string, number>()
export const closed = new Map<string, number>()

const count = (counts: Map<string, number>, url: string): void => void counts.set(url, (counts.get(url) ?? 0) + 1)

/** The buffer the last bytes call handed over, as the kind still holds it. */
export const kept: { buffer: ArrayBuffer | null } = { buffer: null }

const failing = new Set<string>()

/** Makes the next opening of the URL fail. */
export const failOnce = (url: string): void => void failing.add(url)

const openEcho = async (url: string) => {
  if (failing.delete(url)) throw new Error(`could not open ${url}`)
  count(opened, url)
  return {
    methods: {
      echo: (args: { text: string }) => ({ url, text: args.text }),
      bytes: (args: { length: number }) => {
        kept.buffer = new Uint8Array(args.length).fill(7).buffer
        return { pages: [{ bytes: new Uint8Array(kept.buffer) }] }
      },
      numbers: (args: { count: number }) => Array.from({ length: args.count }, (_, index) => index),
      wait: () => new Promise<never>(() => undefined)
    },
    close: () => count(closed, url)
  }
}

export default openEcho satisfies OpenPreviewDocument
