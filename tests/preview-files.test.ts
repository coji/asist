import path from 'node:path'
import { build, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import { previewFiles } from '../scripts/preview-files'
import { longTempFolder } from './helpers/temp'

/**
 * A renderer of two pages built by Vite: each page has its own chunk and a worker started with
 * new Worker(new URL(...)) that loads a file of its own, they share a chunk, and the preview page loads one
 * chunk on demand, where its worker starts.
 */
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'preview-build')

async function builtList(): Promise<{ list: string[]; output: string[] }> {
  const result = (await build({
    root: FIXTURE,
    configFile: false,
    logLevel: 'silent',
    plugins: [previewFiles('preview.html', 'preview-files.json')],
    build: {
      write: false,
      outDir: longTempFolder('asist-preview-build-'),
      rollupOptions: { input: { index: path.join(FIXTURE, 'index.html'), preview: path.join(FIXTURE, 'preview.html') } }
    }
  })) as Rollup.RollupOutput
  const files = result.output
  const list = files.find((file) => file.fileName === 'preview-files.json')
  if (!list || list.type !== 'asset') throw new Error('the build wrote no preview-files.json')
  return { list: JSON.parse(String(list.source)) as string[], output: files.map((file) => file.fileName) }
}

/** The file of the output named `stem`, Vite's eight characters of hash and `extension`. */
const named = (output: string[], stem: string, extension: string): string => {
  const pattern = new RegExp(`^${stem}-[\\w-]{8}\\${extension}$`)
  const found = output.filter((name) => pattern.test(path.posix.basename(name)))
  if (found.length !== 1) throw new Error(`the output holds ${found.length} files named ${stem}*${extension}: ${output.join(', ')}`)
  return found[0]
}

describe("the list of the preview page's files", () => {
  it("lists what a real build of the page loads, a worker and the file it loads included, and nothing only the app's page loads", async () => {
    const { list, output } = await builtList()
    expect(list).toEqual(
      [
        'preview.html',
        named(output, 'preview', '.js'),
        named(output, 'shared', '.js'),
        named(output, 'kind', '.js'),
        named(output, 'preview-worker', '.js'),
        named(output, 'preview-data', '.wasm')
      ].sort()
    )
    expect(output).toEqual(expect.arrayContaining(['index.html', named(output, 'index', '.js'), named(output, 'app-worker', '.js'), named(output, 'app-data', '.wasm')]))
  }, 30_000)
})
