import type { FetchMessageObject, MailboxLockObject, MessageAddressObject } from 'imapflow'
import {
  MAIL_FOLDERS,
  isRecent,
  messageIdOf,
  parseMessageId,
  parseReferences,
  syncSince,
  threadIdOf,
  threadRootOf,
  type MailAccount,
  type MailAccountStatus,
  type MailAddress,
  type MailFolder,
  type MailMessage
} from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'
import { errorMessage, t } from './i18n'
import type { MailBodyParts, MailCache, MailFlagUpdate } from './mail-cache'
import { bodyPartsOf, fetchText } from './mail-body'
import { disconnect, supportsGmail, type ImapClient, type ImapClientFactory } from './mail-imap'

/**
 * The sync of one account. It holds a single connection and runs every operation on it (fetching
 * metadata, fetching a body, changing flags, moving a message) through one queue, one at a time. The
 * open folder, normally the inbox, waits on IDLE for arrivals and flag changes, and every folder is
 * refetched periodically.
 *
 * A fetch asks SEARCH SINCE for the configured number of days and repairs only the difference against
 * the cache: messages that disappeared, messages that appeared, and flags or labels that changed. A
 * folder whose UIDVALIDITY changed is dropped and fetched again. Bodies are fetched after the metadata,
 * newest first and a few at a time; each body is its own round trip, so the first sync of an account
 * can take several minutes.
 */

export type MailSyncState = MailAccountStatus['state']

export interface MailSyncIntervals {
  /** How often every folder is refetched, including sent and archive, which IDLE does not cover. */
  periodicMs: number
  /** The wait before reconnecting; each further attempt takes the next value and the last one repeats. */
  reconnectMs: readonly number[]
  /** How long an IDLE arrival or flag notification is held before the folder is fetched. */
  debounceMs: number
  /**
   * How long the connection kept across the machine's sleep has, after the wake, to send anything before it is
   * replaced. A server answers a NOOP in well under a second; the rest leaves room for a network still coming back.
   * A longer wait keeps the account that much longer on a connection that is gone.
   */
  wakeCheckMs: number
}

export const DEFAULT_SYNC_INTERVALS: MailSyncIntervals = {
  periodicMs: 5 * 60_000,
  reconnectMs: [5_000, 15_000, 60_000, 300_000],
  debounceMs: 1_500,
  wakeCheckMs: 10_000
}

export interface MailSyncOptions {
  account: MailAccount
  /** Read on every connect, so a password re-entered in the settings takes effect from the next connect. */
  password: () => string
  cache: MailCache
  createClient: ImapClientFactory
  syncDays: () => number
  now?: () => number
  intervals?: Partial<MailSyncIntervals>
  onStatus: (state: MailSyncState, error: string) => void
  /** The cache changed and any listing of it has to be read again. */
  onChanged: () => void
  /** New unread mail reached the inbox. It is not called for the first fetch of a folder. */
  onArrived: (messages: MailMessage[]) => void
}

/** How many messages of metadata one fetch asks for, and how many bodies one hydrate pass takes per folder. */
const META_CHUNK = 200
const HYDRATE_BATCH: Record<MailFolder, number> = { inbox: 25, sent: 10, archive: 10 }

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class MailAccountSync {
  readonly account: MailAccount
  private readonly options: MailSyncOptions
  private readonly intervals: MailSyncIntervals
  private client: ImapClient | null = null
  /** Gives up the connection being made, until its handshake ends. */
  private giveUpConnecting: (() => void) | null = null
  private gmail = false
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private readonly folderTimers = new Map<MailFolder, ReturnType<typeof setTimeout>>()
  private hydrateTimer: ReturnType<typeof setTimeout> | null = null
  private synced = new Set<MailFolder>()
  /** How many operations are queued or running on the connection. */
  private pending = 0
  /**
   * The uids whose body could not be fetched or turned into text in this session. The hydrate passes
   * skip them, so one such message does not hold up the bodies behind it.
   */
  private readonly failedBodies: Record<MailFolder, Set<number>> = { inbox: new Set(), sent: new Set(), archive: new Set() }
  /** Why each folder's last fetch failed while the connection held, oldest failure first. */
  private readonly folderFailures = new Map<MailFolder, string>()
  state: MailSyncState = 'off'
  error = ''
  lastSyncAt: number | null = null

  constructor(options: MailSyncOptions) {
    this.options = options
    this.account = options.account
    this.intervals = { ...DEFAULT_SYNC_INTERVALS, ...options.intervals }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private setState(state: MailSyncState, error = ''): void {
    if (this.state === state && this.error === error) return
    this.state = state
    this.error = error
    this.options.onStatus(state, error)
  }

  start(): void {
    this.stopped = false
    this.periodicTimer = setInterval(() => void this.syncNow().catch(() => undefined), this.intervals.periodicMs)
    void this.syncNow().catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of [this.reconnectTimer, this.hydrateTimer, ...this.folderTimers.values()]) if (timer) clearTimeout(timer)
    this.folderTimers.clear()
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.reconnectTimer = this.hydrateTimer = this.periodicTimer = null
    const client = this.client
    this.client = null
    if (client) await disconnect(client)
    // An operation that was running can still write what it fetched into the cache, so a caller that
    // clears part of the cache after stopping waits for it to end.
    await this.queue
    this.setState('off')
  }

  /**
   * Fetches every folder again after the machine wakes from sleep. A connection kept across sleep can look open
   * when the server or the network has forgotten it, and the first command on it then waits out imapflow's socket
   * timeout of 5 minutes, with every operation queued behind it. So the connection is asked first and replaced
   * only when it does not answer, which also ends an operation stuck on it; one that answers is kept, so that a
   * MOVE or an APPEND under way on it is not cut. A connection still being made is given up, since its handshake
   * can wait as long.
   */
  async wake(): Promise<void> {
    const giveUp = this.giveUpConnecting
    this.giveUpConnecting = null
    giveUp?.()
    const client = this.client
    if (client && !(await answers(client, this.intervals.wakeCheckMs)) && this.client === client) {
      this.client = null
      client.close()
    }
    return this.syncNow()
  }

  /** Fetches every folder. It joins the queue, so it starts only once the operation in flight has finished. */
  syncNow(): Promise<void> {
    return this.run(async (client) => {
      this.setState('syncing')
      for (const folder of ['sent', 'archive', 'inbox'] as const) {
        const path = this.pathOf(folder)
        if (path) await this.syncRecorded(client, folder, path)
      }
      this.showSynced()
    })
  }

  /**
   * Fetches one folder and records how it went. A folder that fails on a working connection waits for the
   * next fetch; a broken connection is thrown, since dropping the client schedules the reconnect.
   */
  private async syncRecorded(client: ImapClient, folder: MailFolder, path: string): Promise<void> {
    try {
      await this.syncFolder(client, folder, path)
      this.folderFailures.delete(folder)
    } catch (error) {
      if (!client.usable) throw error
      this.folderFailures.delete(folder)
      this.folderFailures.set(folder, t('mail.errors.sync.folderFailed', { box: t(`mail.boxes.${folder}`), reason: errorMessage(error) }))
    }
  }

  /**
   * The account is in error while any folder's last fetch failed, so fetching one folder does not hide
   * another's failure. The latest failure is the one shown.
   */
  private showSynced(): void {
    this.lastSyncAt = this.now()
    const failure = [...this.folderFailures.values()].at(-1) ?? ''
    this.setState(failure ? 'error' : 'connected', failure)
    this.scheduleHydrate(0)
  }

  /**
   * Runs one operation on the connection, reconnecting first if the connection is gone. Operations on
   * the same account are serialized, so they never contend for the single IMAP connection.
   */
  run<T>(operation: (client: ImapClient, gmail: boolean) => Promise<T>): Promise<T> {
    this.pending += 1
    const task = this.queue.then(
      async () => {
        if (this.stopped) throw new Error(errorText('mail.errors.sync.stopped'))
        const client = await this.ensureClient()
        try {
          return await operation(client, this.gmail)
        } catch (error) {
          if (!client.usable) this.dropClient(client, errorMessage(error))
          throw error
        }
      },
      async () => {
        if (this.stopped) throw new Error(errorText('mail.errors.sync.stopped'))
        const client = await this.ensureClient()
        return operation(client, this.gmail)
      }
    )
    const settle = async (): Promise<void> => {
      this.pending -= 1
      if (this.pending === 0) await this.returnToInbox()
    }
    this.queue = task.then(settle, settle)
    return task
  }

  /**
   * imapflow idles on the folder selected last, and IDLE is how mail arriving in the inbox is noticed
   * between the periodic fetches. Fetching bodies, opening a sent message or starring an archived one
   * selects another folder, so the connection goes back to the inbox once no operation is waiting.
   */
  private async returnToInbox(): Promise<void> {
    const client = this.client
    if (this.stopped || !client?.usable) return
    if (client.mailbox && client.mailbox.path === 'INBOX') return
    try {
      const lock = await client.getMailboxLock('INBOX')
      try {
        // IDLE reports flags by the UIDs of the generation opened here, which may be one the cache does not hold yet.
        this.noticeGeneration(client, 'inbox', 'INBOX')
      } finally {
        lock.release()
      }
    } catch (error) {
      if (!client.usable) this.dropClient(client, errorMessage(error))
      else this.setState('error', t('mail.errors.sync.folderFailed', { box: t('mail.boxes.inbox'), reason: errorMessage(error) }))
    }
  }

  private pathOf(folder: MailFolder): string | null {
    if (folder === 'inbox') return 'INBOX'
    return this.account.folders[folder]
  }

  private requirePath(folder: MailFolder): string {
    const path = this.pathOf(folder)
    if (!path) throw new Error(errorText('mail.errors.folder.notSet', { folder: t(`mail.boxes.${folder}`) }))
    return path
  }

  /**
   * Runs an operation on messages of `folder` named by UID, in the queue like every other operation. A UID
   * names a message only within one UIDVALIDITY of its folder, which the server can renew at any time, as
   * when the mailbox is recreated. `uidValidity` is the generation the UIDs were read under, which the id of
   * each message carries, and the operation runs only while the folder still has it.
   */
  byUid<T>(folder: MailFolder, uidValidity: string, operation: (client: ImapClient) => Promise<T>): Promise<T> {
    return this.run(async (client) => {
      const lock = await this.openGeneration(client, folder, uidValidity)
      try {
        return await operation(client)
      } finally {
        lock.release()
      }
    })
  }

  /** Opens `folder` for UIDs of the generation `uidValidity`, and fails as if their messages were gone once the server has renewed it. */
  private async openGeneration(client: ImapClient, folder: MailFolder, uidValidity: string): Promise<MailboxLockObject> {
    const path = this.requirePath(folder)
    const lock = await client.getMailboxLock(path)
    try {
      if (this.noticeGeneration(client, folder, path) !== uidValidity) throw new Error(errorText('mail.errors.message.notFound'))
      return lock
    } catch (error) {
      lock.release()
      throw error
    }
  }

  /**
   * Records the generation of a folder opened outside its fetch, and returns it. The cache of a renewed folder is
   * dropped here already, so that its UIDs reach nothing before the folder's next fetch, which follows shortly.
   */
  private noticeGeneration(client: ImapClient, folder: MailFolder, path: string): string {
    const opened = this.recordGeneration(client, folder, path)
    if (opened.renewed) {
      this.options.onChanged()
      this.scheduleFolderSync(folder)
    }
    return opened.uidValidity
  }

  /**
   * Records the UIDVALIDITY of the folder just opened. A renewed one drops the folder's cache, since every
   * UID of the old generation may name another message now, and the folder's next fetch counts as its first.
   */
  private recordGeneration(client: ImapClient, folder: MailFolder, path: string): { uidValidity: string; renewed: boolean } {
    const mailbox = client.mailbox
    if (!mailbox) throw new Error(errorText('mail.errors.folder.openFailed', { path }))
    // RFC 3501 requires UIDVALIDITY, and imapflow leaves it undefined when a server sends none. Without it no
    // UID can be told apart from the same UID of a later generation.
    const generation: bigint | undefined = mailbox.uidValidity
    if (generation === undefined) throw new Error(errorText('mail.errors.folder.noUidValidity', { path }))
    const uidValidity = String(generation)
    const renewed = this.options.cache.setUidValidity(this.account.id, folder, uidValidity)
    if (renewed) {
      this.failedBodies[folder].clear()
      this.synced.delete(folder)
    }
    return { uidValidity, renewed }
  }

  private async ensureClient(): Promise<ImapClient> {
    if (this.client?.usable) return this.client
    this.setState('connecting')
    let client: ImapClient
    try {
      client = this.options.createClient(this.account, this.options.password())
    } catch (error) {
      // The password store throws when the entry is missing or cannot be decrypted, and the account would
      // otherwise stay "connecting" with nothing to say why.
      this.setState('error', errorMessage(error))
      throw error
    }
    client.on('error', (error: unknown) => {
      if (this.client === client) this.setState('error', errorMessage(error))
    })
    client.on('close', () => {
      if (this.client === client) this.dropClient(client, this.error || t('mail.errors.sync.disconnected'))
    })
    // These notifications arrive during IDLE and only for the folder that is open, so that folder is
    // fetched again. A flag change that carries a uid, which is the case for the response to our own
    // STORE, is written straight into the cache instead of triggering a fetch.
    client.on('exists', (event: { path?: string }) => {
      const folder = this.folderOf(event.path)
      if (folder) this.scheduleFolderSync(folder)
    })
    client.on('flags', (event: { path?: string; uid?: number; flags?: Set<string> }) => {
      const folder = this.folderOf(event.path)
      if (!folder) return
      if (event.uid && event.flags) this.applyFlags(client, folder, event.uid, event.flags)
      else this.scheduleFolderSync(folder)
    })
    client.on('expunge', (event: { path?: string }) => {
      const folder = this.folderOf(event.path)
      if (folder) this.scheduleFolderSync(folder)
    })
    // imapflow's close() settles a pending connect() only once the socket is up and, with TLS, the handshake is
    // done; closed during DNS, the TCP connect or the TLS handshake, connect() never settles, and this account's
    // queue would wait on it for good. So giving the connection up rejects a promise of ASIST's own as well.
    let giveUp = (): void => undefined
    const givenUp = new Promise<never>((_, reject) => {
      giveUp = () => {
        client.close()
        reject(new Error(errorText('mail.errors.sync.disconnected')))
      }
    })
    this.giveUpConnecting = giveUp
    try {
      await Promise.race([client.connect(), givenUp])
    } catch (error) {
      client.close()
      // wake() gave this connection up and makes its own, so the failure it caused is no reason to report or retry.
      if (this.giveUpConnecting !== giveUp) throw error
      this.giveUpConnecting = null
      const message = errorMessage(error)
      this.setState('error', message)
      this.scheduleReconnect()
      throw new Error(errorText('mail.errors.account.connectFailedFor', { label: this.account.label, reason: errMessage(error) }))
    }
    // wake() gave it up just as the handshake ended.
    if (this.giveUpConnecting !== giveUp) {
      client.close()
      throw new Error(errorText('mail.errors.sync.disconnected'))
    }
    this.giveUpConnecting = null
    // stop() ran while the connection was being made and found no client to end.
    if (this.stopped) {
      await disconnect(client)
      throw new Error(errorText('mail.errors.sync.stopped'))
    }
    this.client = client
    this.gmail = supportsGmail(client)
    this.reconnectAttempts = 0
    return client
  }

  private dropClient(client: ImapClient, reason: string): void {
    if (this.client !== client) return
    this.client = null
    client.close()
    if (this.stopped) return
    this.setState('error', reason)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delays = this.intervals.reconnectMs
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)]
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.syncNow().catch(() => undefined)
    }, delay)
  }

  private folderOf(path: string | undefined): MailFolder | null {
    if (!path) return null
    return MAIL_FOLDERS.find((folder) => this.pathOf(folder) === path) ?? null
  }

  /**
   * Writes the flags the server reported for a UID of the folder open now straight into the cache, under the
   * generation it is open with. A uid that is not cached is ignored.
   */
  private applyFlags(client: ImapClient, folder: MailFolder, uid: number, flags: Set<string>): void {
    const mailbox = client.mailbox
    const generation: bigint | undefined = mailbox && mailbox.path === this.pathOf(folder) ? mailbox.uidValidity : undefined
    if (generation === undefined) return
    const id = messageIdOf(this.account.id, folder, String(generation), uid)
    const before = this.options.cache.get(id)
    if (!before) return
    const next = flagsOf({ flags })
    if (before.unread === next.unread && before.starred === next.starred && before.answered === next.answered) return
    this.options.cache.setFlags(id, next)
    this.options.onChanged()
  }

  private scheduleFolderSync(folder: MailFolder): void {
    if (this.stopped || this.folderTimers.has(folder)) return
    const path = this.pathOf(folder)
    if (!path) return
    this.folderTimers.set(
      folder,
      setTimeout(() => {
        this.folderTimers.delete(folder)
        // Every failure has already reached the account's state: the folder's in syncRecorded, and a
        // connection that failed or broke in ensureClient or dropClient, which also schedule the reconnect.
        void this.run(async (client) => {
          await this.syncRecorded(client, folder, path)
          this.showSynced()
        }).catch(() => undefined)
      }, this.intervals.debounceMs)
    )
  }

  private async syncFolder(client: ImapClient, folder: MailFolder, path: string): Promise<void> {
    const { account, cache } = this.options
    const lock = await client.getMailboxLock(path)
    let changed = false
    const arrived: MailMessage[] = []
    try {
      const generation = this.recordGeneration(client, folder, path)
      // A folder dropped for a new UIDVALIDITY has changed even when nothing of its new generation is fetched.
      changed = generation.renewed
      const first = !this.synced.has(folder)
      const since = syncSince(new Date(this.now()), this.options.syncDays())
      const serverUids = await client.search({ since }, { uid: true })
      // imapflow's search answers false instead of throwing when the server rejects the command or the
      // connection breaks during it. Read as an empty folder, it would remove every cached message, and the
      // next fetch would announce the unread ones of the last day as new mail again.
      if (!Array.isArray(serverUids)) throw new Error(errorText('mail.errors.sync.noMessageList'))
      const cached = cache.flagsIn(account.id, folder)
      const serverSet = new Set(serverUids)
      const removed = [...cached.keys()].filter((uid) => !serverSet.has(uid))
      cache.removeUids(account.id, folder, removed)
      changed ||= removed.length > 0

      const existing = serverUids.filter((uid) => cached.has(uid))
      for (const chunk of chunks(existing, META_CHUNK)) {
        const items = await client.fetchAll(chunk, { uid: true, flags: true, labels: this.gmail }, { uid: true })
        const updates: MailFlagUpdate[] = []
        for (const item of items) {
          const flags = flagsOf(item)
          const before = cached.get(item.uid)
          const labels = item.labels ? [...item.labels] : []
          if (before && before.unread === flags.unread && before.starred === flags.starred && before.answered === flags.answered && sameLabels(before.labels, labels)) continue
          updates.push({ uid: item.uid, ...flags, labels })
        }
        if (updates.length) {
          cache.updateFlags(account.id, folder, updates)
          changed = true
        }
      }

      const fresh = serverUids.filter((uid) => !cached.has(uid))
      for (const chunk of chunks(fresh, META_CHUNK)) {
        const items = await client.fetchAll(
          chunk,
          { uid: true, flags: true, envelope: true, size: true, bodyStructure: true, internalDate: true, threadId: this.gmail, labels: this.gmail, headers: ['references'] },
          { uid: true }
        )
        const messages = items.map((item) => this.toMessage(item, folder, generation.uidValidity))
        cache.upsert(messages)
        changed ||= messages.length > 0
        if (folder === 'inbox' && !first) {
          for (const message of messages) if (message.unread && isRecent(message.date, this.now())) arrived.push(message)
        }
      }
      this.synced.add(folder)
    } finally {
      lock.release()
      // What was written before a later step failed is in the cache as well, and the list has to show it.
      if (changed) this.options.onChanged()
    }
    if (arrived.length) this.options.onArrived(arrived)
  }

  private toMessage(item: FetchMessageObject, folder: MailFolder, uidValidity: string): MailMessage & { parts: MailBodyParts } {
    const { account, cache } = this.options
    const envelope = item.envelope ?? {}
    const id = messageIdOf(account.id, folder, uidValidity, item.uid)
    const headers = { messageId: envelope.messageId ?? '', inReplyTo: envelope.inReplyTo ?? '', references: parseReferences(item.headers?.toString('latin1')) }
    const labels = item.labels ? [...item.labels] : []
    const { parts, attachments } = bodyPartsOf(item.bodyStructure)
    return {
      id,
      accountId: account.id,
      folder,
      uid: item.uid,
      messageId: headers.messageId,
      // A mailer that writes In-Reply-To without References names the parent rather than the message the thread
      // starts from, so a message whose root is cached joins the thread that root is in. The cache moves the
      // replies that came first into the thread of the message they answer once it arrives.
      threadId: (!this.gmail && cache.threadOf(account.id, threadRootOf(headers))) || threadIdOf({ gmailThreadId: this.gmail ? item.threadId : null, ...headers, fallback: id }),
      subject: envelope.subject ?? '',
      from: addressesOf(envelope.from)[0] ?? { name: '', address: '' },
      to: addressesOf(envelope.to),
      cc: addressesOf(envelope.cc),
      replyTo: addressesOf(envelope.replyTo),
      date: dateOf(envelope.date) ?? dateOf(item.internalDate) ?? this.now(),
      snippet: '',
      ...flagsOf(item),
      attachments,
      size: item.size ?? 0,
      labels,
      bodyFetched: false,
      parts
    }
  }

  /**
   * Fetches bodies after the metadata, newest first and a batch at a time. Each batch is a separate
   * entry in the queue, so another operation can get between two batches.
   */
  private scheduleHydrate(delay: number): void {
    if (this.stopped || this.hydrateTimer) return
    this.hydrateTimer = setTimeout(() => {
      this.hydrateTimer = null
      void this.run(async (client) => {
        let fetched = 0
        for (const folder of MAIL_FOLDERS) {
          if (this.pathOf(folder)) fetched += await this.hydrate(client, folder, HYDRATE_BATCH[folder])
        }
        if (fetched > 0) this.scheduleHydrate(100)
      }).catch((error: unknown) => console.warn(`mail bodies (${this.account.label}):`, errMessage(error)))
    }, delay)
  }

  private async hydrate(client: ImapClient, folder: MailFolder, limit: number): Promise<number> {
    const { account, cache } = this.options
    const failed = this.failedBodies[folder]
    const pending = cache.pendingBodies(account.id, folder, limit, [...failed])
    if (pending.length === 0) return 0
    const lock = await this.openGeneration(client, folder, parseMessageId(pending[0].id).uidValidity)
    try {
      for (const item of pending) {
        try {
          const text = await fetchText(client, item.uid, item)
          cache.setBody(item.id, text)
        } catch (error) {
          if (!client.usable) throw error
          // A server can refuse one FETCH, and html-to-text throws RangeError on deeply nested HTML. The
          // message keeps no body rather than an empty one, so opening it fetches again and shows the reason.
          failed.add(item.uid)
          console.warn(`mail body (${account.label}, ${folder} ${item.uid}):`, errMessage(error))
        }
      }
    } finally {
      lock.release()
    }
    this.options.onChanged()
    return pending.length
  }

  /** Fetches one body right away, for opening a message on screen or for read_mail, or serves the cached one. */
  fetchBody(id: string): Promise<string> {
    const { cache } = this.options
    const { folder, uidValidity, uid } = parseMessageId(id)
    const cached = cache.body(id)
    if (cached !== null) return Promise.resolve(cached)
    const parts = cache.bodyParts(id)
    if (!parts) return Promise.reject(new Error(errorText('mail.errors.message.notFound')))
    return this.byUid(folder, uidValidity, async (client) => {
      const text = await fetchText(client, uid, parts)
      cache.setBody(id, text)
      return text
    })
  }
}

/** How often the bytes received on a connection are read while waiting for it to answer. */
const ANSWER_POLL_MS = 250

/**
 * Whether the server sends anything on the connection within `ms`. A NOOP asks it to, but imapflow sends one
 * command at a time, so the NOOP waits behind a command under way, such as a long FETCH; the bytes that command
 * keeps receiving show the connection alive as well. An APPEND under way receives nothing until it ends, and
 * one that outlasts `ms` gets the connection replaced.
 */
function answers(client: Pick<ImapClient, 'noop' | 'stats'>, ms: number): Promise<boolean> {
  const before = client.stats().received
  return new Promise<boolean>((resolve) => {
    const settle = (alive: boolean): void => {
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(alive)
    }
    const poll = setInterval(() => {
      if (client.stats().received > before) settle(true)
    }, ANSWER_POLL_MS)
    const deadline = setTimeout(() => settle(false), ms)
    // A NOOP the server refuses still shows it alive; one the connection fails shows nothing arrived.
    client.noop().then(
      () => settle(true),
      () => settle(client.stats().received > before)
    )
  })
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size)
}

const sameLabels = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((label, index) => label === b[index])

const flagsOf = (item: Pick<FetchMessageObject, 'flags'>): { unread: boolean; starred: boolean; answered: boolean } => {
  const flags = item.flags ?? new Set<string>()
  return { unread: !flags.has('\\Seen'), starred: flags.has('\\Flagged'), answered: flags.has('\\Answered') }
}

const addressesOf = (list: MessageAddressObject[] | undefined): MailAddress[] =>
  (list ?? []).filter((item) => item.address).map((item) => ({ name: (item.name ?? '').trim(), address: (item.address ?? '').trim() }))

function dateOf(value: Date | string | undefined): number | null {
  if (!value) return null
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(time) ? time : null
}
