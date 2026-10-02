import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'
import {
  byUpdated,
  isNoteId,
  noteIdOf,
  noteMatches,
  normalizeNoteMarkdown,
  summarizeNote,
  type NoteChange,
  type NoteRecord,
  type NoteSummary
} from '@shared/notes'
import { writeFileAtomic } from './atomic-json'
import { watchFolder, type FolderChange, type FolderWatch } from './folder-watch'

export interface NoteServiceOptions {
  /** Normally the notes folder inside app.getPath('userData'). */
  directory: string
  /** Moves a deleted note to the macOS Trash, so that a delete can still be undone from Finder. */
  trash: (filePath: string) => Promise<void>
  now?: () => Date
  random?: () => string
  /**
   * Receives the changes of one save, or of one look at what changed in the folder outside ASIST, once they
   * are written or seen, and feeds the notes screen and the card. It is told the notes that changed rather
   * than every note, because reading 40,000 notes back after a save took 1.3 to 3.1 s (Apple M5,
   * 2026-10-02), inside the 2 s that add_note and the search_notes queued behind it are given.
   */
  onChanged?: (changes: NoteChange[]) => void
}

export interface NoteService {
  list(): Promise<NoteSummary[]>
  read(id: string): Promise<string>
  /** The notes containing every word of the query, newest change first. */
  search(query: string): Promise<NoteRecord[]>
  create(markdown: unknown, signal?: AbortSignal): Promise<NoteSummary>
  write(id: string, markdown: unknown, signal?: AbortSignal): Promise<NoteSummary>
  remove(id: string): Promise<void>
  /** Stops watching the folder and lets go of the notes held. A later call reads the folder again. */
  close(): void
}

/** A note as the service holds it, with the size of its file, which tells a change on disk from a note already held. */
interface HeldNote {
  record: NoteRecord
  size: number
}

/**
 * The notes as markdown files in one folder, one file per note. The first call reads every note into
 * memory, and the list, a search and a read are answered from there: reading the folder on every search
 * took 0.85 to 7.8 s with 40,000 notes, past the 2 s search_notes is given, and holding them takes about
 * 28 MB of heap (notes of 659 bytes on average, Apple M5 under load from other work, 2026-10-02). The
 * service's own saves update what it holds, and a watch of the folder brings in a note added, edited,
 * restored or deleted outside ASIST, which onChanged then passes on. A note's file is read again only when
 * its size or modification time differs from what is held. Changes go through one queue, and a write goes to
 * a temporary file that is then renamed, so a note is never left half written.
 */
export function createNoteService(options: NoteServiceOptions): NoteService {
  const now = options.now ?? (() => new Date())
  const random = options.random ?? (() => randomBytes(2).toString('hex'))
  const fileOf = (id: string): string => path.join(options.directory, `${id}.md`)
  let tail: Promise<void> = Promise.resolve()
  let held: Map<string, HeldNote> | null = null
  // The error of each note whose file could not be read when it was first looked at, which a read of it gives.
  const unreadable = new Map<string, unknown>()
  let watch: FolderWatch | null = null
  // Counts the closes, so that a first read of the folder that a close overtook leaves nothing watching.
  let closes = 0

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const checkedId = (value: string): string => {
    if (!isNoteId(value)) throw new Error(errorText('notes.errors.idRequired'))
    return value
  }
  const notify = (changes: NoteChange[]): void => {
    if (changes.length === 0) return
    try {
      options.onChanged?.(changes)
    } catch (error) {
      console.warn('note change listener failed:', error)
    }
  }

  // Compares one note's file with what is held, takes in what differs, and returns the change, if any.
  const look = async (notes: Map<string, HeldNote>, id: string): Promise<NoteChange | null> => {
    const file = fileOf(id)
    const known = notes.get(id)
    const gone = (): NoteChange | null => {
      unreadable.delete(id)
      return notes.delete(id) ? { type: 'removed', id } : null
    }
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) return gone()
      if (known && known.record.updatedAt === stat.mtimeMs && known.size === stat.size) return null
      const markdown = await fs.readFile(file, 'utf8')
      const note = summarizeNote(id, markdown, stat.mtimeMs)
      notes.set(id, { record: { ...note, markdown }, size: stat.size })
      unreadable.delete(id)
      return { type: 'saved', note }
    } catch (error) {
      if (isMissing(error)) return gone()
      unreadable.set(id, error)
      throw error
    }
  }
  // A note whose file cannot be read is left as it was held and its error is returned beside the changes
  // found, so that the changes taken in are still passed on.
  const lookAt = async (notes: Map<string, HeldNote>, ids: string[] | 'all'): Promise<{ changes: NoteChange[]; failures: unknown[] }> => {
    const changes: NoteChange[] = []
    let named = ids
    if (named === 'all') {
      const onDisk = new Set(noteIdsIn(await namesIn(options.directory)))
      for (const id of notes.keys()) {
        if (onDisk.has(id)) continue
        notes.delete(id)
        changes.push({ type: 'removed', id })
      }
      named = [...onDisk]
    }
    const results = await Promise.allSettled(named.map((id) => look(notes, id)))
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) changes.push(result.value)
    }
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown)
    return { changes, failures }
  }
  const follow = (change: FolderChange): Promise<void> =>
    enqueue(async () => {
      if (!held) return
      const { changes, failures } = await lookAt(held, 'all' in change ? 'all' : noteIdsIn(change.names))
      notify(changes)
      for (const error of failures) console.error('notes: a note changed outside ASIST could not be read:', error)
    }).catch((error: unknown) => console.error('notes: the notes folder could not be read after a change outside ASIST:', error))
  // The watch starts before the folder is read, so that no change made during the read is missed. The folder
  // is made first, so that its watch opens now and not again at the first save: on macOS every watch opened
  // or closed in the process leaves a moment in which changes go unreported. A note that cannot be read is
  // left out, and a read of it gives its error, so that it takes no other note down with it.
  const ready = async (): Promise<Map<string, HeldNote>> => {
    if (held) return held
    const begun = closes
    const notes = new Map<string, HeldNote>()
    unreadable.clear()
    await fs.mkdir(options.directory, { recursive: true })
    const started = await watchFolder(options.directory, follow)
    let looked: Awaited<ReturnType<typeof lookAt>>
    try {
      looked = await lookAt(notes, 'all')
    } catch (error) {
      started.close()
      throw error
    }
    for (const error of looked.failures) console.error('notes: a note could not be read:', error)
    if (begun !== closes) {
      started.close()
      return notes
    }
    watch = started
    held = notes
    return notes
  }

  const save = async (id: string, markdown: string, signal?: AbortSignal): Promise<NoteSummary> => {
    // The stat is of the file as it was renamed into place, so the watch, which sees this write as well,
    // finds the file as it is held and reads nothing.
    const written = await writeFileAtomic(fileOf(id), markdown, signal)
    const note = summarizeNote(id, markdown, written.mtimeMs)
    held?.set(id, { record: { ...note, markdown }, size: written.size })
    notify([{ type: 'saved', note }])
    return note
  }
  const exists = async (id: string): Promise<boolean> => {
    try {
      await fs.access(fileOf(id))
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }
  const records = async (): Promise<NoteRecord[]> => [...(await ready()).values()].map((note) => note.record)

  return {
    list: () => enqueue(async () => (await records()).map(({ markdown: _, ...summary }) => summary).sort(byUpdated)),

    read: (id) =>
      enqueue(async () => {
        const checked = checkedId(id)
        const note = (await ready()).get(checked)
        if (note) return note.record.markdown
        if (unreadable.has(checked)) throw unreadable.get(checked)
        throw new Error(errorText('notes.errors.notFound'))
      }),

    search: (query) => enqueue(async () => (await records()).filter((note) => noteMatches(note, query)).sort(byUpdated)),

    create: (value, signal) =>
      enqueue(async () => {
        const markdown = normalizeNoteMarkdown(value)
        const at = now()
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const id = noteIdOf(at, random())
          if (!(await exists(id))) return save(id, markdown, signal)
        }
        throw new Error(errorText('notes.errors.createFailed'))
      }),

    write: (id, value, signal) =>
      enqueue(async () => {
        const markdown = normalizeNoteMarkdown(value)
        if (!(await exists(checkedId(id)))) throw new Error(errorText('notes.errors.notFound'))
        return save(id, markdown, signal)
      }),

    remove: (id) =>
      enqueue(async () => {
        if (!(await exists(checkedId(id)))) throw new Error(errorText('notes.errors.notFound'))
        await options.trash(fileOf(id))
        held?.delete(id)
        notify([{ type: 'removed', id }])
      }),

    close: () => {
      closes += 1
      watch?.close()
      watch = null
      held = null
      unreadable.clear()
    }
  }
}

/** The ids of the note files among the names in the folder. Any other file there is not a note. */
function noteIdsIn(names: string[]): string[] {
  return names.filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).filter(isNoteId)
}

async function namesIn(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
