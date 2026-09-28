import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import {
  MAIL_FOLDERS,
  RECENT_WINDOW_MS,
  isDuplicateCopy,
  mailListQuerySchema,
  parseMailInput,
  snippetOf,
  type MailAddress,
  type MailAttachment,
  type MailFolder,
  type MailListResult,
  type MailMessage,
  type MailView
} from '@shared/mail'

/**
 * A cache of fetched mail in a single SQLite file. The server holds the authoritative copy, so this file
 * can always be thrown away and rebuilt. Listing, search and the unread counts are answered from here,
 * while a body is stored only once it has been fetched. UIDVALIDITY is remembered per folder, and a
 * folder whose UIDVALIDITY changed is dropped and fetched again.
 */

const SCHEMA_VERSION = 1

type Row = Record<string, SQLOutputValue>

export interface CachedFlags {
  unread: boolean
  starred: boolean
  answered: boolean
  labels: string[]
}

export interface MailFlagUpdate {
  uid: number
  unread: boolean
  starred: boolean
  answered: boolean
  labels: string[]
}

/** The body part numbers picked from the message's bodyStructure at fetch time, used to download the body. */
export interface MailBodyParts {
  textPart: string | null
  htmlPart: string | null
}

export interface MailCounts {
  unread: number
  unreadRecent: number
}

/** Escapes % and _ in the search term so that a LIKE pattern matches them as ordinary characters. */
const like = (query: string): string => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

function viewPredicate(view: MailView): string {
  switch (view) {
    case 'inbox':
      return "folder = 'inbox'"
    case 'sent':
      return "folder = 'sent'"
    case 'archive':
      return "folder = 'archive' AND duplicate = 0"
    case 'starred':
      return "starred = 1 AND (folder <> 'archive' OR duplicate = 0)"
  }
}

function rowToMessage(row: Row): MailMessage {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    folder: String(row.folder) as MailFolder,
    uid: Number(row.uid),
    messageId: String(row.message_id),
    threadId: String(row.thread_id),
    subject: String(row.subject),
    from: { name: String(row.from_name), address: String(row.from_address) },
    to: JSON.parse(String(row.to_json)) as MailAddress[],
    cc: JSON.parse(String(row.cc_json)) as MailAddress[],
    replyTo: JSON.parse(String(row.reply_to_json)) as MailAddress[],
    date: Number(row.date),
    snippet: String(row.snippet),
    unread: Number(row.unread) === 1,
    starred: Number(row.starred) === 1,
    answered: Number(row.answered) === 1,
    attachments: JSON.parse(String(row.attachments_json)) as MailAttachment[],
    size: Number(row.size),
    labels: JSON.parse(String(row.labels_json)) as string[],
    bodyFetched: Number(row.body_fetched) === 1
  }
}

const COLUMNS =
  'id, account_id, folder, uid, message_id, thread_id, subject, from_name, from_address, to_json, cc_json, reply_to_json, date, snippet, unread, starred, answered, attachments_json, size, labels_json, duplicate, body_fetched'

export class MailCache {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.initialize()
  }

  private initialize(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined
    if (row && Number(row.value) !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS folders; DELETE FROM meta')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        PRIMARY KEY (account_id, folder)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        reply_to_json TEXT NOT NULL,
        date INTEGER NOT NULL,
        snippet TEXT NOT NULL,
        unread INTEGER NOT NULL,
        starred INTEGER NOT NULL,
        answered INTEGER NOT NULL,
        attachments_json TEXT NOT NULL,
        size INTEGER NOT NULL,
        labels_json TEXT NOT NULL,
        duplicate INTEGER NOT NULL,
        body_fetched INTEGER NOT NULL,
        text_part TEXT,
        html_part TEXT,
        text TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (account_id, folder, date DESC, uid DESC);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (account_id, thread_id);
    `)
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  }

  close(): void {
    this.db.close()
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  uidValidity(accountId: string, folder: MailFolder): string | null {
    const row = this.db.prepare('SELECT uid_validity FROM folders WHERE account_id = ? AND folder = ?').get(accountId, folder) as Row | undefined
    return row ? String(row.uid_validity) : null
  }

  /** Records UIDVALIDITY. When it differs from the one recorded, everything cached for the folder is dropped and true is returned. */
  setUidValidity(accountId: string, folder: MailFolder, uidValidity: string): boolean {
    return this.transaction(() => {
      const current = this.uidValidity(accountId, folder)
      const dropped = current !== null && current !== uidValidity
      if (dropped) this.clearFolder(accountId, folder)
      this.db.prepare('INSERT OR REPLACE INTO folders (account_id, folder, uid_validity) VALUES (?, ?, ?)').run(accountId, folder, uidValidity)
      return dropped
    })
  }

  /** The uid, flags and labels already cached, which the sync compares against the server to find changes. */
  flagsIn(accountId: string, folder: MailFolder): Map<number, CachedFlags> {
    const rows = this.db.prepare('SELECT uid, unread, starred, answered, labels_json FROM messages WHERE account_id = ? AND folder = ?').all(accountId, folder) as Row[]
    return new Map(
      rows.map((row) => [
        Number(row.uid),
        { unread: Number(row.unread) === 1, starred: Number(row.starred) === 1, answered: Number(row.answered) === 1, labels: JSON.parse(String(row.labels_json)) as string[] }
      ])
    )
  }

  upsert(messages: ReadonlyArray<MailMessage & { parts: MailBodyParts }>): void {
    if (messages.length === 0) return
    const statement = this.db.prepare(
      `INSERT INTO messages (${COLUMNS}, text_part, html_part, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         message_id = excluded.message_id, thread_id = excluded.thread_id, subject = excluded.subject,
         from_name = excluded.from_name, from_address = excluded.from_address, to_json = excluded.to_json,
         cc_json = excluded.cc_json, reply_to_json = excluded.reply_to_json, date = excluded.date,
         unread = excluded.unread, starred = excluded.starred, answered = excluded.answered,
         attachments_json = excluded.attachments_json, size = excluded.size, labels_json = excluded.labels_json,
         duplicate = excluded.duplicate, text_part = excluded.text_part, html_part = excluded.html_part`
    )
    this.transaction(() => {
      for (const message of messages) {
        if (!MAIL_FOLDERS.includes(message.folder)) throw new Error(`unknown mail folder: ${message.folder}`)
        statement.run(
          message.id,
          message.accountId,
          message.folder,
          message.uid,
          message.messageId,
          message.threadId,
          message.subject,
          message.from.name,
          message.from.address,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          JSON.stringify(message.replyTo),
          message.date,
          message.snippet,
          message.unread ? 1 : 0,
          message.starred ? 1 : 0,
          message.answered ? 1 : 0,
          JSON.stringify(message.attachments),
          message.size,
          JSON.stringify(message.labels),
          isDuplicateCopy(message.folder, message.labels) ? 1 : 0,
          message.bodyFetched ? 1 : 0,
          message.parts.textPart,
          message.parts.htmlPart
        )
      }
    })
  }

  updateFlags(accountId: string, folder: MailFolder, updates: readonly MailFlagUpdate[]): void {
    if (updates.length === 0) return
    const statement = this.db.prepare(
      'UPDATE messages SET unread = ?, starred = ?, answered = ?, labels_json = ?, duplicate = ? WHERE account_id = ? AND folder = ? AND uid = ?'
    )
    this.transaction(() => {
      for (const update of updates) {
        statement.run(update.unread ? 1 : 0, update.starred ? 1 : 0, update.answered ? 1 : 0, JSON.stringify(update.labels), isDuplicateCopy(folder, update.labels) ? 1 : 0, accountId, folder, update.uid)
      }
    })
  }

  setFlags(id: string, flags: Partial<{ unread: boolean; starred: boolean; answered: boolean }>): void {
    const sets: string[] = []
    const values: Array<number | string> = []
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined) continue
      sets.push(`${key} = ?`)
      values.push(value ? 1 : 0)
    }
    if (!sets.length) return
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  removeUids(accountId: string, folder: MailFolder, uids: readonly number[]): void {
    if (uids.length === 0) return
    const statement = this.db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid = ?')
    this.transaction(() => {
      for (const uid of uids) statement.run(accountId, folder, uid)
    })
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  clearFolder(accountId: string, folder: MailFolder): void {
    this.db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folder)
    this.db.prepare('DELETE FROM folders WHERE account_id = ? AND folder = ?').run(accountId, folder)
  }

  clearAccount(accountId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM folders WHERE account_id = ?').run(accountId)
    })
  }

  setBody(id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ?, snippet = ?, body_fetched = 1 WHERE id = ?').run(text, snippetOf(text), id)
  }

  get(id: string): MailMessage | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id) as Row | undefined
    return row ? rowToMessage(row) : null
  }

  /** Returns null when the body has not been fetched yet. */
  body(id: string): string | null {
    const row = this.db.prepare('SELECT text, body_fetched FROM messages WHERE id = ?').get(id) as Row | undefined
    if (!row || Number(row.body_fetched) !== 1) return null
    return String(row.text ?? '')
  }

  /** The messages whose body is still missing, newest first, leaving out the uids in `skip`. */
  pendingBodies(accountId: string, folder: MailFolder, limit: number, skip: readonly number[]): Array<{ uid: number } & MailBodyParts> {
    const rows = this.db
      .prepare(
        'SELECT uid, text_part, html_part FROM messages WHERE account_id = ? AND folder = ? AND body_fetched = 0 AND uid NOT IN (SELECT value FROM json_each(?)) ORDER BY date DESC, uid DESC LIMIT ?'
      )
      .all(accountId, folder, JSON.stringify(skip), limit) as Row[]
    return rows.map((row) => ({ uid: Number(row.uid), textPart: row.text_part === null ? null : String(row.text_part), htmlPart: row.html_part === null ? null : String(row.html_part) }))
  }

  /** Returns null when the message itself is not in the cache. */
  bodyParts(id: string): MailBodyParts | null {
    const row = this.db.prepare('SELECT text_part, html_part FROM messages WHERE id = ?').get(id) as Row | undefined
    if (!row) return null
    return { textPart: row.text_part === null ? null : String(row.text_part), htmlPart: row.html_part === null ? null : String(row.html_part) }
  }

  list(value: unknown): MailListResult {
    const query = parseMailInput(mailListQuerySchema, value)
    const where = [viewPredicate(query.view)]
    const params: Array<string | number> = []
    if (query.accountId) {
      where.push('account_id = ?')
      params.push(query.accountId)
    }
    if (query.unreadOnly) where.push('unread = 1')
    if (query.query) {
      where.push("(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')")
      const pattern = like(query.query)
      params.push(pattern, pattern, pattern, pattern, pattern)
    }
    const counts = this.db.prepare(`SELECT COUNT(*) AS n, SUM(unread) AS unread FROM messages WHERE ${where.join(' AND ')}`).get(...params) as Row
    const total = Number(counts.n)
    const unread = Number(counts.unread ?? 0)
    // Several messages can share a date, since a Date header counts whole seconds, and the same date and
    // uid can recur across accounts and folders. The id completes the order, so a page that ends inside
    // such a run continues exactly where it stopped.
    if (query.before !== null) {
      where.push('(date, uid, id) < (?, ?, ?)')
      params.push(query.before.date, query.before.uid, query.before.id)
    }
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY date DESC, uid DESC, id DESC LIMIT ?`)
      .all(...params, query.limit) as Row[]
    return { messages: rows.map(rowToMessage), total, unread }
  }

  /** Every message of the thread, oldest first, leaving out the archive copies of messages in another folder. */
  thread(accountId: string, threadId: string): MailMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE account_id = ? AND thread_id = ? AND (folder <> 'archive' OR duplicate = 0) ORDER BY date ASC, uid ASC`)
      .all(accountId, threadId) as Row[]
    return rows.map(rowToMessage)
  }

  /** The unread messages in the inbox, and how many of them arrived within RECENT_WINDOW_MS of now. */
  counts(accountId: string, now: number): MailCounts {
    const row = this.db
      .prepare("SELECT COUNT(*) AS unread, SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS recent FROM messages WHERE account_id = ? AND folder = 'inbox' AND unread = 1")
      .get(now - RECENT_WINDOW_MS, accountId) as Row
    return { unread: Number(row.unread ?? 0), unreadRecent: Number(row.recent ?? 0) }
  }
}

