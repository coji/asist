import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'

/**
 * Replaces a file as a whole. The content goes to a temporary file beside the target, is flushed to the
 * disk, and is then renamed over the target, and the rename is the point at which the save counts as
 * done. An abort is accepted until the rename starts, and a rename that has started is awaited.
 */

/** Every file written here is readable by the user alone. On Windows the mode has no effect, and the profile's access rights protect userData. */
const FILE_MODE = 0o600

/**
 * The waits between the attempts at the rename on Windows, about two seconds in total. Windows replaces a
 * file with MoveFileEx, which fails while another process holds the target open, and antivirus software,
 * the search indexer and OneDrive open a file for a moment right after it has changed.
 */
const RENAME_WAITS_MS = [20, 40, 80, 160, 320, 460, 460, 460]
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** A name in the target's folder that no other write shares, so that two overlapping writes never fill the same temporary file. */
function temporaryPathBeside(target: string): string {
  return `${target}.${randomBytes(6).toString('hex')}.tmp`
}

const isTemporaryOf = (target: string, name: string): boolean => {
  const base = path.basename(target)
  return name.startsWith(base) && /^\.[0-9a-f]{12}\.tmp$/.test(name.slice(base.length))
}

/**
 * The temporary files of the writes this process has started and not finished. Any other temporary file
 * of a target was left by a write that never finished, because the app quit or crashed in the middle of
 * it, and ASIST runs as a single instance, so nothing will finish it. Nothing else would ever remove it,
 * and one left by a save of the secrets still holds a key the user may have deleted since.
 */
const unfinished = new Set<string>()

/** The temporary files among names, the entries of target's folder, that no write of this process is filling. */
function abandonedBeside(target: string, names: string[]): string[] {
  return names
    .filter((name) => isTemporaryOf(target, name))
    .map((name) => path.join(path.dirname(target), name))
    .filter((file) => !unfinished.has(file))
}

/** The save does not depend on the leftover, and the next save of the target tries again. */
const leftoverStays = (file: string, error: unknown): void => {
  console.warn(`atomic write: ${path.basename(file)} could not be removed:`, error)
}

/** The wait before the next attempt at the rename, or null when the error is final. */
function renameRetryWait(error: unknown, attempt: number): number | null {
  if (process.platform !== 'win32' || !isNodeError(error) || !TRANSIENT_RENAME_ERRORS.has(error.code ?? '')) return null
  return RENAME_WAITS_MS[attempt] ?? null
}

async function renameOver(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, target)
      return
    } catch (error) {
      const wait = renameRetryWait(error, attempt)
      if (wait === null) throw error
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

function renameOverSync(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fsSync.renameSync(temporary, target)
      return
    } catch (error) {
      const wait = renameRetryWait(error, attempt)
      if (wait === null) throw error
      // A synchronous caller has no event loop turn to give back, so the thread sleeps.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    }
  }
}

/**
 * Replaces target with the file that fill writes at the temporary path it is given. fill creates that
 * file itself, flushed to the disk before it resolves, and a fill that throws leaves the target as it was.
 */
export async function replaceFileAtomic(
  target: string,
  fill: (temporary: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const temporary = temporaryPathBeside(target)
  unfinished.add(temporary)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    for (const file of abandonedBeside(target, await fs.readdir(path.dirname(target)))) {
      await fs.rm(file, { force: true }).catch((error: unknown) => leftoverStays(file, error))
    }
    await fill(temporary)
    signal?.throwIfAborted()
    await renameOver(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    unfinished.delete(temporary)
  }
}

export function writeFileAtomic(target: string, data: string, signal?: AbortSignal): Promise<void> {
  return replaceFileAtomic(
    target,
    (temporary) => fs.writeFile(temporary, data, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx', flush: true, signal }),
    signal
  )
}

/** The same write for a caller that reads and writes synchronously. */
export function writeFileAtomicSync(target: string, data: string): void {
  fsSync.mkdirSync(path.dirname(target), { recursive: true })
  for (const file of abandonedBeside(target, fsSync.readdirSync(path.dirname(target)))) {
    try {
      fsSync.rmSync(file, { force: true })
    } catch (error) {
      leftoverStays(file, error)
    }
  }
  const temporary = temporaryPathBeside(target)
  try {
    fsSync.writeFileSync(temporary, data, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx', flush: true })
    renameOverSync(temporary, target)
  } catch (error) {
    try {
      fsSync.rmSync(temporary, { force: true })
    } catch {
      // A failure to remove the temporary file must not hide the save error, which matters more.
    }
    throw error
  }
}

/** A missing file returns null. Content that does not parse as JSON fails without touching the original file. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(errorText('app.storage.jsonBroken', { file: path.basename(filePath) }), { cause: error })
  }
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export function writeJsonFileAtomic(filePath: string, value: unknown, signal?: AbortSignal): Promise<void> {
  return writeFileAtomic(filePath, jsonText(value), signal)
}

export function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  writeFileAtomicSync(filePath, jsonText(value))
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
