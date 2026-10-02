import path from 'node:path'
import fs from 'node:fs'
import { carriesUrl, classifyFile, MAX_TEXT_BYTES, TEXT_KINDS, type FileEntry, type FileItem } from '@shared/files'
import { errorText } from '@shared/i18n/error-text'
import { errorMessage, t } from './i18n'

/**
 * The main-process side of the files card (show_files). It validates paths and reads files, and leaves
 * interpreting the content to the renderer's viewer.
 */

export { classifyFile } from '@shared/files'

/**
 * What allowedPath asks of the OS: its rules for writing a path, and the lookup that resolves a path's
 * links and spells each name as the disk stores it. Tests pass path.win32 with a disk of their own, so
 * that the Windows rules are checked on any OS.
 */
export interface PathSystem {
  path: typeof path.posix
  realpath: (target: string) => string
}

const NATIVE: PathSystem = { path, realpath: fs.realpathSync.native }

/**
 * The path to read for target when it lies under an allowed root, which are the jobs' working directories,
 * the memory folder and the folders allowed in the settings, or null when it does not. Both sides are
 * compared as the OS resolves them, so a link inside a root that points outside it, such as one checked into
 * a cloned repository, is refused, and so is a .. that climbs out of such a link. The caller reads the
 * returned path and never target itself, so that what is read is what was checked. When the OS refuses to
 * resolve target, the refusal is thrown for a target written under a root, and null is returned for any other.
 */
export function allowedPath(target: string, allowedRoots: readonly string[], system: PathSystem = NATIVE): string | null {
  const paths = system.path
  const windows = paths === path.win32
  if (!paths.isAbsolute(target)) return null
  const roots = allowedRoots.filter((root) => paths.isAbsolute(root))
  if (windows) {
    // NTFS opens "report.md:name" as the stream "name" of report.md, data that no listing of the folder shows.
    if (target.slice(paths.parse(target).root.length).includes(':')) return null
    // Resolving a path on a server connects to it and hands it the user's Windows credentials, so a target
    // written on a drive or a share that no root is written on is refused before the disk is asked. A link
    // under a root that points to another server is still followed.
    const volume = (p: string): string => paths.parse(paths.normalize(p)).root.toLowerCase()
    if (!roots.some((root) => volume(root) === volume(target))) return null
  }
  // Windows matches names regardless of letter case.
  const key = windows ? (p: string): string => p.toLowerCase() : (p: string): string => p
  // path.join leaves a single separator at the end, so a root such as "/" or "C:\" is a prefix of every path on it too.
  const under = (p: string, root: string | null): boolean =>
    root !== null && (key(p) === key(root) || key(p).startsWith(key(paths.join(root, paths.sep))))
  const resolveRoot = (root: string): string | null => {
    try {
      return realPath(root, system)
    } catch {
      // A root the OS refuses to resolve, such as the folder of a past job whose parent became unreadable,
      // allows nothing, and must not make the files under the other roots unreadable.
      return null
    }
  }
  let resolved: string | null
  try {
    resolved = realPath(target, system)
  } catch (error) {
    // The refusal is the answer for a target written under a root, which the user may be shown; any other lies
    // outside the roots whatever the OS says about it. Compared as text, a target that names its root in another
    // letter case or Unicode form is answered as outside, which reads nothing either way.
    const written = paths.resolve(target)
    if (roots.some((root) => under(written, paths.resolve(root)) || under(written, resolveRoot(root)))) throw error
    return null
  }
  const real = resolved
  return real !== null && roots.some((root) => under(real, resolveRoot(root))) ? real : null
}

/**
 * The absolute path the OS opens for target, spelled as the disk stores it. The names of the part that does
 * not exist are kept as written, so that the read that follows reports the file as missing; a . or .. among
 * them could never be reached, and the path is refused.
 */
function realPath(target: string, { path: paths, realpath }: PathSystem): string | null {
  // The path is not normalized as text first: path.resolve would collapse "link/.." to the folder that holds
  // the link, while the OS follows the link first and climbs out of its target.
  const missing: string[] = []
  let existing = target
  for (;;) {
    try {
      // fs.realpathSync keeps the letter case and the Unicode normalization the path was written in, while
      // the default APFS volume matches names regardless of both. The native call returns the names as they
      // are stored, so a Japanese folder name written in the other normalization form, or a name in another
      // letter case, still matches its root.
      const real = realpath(existing)
      return missing.some((name) => name === '.' || name === '..') ? null : paths.join(real, ...missing)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    }
    const parent = paths.dirname(existing)
    if (parent === existing) return null
    missing.unshift(paths.basename(existing))
    existing = parent
  }
}

/** How many entries of a folder an item carries. The item also says how many the folder holds. */
export const MAX_DIRECTORY_ENTRIES = 200

/** The contents of a folder, by name with folders first, leaving out hidden files and node_modules. */
export function listDirectory(dir: string): FileEntry[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push({ name: entry.name, path: full, kind: 'directory', sizeBytes: 0 })
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      out.push({ name: entry.name, path: full, kind: classifyFile(full), sizeBytes: size })
    }
  }
  out.sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'ja')
  })
  return out
}

/**
 * Turns one path asked for into a FileItem: checks it against the allowed roots and reads what it names. A path
 * that is refused or cannot be read comes back with the reason in `error`, so that the caller can still show the
 * other items.
 */
export function fileItem(target: string, allowedRoots: readonly string[], toUrl: (filePath: string) => string): FileItem {
  try {
    const allowed = allowedPath(target, allowedRoots)
    return allowed === null ? failedItem(target, t('files.errors.outsideRoots')) : readFileItem(allowed, toUrl)
  } catch (error) {
    return failedItem(target, errorMessage(failure(error)))
  }
}

/**
 * The path to show in Finder or File Explorer for target, checked as fileItem checks a path it reads. A path that
 * is refused, gone or closed to the app throws the reason the card gives it.
 */
export function revealablePath(target: string, allowedRoots: readonly string[]): string {
  let allowed: string | null
  try {
    allowed = allowedPath(target, allowedRoots)
    // showItemInFolder says nothing when the file is gone, as when it was removed after the card showed it.
    if (allowed !== null) fs.statSync(allowed)
  } catch (error) {
    throw new Error(failure(error))
  }
  if (allowed === null) throw new Error(errorText('files.errors.outsideRoots'))
  return allowed
}

/**
 * Reads a path that has passed allowedPath into a FileItem, and throws what the OS answers when it cannot.
 * `toUrl` builds the asist-file:// URL binary kinds are fetched over.
 */
export function readFileItem(filePath: string, toUrl: (filePath: string) => string): FileItem {
  const name = path.basename(filePath)
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    const entries = listDirectory(filePath)
    return {
      path: filePath,
      name,
      kind: 'directory',
      sizeBytes: 0,
      modifiedAt: stat.mtimeMs,
      entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
      entryCount: entries.length
    }
  }
  if (!stat.isFile()) return failedItem(filePath, t('files.errors.notAFile'))
  const kind = classifyFile(filePath)
  const base: FileItem = { path: filePath, name, kind, sizeBytes: stat.size, modifiedAt: stat.mtimeMs }
  if (TEXT_KINDS.has(kind)) {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      base.text = buffer.subarray(0, read).toString('utf8')
      base.truncated = stat.size > MAX_TEXT_BYTES
    } finally {
      fs.closeSync(fd)
    }
  }
  if (carriesUrl(kind, filePath)) base.url = toUrl(filePath)
  return base
}

const failedItem = (filePath: string, error: string): FileItem => ({ path: filePath, name: path.basename(filePath), kind: 'binary', sizeBytes: 0, error })

/** Why the OS could not resolve, open or list a path, as the text of an error written for the user. */
function failure(error: unknown): string {
  switch ((error as NodeJS.ErrnoException).code) {
    // A path that runs through a file, such as report.md/notes, names nothing either.
    case 'ENOENT':
    case 'ENOTDIR':
      return errorText('files.errors.missing')
    case 'EACCES':
    case 'EPERM':
      return errorText('files.errors.denied')
    default:
      return errorText('files.errors.readFailed', { message: String(error) })
  }
}
