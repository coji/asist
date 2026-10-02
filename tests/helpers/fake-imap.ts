import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { FetchMessageObject, FetchQueryObject, ListResponse, MailboxObject, MessageEnvelopeObject, MessageStructureObject } from 'imapflow'
import type { ImapClient } from '../../src/main/services/mail-imap'

/**
 * A fake imapflow client over in-memory folders. It covers what the sync and the service use: connect,
 * list, open, UID search, fetch, download, flags, move and append. A body is held as text / html strings
 * and served by bodyStructure part number ('1' is text, '2' is html).
 */

export interface FakeMail {
  uid: number
  flags?: string[]
  labels?: string[]
  threadId?: string
  subject?: string
  from?: MessageEnvelopeObject['from']
  to?: MessageEnvelopeObject['to']
  cc?: MessageEnvelopeObject['cc']
  replyTo?: MessageEnvelopeObject['replyTo']
  messageId?: string
  inReplyTo?: string
  references?: string
  date: Date
  size?: number
  text?: string
  /** The HTML part as the server hands it over; bytes stand for a part whose MIME header names no charset, which imapflow passes on unconverted. */
  html?: string | Buffer
  attachments?: Array<{ filename: string; type: string; size: number }>
  /** True for a broken mail that has no bodyStructure. */
  noStructure?: boolean
}

interface Stored extends FakeMail {
  flags: string[]
}

export interface FakeFolder {
  uidValidity: bigint
  specialUse?: string
  messages: Map<number, Stored>
  nextUid: number
}

export class FakeImap extends EventEmitter {
  usable = false
  capabilities = new Map<string, boolean | number>()
  mailbox: MailboxObject | false = false
  readonly folders: Map<string, FakeFolder>
  readonly calls: string[] = []
  failConnect: Error | null = null
  /** The uids whose download fails. */
  failDownload = new Set<number>()
  /** True while the server answers every SEARCH with NO. */
  failSearch = false
  /**
   * True once the connection has gone silent, as one kept across the machine's sleep: the socket still looks
   * open, every command waits for an answer that never comes, and only closing the connection ends the wait.
   */
  silent = false
  /**
   * True while a new connection, made by reconnectable() as well, never finishes its handshake. Closing it does
   * not end the wait either, as with imapflow closed during DNS, TCP connect or the TLS handshake.
   */
  hangConnect = false
  /** The bytes received from the server, which stats() reports. A test adds to it for data still arriving. */
  received = 0
  private readonly unanswered: Array<(error: Error) => void> = []
  private readonly gmail: boolean
  private currentPath = ''

  constructor(options: { gmail?: boolean; folders?: Map<string, FakeFolder> } = {}) {
    super()
    this.gmail = Boolean(options.gmail)
    if (options.gmail) this.capabilities.set('X-GM-EXT-1', true)
    this.folders = options.folders ?? new Map()
    if (!this.folders.has('INBOX')) this.addFolder('INBOX', { specialUse: '\\Inbox' })
  }

  /**
   * Reconnects to the same server, that is the same folders. The real library makes a new client per
   * connection, so a new fake is returned once the previous one has dropped. Every fake stays in `instances`.
   */
  reconnectable(): { next: () => FakeImap; instances: FakeImap[] } {
    const instances: FakeImap[] = [this]
    return {
      instances,
      next: () => {
        const last = instances[instances.length - 1]
        if (!last.usable && last.calls.includes('connect')) {
          const created = new FakeImap({ gmail: this.gmail, folders: this.folders })
          created.failConnect = this.failConnect
          created.hangConnect = this.hangConnect
          instances.push(created)
        }
        return instances[instances.length - 1]
      }
    }
  }

  addFolder(path: string, options: { specialUse?: string; uidValidity?: bigint } = {}): FakeFolder {
    const folder: FakeFolder = { uidValidity: options.uidValidity ?? 1n, specialUse: options.specialUse, messages: new Map(), nextUid: 1 }
    this.folders.set(path, folder)
    return folder
  }

  /** Puts a mail into the folder. Without a uid it gets the next number. */
  put(path: string, mail: Omit<FakeMail, 'uid'> & { uid?: number }): Stored {
    const folder = this.requireFolder(path)
    const uid = mail.uid ?? folder.nextUid
    folder.nextUid = Math.max(folder.nextUid, uid + 1)
    const stored: Stored = { ...mail, uid, flags: mail.flags ?? [] }
    folder.messages.set(uid, stored)
    return stored
  }

  /** Announces an arrival in the open folder, as the `exists` event of IDLE does. */
  arrive(path: string, mail: Omit<FakeMail, 'uid'> & { uid?: number }): Stored {
    const stored = this.put(path, mail)
    if (this.currentPath === path) this.emit('exists', { path, count: this.requireFolder(path).messages.size, prevCount: this.requireFolder(path).messages.size - 1 })
    return stored
  }

  drop(reason = 'connection lost'): void {
    this.usable = false
    this.emit('error', new Error(reason))
    this.emit('close')
  }

  asClient(): ImapClient {
    return this as unknown as ImapClient
  }

  async connect(): Promise<void> {
    this.calls.push('connect')
    if (this.failConnect) throw this.failConnect
    if (this.hangConnect) await new Promise<never>(() => undefined)
    this.usable = true
  }

  async noop(): Promise<void> {
    this.calls.push('noop')
    await this.answer()
    this.received += 20
  }

  stats(): { sent: number; received: number } {
    return { sent: 0, received: this.received }
  }

  async logout(): Promise<void> {
    this.calls.push('logout')
    await this.answer()
    this.usable = false
    this.emit('close')
  }

  close(): void {
    for (const reject of this.unanswered.splice(0)) reject(new Error('Connection not available'))
    if (!this.usable) return
    this.usable = false
    this.emit('close')
  }

  private async answer(): Promise<void> {
    if (this.silent) await new Promise<never>((_, reject) => this.unanswered.push(reject))
  }

  async list(): Promise<ListResponse[]> {
    this.calls.push('list')
    await this.answer()
    return [...this.folders.entries()].map(([path, folder]) => ({
      path,
      pathAsListed: path,
      name: path.split('/').pop() ?? path,
      delimiter: '/',
      parent: [],
      parentPath: '',
      flags: new Set<string>(),
      specialUse: folder.specialUse,
      listed: true,
      subscribed: true
    }))
  }

  async getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
    const folder = this.requireFolder(path)
    this.calls.push(`open:${path}`)
    await this.answer()
    this.currentPath = path
    this.mailbox = {
      path,
      delimiter: '/',
      flags: new Set(),
      uidValidity: folder.uidValidity,
      uidNext: folder.nextUid,
      exists: folder.messages.size
    }
    return { path, release: () => undefined }
  }

  /** Like the real client, it answers an empty list when nothing matches and false when the server rejects the command. */
  async search(query: { since?: Date | string; all?: boolean; header?: Record<string, string> }): Promise<number[] | false> {
    const folder = this.current()
    const messageId = Object.entries(query.header ?? {}).find(([name]) => name.toLowerCase() === 'message-id')?.[1]
    this.calls.push(messageId === undefined ? `search:${this.currentPath}` : `search:${this.currentPath}:${messageId}`)
    await this.answer()
    if (this.failSearch) return false
    const since = query.since ? new Date(query.since).getTime() : 0
    return [...folder.messages.values()]
      .filter((mail) => mail.date.getTime() >= since && (messageId === undefined || mail.messageId === messageId))
      .map((mail) => mail.uid)
  }

  async fetchAll(range: number[] | string, query: FetchQueryObject): Promise<FetchMessageObject[]> {
    const folder = this.current()
    this.calls.push(`fetch:${this.currentPath}:${Array.isArray(range) ? range.length : range}`)
    await this.answer()
    const uids = Array.isArray(range) ? range : [...folder.messages.keys()]
    return uids
      .map((uid) => folder.messages.get(uid))
      .filter((mail): mail is Stored => Boolean(mail))
      .map((mail) => this.toFetchObject(mail, query))
  }

  async fetchOne(uid: number, query: FetchQueryObject): Promise<FetchMessageObject | false> {
    await this.answer()
    const mail = this.current().messages.get(uid)
    return mail ? this.toFetchObject(mail, query) : false
  }

  async download(uid: number, part?: string): Promise<{ meta: Record<string, unknown>; content: Readable }> {
    const mail = this.current().messages.get(uid)
    this.calls.push(`download:${uid}:${part ?? ''}`)
    await this.answer()
    if (!mail || this.failDownload.has(uid)) throw new Error(`download failed: ${uid}`)
    const body = part === '2' ? (mail.html ?? '') : part === '1' || part === 'TEXT' ? (mail.text ?? mail.html ?? '') : ''
    return { meta: {}, content: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]) }
  }

  /** Like the real client, it takes one uid or a list, and returns false when none matches. */
  async messageFlagsAdd(range: number | number[], flags: string[]): Promise<boolean> {
    const uids = Array.isArray(range) ? range : [range]
    this.calls.push(`flags+:${this.currentPath}:${uids.join(',')}:${flags.join(',')}`)
    await this.answer()
    const mails = uids.map((uid) => this.current().messages.get(uid)).filter((mail): mail is Stored => Boolean(mail))
    if (!mails.length) return false
    for (const mail of mails) mail.flags = [...new Set([...mail.flags, ...flags])]
    return true
  }

  async messageFlagsRemove(range: number | number[], flags: string[]): Promise<boolean> {
    const uids = Array.isArray(range) ? range : [range]
    this.calls.push(`flags-:${this.currentPath}:${uids.join(',')}:${flags.join(',')}`)
    await this.answer()
    const mails = uids.map((uid) => this.current().messages.get(uid)).filter((mail): mail is Stored => Boolean(mail))
    if (!mails.length) return false
    for (const mail of mails) mail.flags = mail.flags.filter((flag) => !flags.includes(flag))
    return true
  }

  async messageMove(uid: number, destination: string): Promise<{ path: string; destination: string } | false> {
    this.calls.push(`move:${this.currentPath}:${uid}:${destination}`)
    await this.answer()
    const from = this.current()
    const to = this.requireFolder(destination)
    const mail = from.messages.get(uid)
    if (!mail) return false
    from.messages.delete(uid)
    const moved = { ...mail, uid: to.nextUid++ }
    to.messages.set(moved.uid, moved)
    return { path: this.currentPath, destination }
  }

  async append(path: string, content: Buffer, flags?: string[], date?: Date): Promise<{ destination: string; uid: number }> {
    this.calls.push(`append:${path}`)
    await this.answer()
    const stored = this.put(path, { flags, date: date ?? new Date(), text: content.toString('utf8') })
    return { destination: path, uid: stored.uid }
  }

  private requireFolder(path: string): FakeFolder {
    const folder = this.folders.get(path)
    if (!folder) throw new Error(`no such mailbox: ${path}`)
    return folder
  }

  private current(): FakeFolder {
    if (!this.currentPath) throw new Error('no mailbox selected')
    return this.requireFolder(this.currentPath)
  }

  private toFetchObject(mail: Stored, query: FetchQueryObject): FetchMessageObject {
    const object: FetchMessageObject = { seq: mail.uid, uid: mail.uid }
    if (query.flags) object.flags = new Set(mail.flags)
    if (query.labels && this.capabilities.has('X-GM-EXT-1')) object.labels = new Set(mail.labels ?? [])
    if (query.threadId && this.capabilities.has('X-GM-EXT-1')) object.threadId = mail.threadId
    if (query.size) object.size = mail.size ?? (mail.text?.length ?? 0) + (mail.html?.length ?? 0)
    if (query.internalDate) object.internalDate = mail.date
    if (query.envelope) {
      object.envelope = {
        date: mail.date,
        subject: mail.subject,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        replyTo: mail.replyTo
      }
    }
    if (query.headers) object.headers = Buffer.from(mail.references ? `References: ${mail.references}\r\n\r\n` : '\r\n')
    if (query.bodyStructure && !mail.noStructure) object.bodyStructure = structureOf(mail)
    return object
  }
}

function structureOf(mail: FakeMail): MessageStructureObject {
  const parts: MessageStructureObject[] = []
  if (mail.text !== undefined) parts.push({ part: '1', type: 'text/plain', size: mail.text.length })
  if (mail.html !== undefined) parts.push({ part: '2', type: 'text/html', size: mail.html.length })
  for (const [index, attachment] of (mail.attachments ?? []).entries()) {
    parts.push({ part: String(parts.length + 1 + index), type: attachment.type, size: attachment.size, disposition: 'attachment', dispositionParameters: { filename: attachment.filename } })
  }
  if (parts.length === 1 && !mail.attachments?.length) return { type: parts[0].type, size: parts[0].size }
  return { type: 'multipart/mixed', childNodes: parts }
}
