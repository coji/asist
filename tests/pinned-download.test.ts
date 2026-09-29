import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory, getVersion: () => '0.0.0' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

import { downloadPinnedFile } from '../src/main/services/pinned-download'

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-pinned-download-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

describe('downloading a pinned file', () => {
  it('rejects without an uncaught error when the file cannot be written, although the response never ends', async () => {
    // 4 MB arrive in 64 KB chunks and the body stays open, as a download does halfway through.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i++) controller.enqueue(new Uint8Array(65_536))
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    const target = path.join(mocks.directory, 'models', 'model.onnx')
    // A folder in place of the temporary file makes every write fail, as a full disk or a missing permission does.
    const folder = path.join(mocks.directory, 'models', 'folder')
    fs.mkdirSync(folder, { recursive: true })
    const createWriteStream = fs.createWriteStream
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((_file: string, options: never) => createWriteStream(folder, options)) as never)
    const uncaught: Error[] = []
    const onUncaught = (error: Error): void => { uncaught.push(error) }
    process.prependListener('uncaughtException', onUncaught)
    try {
      const outcome = await Promise.race([
        downloadPinnedFile({ url: 'https://example.invalid/model.onnx', file: 'model.onnx', sha256: '0' }, target, new AbortController().signal, () => {})
          .then(() => 'resolved', () => 'rejected'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000))
      ])
      expect(outcome).toBe('rejected')
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(fs.existsSync(target)).toBe(false)
  })

  it('installs nothing when the last write fails, even though the bytes received match the hash', async () => {
    const content = Buffer.alloc(4096, 7)
    const sha256 = crypto.createHash('sha256').update(content).digest('hex')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(content), { status: 200 })))
    // The disk takes the first half and then runs out of space.
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((file: string) => {
      fs.writeFileSync(file, content.subarray(0, 2048))
      return new Writable({
        highWaterMark: 1024 * 1024,
        write(_chunk, _encoding, callback) {
          setTimeout(() => callback(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })), 5)
        }
      })
    }) as never)
    const target = path.join(mocks.directory, 'model.onnx')
    await expect(
      downloadPinnedFile({ url: 'https://example.invalid/model.onnx', file: 'model.onnx', sha256 }, target, new AbortController().signal, () => {})
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(fs.readdirSync(mocks.directory)).toEqual([])
  })

  it('puts a file whose content matches its hash in place', async () => {
    const content = Buffer.alloc(100_000, 3)
    const sha256 = crypto.createHash('sha256').update(content).digest('hex')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(content), { status: 200 })))
    const target = path.join(mocks.directory, 'models', 'model.onnx')
    let received = 0
    await downloadPinnedFile({ url: 'https://example.invalid/model.onnx', file: 'model.onnx', sha256 }, target, new AbortController().signal, (bytes) => { received += bytes })
    expect(fs.readFileSync(target).equals(content)).toBe(true)
    expect(received).toBe(content.length)
  })
})
