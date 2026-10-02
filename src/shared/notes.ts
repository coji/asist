import { errorText } from './i18n/error-text'

/**
 * The notes the user keeps. One note is one markdown file whose name is its id, and the id carries the
 * time the note was created, so the file holds nothing but what the user wrote.
 */

export const MAX_NOTE_CHARS = 100_000
const EXCERPT_CHARS = 160

export interface NoteSummary {
  id: string
  /** The first heading, or the first line when there is no heading. */
  title: string
  /** The text after the title on one line, cut to a length a list row can show. */
  excerpt: string
  createdAt: number
  updatedAt: number
}

/** A note with its body, as a search reads it. */
export interface NoteRecord extends NoteSummary {
  markdown: string
}

const NOTE_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{4})$/

/**
 * An id like 20260923-153012-a1b2: the local time of creation to the second and four random hex
 * digits. The pattern also keeps a path out of a file name handed in from the renderer or a tool.
 */
export function noteIdOf(at: Date, random: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${day}-${time}-${random}`
}

export function isNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID.test(value)
}

/** The creation time the id carries, in local time. */
export function noteCreatedAt(id: string): number {
  const match = NOTE_ID.exec(id)
  if (!match) throw new Error(errorText('notes.errors.idRequired'))
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** Rejects a body that is not text, is only whitespace or is too long, rather than trimming it to fit. */
export function normalizeNoteMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new Error(errorText('notes.errors.textType'))
  const markdown = value.replace(/\r\n?/g, '\n').trimEnd()
  if (!markdown.trim()) throw new Error(errorText('notes.errors.empty'))
  if (markdown.length > MAX_NOTE_CHARS) throw new Error(errorText('notes.errors.tooLong', { limit: MAX_NOTE_CHARS }))
  return `${markdown}\n`
}

/** Strips the markdown marks from one line so that a title or an excerpt reads as plain text. */
function plain(line: string): string {
  // The rule under a table header says nothing, and the cells of a row read as words side by side.
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return ''
  return line
    .replace(/^\s*\|(.*)\|\s*$/, (_, cells: string) => cells.split('|').map((cell) => cell.trim()).join(' '))
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .trim()
}

export function summarizeNote(id: string, markdown: string, updatedAt: number): NoteSummary {
  const lines = markdown.split('\n').filter((line) => line.trim() && !/^\s*(```|---\s*$)/.test(line))
  const headingIndex = lines.findIndex((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
  const titleIndex = headingIndex >= 0 ? headingIndex : 0
  const title = plain(lines[titleIndex] ?? '')
  const rest = lines
    .filter((_, i) => i !== titleIndex)
    .map(plain)
    .filter(Boolean)
    .join(' ')
  const excerpt = rest.length > EXCERPT_CHARS ? `${rest.slice(0, EXCERPT_CHARS)}…` : rest
  return { id, title, excerpt, createdAt: noteCreatedAt(id), updatedAt }
}

/** Every word of the query must appear in the note, ignoring case. An empty query matches every note. */
export function noteMatches(note: NoteRecord, query: string): boolean {
  const haystack = note.markdown.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

/** The newest change first. */
export function byUpdated(a: NoteSummary, b: NoteSummary): number {
  return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
}

/** One change main has written: a note saved, new or rewritten, or a note moved to the trash. */
export type NoteChange = { type: 'saved'; note: NoteSummary } | { type: 'removed'; id: string }

/** The list of notes, newest change first, after one change. */
export function applyNoteChange(notes: NoteSummary[], change: NoteChange): NoteSummary[] {
  if (change.type === 'removed') return notes.filter((note) => note.id !== change.id)
  return [...notes.filter((note) => note.id !== change.note.id), change.note].sort(byUpdated)
}
