import path from 'node:path'
import type { Plugin, Rollup } from 'vite'

/**
 * Writes the list of the files one page of the renderer loads, from the build's own output, so that main serves
 * that page and nothing else of the renderer. Vite's manifest leaves out a worker started with
 * `new Worker(new URL(...))` and the files such a worker loads, so the list follows the names the files hold
 * instead: a file belongs to the page when its name is in the text of the page or of a file the page loads.
 * Every name carries a hash of the file's content, so none appears in a text by chance. Another page is never
 * followed, since a script loads no page.
 */

const TEXT = /\.(?:html|m?js|css)$/

/** The files the page loads, at once or on demand, by their names in the output, the page included. */
export function filesLoadedBy(page: string, texts: ReadonlyMap<string, string | null>): string[] {
  // Rollup names its output with / on every OS, and a file refers to another by a path relative to itself, so
  // what every reference holds is the last name.
  const candidates = [...texts.keys()].filter((name) => !name.endsWith('.html')).map((name) => ({ name, last: path.posix.basename(name) }))
  const loaded = new Set([page])
  const queue = [page]
  while (queue.length > 0) {
    const text = texts.get(queue.pop()!)
    if (!text) continue
    for (const { name, last } of candidates) {
      if (loaded.has(name) || !text.includes(last)) continue
      loaded.add(name)
      queue.push(name)
    }
  }
  return [...loaded].sort()
}

function textOf(output: Rollup.OutputChunk | Rollup.OutputAsset): string | null {
  if (!TEXT.test(output.fileName)) return null
  if (output.type === 'chunk') return output.code
  return typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)
}

/** Adds `list`, the files `page` loads, to the build's output. */
export function previewFiles(page: string, list: string): Plugin {
  return {
    name: 'preview-files',
    apply: 'build',
    generateBundle: {
      // After Vite has written the pages and emitted the workers' files into the bundle.
      order: 'post',
      handler(_options, bundle) {
        const texts = new Map(Object.values(bundle).map((output) => [output.fileName, textOf(output)]))
        if (!texts.has(page)) throw new Error(`the renderer's build has no ${page}`)
        this.emitFile({ type: 'asset', fileName: list, source: JSON.stringify(filesLoadedBy(page, texts), null, 2) })
      }
    }
  }
}
