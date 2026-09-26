import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { MAX_MAIL_DRAFTS, mailDraftPatchSchema, parseMailInput, replySubject, type MailDraft } from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { writeJsonFileAtomicSync } from './atomic-json'
import { openStoredFileSync } from './stored-file'

export const DRAFTS_FORMAT: StoredFormat<MailDraft[]> = {
  name: 'mail-drafts.json',
  version: 3,
  upgrades: {
    // A version 1 reply held only the message it answered, and its recipients were decided when it was
    // sent. Nothing in the file says where it would have gone, so it becomes a new message with an empty
    // To, which the user fills in before it can be sent.
    1: (content) => {
      const drafts = (content as { drafts?: unknown } | null)?.drafts
      if (!Array.isArray(drafts)) throw new Error('drafts is not a list')
      return {
        drafts: drafts.map((draft: { reply?: { subject?: unknown } | null }) =>
          draft.reply ? { ...draft, to: [], cc: [], subject: replySubject(String(draft.reply.subject ?? '')), reply: null } : draft
        )
      }
    },
    // Version 2 recorded no send. A draft still in the file was either never sent or sent while its removal
    // failed, and nothing tells the two apart, so each is taken as not sent, as version 2 did.
    2: (content) => {
      const drafts = (content as { drafts?: unknown } | null)?.drafts
      if (!Array.isArray(drafts)) throw new Error('drafts is not a list')
      return { drafts: drafts.map((draft: object) => ({ ...draft, sendStartedAt: null })) }
    }
  },
  parse: (content) => {
    const drafts = (content as { drafts?: unknown } | null)?.drafts
    if (!Array.isArray(drafts)) throw new Error('drafts is not a list')
    return drafts as MailDraft[]
  },
  serialize: (drafts) => ({ drafts })
}

/**
 * Mail drafts, both the ones an Agent wrote and the ones the user is still typing, in a single JSON
 * file. Sending cannot be undone, so a draft lives in main and survives a restart instead of living in
 * the props of a card that can disappear. It is kept apart from the mail cache, which is a SQLite file
 * that can always be rebuilt from the server.
 */

export interface MailDraftStoreOptions {
  filePath: string
  now?: () => number
  createId?: () => string
  /** Receives every draft once a save has completed, and feeds the renderer's screen and cards. */
  onChanged?: (drafts: MailDraft[]) => void
}

export type MailDraftSeed = Omit<MailDraft, 'id' | 'createdAt' | 'updatedAt' | 'sendStartedAt'>

export class MailDraftStore {
  private drafts: MailDraft[] | null = null

  constructor(private readonly options: MailDraftStoreOptions) {
    if (!options.filePath.trim()) throw new Error('mail drafts file path is required')
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private load(): MailDraft[] {
    if (this.drafts) return this.drafts
    try {
      const raw = fs.readFileSync(this.options.filePath, 'utf8')
      this.drafts = openStoredFileSync(this.options.filePath, JSON.parse(raw) as unknown, DRAFTS_FORMAT)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(errorText('mail.errors.draft.fileUnreadable', { reason: (error as Error).message }))
      this.drafts = []
    }
    return this.drafts
  }

  /** Writes through a temporary file and a rename, and leaves the in-memory state behind if the write fails. */
  private commit(next: MailDraft[]): void {
    writeJsonFileAtomicSync(this.options.filePath, storedContent(DRAFTS_FORMAT, next))
    this.drafts = next
    this.options.onChanged?.(next.map((draft) => ({ ...draft })))
  }

  list(): MailDraft[] {
    return this.load().map((draft) => ({ ...draft }))
  }

  get(id: string): MailDraft | null {
    const draft = this.load().find((candidate) => candidate.id === id)
    return draft ? { ...draft } : null
  }

  require(id: string): MailDraft {
    const draft = this.get(id)
    if (!draft) throw new Error(errorText('mail.errors.draft.gone'))
    return draft
  }

  create(seed: MailDraftSeed): MailDraft {
    const current = this.load()
    if (current.length >= MAX_MAIL_DRAFTS) throw new Error(errorText('mail.errors.draft.tooMany', { count: MAX_MAIL_DRAFTS }))
    const now = this.now()
    const draft: MailDraft = { ...seed, id: this.options.createId?.() ?? randomUUID(), createdAt: now, updatedAt: now, sendStartedAt: null }
    this.commit([draft, ...current])
    return { ...draft }
  }

  update(id: string, patchValue: unknown): MailDraft {
    const patch = parseMailInput(mailDraftPatchSchema, patchValue)
    const current = this.load()
    const index = current.findIndex((draft) => draft.id === id)
    if (index < 0) throw new Error(errorText('mail.errors.draft.gone'))
    const before = current[index]
    // A reply draft keeps the recipients and the subject settled from the message it answers, so only
    // the body can be edited.
    const allowed = before.reply ? { body: patch.body } : patch
    const next: MailDraft = { ...before, ...stripUndefined(allowed), updatedAt: this.now() }
    this.commit(current.map((draft, at) => (at === index ? next : draft)))
    return { ...next }
  }

  /** Records that a send started, or with null that it failed. updatedAt stays, since it follows edits of the text. */
  setSendStartedAt(id: string, at: number | null): MailDraft {
    const current = this.load()
    const index = current.findIndex((draft) => draft.id === id)
    if (index < 0) throw new Error(errorText('mail.errors.draft.gone'))
    const next: MailDraft = { ...current[index], sendStartedAt: at }
    this.commit(current.map((draft, position) => (position === index ? next : draft)))
    return { ...next }
  }

  remove(id: string): MailDraft {
    const current = this.load()
    const draft = current.find((candidate) => candidate.id === id)
    if (!draft) throw new Error(errorText('mail.errors.draft.gone'))
    this.commit(current.filter((candidate) => candidate.id !== id))
    return { ...draft }
  }
}

const stripUndefined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
