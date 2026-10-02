import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SERVED_FILES_PATH, serveFolder } from '../scripts/cdp/demo-server.mjs'
import { parseRange } from '../src/shared/byte-range'
import { zipWriter } from '../scripts/cdp/viewer-files/zip.mjs'

/** A folder of served files inside a root that also holds a file the folder must not give away. */
let root = ''
let server: http.Server
let origin = ''
const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 251))

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-served-files-'))
  fs.mkdirSync(path.join(root, 'served'))
  fs.writeFileSync(path.join(root, 'served', 'sample.bin'), content)
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not served')
  server = http.createServer(serveFolder(path.join(root, 'served'), parseRange))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
})

const get = (name: string, range?: string): Promise<Response> =>
  fetch(`${origin}${SERVED_FILES_PATH}${name}`, { headers: range ? { Range: range } : {} })

describe('the files demo:viewer-budgets serves', () => {
  it('answers a range with exactly its bytes and where they sit in the file', async () => {
    const response = await get('sample.bin', 'bytes=10-19')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content.subarray(10, 20))
  })

  it('answers a range from an offset to the end and a range of the last bytes', async () => {
    const open = await get('sample.bin', 'bytes=995-')
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 995-999/1000')
    expect(Buffer.from(await open.arrayBuffer())).toEqual(content.subarray(995))
    const suffix = await get('sample.bin', 'bytes=-5')
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000')
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(content.subarray(995))
  })

  it('answers a range of more last bytes than the file holds with the whole file and its length', async () => {
    // A zip reader asks for the end of central directory this way, before it knows the file's length.
    const response = await get('sample.bin', 'bytes=-65577')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-999/1000')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content)
  })

  it('answers a request without a range with the whole file, which the browser may not keep', async () => {
    const response = await get('sample.bin')
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content)
  })

  it('answers a range that holds no byte of the file with the whole file, as the app does', async () => {
    for (const range of ['bytes=1000-', 'bytes=-', 'bytes=50-10']) {
      const response = await get('sample.bin', range)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBeNull()
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content)
    }
  })

  it('never serves a file outside its folder', async () => {
    for (const name of ['..%2Fsecret.txt', '%2E%2E%2Fsecret.txt', `..${encodeURIComponent(path.sep)}secret.txt`]) {
      const response = await get(name)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('not served')
    }
  })
})

describe('the zip writer of the generated Office files', () => {
  it('writes deflated and stored entries with UTF-8 names that a zip reader gets back unchanged', async () => {
    const file = path.join(root, 'written.zip')
    const picture = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256))
    const zip = zipWriter(file)
    zip.add('word/document.xml', '<w:document>売上の推移</w:document>')
    zip.add('word/media/写真 1.jpeg', picture, { store: true })
    zip.close()
    const read = await JSZip.loadAsync(fs.readFileSync(file))
    expect(Object.keys(read.files).sort()).toEqual(['word/document.xml', 'word/media/写真 1.jpeg'])
    expect(await read.file('word/document.xml')!.async('string')).toBe('<w:document>売上の推移</w:document>')
    expect(Buffer.from(await read.file('word/media/写真 1.jpeg')!.async('uint8array'))).toEqual(picture)
  })
})
