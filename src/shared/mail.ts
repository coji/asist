import { z } from 'zod'
import { localIsoWithOffset } from './calendar'
import { errorText } from './i18n/error-text'

/**
 * The shared schema of the mail integration and the calculations over it. The main process reads and
 * writes over IMAP and SMTP, and the renderer's mail screen, the mail cards and the Agent's tools all
 * use the same shape. There can be several accounts. The servers and folders live in settings.json,
 * the passwords in a separate encrypted file, and the fetched mail in a SQLite cache that can always
 * be rebuilt from the server.
 */

export const MAIL_PROVIDERS = ['gmail', 'icloud', 'custom'] as const
export type MailProvider = (typeof MAIL_PROVIDERS)[number]

export interface MailEndpoint {
  host: string
  port: number
  /** True means TLS from the moment the connection opens, false means STARTTLS. */
  secure: boolean
}

/** The default servers per provider. A custom provider is typed in by the user. */
export const MAIL_PRESETS: Record<Exclude<MailProvider, 'custom'>, { label: string; imap: MailEndpoint; smtp: MailEndpoint }> = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
  },
  icloud: {
    label: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }
  }
}

export const MIN_SYNC_DAYS = 7
export const MAX_SYNC_DAYS = 365
export const DEFAULT_SYNC_DAYS = 30
export const MAX_MAIL_ACCOUNTS = 8
const MAX_LABEL_LENGTH = 40
export const MAX_SUBJECT_LENGTH = 500
export const MAX_BODY_LENGTH = 50_000
export const MAX_RECIPIENTS = 50
/**
 * How many messages one change may touch. IMAP's STORE would take them in a single command; the limit
 * keeps the confirmation sentence and the list of UIDs short.
 */
export const MAX_BULK_CHANGE = 1000
export const MAX_MAIL_DRAFTS = 50
/** How far back a message still counts as new, for the badge in the navigation. */
export const RECENT_WINDOW_MS = 24 * 3_600_000

const endpointSchema = z.strictObject({
  host: z.string().trim().min(1, errorText('mail.errors.form.host')).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean()
})
const folderPath = z.string().min(1).max(500)
/**
 * The special folders found on the server. The inbox is always INBOX and is therefore not listed. A
 * folder that was not found is null, never guessed.
 */
export const mailFoldersSchema = z.strictObject({
  sent: folderPath.nullable(),
  archive: folderPath.nullable(),
  trash: folderPath.nullable()
})
export type MailFolders = z.infer<typeof mailFoldersSchema>

const emailSchema = z.email({ error: errorText('mail.errors.form.email') }).trim().max(254)
const labelSchema = z.string().trim().min(1, errorText('mail.errors.form.label')).max(MAX_LABEL_LENGTH, errorText('mail.errors.form.labelTooLong', { count: MAX_LABEL_LENGTH }))
const nameSchema = z.string().trim().max(100)

export const mailAccountSchema = z.strictObject({
  id: z.string().min(1).max(100),
  /** The name the account goes by on screen and in conversation, such as "仕事". */
  label: labelSchema,
  /** Both the login name and the sender address. */
  email: emailSchema,
  /** The sender's display name. When it is empty, mail goes out with the address alone. */
  name: nameSchema,
  provider: z.enum(MAIL_PROVIDERS),
  imap: endpointSchema,
  smtp: endpointSchema,
  folders: mailFoldersSchema
})
export type MailAccount = z.infer<typeof mailAccountSchema>

/**
 * The input for adding an account and for testing the connection. It carries no id and no folders,
 * because both are decided after asking the server.
 */
export const mailAccountInputSchema = z.strictObject({
  label: labelSchema,
  email: emailSchema,
  name: nameSchema,
  provider: z.enum(MAIL_PROVIDERS),
  imap: endpointSchema,
  smtp: endpointSchema,
  password: z.string().min(1, errorText('mail.errors.form.password')).max(500)
})
export type MailAccountInput = z.infer<typeof mailAccountInputSchema>

/** A change to the settings. Only the fields present change, and the password takes another path. */
export const mailAccountPatchSchema = z
  .strictObject({
    label: labelSchema.optional(),
    name: nameSchema.optional(),
    folders: mailFoldersSchema.optional()
  })
  .refine((patch) => Object.keys(patch).length > 0, errorText('mail.errors.form.noChanges'))
export type MailAccountPatch = z.infer<typeof mailAccountPatchSchema>

export const mailSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    accounts: z.array(mailAccountSchema).max(MAX_MAIL_ACCOUNTS, errorText('mail.errors.form.tooManyAccounts', { count: MAX_MAIL_ACCOUNTS })),
    /** The default sender for a new message. Null means the first account. */
    defaultAccountId: z.string().min(1).nullable(),
    /** How many days back to fetch. Older mail is reachable only through a search on the server. */
    syncDays: z.number().int().min(MIN_SYNC_DAYS).max(MAX_SYNC_DAYS),
    /** Whether new mail raises an OS notification while the window is not in front. */
    notifyNewMail: z.boolean()
  })
  .refine((value) => new Set(value.accounts.map((account) => account.id)).size === value.accounts.length, {
    message: errorText('mail.errors.form.duplicateId')
  })
  .refine((value) => new Set(value.accounts.map((account) => account.email.toLowerCase())).size === value.accounts.length, {
    message: errorText('mail.errors.form.duplicateEmail')
  })
  .refine((value) => value.defaultAccountId === null || value.accounts.some((account) => account.id === value.defaultAccountId), {
    message: errorText('mail.errors.form.defaultAccountMissing')
  })
export type MailSettings = z.infer<typeof mailSettingsSchema>

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  enabled: false,
  accounts: [],
  defaultAccountId: null,
  syncDays: DEFAULT_SYNC_DAYS,
  notifyNewMail: true
}

export interface MailAddress {
  name: string
  address: string
}
/**
 * The folders that are synced: the inbox, sent mail, and the archive, which on Gmail is "すべての
 * メール".
 */
export const MAIL_FOLDERS = ['inbox', 'sent', 'archive'] as const
export type MailFolder = (typeof MAIL_FOLDERS)[number]
/**
 * The filters of the screen and the list. Starred means the flagged messages across the inbox, sent
 * mail and the archive.
 */
export const MAIL_VIEWS = ['inbox', 'starred', 'sent', 'archive'] as const
export type MailView = (typeof MAIL_VIEWS)[number]

export interface MailAttachment {
  filename: string
  contentType: string
  size: number
}

export interface MailMessage {
  /** `${accountId}:${folder}:${uid}`. Moving a message to another folder changes it. */
  id: string
  accountId: string
  folder: MailFolder
  uid: number
  /** The Message-ID header, or an empty string when the message has none. */
  messageId: string
  /** On Gmail the server's thread ID; elsewhere it is derived from the first entry of References. */
  threadId: string
  subject: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  replyTo: MailAddress[]
  /** When the message was sent, in milliseconds. Without a Date header it is the server's receipt time. */
  date: number
  /** The opening of the body. It is an empty string until the body has been fetched. */
  snippet: string
  unread: boolean
  starred: boolean
  answered: boolean
  attachments: MailAttachment[]
  size: number
  /** Gmail's labels, from X-GM-LABELS. It stays empty on the other providers. */
  labels: string[]
  bodyFetched: boolean
}

export interface MailMessageBody {
  message: MailMessage
  text: string
}

export interface MailAccountStatus {
  id: string
  label: string
  email: string
  provider: MailProvider
  state: 'off' | 'connecting' | 'syncing' | 'connected' | 'error'
  /** The reason, when state is error. */
  error: string
  lastSyncAt: number | null
  /** The number of unread messages in the inbox. */
  unread: number
  /** The unread messages of the inbox that arrived within the last 24 hours. */
  unreadRecent: number
}

export interface MailStatus {
  enabled: boolean
  accounts: MailAccountStatus[]
  unread: number
  unreadRecent: number
}

/** The result of testing a connection. The folders it found go into the settings unchanged. */
export interface MailProbeResult {
  folders: MailFolders
  /** Whether Gmail's extensions are available: thread IDs, labels and the search syntax. */
  gmail: boolean
  mailboxes: string[]
}

export const mailListQuerySchema = z.strictObject({
  view: z.enum(MAIL_VIEWS).default('inbox'),
  /** Omitting it, or null, means every account. */
  accountId: z.string().min(1).nullable().default(null),
  /** A substring match on the subject, the sender and the body. */
  query: z.string().trim().max(200).default(''),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAX_BULK_CHANGE).default(50),
  /**
   * The last message of the page before, for reading the next page. The list is ordered by date, then
   * uid, then id, newest first, and only the id is unique, so all three are given.
   */
  before: z.strictObject({ date: z.number().int(), uid: z.number().int().positive(), id: z.string().min(1) }).nullable().default(null)
})
export type MailListQuery = z.input<typeof mailListQuerySchema>
export interface MailListResult {
  messages: MailMessage[]
  /** How many messages match the filter, before the limit is applied. */
  total: number
  /**
   * How many of the matching messages are unread, before the limit is applied. It is the count that
   * "mark everything as read" would act on.
   */
  unread: number
}

const recipientsSchema = z.array(z.string().trim().min(1)).max(MAX_RECIPIENTS)
const bodySchema = z.string().max(MAX_BODY_LENGTH, errorText('mail.errors.form.bodyTooLong', { count: MAX_BODY_LENGTH }))
const idSchema = z.string().min(1, errorText('mail.errors.form.idRequired'))

export const mailChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('send'),
    /** Omitting it uses the default sender. */
    accountId: z.string().min(1).nullable().default(null),
    to: recipientsSchema.min(1, errorText('mail.errors.form.recipientRequired')),
    cc: recipientsSchema.default([]),
    subject: z.string().trim().max(MAX_SUBJECT_LENGTH),
    body: bodySchema
  }),
  z.strictObject({
    operation: z.literal('reply'),
    id: idSchema,
    body: bodySchema,
    /** True also sends to the original recipients and Cc. */
    replyAll: z.boolean().default(false)
  }),
  z.strictObject({ operation: z.literal('archive'), id: idSchema }),
  z.strictObject({ operation: z.literal('trash'), id: idSchema }),
  z.strictObject({
    operation: z.literal('markRead'),
    /** Several at once. Messages in the same account and folder are changed with a single STORE. */
    ids: z.array(idSchema).min(1, errorText('mail.errors.form.idRequired')).max(MAX_BULK_CHANGE, errorText('mail.errors.form.bulkLimit', { count: MAX_BULK_CHANGE })),
    read: z.boolean()
  }),
  z.strictObject({ operation: z.literal('star'), id: idSchema, starred: z.boolean() })
])
export type MailChange = z.infer<typeof mailChangeSchema>
export type MailChangeInput = z.input<typeof mailChangeSchema>

export type MailChangeResult =
  | { cancelled: true; saved: false }
  | {
      saved: true
      operation: MailChange['operation']
      /**
       * The id of the message that changed. For a send it is the Message-ID, and for a bulk read
       * change it is the first of the ids.
       */
      id: string
      summary: string
    }
  /**
   * A send or a reply coming from the Agent is never sent; it comes back as a draft, and goes out
   * when the user presses send on the card or on the screen.
   */
  | { drafted: true; saved: false; draftId: string; summary: string }

const addressSchema = z.strictObject({ name: z.string(), address: z.string().min(1) })

/**
 * A reply as it will go out, settled by main from the message it answers when the reply is made. The
 * recipients shown before the send button is pressed are these, and so are the ones it is sent to; the
 * message answered is not needed again, so the reply still goes out after that message was archived or
 * left the range that is fetched.
 */
export const mailReplySchema = z.strictObject({
  /** The message answered, as it was named when the reply was made. It is marked answered after the send while it is still there. */
  id: idSchema,
  /** The subject and the sender of the message answered, which name that message on screen. */
  subject: z.string(),
  from: addressSchema,
  replyAll: z.boolean(),
  to: z.array(addressSchema).min(1),
  cc: z.array(addressSchema),
  /** The Message-ID of the message answered, or an empty string when it has none. */
  inReplyTo: z.string(),
  references: z.array(z.string()),
  /** The line naming the original and the quoted original body, appended below the reply's body. */
  quote: z.string()
})
export type MailReply = z.infer<typeof mailReplySchema>

/** A reply from the reader of the mail screen: the reply main settled and the screen showed, and the body. */
export const mailReplySendSchema = z.strictObject({ reply: mailReplySchema, body: bodySchema })
export type MailReplySend = z.infer<typeof mailReplySendSchema>

/**
 * A draft. Both what the Agent composed and what the user is still writing on screen are held in the
 * main process. A reply draft carries the reply settled from the original message, and only its body
 * can be edited.
 */
export interface MailDraft {
  id: string
  accountId: string
  /** Each entry is either "名前 <addr>" or just "addr". */
  to: string[]
  cc: string[]
  subject: string
  body: string
  reply: MailReply | null
  origin: 'agent' | 'screen'
  createdAt: number
  updatedAt: number
  /**
   * When a send of the draft started. It is stored before the message is handed to SMTP and cleared only
   * when the send fails, so a draft that went out can never be sent again, even when removing it fails.
   */
  sendStartedAt: number | null
}

/** A new message saved as a draft. A reply draft is made only by change_mail's reply. */
export const mailDraftInputSchema = z.strictObject({
  /** Omitting it uses the default sender. */
  accountId: z.string().min(1).nullable().default(null),
  to: recipientsSchema.default([]),
  cc: recipientsSchema.default([]),
  subject: z.string().trim().max(MAX_SUBJECT_LENGTH).default(''),
  body: bodySchema.default('')
})
export type MailDraftInput = z.input<typeof mailDraftInputSchema>

export const mailDraftPatchSchema = z
  .strictObject({
    accountId: z.string().min(1).optional(),
    to: recipientsSchema.optional(),
    cc: recipientsSchema.optional(),
    subject: z.string().trim().max(MAX_SUBJECT_LENGTH).optional(),
    body: bodySchema.optional()
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), errorText('mail.errors.form.noChanges'))
export type MailDraftPatch = z.input<typeof mailDraftPatchSchema>

export type MailEvent =
  | { type: 'status'; status: MailStatus }
  /** A fetch or a change altered the cache, and the screen reloads its list. */
  | { type: 'changed'; accountId: string }
  | { type: 'arrived'; accountId: string; messages: MailMessage[] }
  /** Every draft, emitted once a draft's save has completed. */
  | { type: 'drafts'; drafts: MailDraft[] }

export const messageIdOf = (accountId: string, folder: MailFolder, uid: number): string => `${accountId}:${folder}:${uid}`

export function parseMessageId(id: string): { accountId: string; folder: MailFolder; uid: number } {
  const last = id.lastIndexOf(':')
  const middle = id.lastIndexOf(':', last - 1)
  const folder = id.slice(middle + 1, last)
  const uid = Number(id.slice(last + 1))
  const accountId = id.slice(0, middle)
  if (middle <= 0 || !MAIL_FOLDERS.includes(folder as MailFolder) || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(errorText('mail.errors.message.badId', { id }))
  }
  return { accountId, folder: folder as MailFolder, uid }
}

export const presetFor = (provider: MailProvider): { imap: MailEndpoint; smtp: MailEndpoint } | null =>
  provider === 'custom' ? null : { imap: { ...MAIL_PRESETS[provider].imap }, smtp: { ...MAIL_PRESETS[provider].smtp } }

const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** Splits forms such as `田中 <t@example.com>`, `t@example.com` and `"Tanaka, T" <t@example.com>`. */
export function parseAddress(text: string): MailAddress {
  const value = text.trim()
  const angle = value.match(/^(.*?)\s*<([^<>]+)>$/)
  if (angle) {
    const address = angle[2].trim()
    if (!ADDRESS_PATTERN.test(address)) throw new Error(errorText('mail.errors.form.badAddress', { text }))
    return { name: angle[1].trim().replace(/^"(.*)"$/, '$1'), address }
  }
  if (!ADDRESS_PATTERN.test(value)) throw new Error(errorText('mail.errors.form.badAddress', { text }))
  return { name: '', address: value }
}

export const formatAddress = (address: MailAddress): string => (address.name ? `${address.name} <${address.address}>` : address.address)
/** The short form shown to the user: the name when there is one, otherwise the address. */
export const displayName = (address: MailAddress): string => address.name || address.address

export function replySubject(subject: string): string {
  const trimmed = subject.trim()
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

/**
 * The recipients of a reply. It goes to the original Reply-To, or to From when there is none, and a
 * reply-all adds the original recipients and Cc with the user's own address removed.
 */
export function replyRecipients(message: Pick<MailMessage, 'from' | 'to' | 'cc' | 'replyTo'>, self: string, replyAll: boolean): { to: MailAddress[]; cc: MailAddress[] } {
  const to = message.replyTo.length ? [...message.replyTo] : [message.from]
  if (!replyAll) return { to, cc: [] }
  const seen = new Set(to.map((address) => address.address.toLowerCase()))
  seen.add(self.toLowerCase())
  const rest: MailAddress[] = []
  for (const address of [...message.to, ...message.cc]) {
    const key = address.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rest.push(address)
  }
  return { to, cc: rest }
}

/**
 * The quotation appended below a reply: one line with the date and the sender, then the original
 * body with every line prefixed by "> ".
 */
export function quotation(original: { date: number; from: MailAddress; text: string }, timeZone?: string): string {
  const stamp = new Intl.DateTimeFormat('ja-JP', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(original.date)
  const quoted = original.text
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
  return `${stamp} ${formatAddress(original.from)}:\n${quoted}\n`
}

/** Extracts the Message-IDs from the raw value of a References header. */
export function parseReferences(raw: string | undefined): string[] {
  if (!raw) return []
  return [...raw.matchAll(/<[^<>\s]+>/g)].map((match) => match[0])
}

/**
 * The References of a reply, as RFC 5322 3.6.4 has it: the parent's References, or its In-Reply-To when
 * the parent has no References and that names a single message, followed by the parent's Message-ID.
 * Other programs group a thread by these, and threadIdOf groups by their first entry.
 */
export function replyReferences(parent: { messageId: string; inReplyTo: string; references: readonly string[] }): string[] {
  const inReplyTo = parseReferences(parent.inReplyTo)
  const before = parent.references.length ? [...parent.references] : inReplyTo.length === 1 ? inReplyTo : []
  return parent.messageId ? [...before, parent.messageId] : before
}

/**
 * The key a thread is grouped by. Gmail's own thread ID is used as it is; elsewhere the first entry
 * of References groups the thread, falling back to In-Reply-To and then to the message's own
 * Message-ID.
 */
export function threadIdOf(input: { gmailThreadId?: string | null; messageId: string; inReplyTo: string; references: string[]; fallback: string }): string {
  if (input.gmailThreadId) return `g:${input.gmailThreadId}`
  const root = input.references[0] || input.inReplyTo || input.messageId
  return root ? `m:${root}` : `u:${input.fallback}`
}

/**
 * Gmail's "すべてのメール" also holds copies of the inbox and of sent mail. A copy carrying one of
 * those labels is not counted as archived, so that it does not appear twice alongside the inbox and
 * sent lists.
 */
export function isDuplicateCopy(folder: MailFolder, labels: readonly string[]): boolean {
  if (folder !== 'archive') return false
  return labels.some((label) => label === '\\Inbox' || label === '\\Sent' || label === '\\Draft' || label === '\\Trash' || label === '\\Spam')
}

/** The start of the range that gets fetched: midnight of a local date. */
export function syncSince(now: Date, syncDays: number): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - syncDays)
  return start
}

export const isRecent = (date: number, now: number): boolean => now - date <= RECENT_WINDOW_MS

/** One row of the list in the shape handed to the conversation. The body comes from read_mail. */
export function mailSummary(message: MailMessage, accountLabel: string): Record<string, unknown> {
  return {
    id: message.id,
    account: accountLabel,
    from: formatAddress(message.from),
    subject: message.subject,
    date: localIsoWithOffset(message.date),
    unread: message.unread,
    starred: message.starred,
    ...(message.attachments.length ? { attachments: message.attachments.map((item) => item.filename) } : {}),
    snippet: message.snippet
  }
}

/** The opening of the body, dropping blank lines and quotations, up to 200 characters. */
export function snippetOf(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * Throws the first zod issue as it is. Each issue's message already carries the key of the sentence the
 * user reads, and only one of them survives a concatenation, so the rest are dropped rather than joined.
 */
export function parseMailInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new Error(result.error.issues[0].message)
}
