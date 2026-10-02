import {
  displayName,
  formatAddress,
  mailAccountInputSchema,
  mailAccountPatchSchema,
  mailChangeSchema,
  mailDraftInputSchema,
  mailDraftPatchSchema,
  mailReplySendSchema,
  mailSettingsSchema,
  parseAddress,
  parseMailInput,
  parseMessageId,
  parseReferences,
  quotation,
  replyRecipients,
  replyReferences,
  replySubject,
  syncSince,
  type MailAccount,
  type MailAccountStatus,
  type MailAddress,
  type MailChange,
  type MailChangeResult,
  type MailDraft,
  type MailEvent,
  type MailFolder,
  type MailFolders,
  type MailListResult,
  type MailMessage,
  type MailMessageBody,
  type MailProbeResult,
  type MailReply,
  type MailSettings,
  type MailStatus
} from '@shared/mail'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { promptLanguage } from '@shared/conversation-locale'
import { conversationLocale } from './conversation-locale'
import { errorMessage, t } from './i18n'
import type { MailCache } from './mail-cache'
import type { MailDraftStore } from './mail-drafts'
import { disconnect, supportsGmail, type ImapClient, type ImapClientFactory } from './mail-imap'
import type { MailSecretStore } from './mail-secrets'
import { failedBeforeSending, type OutgoingMail, type SmtpSender } from './mail-smtp'
import { MailAccountSync, type MailSyncIntervals } from './mail-sync'
import { getSettings } from './settings'
import { formatLocaleOf } from '@shared/conversation-locale'

/**
 * The centre of the mail integration. It owns one sync per account, answers listings and bodies from the
 * cache, and puts sending, replying, archiving, trashing, marking read and starring through the approval
 * gate before they reach the server.
 *
 * The approval rule: for an operation that leaves the machine, sending or replying, approval is the user
 * pressing the send button after seeing the recipients and the whole body. An Agent that wants to send
 * does not send; it writes a draft and waits for the user to press the button on the card or the screen.
 * Sending from the compose form, from the reply form of the reader or from a draft is already approved
 * by that press, so no confirmation dialog is shown. A reply is settled before it is shown, and what is
 * shown is what is sent. Every other Agent operation (archive, trash, mark read, star) and trashing from the
 * screen goes through the confirmation dialog. A send is attempted exactly once, and a failure whose
 * outcome is unknown is never retried.
 */

export type MailChangeSource = 'agent' | 'screen'

export interface MailServiceDependencies {
  settings: () => MailSettings
  /** Writes the settings file. Validation is the job of the settings module that supplies this. */
  saveSettings: (mail: MailSettings) => void
  secrets: MailSecretStore
  cache: MailCache
  drafts: MailDraftStore
  createClient: ImapClientFactory
  smtp: SmtpSender
  /** `action` names the operation on the button that carries it out, such as "ゴミ箱へ移す". */
  confirm: (detail: string, signal: AbortSignal, action: string, destructive: boolean) => Promise<boolean>
  emit: (event: MailEvent) => void
  now?: () => number
  createId?: () => string
  syncIntervals?: Partial<MailSyncIntervals>
}

const SPECIAL_USE: Record<keyof MailFolders, readonly string[]> = {
  sent: ['\\Sent'],
  // On Gmail the archive lives in "すべてのメール" (All Mail), which reports \All rather than \Archive.
  archive: ['\\Archive', '\\All'],
  trash: ['\\Trash']
}

const CONFIRM_BODY_MAX = 1200
const REJECTED = errorText('mail.errors.change.rejected')

/** The words on the confirmation's button: the operation itself, so that the button says what pressing it does. */
function confirmAction(input: PlannedChange): string {
  if (input.operation === 'markRead') return t(input.read ? 'mail.confirm.action.markRead' : 'mail.confirm.action.markUnread')
  if (input.operation === 'star') return t(input.starred ? 'mail.confirm.action.star' : 'mail.confirm.action.unstar')
  if (input.operation === 'send') return t('mail.confirm.action.send')
  return t(input.operation === 'archive' ? 'mail.confirm.action.archive' : 'mail.confirm.action.trash')
}

/** A reply never goes through a plan: it is settled first so that its recipients can be shown. */
type PlannedChange = Exclude<MailChange, { operation: 'reply' }>

export class MailService {
  private readonly syncs = new Map<string, MailAccountSync>()
  private started = false
  /**
   * Only one confirmation dialog may be open at a time. The operations themselves are not guarded here,
   * because the connection queue in mail-sync's run already serializes them.
   */
  private confirming = false
  /** The drafts whose send is under way. */
  private readonly sendingDrafts = new Set<string>()

  constructor(private readonly deps: MailServiceDependencies) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    this.started = true
    this.applySettings()
  }

  /**
   * Checks the cache file, and replaces it with an empty cache when it is damaged. It runs before start(): the
   * syncs are the cache's only writers, and one that kept running across the replacement would take every
   * message of the empty cache's first fetch for new mail.
   */
  async checkCache(): Promise<void> {
    const damage = await this.deps.cache.check()
    if (damage === null) return
    this.deps.cache.replace(damage)
    for (const account of this.deps.settings().accounts) this.deps.emit({ type: 'changed', accountId: account.id })
  }

  async stop(): Promise<void> {
    this.started = false
    await Promise.all([...this.syncs.values()].map((sync) => sync.stop()))
    this.syncs.clear()
  }

  /** Rebuilds the syncs from the settings. An account whose configuration is unchanged keeps its connection. */
  applySettings(): void {
    if (!this.started) return
    const settings = this.deps.settings()
    const wanted = new Map(settings.enabled ? settings.accounts.map((account) => [account.id, account]) : [])
    for (const [id, sync] of this.syncs) {
      const account = wanted.get(id)
      if (account && JSON.stringify(account) === JSON.stringify(sync.account)) continue
      this.syncs.delete(id)
      void sync.stop()
    }
    for (const [id, account] of wanted) {
      if (this.syncs.has(id)) continue
      const sync = new MailAccountSync({
        account,
        password: () => this.passwordOf(id),
        cache: this.deps.cache,
        createClient: this.deps.createClient,
        syncDays: () => this.deps.settings().syncDays,
        now: () => this.now(),
        intervals: this.deps.syncIntervals,
        onStatus: () => this.emitStatus(),
        onChanged: () => {
          this.deps.emit({ type: 'changed', accountId: id })
          this.emitStatus()
        },
        onArrived: (messages) => this.deps.emit({ type: 'arrived', accountId: id, messages })
      })
      this.syncs.set(id, sync)
      sync.start()
    }
    this.emitStatus()
  }

  private passwordOf(id: string): string {
    const password = this.deps.secrets.get(id)
    if (password === null) throw new Error(errorText('mail.errors.account.passwordMissing'))
    return password
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'status', status: this.status() })
  }

  status(): MailStatus {
    const settings = this.deps.settings()
    const now = this.now()
    const accounts: MailAccountStatus[] = settings.accounts.map((account) => {
      const sync = this.syncs.get(account.id)
      const counts = this.deps.cache.counts(account.id, now)
      return {
        id: account.id,
        label: account.label,
        email: account.email,
        provider: account.provider,
        state: sync?.state ?? 'off',
        error: sync?.error ?? '',
        lastSyncAt: sync?.lastSyncAt ?? null,
        unread: counts.unread,
        unreadRecent: counts.unreadRecent
      }
    })
    return {
      enabled: settings.enabled,
      accounts,
      unread: accounts.reduce((sum, account) => sum + account.unread, 0),
      unreadRecent: accounts.reduce((sum, account) => sum + account.unreadRecent, 0)
    }
  }

  /** Connects and looks up the special folders. A folder the server does not advertise stays null; it is never guessed. */
  async probe(value: unknown): Promise<MailProbeResult> {
    const input = parseMailInput(mailAccountInputSchema, value)
    const client = this.deps.createClient({ email: input.email, imap: input.imap }, input.password)
    // imapflow reports a connection lost after the login by emitting 'error', which an EventEmitter with no
    // listener throws as an uncaught exception of the main process, and rejects the command waiting on it
    // only with "Connection not available". The emitted error is the reason the probe reports.
    let lost: unknown = null
    client.on('error', (error: unknown) => {
      lost ??= error
    })
    try {
      await client.connect()
    } catch (error) {
      client.close()
      throw new Error(errorText('mail.errors.account.connectFailed', { reason: errMessage(error) }))
    }
    try {
      const folders = await client.list()
      const find = (kinds: readonly string[]): string | null => {
        for (const kind of kinds) {
          const hit = folders.find((folder) => folder.specialUse === kind)
          if (hit) return hit.path
        }
        return null
      }
      return {
        folders: { sent: find(SPECIAL_USE.sent), archive: find(SPECIAL_USE.archive), trash: find(SPECIAL_USE.trash) },
        gmail: supportsGmail(client),
        mailboxes: folders.map((folder) => folder.path)
      }
    } catch (error) {
      throw new Error(errorText('mail.errors.account.connectFailed', { reason: errMessage(lost ?? error) }))
    } finally {
      await disconnect(client)
    }
  }

  async addAccount(value: unknown): Promise<MailAccount> {
    const input = parseMailInput(mailAccountInputSchema, value)
    const settings = this.deps.settings()
    if (settings.accounts.some((account) => account.email.toLowerCase() === input.email.toLowerCase())) {
      throw new Error(errorText('mail.errors.account.duplicate'))
    }
    const id = this.deps.createId?.() ?? globalThis.crypto.randomUUID()
    const { password, ...fields } = input
    const withAccount = (folders: MailFolders): MailSettings => ({
      ...settings,
      enabled: true,
      accounts: [...settings.accounts, { id, ...fields, folders }],
      defaultAccountId: settings.defaultAccountId ?? id
    })
    // An account the settings would refuse, one past the limit of accounts for one, is turned down before the server is asked.
    parseMailInput(mailSettingsSchema, withAccount({ sent: null, archive: null, trash: null }))
    const next = withAccount((await this.probe(input)).folders)
    // Only removing the account removes its password, so the password is taken back when the settings cannot
    // be saved with the account, and neither is left without the other.
    this.deps.secrets.set(id, password)
    try {
      this.deps.saveSettings(next)
    } catch (error) {
      this.deps.secrets.remove(id)
      throw error
    }
    this.applySettings()
    return next.accounts.at(-1)!
  }

  async updateAccount(id: string, patchValue: unknown, password?: string): Promise<MailAccount> {
    const settings = this.deps.settings()
    const current = settings.accounts.find((account) => account.id === id)
    if (!current) throw new Error(errorText('mail.errors.account.notFound'))
    const patch = patchValue === undefined ? {} : parseMailInput(mailAccountPatchSchema, patchValue)
    const next: MailAccount = { ...current, ...patch }
    if (password !== undefined) {
      if (!password) throw new Error(errorText('mail.errors.form.password'))
      // The new password is stored only after a real connection with it has succeeded.
      await this.probe({ label: next.label, email: next.email, name: next.name, provider: next.provider, imap: next.imap, smtp: next.smtp, password })
      this.deps.secrets.set(id, password)
    }
    // The account's sync is rebuilt below. The running one is stopped first, since it holds the old
    // password and could still write the folder it was fetching after the cache is cleared.
    const sync = this.syncs.get(id)
    if (sync) {
      this.syncs.delete(id)
      await sync.stop()
    }
    // The cache files messages under the role of their folder, not its path, and drops them by itself only
    // when UIDVALIDITY changes, which two mailboxes can share. Unless a folder that now points at another
    // mailbox is emptied, the list goes on showing the old messages, and a move to the trash takes the new
    // mailbox's message with the same UID.
    const repointed = (['sent', 'archive'] as const).filter((folder) => next.folders[folder] !== current.folders[folder])
    for (const folder of repointed) this.deps.cache.clearFolder(id, folder)
    this.deps.saveSettings({ ...settings, accounts: settings.accounts.map((account) => (account.id === id ? next : account)) })
    this.applySettings()
    if (repointed.length > 0) this.deps.emit({ type: 'changed', accountId: id })
    return next
  }

  async removeAccount(id: string): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.accounts.some((account) => account.id === id)) throw new Error(errorText('mail.errors.account.notFound'))
    const sync = this.syncs.get(id)
    this.syncs.delete(id)
    if (sync) await sync.stop()
    const accounts = settings.accounts.filter((account) => account.id !== id)
    this.deps.saveSettings({
      ...settings,
      accounts,
      defaultAccountId: settings.defaultAccountId === id ? (accounts[0]?.id ?? null) : settings.defaultAccountId
    })
    this.deps.cache.clearAccount(id)
    this.deps.secrets.remove(id)
    this.applySettings()
    this.deps.emit({ type: 'changed', accountId: id })
  }

  list(query: unknown): MailListResult {
    return this.deps.cache.list(query)
  }

  thread(accountId: string, threadId: string): MailMessage[] {
    return this.deps.cache.thread(accountId, threadId)
  }

  async read(id: string): Promise<MailMessageBody> {
    const message = this.requireMessage(id)
    const text = await this.requireSync(message.accountId).fetchBody(id)
    return { message: this.deps.cache.get(id) ?? message, text }
  }

  syncNow(): Promise<void> {
    return Promise.all([...this.syncs.values()].map((sync) => sync.syncNow())).then(() => undefined)
  }

  /** Fetches every account again when the machine wakes from sleep, over a new connection where the old one no longer answers. */
  wake(): Promise<void> {
    return Promise.all([...this.syncs.values()].map((sync) => sync.wake())).then(() => undefined)
  }

  private requireSync(accountId: string): MailAccountSync {
    const sync = this.syncs.get(accountId)
    if (!sync) throw new Error(errorText('mail.errors.account.off'))
    return sync
  }

  private accountOf(id: string): MailAccount {
    const account = this.deps.settings().accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error(errorText('mail.errors.account.notFound'))
    return account
  }

  private senderAccount(accountId: string | null): MailAccount {
    const settings = this.deps.settings()
    if (accountId) return this.accountOf(accountId)
    const account = settings.accounts.find((candidate) => candidate.id === settings.defaultAccountId) ?? settings.accounts[0]
    if (!account) throw new Error(errorText('mail.errors.account.none'))
    return account
  }

  async change(value: unknown, signal: AbortSignal, source: MailChangeSource): Promise<MailChangeResult> {
    const input: MailChange = parseMailInput(mailChangeSchema, value)
    signal.throwIfAborted()
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    if (source === 'agent' && input.operation === 'send') {
      const draft = this.draftCreate({ accountId: input.accountId, to: input.to, cc: input.cc, subject: input.subject, body: input.body }, 'agent')
      return { drafted: true, saved: false, draftId: draft.id, summary: draftSummary(draft) }
    }
    if (input.operation === 'reply') {
      // A reply goes out only after the addresses it is sent to were on screen: the Agent's becomes a draft
      // carrying the reply settled here, and the reader's is settled by replySettle and sent by replySend.
      if (source !== 'agent') throw new Error('a reply from the screen is settled with replySettle and sent with replySend')
      const message = this.requireMessage(input.id)
      const account = this.accountOf(message.accountId)
      const reply = await this.settleReply(message, account, input.replyAll)
      const draft = this.deps.drafts.create({ accountId: account.id, to: [], cc: [], subject: '', body: input.body, reply, origin: 'agent' })
      return { drafted: true, saved: false, draftId: draft.id, summary: draftSummary(draft) }
    }
    const plan = this.plan(input)
    const needsConfirm = source === 'agent' || input.operation === 'trash'
    if (needsConfirm) {
      if (this.confirming) throw new Error(errorText('mail.errors.change.confirmBusy'))
      this.confirming = true
      try {
        const configuration = JSON.stringify(this.deps.settings())
        signal.throwIfAborted()
        if (!(await this.deps.confirm(plan.detail, signal, confirmAction(input), input.operation === 'trash'))) return { cancelled: true, saved: false }
        signal.throwIfAborted()
        if (JSON.stringify(this.deps.settings()) !== configuration) {
          throw new Error(errorText('mail.errors.change.settingsChanged'))
        }
      } finally {
        this.confirming = false
      }
    }
    return plan.perform()
  }

  draftList(): MailDraft[] {
    return this.deps.drafts.list()
  }

  /** Checks the sender account and the recipients of a new message before storing anything. */
  draftCreate(value: unknown, origin: MailDraft['origin']): MailDraft {
    const input = parseMailInput(mailDraftInputSchema, value)
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    const account = this.senderAccount(input.accountId)
    for (const recipient of [...input.to, ...input.cc]) parseAddress(recipient)
    return this.deps.drafts.create({ accountId: account.id, to: input.to, cc: input.cc, subject: input.subject, body: input.body, reply: null, origin })
  }

  /** Checks the recipients and the account an edit brings before anything is stored. */
  draftUpdate(id: string, value: unknown): MailDraft {
    this.requireIdle(id)
    requireUnsent(this.deps.drafts.require(id))
    const patch = parseMailInput(mailDraftPatchSchema, value)
    for (const recipient of [...(patch.to ?? []), ...(patch.cc ?? [])]) parseAddress(recipient)
    if (patch.accountId) this.accountOf(patch.accountId)
    return this.deps.drafts.update(id, patch)
  }

  draftRemove(id: string): void {
    this.requireIdle(id)
    this.deps.drafts.remove(id)
  }

  /**
   * A draft whose send is under way cannot be sent, edited or discarded again. The card and the mail screen
   * each carry a send button for the same draft, and a second press would deliver it twice.
   */
  private requireIdle(id: string): void {
    if (this.sendingDrafts.has(id)) throw new Error(errorText('mail.errors.draft.sending'))
  }

  /**
   * Sends a draft. The user's press is the approval, so no confirmation is shown, and the draft is removed
   * once the send succeeds. `shown` is the updatedAt of the draft as the screen showed it when the button was
   * pressed: the Agent can change the draft until then, and a version the user did not see is not sent. The
   * start of the send is written to the draft file before the message leaves: removing the draft can fail after
   * the message went out, and only a record made beforehand keeps the draft from being sent twice, in this
   * session and after a restart.
   */
  async draftSend(id: string, signal: AbortSignal, shown: number): Promise<MailChangeResult> {
    this.requireIdle(id)
    this.sendingDrafts.add(id)
    try {
      const draft = this.deps.drafts.require(id)
      requireUnsent(draft)
      if (draft.updatedAt !== shown) throw new Error(errorText('mail.errors.draft.changed'))
      signal.throwIfAborted()
      if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
      if (!draft.body.trim()) throw new Error(errorText('mail.errors.draft.emptyBody'))
      const account = this.accountOf(draft.accountId)
      const reply = draft.reply
      const send = reply
        ? () => this.sendReply(account, reply, draft.body)
        : this.plan({ operation: 'send', accountId: account.id, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body }).perform
      this.deps.drafts.setSendStartedAt(id, this.now())
      let result: MailChangeResult
      try {
        result = await send()
      } catch (error) {
        // send rejects only when the hand-off failed: the message provably did not leave, or the error asks the
        // user to look in the Sent folder before sending again. Either way the user decides whether to send it again.
        try {
          this.deps.drafts.setSendStartedAt(id, null)
        } catch (release) {
          throw new Error(errorText('mail.errors.draft.lockedAfterFailure', { error: errorMessage(error), reason: errorMessage(release) }))
        }
        throw error
      }
      try {
        this.deps.drafts.remove(id)
      } catch (error) {
        const note = t('mail.result.draftNotRemoved', { reason: errorMessage(error) })
        return result.saved ? { ...result, summary: `${result.summary}\n${note}` } : result
      }
      return result
    } finally {
      this.sendingDrafts.delete(id)
    }
  }

  /** A reply for the reader to show before it is sent. The reader hands the same reply to replySend. */
  async replySettle(id: string, replyAll: boolean): Promise<MailReply> {
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    const message = this.requireMessage(id)
    return this.settleReply(message, this.accountOf(message.accountId), replyAll)
  }

  /** Sends a reply replySettle settled and the reader showed. The user's press is the approval, so no confirmation is shown. */
  async replySend(value: unknown, signal: AbortSignal): Promise<MailChangeResult> {
    const { reply, body } = parseMailInput(mailReplySendSchema, value)
    signal.throwIfAborted()
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    if (!body.trim()) throw new Error(errorText('mail.errors.draft.emptyBody'))
    return this.sendReply(this.accountOf(parseMessageId(reply.id).accountId), reply, body)
  }

  /**
   * Settles a reply from the message it answers: its recipients, its thread headers and the quotation.
   * The parent's References and In-Reply-To are not kept in the cache, so they are read from the server.
   */
  private async settleReply(message: MailMessage, account: MailAccount, replyAll: boolean): Promise<MailReply> {
    const sync = this.requireSync(account.id)
    const text = await sync.fetchBody(message.id)
    const parent = await sync.byUid(message.folder, parseMessageId(message.id).uidValidity, async (client) => {
      const fetched = await client.fetchOne(message.uid, { envelope: true, headers: ['references'] }, { uid: true })
      if (!fetched) throw new Error(errorText('mail.errors.message.notFound'))
      return { inReplyTo: fetched.envelope?.inReplyTo ?? '', references: parseReferences(fetched.headers?.toString('latin1')) }
    })
    const { to, cc } = replyRecipients(message, account.email, replyAll)
    return {
      id: message.id,
      subject: message.subject,
      from: message.from,
      replyAll,
      to,
      cc,
      inReplyTo: message.messageId,
      references: replyReferences({ messageId: message.messageId, ...parent }),
      quote: quotation({ date: message.date, from: message.from, text })
    }
  }

  private sendReply(account: MailAccount, reply: MailReply, body: string): Promise<MailChangeResult> {
    return this.send(
      account,
      {
        from: { name: account.name, address: account.email },
        to: reply.to,
        cc: reply.cc,
        subject: replySubject(reply.subject),
        text: `${body.trimEnd()}\n\n${reply.quote}`,
        inReplyTo: reply.inReplyTo || undefined,
        references: reply.references
      },
      { id: reply.id, messageId: reply.inReplyTo }
    )
  }

  /**
   * Settles what the operation will do before it runs, and returns the text for the confirmation dialog
   * together with the function that performs it. Nothing here changes state on the server, so a plan the
   * user rejects leaves no trace.
   */
  private plan(input: PlannedChange): { detail: string; perform: () => Promise<MailChangeResult> } {
    if (input.operation === 'send') {
      const account = this.senderAccount(input.accountId)
      const to = input.to.map(parseAddress)
      const cc = input.cc.map(parseAddress)
      if (!to.length) throw new Error(errorText('mail.errors.form.recipientRequired'))
      const detail = [
        t('mail.confirm.send', { label: account.label, email: account.email }),
        t('mail.confirm.to', { addresses: to.map(formatAddress).join(', ') }),
        cc.length ? t('mail.confirm.cc', { addresses: cc.map(formatAddress).join(', ') }) : '',
        t('mail.confirm.subject', { subject: input.subject || t('mail.noSubject') }),
        t('mail.confirm.body', { body: clip(input.body) })
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        detail,
        perform: () => this.send(account, { from: { name: account.name, address: account.email }, to, cc, subject: input.subject, text: input.body }, null)
      }
    }
    if (input.operation === 'markRead') return this.planMarkRead(input.ids, input.read)
    const message = this.requireMessage(input.id)
    const account = this.accountOf(message.accountId)
    const sync = this.requireSync(account.id)
    const head = { label: account.label, ...describe(message) }
    const { uidValidity } = parseMessageId(message.id)
    if (input.operation === 'archive') {
      if (message.folder !== 'inbox') throw new Error(errorText('mail.errors.change.notInInbox'))
      const destination = account.folders.archive
      if (!destination) throw new Error(errorText('mail.errors.folder.archiveMissing'))
      return {
        detail: t('mail.confirm.archive', { ...head, folder: destination }),
        perform: async () => {
          await sync.byUid(message.folder, uidValidity, async (client) => {
            if (!(await client.messageMove(message.uid, destination, { uid: true }))) throw new Error(REJECTED)
          })
          this.deps.cache.remove(message.id)
          this.afterChange(account.id)
          return { saved: true, operation: input.operation, id: message.id, summary: t('mail.result.archive', { subject: head.subject }) }
        }
      }
    }
    if (input.operation === 'trash') {
      const destination = account.folders.trash
      if (!destination) throw new Error(errorText('mail.errors.folder.trashMissing'))
      return {
        detail: t('mail.confirm.trash', { ...head, folder: destination }),
        perform: async () => {
          await sync.byUid(message.folder, uidValidity, async (client) => {
            if (!(await client.messageMove(message.uid, destination, { uid: true }))) throw new Error(REJECTED)
          })
          this.deps.cache.remove(message.id)
          this.afterChange(account.id)
          return { saved: true, operation: input.operation, id: message.id, summary: t('mail.result.trash', { subject: head.subject }) }
        }
      }
    }
    return {
      detail: t(input.starred ? 'mail.confirm.star' : 'mail.confirm.unstar', head),
      perform: async () => {
        await sync.byUid(message.folder, uidValidity, (client) => storeFlag(client, [message.uid], '\\Flagged', input.starred))
        this.deps.cache.setFlags(message.id, { starred: input.starred })
        this.afterChange(account.id)
        return {
          saved: true,
          operation: input.operation,
          id: message.id,
          summary: t(input.starred ? 'mail.result.star' : 'mail.result.unstar', { subject: head.subject })
        }
      }
    }
  }

  /**
   * Marking read or unread. It takes several ids and changes the ones that share an account and a folder
   * in a single STORE. The confirmation names the subject for a single message and the counts otherwise.
   */
  private planMarkRead(ids: readonly string[], read: boolean): { detail: string; perform: () => Promise<MailChangeResult> } {
    const messages = [...new Set(ids)].map((id) => this.requireMessage(id))
    const groups = new Map<string, { account: MailAccount; sync: MailAccountSync; folder: MailFolder; uidValidity: string; messages: MailMessage[] }>()
    for (const message of messages) {
      const { uidValidity } = parseMessageId(message.id)
      const key = `${message.accountId}:${message.folder}:${uidValidity}`
      let group = groups.get(key)
      if (!group) {
        const account = this.accountOf(message.accountId)
        group = { account, sync: this.requireSync(account.id), folder: message.folder, uidValidity, messages: [] }
        groups.set(key, group)
      }
      group.messages.push(message)
    }
    const single = messages.length === 1 ? messages[0] : null
    const detail = single
      ? t(read ? 'mail.confirm.markRead' : 'mail.confirm.markUnread', { label: this.accountOf(single.accountId).label, ...describe(single) })
      : [
          t(read ? 'mail.confirm.markReadMany' : 'mail.confirm.markUnreadMany'),
          ...[...groups.values()].map((group) =>
            t('mail.confirm.group', { label: group.account.label, box: t(`mail.boxes.${group.messages[0].folder}`), count: group.messages.length })
          )
        ].join('\n')
    return {
      detail,
      perform: async () => {
        for (const group of groups.values()) {
          await group.sync.byUid(group.folder, group.uidValidity, (client) => storeFlag(client, group.messages.map((message) => message.uid), '\\Seen', read))
          for (const message of group.messages) this.deps.cache.setFlags(message.id, { unread: !read })
          this.afterChange(group.account.id)
        }
        return {
          saved: true,
          operation: 'markRead',
          id: messages[0].id,
          summary: single
            ? t(read ? 'mail.result.markRead' : 'mail.result.markUnread', { subject: single.subject || t('mail.noSubject') })
            : t(read ? 'mail.result.markReadCount' : 'mail.result.markUnreadCount', { count: messages.length })
        }
      }
    }
  }

  private requireMessage(id: string): MailMessage {
    parseMessageId(id)
    const message = this.deps.cache.get(id)
    if (!message) throw new Error(errorText('mail.errors.message.notFound'))
    return message
  }

  private afterChange(accountId: string): void {
    this.deps.emit({ type: 'changed', accountId })
    this.emitStatus()
  }

  /**
   * Sends. Once the message has been handed to SMTP it is never sent again, even when the outcome is
   * unknown. It rejects only when the hand-off fails, so a rejection always means that the message provably
   * did not leave or that its outcome is unknown. Whatever fails after SMTP accepted the message becomes a
   * note on the result, since an error would read as "not sent" and invite a second send to the same people.
   */
  private async send(account: MailAccount, outgoing: OutgoingMail, answered: { id: string; messageId: string } | null): Promise<MailChangeResult> {
    const password = this.passwordOf(account.id)
    const replying = answered !== null
    let sent: { messageId: string; raw: Buffer }
    try {
      sent = await this.deps.smtp.send(account, password, outgoing)
    } catch (error) {
      const reason = errorMessage(error)
      if (failedBeforeSending(error)) throw new Error(errorText(replying ? 'mail.errors.send.replyFailed' : 'mail.errors.send.sendFailed', { reason }))
      throw new Error(errorText(replying ? 'mail.errors.send.replyUnknown' : 'mail.errors.send.sendUnknown', { reason }))
    }
    const notes: string[] = []
    try {
      await this.afterSent(account, sent, answered, notes)
    } catch (error) {
      notes.push(t('mail.result.afterSendFailed', { reason: errorMessage(error) }))
    }
    const recipients = outgoing.to.map(displayName).join(', ')
    return {
      saved: true,
      operation: replying ? 'reply' : 'send',
      id: sent.messageId,
      summary: [t(replying ? 'mail.result.reply' : 'mail.result.send', { recipients }), ...notes].join('\n')
    }
  }

  /**
   * What follows a message SMTP accepted. Outside Gmail, which files every message sent through it in Sent Mail
   * itself, the same bytes go into the Sent folder unless a search finds that the server filed the message there,
   * as Exchange Online and Yahoo do. A reply puts the \Answered flag on the message it answers, `answered`, while
   * that message is still in the cache. A step that fails adds its note to `notes`.
   */
  private async afterSent(account: MailAccount, sent: { messageId: string; raw: Buffer }, answered: { id: string; messageId: string } | null, notes: string[]): Promise<void> {
    const sync = this.syncs.get(account.id)
    const sentFolder = account.folders.sent
    if (sync && sentFolder && account.provider !== 'gmail') {
      try {
        await sync.run(async (client) => {
          const lock = await client.getMailboxLock(sentFolder)
          try {
            // Only a search that answered with the message skips the copy. imapflow answers false for one the server
            // refused or the connection cut, and a missing copy is worse than a second one. A server that files its
            // own copy only after the search still ends up with two.
            const filed = await client.search({ header: { 'message-id': sent.messageId }, since: syncSince(new Date(this.now()), 1) }, { uid: true })
            if (!Array.isArray(filed) || filed.length === 0) await client.append(sentFolder, sent.raw, ['\\Seen'], new Date(this.now()))
          } finally {
            lock.release()
          }
        })
      } catch (error) {
        notes.push(t('mail.result.sentFolderFailed', { reason: errorMessage(error) }))
      }
    }
    if (sync && answered !== null) {
      try {
        // The id names its folder by role, and a folder pointed at another mailbox with the same UIDVALIDITY can
        // have filed another message under it since the reply was settled.
        // A message without a Message-ID cannot be told from another one, so it is never taken for the original.
        const original = this.deps.cache.get(answered.id)
        if (!original || !answered.messageId || original.messageId !== answered.messageId) throw new Error(errorText('mail.errors.message.notFound'))
        await sync.byUid(original.folder, parseMessageId(original.id).uidValidity, (client) => storeFlag(client, [original.uid], '\\Answered', true))
        this.deps.cache.setFlags(original.id, { answered: true })
      } catch (error) {
        notes.push(t('mail.result.answeredFailed', { reason: errorMessage(error) }))
      }
    }
    if (sync) void sync.syncNow().catch(() => undefined)
    this.afterChange(account.id)
  }
}

/**
 * A draft whose send started may already have gone out. It is neither sent again nor edited, so that it keeps
 * showing where the mail may have gone, and it can only be discarded.
 */
function requireUnsent(draft: MailDraft): void {
  if (draft.sendStartedAt !== null) throw new Error(errorText('mail.errors.draft.sendStarted'))
}

/** The values that name a message in the confirmation: its subject, its sender and when it was sent. */
const describe = (message: MailMessage): { subject: string; name: string; date: string } => ({
  subject: message.subject || t('mail.noSubject'),
  name: displayName(message.from),
  date: stamp(message.date)
})

/**
 * What the Agent's send or reply returns to the model instead of sending. It is read by the model, never
 * shown on a screen, so it is written in the language of the conversation and tells the model that the
 * user's press on the card is what sends the mail. A reply names the addresses it goes to, which Reply-To
 * can make differ from the sender of the message answered.
 */
const draftSummary = (draft: MailDraft): string => {
  const language = promptLanguage(conversationLocale())
  const noSubject = { ja: '(件名なし)', en: '(no subject)' }[language]
  if (draft.reply) {
    const to = draft.reply.to.map(formatAddress).join(', ')
    const addressed = draft.reply.cc.length ? `${to} (Cc: ${draft.reply.cc.map(formatAddress).join(', ')})` : to
    return {
      ja: `「${draft.reply.subject || noSubject}」(${displayName(draft.reply.from)})への返信を下書きにしました。宛先は ${addressed}。ユーザーがカードの「送信」を押すと送ります`,
      en: `Drafted a reply to "${draft.reply.subject || noSubject}" from ${displayName(draft.reply.from)}, addressed to ${addressed}. It is sent when the user presses send on the card.`
    }[language]
  }
  return {
    ja: `${draft.to.join(', ')} 宛「${draft.subject || noSubject}」を下書きにしました。ユーザーがカードの「送信」を押すと送ります`,
    en: `Drafted "${draft.subject || noSubject}" to ${draft.to.join(', ')}. It is sent when the user presses send on the card.`
  }[language]
}

/**
 * Adds or removes a flag in the folder byUid opened. imapflow returns false instead of throwing when the
 * flag is not permitted or no mailbox is selected, so the false is turned into an error rather than passing silently.
 */
async function storeFlag(client: ImapClient, uids: number[], flag: string, add: boolean): Promise<void> {
  const ok = add ? await client.messageFlagsAdd(uids, [flag], { uid: true }) : await client.messageFlagsRemove(uids, [flag], { uid: true })
  if (!ok) throw new Error(REJECTED)
}

const clip = (text: string): string =>
  text.length > CONFIRM_BODY_MAX
    ? `${text.slice(0, CONFIRM_BODY_MAX)}\n${t('mail.confirm.clipped', { count: text.length - CONFIRM_BODY_MAX })}`
    : text
const stamp = (date: number): string => new Intl.DateTimeFormat(formatLocaleOf(getSettings().uiLocale, getSettings().region), { dateStyle: 'medium', timeStyle: 'short' }).format(date)

export type { MailAddress }
