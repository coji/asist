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

export interface NoteServiceOptions {
  /** Normally the notes folder inside app.getPath('userData'). */
  directory: string
  /** Moves a deleted note to the macOS Trash, so that a delete can still be undone from Finder. */
  trash: (filePath: string) => Promise<void>
  now?: () => Date
  random?: () => string
  /**
   * Receives each change once it has been written, and feeds the notes screen and the card. It is told
   * the one note that changed rather than every note, because reading 40,000 notes back after a save
   * took 1.3 to 3.1 s (Apple M5, 2026-10-02), inside the 2 s that add_note and the search_notes queued
   * behind it are given.
   */
  onChanged?: (change: NoteChange) => void
}

export interface NoteService {
  list(): Promise<NoteSummary[]>
  read(id: string): Promise<string>
  /** The notes containing every word of the query, newest change first. */
  search(query: string): Promise<NoteRecord[]>
  create(markdown: unknown, signal?: AbortSignal): Promise<NoteSummary>
  write(id: string, markdown: unknown, signal?: AbortSignal): Promise<NoteSummary>
  remove(id: string): Promise<void>
}

/**
 * The notes as markdown files in one folder, one file per note. The files are read again on every
 * call, so a note edited in another editor shows up as it is. Changes go through one queue, and a
 * write goes to a temporary file that is then renamed, so a note is never left half written.
 */
export function createNoteService(options: NoteServiceOptions): NoteService {
  const now = options.now ?? (() => new Date())
  const random = options.random ?? (() => randomBytes(2).toString('hex'))
  const fileOf = (id: string): string => path.join(options.directory, `${id}.md`)
  let tail: Promise<void> = Promise.resolve()

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
  const readAll = async (): Promise<NoteRecord[]> => {
    let names: string[]
    try {
      names = await fs.readdir(options.directory)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const ids = names.filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).filter(isNoteId)
    const records = await Promise.all(
      ids.map(async (id) => {
        const file = fileOf(id)
        const [markdown, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
        return { ...summarizeNote(id, markdown, stat.mtimeMs), markdown }
      })
    )
    return records.sort(byUpdated)
  }
  const summaries = async (): Promise<NoteSummary[]> => (await readAll()).map(({ markdown: _, ...summary }) => summary)
  const notify = (change: NoteChange): void => {
    try {
      options.onChanged?.(change)
    } catch (error) {
      console.warn('note change listener failed:', error)
    }
  }
  const save = async (id: string, markdown: string, signal?: AbortSignal): Promise<NoteSummary> => {
    const file = fileOf(id)
    await writeFileAtomic(file, markdown, signal)
    const note = summarizeNote(id, markdown, (await fs.stat(file)).mtimeMs)
    notify({ type: 'saved', note })
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

  return {
    list: () => enqueue(summaries),

    read: (id) =>
      enqueue(async () => {
        try {
          return await fs.readFile(fileOf(checkedId(id)), 'utf8')
        } catch (error) {
          if (isMissing(error)) throw new Error(errorText('notes.errors.notFound'))
          throw error
        }
      }),

    search: (query) => enqueue(async () => (await readAll()).filter((note) => noteMatches(note, query))),

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
        notify({ type: 'removed', id })
      })
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
