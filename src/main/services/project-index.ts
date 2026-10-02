import fs from 'node:fs'
import path from 'node:path'
import { samePath } from '@shared/file-path'
import {
  matchProjects,
  recentProjects,
  upsertProject,
  type ProjectCandidate,
  type ProjectEntry
} from '@shared/project-index'
import { z } from 'zod'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { isFullPath } from './full-path'
import { dataPath, writeJson } from './store'
import { openStoredFileSync } from './stored-file'
import { errorText } from '@shared/i18n/error-text'

/**
 * The project index in userData/projects.json. It maps a name to a path and is what the resolve_project
 * tool reads. It grows only from what has actually been used, a job started with an explicit cwd, and
 * from the user asking to remember a folder. Nothing is ever discovered by scanning the disk.
 */

const FILE = 'projects.json'

const entrySchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  aliases: z.array(z.string()),
  lastUsedAt: z.number(),
  source: z.enum(['job', 'told'])
})

export const PROJECTS_FORMAT: StoredFormat<ProjectEntry[]> = {
  name: FILE,
  version: 1,
  upgrades: {},
  parse: (content) => z.array(entrySchema).parse((content as { entries?: unknown } | null)?.entries),
  serialize: (entries) => ({ entries })
}

let cache: ProjectEntry[] | null = null

/** Only a missing file counts as no project yet, so that an unreadable one is never replaced by an empty list. */
function load(): ProjectEntry[] {
  if (cache) return cache
  const file = dataPath(FILE)
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cache = [])
    throw error
  }
  let stored: unknown
  try {
    stored = JSON.parse(source)
  } catch (error) {
    throw new Error(errorText('app.storage.jsonBroken', { file: FILE }), { cause: error })
  }
  return (cache = openStoredFileSync(file, stored, PROJECTS_FORMAT))
}

function persist(entries: ProjectEntry[]): void {
  writeJson(FILE, storedContent(PROJECTS_FORMAT, entries))
  cache = entries
}

export function list(): ProjectEntry[] {
  return [...load()]
}

/** Records that a job was started with this path as an explicit cwd. */
export function noteUsed(folder: string, now = Date.now()): void {
  persist(upsertProject(load(), { path: folder, source: 'job', now }))
}

/**
 * Registers a folder the user asked to remember, as in "このフォルダ覚えて". Only the full path of an existing
 * directory is accepted: a relative one would be resolved against the app's own folder, which is / when the
 * app is opened from Finder.
 */
export function register(name: string, folder: string, now = Date.now()): ProjectEntry {
  if (!isFullPath(folder)) throw new Error(errorText('app.storage.folderNotFull', { path: folder }))
  const resolved = path.resolve(folder)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(errorText('app.storage.projectDirMissing', { path: resolved }))
  }
  const entries = upsertProject(load(), { path: resolved, name, source: 'told', now })
  persist(entries)
  return entries.find((e) => samePath(e.path, resolved))!
}

export function resolve(query: string, limit = 3): ProjectCandidate[] {
  return matchProjects(load(), query, { limit })
}

export function recent(limit = 5): ProjectEntry[] {
  return recentProjects(load(), limit)
}

export function resetForTest(): void {
  cache = null
}
