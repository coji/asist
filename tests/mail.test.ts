import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIL_SETTINGS,
  formatAddress,
  isDuplicateCopy,
  mailAccountInputSchema,
  mailChangeSchema,
  mailDraftInputSchema,
  mailDraftPatchSchema,
  mailListQuerySchema,
  mailSettingsSchema,
  messageIdOf,
  parseAddress,
  parseMailInput,
  parseMessageId,
  parseReferences,
  presetFor,
  quotation,
  replyRecipients,
  replyReferences,
  replySubject,
  snippetOf,
  syncSince,
  threadIdOf,
  type MailAccount
} from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'

const account = (patch: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1',
  label: '仕事',
  email: 'me@example.com',
  name: '私',
  provider: 'gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  folders: { sent: '[Gmail]/Sent Mail', archive: '[Gmail]/All Mail', trash: '[Gmail]/Trash' },
  ...patch
})

describe('addresses', () => {
  it('parses an address with a name, without one and with a quoted name, and throws on a malformed one', () => {
    expect(parseAddress('田中 <t@example.com>')).toEqual({ name: '田中', address: 't@example.com' })
    expect(parseAddress('  t@example.com ')).toEqual({ name: '', address: 't@example.com' })
    expect(parseAddress('"Tanaka, T" <t@example.com>')).toEqual({ name: 'Tanaka, T', address: 't@example.com' })
    expect(() => parseAddress('tanaka')).toThrow(errorText('mail.errors.form.badAddress', { text: 'tanaka' }))
    expect(() => parseAddress('田中 <not an address>')).toThrow(errorText('mail.errors.form.badAddress', { text: '田中 <not an address>' }))
    expect(formatAddress({ name: '田中', address: 't@example.com' })).toBe('田中 <t@example.com>')
    expect(formatAddress({ name: '', address: 't@example.com' })).toBe('t@example.com')
  })
})

describe('replies', () => {
  const message = {
    from: { name: '田中', address: 't@example.com' },
    to: [{ name: '私', address: 'me@example.com' }, { name: '鈴木', address: 's@example.com' }],
    cc: [{ name: '', address: 'cc@example.com' }, { name: '田中', address: 'T@example.com' }],
    replyTo: [] as Array<{ name: string; address: string }>
  }
  it('prefixes the subject with Re: only once', () => {
    expect(replySubject('打合せ')).toBe('Re: 打合せ')
    expect(replySubject('Re: 打合せ')).toBe('Re: 打合せ')
    expect(replySubject('RE: 打合せ ')).toBe('RE: 打合せ')
  })
  it('replies to the sender alone, or to Reply-To when it is set, while a reply-all adds the others without the account address or duplicates', () => {
    expect(replyRecipients(message, 'me@example.com', false)).toEqual({ to: [message.from], cc: [] })
    expect(replyRecipients({ ...message, replyTo: [{ name: '', address: 'list@example.com' }] }, 'me@example.com', false).to).toEqual([{ name: '', address: 'list@example.com' }])
    expect(replyRecipients(message, 'ME@example.com', true)).toEqual({
      to: [message.from],
      cc: [{ name: '鈴木', address: 's@example.com' }, { name: '', address: 'cc@example.com' }]
    })
  })
  it('answers the user’s own message to the people it went to, and leaves the user out of both To and Cc', () => {
    const me = { name: '私', address: 'me@example.com' }
    const tanaka = { name: '田中', address: 't@example.com' }
    const suzuki = { name: '鈴木', address: 's@example.com' }
    const sent = { from: me, to: [tanaka, { name: '', address: 'ME@example.com' }], cc: [suzuki, me], replyTo: [] }
    expect(replyRecipients(sent, 'me@example.com', false)).toEqual({ to: [tanaka], cc: [] })
    expect(replyRecipients(sent, 'me@example.com', true)).toEqual({ to: [tanaka], cc: [suzuki] })
    // A Reply-To that names the user along with a list answers the list alone.
    expect(replyRecipients({ ...message, replyTo: [me, { name: '', address: 'list@example.com' }] }, 'me@example.com', false).to).toEqual([{ name: '', address: 'list@example.com' }])
    // A message the user sent to themselves leaves nobody else to answer.
    expect(replyRecipients({ ...sent, to: [me], cc: [] }, 'me@example.com', true)).toEqual({ to: [me], cc: [] })
  })
  it('quotes the original below a line with its date and sender', () => {
    const quote = quotation({ date: Date.UTC(2026, 8, 15, 1, 0), from: message.from, text: '一行目\r\n\r\n二行目\n' }, 'Asia/Tokyo')
    expect(quote).toBe('2026/09/15 10:00 田中 <t@example.com>:\n> 一行目\n>\n> 二行目\n')
  })
  it('chains the parent References and Message-ID, falling back to a single In-Reply-To, as RFC 5322 3.6.4 has it', () => {
    expect(replyReferences({ messageId: '<p2@x>', inReplyTo: '<p1@x>', references: ['<root@x>', '<p1@x>'] })).toEqual(['<root@x>', '<p1@x>', '<p2@x>'])
    expect(replyReferences({ messageId: '<p2@x>', inReplyTo: '<p1@x>', references: [] })).toEqual(['<p1@x>', '<p2@x>'])
    expect(replyReferences({ messageId: '<p2@x>', inReplyTo: '<a@x> <b@x>', references: [] })).toEqual(['<p2@x>'])
    expect(replyReferences({ messageId: '', inReplyTo: '', references: ['<root@x>'] })).toEqual(['<root@x>'])
    expect(replyReferences({ messageId: '', inReplyTo: '', references: [] })).toEqual([])
  })
})

describe('threading', () => {
  it('extracts the Message-IDs of References in order', () => {
    expect(parseReferences('References: <a@x>\r\n <b@x>\r\n\r\n')).toEqual(['<a@x>', '<b@x>'])
    expect(parseReferences(undefined)).toEqual([])
  })
  it('groups by the Gmail thread id, otherwise by the first entry of References, and by the message id itself when there is neither', () => {
    expect(threadIdOf({ gmailThreadId: '17', messageId: '<m@x>', inReplyTo: '', references: ['<r@x>'], fallback: 'f' })).toBe('g:17')
    expect(threadIdOf({ messageId: '<m@x>', inReplyTo: '<p@x>', references: ['<r@x>', '<p@x>'], fallback: 'f' })).toBe('m:<r@x>')
    expect(threadIdOf({ messageId: '<m@x>', inReplyTo: '<p@x>', references: [], fallback: 'f' })).toBe('m:<p@x>')
    expect(threadIdOf({ messageId: '<m@x>', inReplyTo: '', references: [], fallback: 'f' })).toBe('m:<m@x>')
    expect(threadIdOf({ messageId: '', inReplyTo: '', references: [], fallback: 'a:inbox:1' })).toBe('u:a:inbox:1')
  })
  it('does not count the All Mail copies of inbox and sent messages as archived', () => {
    expect(isDuplicateCopy('archive', ['\\Inbox', '\\Important'])).toBe(true)
    expect(isDuplicateCopy('archive', ['\\Sent'])).toBe(true)
    expect(isDuplicateCopy('archive', ['\\Important'])).toBe(false)
    expect(isDuplicateCopy('inbox', ['\\Inbox'])).toBe(false)
  })
})

describe('ids, snippets and the sync range', () => {
  it('round-trips account, folder and uid through the message id, and throws on a broken one', () => {
    const id = messageIdOf('acc:with:colons', 'inbox', 42)
    expect(parseMessageId(id)).toEqual({ accountId: 'acc:with:colons', folder: 'inbox', uid: 42 })
    expect(() => parseMessageId('acc:nowhere:1')).toThrow(errorText('mail.errors.message.badId', { id: 'acc:nowhere:1' }))
    expect(() => parseMessageId('acc:inbox:x')).toThrow(errorText('mail.errors.message.badId', { id: 'acc:inbox:x' }))
    expect(() => parseMessageId('inbox:1')).toThrow(errorText('mail.errors.message.badId', { id: 'inbox:1' }))
  })
  it('drops blank lines and quotes from the snippet, collapses whitespace, and stops at 200 characters', () => {
    expect(snippetOf('一行目\r\n\r\n> 引用\n  二行目  \n')).toBe('一行目 二行目')
    expect(snippetOf('あ'.repeat(300))).toHaveLength(200)
  })
  it('counts the sync range from midnight of the local date', () => {
    const since = syncSince(new Date(2026, 8, 16, 15, 30), 30)
    expect([since.getFullYear(), since.getMonth(), since.getDate(), since.getHours()]).toEqual([2026, 7, 17, 0])
  })
})

describe('settings validation', () => {
  it('offers host presets for Gmail and iCloud and none for the other providers', () => {
    expect(presetFor('gmail')?.imap.host).toBe('imap.gmail.com')
    expect(presetFor('icloud')?.smtp).toEqual({ host: 'smtp.mail.me.com', port: 587, secure: false })
    expect(presetFor('custom')).toBeNull()
  })
  it('rejects duplicate ids and addresses, a default account that does not exist, and a day count out of range', () => {
    const ok = { ...DEFAULT_MAIL_SETTINGS, accounts: [account()], defaultAccountId: 'a1' }
    expect(mailSettingsSchema.safeParse(ok).success).toBe(true)
    expect(mailSettingsSchema.safeParse({ ...ok, accounts: [account(), account({ email: 'other@example.com' })] }).success).toBe(false)
    expect(mailSettingsSchema.safeParse({ ...ok, accounts: [account(), account({ id: 'a2', email: 'ME@example.com' })] }).success).toBe(false)
    expect(mailSettingsSchema.safeParse({ ...ok, defaultAccountId: 'zz' }).success).toBe(false)
    expect(mailSettingsSchema.safeParse({ ...ok, syncDays: 3 }).success).toBe(false)
    expect(mailSettingsSchema.safeParse({ ...ok, accounts: [account({ folders: { sent: null, archive: null, trash: null } })] }).success).toBe(true)
  })
  it('requires a label, an address and a password when adding an account, and reports the failure in one sentence', () => {
    expect(() => parseMailInput(mailAccountInputSchema, { ...account(), id: undefined, folders: undefined, label: '', password: 'x' })).toThrow(errorText('mail.errors.form.label'))
    expect(() => parseMailInput(mailAccountInputSchema, { label: '仕事', email: 'me', name: '', provider: 'gmail', imap: account().imap, smtp: account().smtp, password: 'x' })).toThrow(errorText('mail.errors.form.email'))
    expect(() => parseMailInput(mailAccountInputSchema, { label: '仕事', email: 'me@example.com', name: '', provider: 'gmail', imap: account().imap, smtp: account().smtp, password: '' })).toThrow(errorText('mail.errors.form.password'))
  })
  it('requires the fields that each operation needs in a change input', () => {
    expect(mailChangeSchema.safeParse({ operation: 'send', to: ['a@example.com'], subject: 'x', body: 'y' }).success).toBe(true)
    expect(mailChangeSchema.safeParse({ operation: 'send', to: [], subject: 'x', body: 'y' }).success).toBe(false)
    expect(mailChangeSchema.safeParse({ operation: 'reply', id: 'a:inbox:1', body: 'y' }).success).toBe(true)
    expect(mailChangeSchema.safeParse({ operation: 'markRead', ids: ['a:inbox:1'] }).success).toBe(false)
    expect(mailChangeSchema.safeParse({ operation: 'markRead', ids: [], read: true }).success).toBe(false)
    expect(mailChangeSchema.safeParse({ operation: 'markRead', ids: ['a:inbox:1', 'a:inbox:2'], read: true }).success).toBe(true)
    expect(mailChangeSchema.safeParse({ operation: 'delete', id: 'a:inbox:1' }).success).toBe(false)
    expect(mailListQuerySchema.parse({})).toEqual({ view: 'inbox', accountId: null, query: '', unreadOnly: false, limit: 50, before: null })
    expect(mailDraftInputSchema.parse({})).toEqual({ accountId: null, to: [], cc: [], subject: '', body: '' })
    expect(mailDraftPatchSchema.safeParse({}).success).toBe(false)
    expect(mailDraftPatchSchema.safeParse({ body: 'x' }).success).toBe(true)
  })
})
