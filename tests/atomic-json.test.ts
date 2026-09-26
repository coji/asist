import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeJsonFileAtomic, writeJsonFileAtomicSync } from '../src/main/services/atomic-json'

/**
 * On Windows a rename over a file fails while another process holds that file open, which antivirus
 * software, the search indexer and OneDrive do for a moment after every change.
 */

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let directory: string
let target: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-atomic-'))
  target = path.join(directory, 'state.json')
  fs.writeFileSync(target, '"before"\n')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

const simulate = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platform, value })
}
const busy = (): NodeJS.ErrnoException => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
const saved = (): unknown => JSON.parse(fs.readFileSync(target, 'utf8'))

describe('replacing a file on Windows', () => {
  it('retries a rename the target being held open refuses, and saves once it is let go', async () => {
    simulate('win32')
    const rename = fsp.rename.bind(fsp)
    const attempts = vi.spyOn(fsp, 'rename')
    attempts.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockImplementation(rename)

    await writeJsonFileAtomic(target, 'after')

    expect(saved()).toBe('after')
    expect(attempts).toHaveBeenCalledTimes(3)
    expect(fs.readdirSync(directory)).toEqual(['state.json'])
  })

  it('gives up on a target that stays held, keeping the old content and no temporary file', async () => {
    simulate('win32')
    vi.useFakeTimers()
    let attempted!: () => void
    const firstAttempt = new Promise<void>((resolve) => (attempted = resolve))
    const attempts = vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      attempted()
      throw busy()
    })

    const failed = expect(writeJsonFileAtomic(target, 'after')).rejects.toMatchObject({ code: 'EBUSY' })
    await firstAttempt
    await vi.advanceTimersByTimeAsync(10_000)
    await failed

    expect(attempts.mock.calls.length).toBeGreaterThan(1)
    expect(saved()).toBe('before')
    expect(fs.readdirSync(directory)).toEqual(['state.json'])
  })

  it('retries a synchronous write the same way', () => {
    simulate('win32')
    const rename = fs.renameSync.bind(fs)
    const attempts = vi.spyOn(fs, 'renameSync')
    attempts.mockImplementationOnce(() => { throw busy() }).mockImplementation(rename)

    writeJsonFileAtomicSync(target, 'after')

    expect(saved()).toBe('after')
    expect(attempts).toHaveBeenCalledTimes(2)
  })

  it('throws from a synchronous write that stays refused, keeping the old content', () => {
    simulate('win32')
    const attempts = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy() })

    expect(() => writeJsonFileAtomicSync(target, 'after')).toThrow('EBUSY')

    expect(attempts.mock.calls.length).toBeGreaterThan(1)
    expect(saved()).toBe('before')
    expect(fs.readdirSync(directory)).toEqual(['state.json'])
  })

  it('does not retry an error that waiting cannot clear', async () => {
    simulate('win32')
    const attempts = vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))

    await expect(writeJsonFileAtomic(target, 'after')).rejects.toMatchObject({ code: 'EXDEV' })
    expect(attempts).toHaveBeenCalledOnce()
  })
})

describe('replacing a file on macOS', () => {
  it('fails at once when the rename fails, since nothing there holds a file against a rename', async () => {
    simulate('darwin')
    const attempts = vi.spyOn(fsp, 'rename').mockRejectedValue(busy())
    const syncAttempts = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy() })

    await expect(writeJsonFileAtomic(target, 'after')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(() => writeJsonFileAtomicSync(target, 'after')).toThrow('EBUSY')
    expect(attempts).toHaveBeenCalledOnce()
    expect(syncAttempts).toHaveBeenCalledOnce()
    expect(saved()).toBe('before')
  })
})

describe('overlapping writes', () => {
  it('both finish, and the file holds one of them whole', async () => {
    // Both writes reach the rename before either renames, as two saves in flight at once do.
    const rename = fsp.rename.bind(fsp)
    let waiting = 0
    let release!: () => void
    const bothWritten = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (++waiting === 2) release()
      await bothWritten
      await rename(from, to)
    })

    await Promise.all([writeJsonFileAtomic(target, { writer: 'first' }), writeJsonFileAtomic(target, { writer: 'second' })])

    expect([{ writer: 'first' }, { writer: 'second' }]).toContainEqual(saved())
    expect(fs.readdirSync(directory)).toEqual(['state.json'])
  })
})

describe('temporary files a write never finished', () => {
  // A write the app quit or crashed in the middle of leaves its temporary file, named as every write names one.
  const abandoned = (target: string): string => {
    const file = `${target}.0123456789ab.tmp`
    fs.writeFileSync(file, '"half written"')
    return file
  }

  it('are removed by the next write of the same target, and one of another target is left alone', async () => {
    abandoned(target)
    const other = abandoned(path.join(directory, 'other.json'))

    await writeJsonFileAtomic(target, 'after')
    expect(fs.readdirSync(directory).sort()).toEqual([path.basename(other), 'state.json'])

    abandoned(target)
    writeJsonFileAtomicSync(target, 'again')
    expect(fs.readdirSync(directory).sort()).toEqual([path.basename(other), 'state.json'])
    expect(saved()).toBe('again')
  })

  it('does not include the temporary file of a write of this process that is still running', async () => {
    const rename = fsp.rename.bind(fsp)
    let entered!: () => void
    const firstRenaming = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fsp, 'rename')
      .mockImplementationOnce(async (from, to) => {
        entered()
        await gate
        await rename(from, to)
      })
      .mockImplementation(rename)

    const first = writeJsonFileAtomic(target, 'first')
    await firstRenaming
    await writeJsonFileAtomic(target, 'second')
    writeJsonFileAtomicSync(target, 'third')
    release()
    await first

    expect(saved()).toBe('first')
    expect(fs.readdirSync(directory)).toEqual(['state.json'])
  })
})
