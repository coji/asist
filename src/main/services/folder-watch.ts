import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** The entries of a watched folder that may have changed, or everything in it. */
export type FolderChange = { names: string[] } | { all: true }

export interface FolderWatch {
  close(): void
}

/**
 * The wait from the first event to the report, so that one report serves all the events of one save (a
 * temporary file and its rename over the target). FSEvents holds events back for 50 ms (libuv 1.52), and of
 * ten saves, eight arrived in one batch and two in two batches 50 ms apart (Apple M5, 2026-10-02).
 */
const SETTLE_MS = 100

/**
 * FSEvents watches a path (libuv resolves it to its real path first), so on macOS an open watch goes on
 * reporting a folder put at that path in place of the one it was opened on, and reports the folder itself
 * being moved, removed, put back or replaced under its own name. It is opened again only when the real path
 * changes, as when the folder is moved elsewhere and a link to it is left in its place. Opening one loses
 * changes: libuv (1.52) makes the process's one FSEvents stream again whenever any watch is opened or
 * closed, on a thread of its own after fs.watch has returned, and what changes before that stream runs is
 * never reported. A note written into a replaced folder right after its watch was opened again went
 * unreported under load (Apple M5, 2026-10-02). ReadDirectoryChangesW watches the folder it was opened on,
 * wherever it is moved, and runs once fs.watch has returned, so on Windows the watch is opened again on the
 * folder now at the path.
 */
const WATCH_FOLLOWS_PATH = process.platform === 'darwin'

/**
 * A name in the 8.3 form Windows gives a long name for old programs, such as 202609~1.MD. libuv (1.52) passes
 * on the name of a removed or renamed entry as Windows reports it, which is this short name when the entry
 * was removed through it, so the entry's own name is not known.
 */
const SHORT_NAME = /^[^.~]{0,6}~\d{1,6}(\.[^.]{0,3})?$/

/** The folder at a path: its device and inode, and the real path a watch of it follows on macOS. */
interface Place {
  identity: string
  real: string
  /** The path is a link to a folder elsewhere. */
  linked: boolean
}

/**
 * Reports what may have changed in one folder, from fs.watch on macOS (FSEvents) and Windows
 * (ReadDirectoryChangesW). An event says only that something happened to a name: FSEvents reports a new
 * file, a write in place and a deletion all as 'rename', so the caller looks at each named entry itself.
 * The watch is not recursive, so an entry inside a subfolder is never reported.
 *
 * A report of everything means the caller has to look at the whole folder again: when Windows's buffer of
 * events overflowed (no name), when a name is a short 8.3 one, when FSEvents reports the folder itself (it
 * does so when it coalesced events below it, and when the folder was moved, removed or put back), when the
 * watch failed and was opened again, and when the folder at the path is another one than before. The next
 * report waits until onChange has settled, so that events arriving while the caller looks fold into one more
 * look.
 *
 * The parent folder is watched where the folder's own watch cannot see another folder put at the path: on
 * Windows, and on macOS once the path is a link or has no folder to watch. On macOS otherwise it is not,
 * since the folder's watch reports all of that under the folder's name, and a watch of the parent would bring
 * the events of every file beside the folder (Chromium's caches and the databases in userData) into the
 * process's FSEvents stream, where libuv drops them only after they have crossed into the process.
 */
export async function watchFolder(directory: string, onChange: (change: FolderChange) => Promise<void>): Promise<FolderWatch> {
  const ownName = path.basename(directory)
  let closed = false
  let folder: fs.FSWatcher | null = null
  // What the open watch of the folder follows: the real path on macOS, the folder's identity on Windows.
  let watched: string | null = null
  let parent: fs.FSWatcher | null = null
  // The identity of the folder last seen at the path, or null while there is none.
  let seen: string | null = null
  let names = new Set<string>()
  let everything = false
  let checkFolder = false
  let timer: NodeJS.Timeout | null = null
  // The reports run one after another, and each waits for the caller, so that two never open a watch at once
  // and a look that is still running is not followed by a queue of others.
  let flushing = Promise.resolve()

  const schedule = (): void => {
    timer ??= setTimeout(() => {
      flushing = flushing.then(flush).catch((error: unknown) => console.error('folder watch: a change could not be reported:', error))
    }, SETTLE_MS)
  }
  const stopFolder = (): void => {
    folder?.close()
    folder = null
    watched = null
  }
  const onFolderEvent = (_event: string, name: string | null): void => {
    if (name === null || SHORT_NAME.test(name)) everything = true
    else if (path.isAbsolute(name)) {
      // Windows names the folder by its full path when it is being deleted, and the deletion waits until
      // every handle on the folder is closed, this watch's included.
      stopFolder()
      checkFolder = true
    } else if (name === ownName) {
      checkFolder = true
      everything = true
    } else names.add(name)
    schedule()
  }
  const onFolderError = (error: Error): void => {
    console.warn('folder watch: the watch of the folder failed and is opened again:', error)
    stopFolder()
    checkFolder = true
    everything = true
    schedule()
  }
  const onParentEvent = (_event: string, name: string | null): void => {
    if (name !== null && name !== ownName) return
    checkFolder = true
    schedule()
  }
  const onParentError = (error: Error): void => {
    console.warn('folder watch: the watch of the parent folder failed and is opened again:', error)
    parent?.close()
    parent = null
    checkFolder = true
    everything = true
    schedule()
  }

  // Watches what is now at the path, and says whether it may differ from what was reported: another folder
  // than was last seen there, or a watch opened again, which saw nothing while it was closed.
  const follow = async (): Promise<boolean> => {
    const place = await placeOf(directory)
    if (closed) return false
    const replaced = (place?.identity ?? null) !== seen
    seen = place?.identity ?? null
    const target = place && (WATCH_FOLLOWS_PATH ? place.real : place.identity)
    let opened = false
    if (!(folder && (place ? target === watched : WATCH_FOLLOWS_PATH))) {
      stopFolder()
      try {
        if (place) {
          folder = fs.watch(directory, { persistent: false }, onFolderEvent)
          folder.on('error', onFolderError)
          watched = target
          opened = true
        }
      } catch (error) {
        if (!isMissing(error)) throw error
        seen = null
      }
    }
    if (!parent && (!WATCH_FOLLOWS_PATH || place?.linked || !folder)) {
      parent = fs.watch(path.dirname(directory), { persistent: false }, onParentEvent)
      parent.on('error', onParentError)
    }
    return replaced || opened
  }

  const flush = async (): Promise<void> => {
    timer = null
    const changed = names
    names = new Set()
    let all = everything
    everything = false
    try {
      if (checkFolder) {
        checkFolder = false
        if (await follow()) all = true
      }
    } catch (error) {
      console.error('folder watch: the folder could not be looked at:', error)
      all = true
    }
    if (closed) return
    if (all) await onChange({ all: true })
    else if (changed.size > 0) await onChange({ names: [...changed] })
  }

  const close = (): void => {
    closed = true
    if (timer) clearTimeout(timer)
    stopFolder()
    parent?.close()
    parent = null
  }
  try {
    await follow()
  } catch (error) {
    close()
    throw error
  }
  return { close }
}

/** The folder at the path, or null when there is none. */
async function placeOf(directory: string): Promise<Place | null> {
  try {
    const [stat, real, realParent] = await Promise.all([
      fsp.stat(directory, { bigint: true }),
      fsp.realpath(directory),
      fsp.realpath(path.dirname(directory))
    ])
    return { identity: `${stat.dev}:${stat.ino}`, real, linked: real !== path.join(realParent, path.basename(directory)) }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
