import path from 'node:path'
import fs from 'node:fs'
import { carriesUrl, classifyFile, MAX_TEXT_BYTES, TEXT_KINDS, type FileEntry, type FileItem } from '@shared/files'
import { t } from './i18n'

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
 * returned path and never target itself, so that what is read is what was checked.
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
  const resolved = realPath(target, system)
  if (resolved === null) return null
  // Windows matches names regardless of letter case.
  const key = windows ? (p: string): string => p.toLowerCase() : (p: string): string => p
  const allowed = roots.some((root) => {
    let resolvedRoot: string | null
    try {
      resolvedRoot = realPath(root, system)
    } catch {
      // A root the OS refuses to resolve, such as the folder of a past job whose parent became unreadable,
      // allows nothing, and must not make the files under the other roots unreadable. A target inside it
      // fails to resolve itself and throws above.
      return false
    }
    if (resolvedRoot === null) return false
    // path.join leaves a single separator at the end, so a root such as "/" or "C:\" is a prefix of every path on it too.
    return key(resolved) === key(resolvedRoot) || key(resolved).startsWith(key(paths.join(resolvedRoot, paths.sep)))
  })
  return allowed ? resolved : null
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

const MAX_DIRECTORY_ENTRIES = 200

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
  return out.slice(0, MAX_DIRECTORY_ENTRIES)
}

/**
 * Turns one path into a FileItem. A path that cannot be read comes back with the reason in `error`, so
 * that the caller can still show the other items. `toUrl` builds the asist-file:// URL binary kinds are
 * fetched over.
 */
export function readFileItem(filePath: string, toUrl: (filePath: string) => string): FileItem {
  const name = path.basename(filePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      path: filePath,
      name,
      kind: 'binary',
      sizeBytes: 0,
      error: code === 'ENOENT' ? t('files.errors.missing') : String(error)
    }
  }
  if (stat.isDirectory()) {
    try {
      return { path: filePath, name, kind: 'directory', sizeBytes: 0, modifiedAt: stat.mtimeMs, entries: listDirectory(filePath) }
    } catch (error) {
      return { path: filePath, name, kind: 'directory', sizeBytes: 0, error: t('files.errors.folderFailed', { message: String(error) }) }
    }
  }
  if (!stat.isFile()) return { path: filePath, name, kind: 'binary', sizeBytes: 0, error: t('files.errors.notAFile') }
  const kind = classifyFile(filePath)
  const base: FileItem = { path: filePath, name, kind, sizeBytes: stat.size, modifiedAt: stat.mtimeMs }
  if (TEXT_KINDS.has(kind)) {
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
        base.text = buffer.subarray(0, read).toString('utf8')
        base.truncated = stat.size > MAX_TEXT_BYTES
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      return { ...base, error: t('files.errors.readFailed', { message: String(error) }) }
    }
  }
  if (carriesUrl(kind, filePath)) base.url = toUrl(filePath)
  return base
}
