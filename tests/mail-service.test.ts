import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MAIL_ACCOUNTS, messageIdOf, threadIdOf, type MailAccount, type MailEvent, type MailSettings } from '@shared/mail'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailCache } from '../src/main/services/mail-cache'
import { MailDraftStore } from '../src/main/services/mail-drafts'
import type { MailSecretStore } from '../src/main/services/mail-secrets'
import { MailService } from '../src/main/services/mail-service'
import type { OutgoingMail, SmtpSender } from '../src/main/services/mail-smtp'
import { FakeImap } from './helpers/fake-imap'

/**
 * The approval gate: an agent's send or reply becomes a draft instead of leaving the machine, an agent's
 * other operations and the screen's trash need a confirmation, and pressing send or reply on the screen
 * is itself the approval.
 */

// The service writes the confirmation and the result of a change in the interface language, which it reads from the settings.
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'ja-JP' }) }))
const t = createTranslator('ja-JP')

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 16, 6)
const tanaka = [{ name: '田中', address: 't@example.com' }]
const suzuki = [{ name: '鈴木', address: 's@example.com' }]
const me = [{ name: '', address: 'me@example.com' }]

const account = (patch: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1',
  label: '仕事',
  email: 'me@example.com',
  name: '私',
  provider: 'gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' },
  ...patch
})

function memorySecrets(initial: Record<string, string> = {}): MailSecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (id) => data.get(id) ?? null,
    set: (id, password) => void data.set(id, password),
    remove: (id) => void data.delete(id)
  }
}

async function setup(options: { provider?: MailAccount['provider']; enabled?: boolean; draftsFile?: string } = {}) {
  const provider = options.provider ?? 'gmail'
  const imap = new FakeImap({ gmail: provider === 'gmail' })
  imap.addFolder('Sent', { specialUse: '\\Sent' })
  imap.addFolder('Archive', { specialUse: provider === 'gmail' ? '\\All' : '\\Archive' })
  imap.addFolder('Trash', { specialUse: '\\Trash' })
  const question = imap.put('INBOX', { subject: '見積もりの相談', from: tanaka, to: [...me, ...suzuki], cc: [{ name: '', address: 'cc@example.com' }], date: new Date(NOW - HOUR), text: '一行目\n二行目', messageId: '<q@x>' })
  const other = imap.put('INBOX', { subject: 'ほか', from: suzuki, to: me, date: new Date(NOW - 2 * HOUR), text: 'x', flags: ['\\Seen'] })
  const sentOne = imap.put('Sent', { subject: '送った', from: me, to: tanaka, date: new Date(NOW - 3 * HOUR), text: 's', flags: ['\\Seen'] })
  let settings: MailSettings = { enabled: options.enabled ?? true, accounts: [account({ provider })], defaultAccountId: 'a1', syncDays: 30, notifyNewMail: true }
  const secrets = memorySecrets({ a1: 'app-password' })
  const smtp: SmtpSender & { send: ReturnType<typeof vi.fn> } = { send: vi.fn(async () => ({ messageId: '<sent-1@me>', raw: Buffer.from('raw message') })) }
  const confirm = vi.fn(async () => true)
  const events: MailEvent[] = []
  const saveSettings = vi.fn((next: MailSettings) => {
    settings = next
  })
  const cache = new MailCache(':memory:')
  const draftsFile = options.draftsFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asist-drafts-')), 'mail-drafts.json')
  const drafts = new MailDraftStore({ filePath: draftsFile, onChanged: (list) => events.push({ type: 'drafts', drafts: list }) })
  const server = imap.reconnectable()
  const service = new MailService({
    settings: () => settings,
    saveSettings,
    secrets,
    cache,
    drafts,
    createClient: () => server.next().asClient(),
    smtp,
    confirm,
    emit: (event) => events.push(event),
    now: () => Date.now(),
    createId: () => 'new-id',
    syncIntervals: { periodicMs: 60_000, reconnectMs: [1_000], debounceMs: 100 }
  })
  service.start()
  if (settings.enabled) await service.syncNow()
  const ids = {
    question: messageIdOf('a1', 'inbox', '1', question.uid),
    other: messageIdOf('a1', 'inbox', '1', other.uid),
    sent: messageIdOf('a1', 'sent', '1', sentOne.uid)
  }
  const signal = new AbortController()
  const outgoing = (): OutgoingMail => smtp.send.mock.calls[0][2] as OutgoingMail
  return { imap, server, cache, drafts, draftsFile, service, secrets, smtp, confirm, events, saveSettings, settings: () => settings, ids, signal, outgoing, question, other }
}

/** What the send button of a draft does when the screen shows the draft as it is stored. */
function pressSend(f: Awaited<ReturnType<typeof setup>>, id: string) {
  return f.service.draftSend(id, f.signal.signal, f.drafts.get(id)?.updatedAt ?? 0)
}

/** What the reader's reply form does: main settles the reply the form shows, and the same reply is sent. */
async function replyFromReader(f: Awaited<ReturnType<typeof setup>>, id: string, body: string, replyAll = false) {
  return f.service.replySend({ reply: await f.service.replySettle(id, replyAll), body }, f.signal.signal)
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the approval gate', () => {
  it('confirms an agent operation even when it only marks a message read, and changes server and cache once approved', async () => {
    const f = await setup()
    const result = await f.service.change({ operation: 'markRead', ids: [f.ids.question], read: true }, f.signal.signal, 'agent')
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0][0]).toContain('見積もりの相談')
    expect(f.confirm.mock.calls[0][0]).toContain('既読にします')
    // The button names the operation, so pressing it holds no surprise.
    expect(f.confirm.mock.calls[0][2]).toBe(t('mail.confirm.action.markRead'))
    expect(result).toMatchObject({ saved: true, operation: 'markRead', id: f.ids.question })
    expect(f.imap.calls).toContain(`flags+:INBOX:${f.question.uid}:\\Seen`)
    expect(f.cache.get(f.ids.question)?.unread).toBe(false)
    expect(f.events.some((event) => event.type === 'changed')).toBe(true)
    await f.service.stop()
  })

  it('runs star and archive from the screen without a confirmation and confirms trash', async () => {
    const f = await setup()
    await f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen')
    await f.service.change({ operation: 'archive', id: f.ids.other }, f.signal.signal, 'screen')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.cache.get(f.ids.question)?.starred).toBe(true)
    expect(f.cache.get(f.ids.other)).toBeNull()
    expect(f.imap.calls).toContain(`move:INBOX:${f.other.uid}:Archive`)
    await f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen')
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0]?.[3]).toBe(true)
    expect(f.imap.calls).toContain(`move:INBOX:${f.question.uid}:Trash`)
    await f.service.stop()
  })

  it('changes nothing when the confirmation is cancelled or aborted, and stops when the settings change while it is open', async () => {
    const f = await setup()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen')).resolves.toEqual({ cancelled: true, saved: false })
    f.confirm.mockImplementationOnce(async () => {
      f.signal.abort()
      return true
    })
    await expect(f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen')).rejects.toThrow()
    const fresh = new AbortController()
    f.confirm.mockImplementationOnce(async () => {
      f.saveSettings({ ...f.settings(), syncDays: 60 })
      return true
    })
    await expect(f.service.change({ operation: 'trash', id: f.ids.question }, fresh.signal, 'screen')).rejects.toThrow(errorText('mail.errors.change.settingsChanged'))
    expect(f.imap.calls.some((call) => call.startsWith('move:'))).toBe(false)
    expect(f.smtp.send).not.toHaveBeenCalled()
    expect(f.cache.get(f.ids.question)).not.toBeNull()
    await f.service.stop()
  })

  it('allows only one confirmation at a time and refuses every operation while mail is disabled', async () => {
    const f = await setup()
    let release!: (value: boolean) => void
    f.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
    const first = f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen')
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
    await expect(f.service.change({ operation: 'trash', id: f.ids.other }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.change.confirmBusy'))
    release(false)
    await first
    f.saveSettings({ ...f.settings(), enabled: false })
    await expect(f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.disabled'))
    await f.service.stop()
  })
})

describe('flag changes', () => {
  it('fails and leaves the cache untouched when the server rejects the flag change', async () => {
    const f = await setup()
    f.imap.folders.get('INBOX')!.messages.delete(f.question.uid)
    await expect(f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.change.rejected'))
    expect(f.cache.get(f.ids.question)?.starred).toBe(false)
    await f.service.stop()
  })

  it('marks the messages of one folder read in a single STORE and counts them per folder in the confirmation text', async () => {
    const f = await setup()
    f.imap.put('INBOX', { subject: '三つ目', from: tanaka, to: me, date: new Date(NOW - 4 * HOUR), text: 'z' })
    await f.service.syncNow()
    const unread = f.service.list({ view: 'inbox', unreadOnly: true }).messages.map((message) => message.id)
    expect(unread).toHaveLength(2)
    const result = await f.service.change({ operation: 'markRead', ids: [...unread, f.ids.sent], read: true }, f.signal.signal, 'agent')
    expect(f.confirm.mock.calls[0][0]).toBe(
      [
        t('mail.confirm.markReadMany'),
        t('mail.confirm.group', { label: '仕事', box: t('mail.boxes.inbox'), count: 2 }),
        t('mail.confirm.group', { label: '仕事', box: t('mail.boxes.sent'), count: 1 })
      ].join('\n')
    )
    expect(result).toMatchObject({ saved: true, operation: 'markRead', summary: t('mail.result.markReadCount', { count: 3 }) })
    expect(f.imap.calls.filter((call) => call.startsWith('flags+:INBOX'))).toHaveLength(1)
    expect(f.imap.calls.filter((call) => call.startsWith('flags+:Sent'))).toHaveLength(1)
    expect(f.service.list({ view: 'inbox' }).unread).toBe(0)
    await expect(f.service.change({ operation: 'markRead', ids: ['a1:inbox:1:999'], read: true }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.message.notFound'))
    await f.service.stop()
  })

  it('queues operations that need no confirmation instead of rejecting the ones that arrive while another runs', async () => {
    const f = await setup()
    const results = await Promise.all([
      f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen'),
      f.service.change({ operation: 'markRead', ids: [f.ids.question], read: true }, f.signal.signal, 'screen'),
      f.service.change({ operation: 'star', id: f.ids.other, starred: true }, f.signal.signal, 'screen')
    ])
    expect(results.every((result) => result.saved)).toBe(true)
    expect(f.cache.get(f.ids.question)).toMatchObject({ starred: true, unread: false })
    expect(f.cache.get(f.ids.other)?.starred).toBe(true)
    await f.service.stop()
  })
})

describe('sending and replying', () => {
  it('sends without a confirmation from the screen and parses the recipients', async () => {
    const f = await setup()
    const result = await f.service.change(
      { operation: 'send', to: ['田中 <t@example.com>', 's@example.com'], cc: ['cc@example.com'], subject: '来週の件', body: 'よろしくお願いします。' },
      f.signal.signal,
      'screen'
    )
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.smtp.send).toHaveBeenCalledOnce()
    expect(f.smtp.send.mock.calls[0][1]).toBe('app-password')
    expect(f.outgoing()).toMatchObject({
      from: { name: '私', address: 'me@example.com' },
      to: [{ name: '田中', address: 't@example.com' }, { name: '', address: 's@example.com' }],
      cc: [{ name: '', address: 'cc@example.com' }],
      subject: '来週の件',
      text: 'よろしくお願いします。'
    })
    expect(result).toMatchObject({ saved: true, operation: 'send', id: '<sent-1@me>' })
    expect((result as { summary: string }).summary).toBe(t('mail.result.send', { recipients: '田中, s@example.com' }))
    await f.service.stop()
  })

  it('appends the raw sent message to the Sent folder when the server did not file it there', async () => {
    const f = await setup({ provider: 'icloud' })
    await f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')
    expect(f.imap.calls).toContain('append:Sent')
    expect([...f.imap.folders.get('Sent')!.messages.values()].some((mail) => mail.text === 'raw message' && mail.flags.includes('\\Seen'))).toBe(true)
    await f.service.stop()
  })

  it('appends nothing to Sent when the server filed the sent message there itself, as Exchange Online and Yahoo do', async () => {
    const f = await setup({ provider: 'custom' })
    f.smtp.send.mockImplementationOnce(async () => {
      f.imap.put('Sent', { subject: 'x', from: me, to: tanaka, date: new Date(), text: 'y', flags: ['\\Seen'], messageId: '<sent-1@me>' })
      return { messageId: '<sent-1@me>', raw: Buffer.from('raw message') }
    })
    await f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')
    expect(f.imap.calls).not.toContain('append:Sent')
    expect([...f.imap.folders.get('Sent')!.messages.values()].filter((mail) => mail.messageId === '<sent-1@me>')).toHaveLength(1)
    await f.service.stop()
  })

  it('appends the sent message to Sent when the search for it fails, since a missing copy is worse than a second one', async () => {
    const f = await setup({ provider: 'icloud' })
    f.imap.failSearch = true
    const result = await f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')
    expect(f.imap.calls).toContain('append:Sent')
    expect((result as { summary: string }).summary).toBe(t('mail.result.send', { recipients: 't@example.com' }))
    await f.service.stop()
  })

  it('neither searches nor appends to Sent on Gmail, which files every message sent through it there itself', async () => {
    const f = await setup({ provider: 'gmail' })
    const result = await f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')
    expect(f.imap.calls.filter((call) => call === 'search:Sent:<sent-1@me>' || call === 'append:Sent')).toEqual([])
    expect((result as { summary: string }).summary).toBe(t('mail.result.send', { recipients: 't@example.com' }))
    await f.service.stop()
  })

  it('replies to the sender with Re:, quotes the original body, carries the thread headers, and flags the original as answered', async () => {
    const f = await setup()
    const result = await replyFromReader(f, f.ids.question, '了解です。')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.outgoing()).toMatchObject({
      to: [{ name: '田中', address: 't@example.com' }],
      cc: [],
      subject: 'Re: 見積もりの相談',
      inReplyTo: '<q@x>',
      references: ['<q@x>']
    })
    expect(f.outgoing().text).toMatch(/^了解です。\n\n.*田中 <t@example.com>:\n> 一行目\n> 二行目\n$/s)
    expect(f.imap.calls).toContain(`flags+:INBOX:${f.question.uid}:\\Answered`)
    expect(f.cache.get(f.ids.question)?.answered).toBe(true)
    expect(result).toMatchObject({ saved: true, operation: 'reply' })
    await f.service.stop()
  })

  it('adds the original recipients and Cc to a reply-all, leaving out the account address itself', async () => {
    const f = await setup()
    await replyFromReader(f, f.ids.question, 'ok', true)
    expect(f.outgoing()).toMatchObject({
      to: [{ name: '田中', address: 't@example.com' }],
      cc: [{ name: '鈴木', address: 's@example.com' }, { name: '', address: 'cc@example.com' }]
    })
    await f.service.stop()
  })

  it('answers a message the user sent to the people it went to, in a reply and in a reply-all', async () => {
    const f = await setup()
    const sent = f.imap.put('Sent', { subject: '日程のご相談', from: me, to: tanaka, cc: suzuki, date: new Date(NOW - 2 * HOUR), text: 'いかがでしょうか', flags: ['\\Seen'], messageId: '<ask@me>' })
    await f.service.syncNow()
    const id = messageIdOf('a1', 'sent', '1', sent.uid)
    expect(await f.service.replySettle(id, false)).toMatchObject({ to: tanaka, cc: [] })
    expect(await f.service.replySettle(id, true)).toMatchObject({ to: tanaka, cc: suzuki })
    await f.service.stop()
  })

  it('sends a reply from the reader to exactly the To and Cc it settled for the form, which follow Reply-To rather than the sender', async () => {
    const f = await setup()
    const elsewhere = { name: '上司', address: 'attacker@evil.example' }
    const phishing = f.imap.put('INBOX', { subject: '請求書の件', from: [{ name: '上司', address: 'boss@company.example' }], replyTo: [elsewhere], to: [...me, ...suzuki], date: new Date(NOW - HOUR), text: '至急返信して', messageId: '<m1@x>' })
    await f.service.syncNow()
    const reply = await f.service.replySettle(messageIdOf('a1', 'inbox', '1', phishing.uid), true)
    expect({ to: reply.to, cc: reply.cc }).toEqual({ to: [elsewhere], cc: suzuki })
    await f.service.replySend({ reply, body: '確認します' }, f.signal.signal)
    expect({ to: f.outgoing().to, cc: f.outgoing().cc }).toEqual({ to: reply.to, cc: reply.cc })
    await f.service.stop()
  })

  it('refuses a reply from the screen that was not settled first, and fails to settle one without a connection to the account', async () => {
    const f = await setup()
    await expect(f.service.change({ operation: 'reply', id: f.ids.question, body: '了解です。' }, f.signal.signal, 'screen')).rejects.toThrow()
    await expect(f.service.replySend({ reply: { id: f.ids.question }, body: '了解です。' }, f.signal.signal)).rejects.toThrow()
    await f.service.stop()
    await expect(f.service.replySettle(f.ids.question, false)).rejects.toThrow(errorText('mail.errors.account.off'))
    expect(f.smtp.send).not.toHaveBeenCalled()
  })

  it('carries the parent References followed by its Message-ID, so that a reply to a later message joins the same thread', async () => {
    const f = await setup({ provider: 'icloud' })
    const second = f.imap.put('INBOX', { subject: 'Re: 打合せ', from: tanaka, to: me, date: new Date(NOW - HOUR), text: '二通目', messageId: '<p2@x>', inReplyTo: '<p1@x>', references: '<root@x> <p1@x>' })
    await f.service.syncNow()
    const id = messageIdOf('a1', 'inbox', '1', second.uid)
    await replyFromReader(f, id, '了解です。')
    expect(f.outgoing()).toMatchObject({ inReplyTo: '<p2@x>', references: ['<root@x>', '<p1@x>', '<p2@x>'] })
    // The thread the sync puts the sent copy in, from the headers the reply carries.
    const replyThread = threadIdOf({ messageId: '<sent-1@me>', inReplyTo: f.outgoing().inReplyTo ?? '', references: f.outgoing().references ?? [], fallback: 'x' })
    expect(replyThread).toBe(f.cache.get(id)?.threadId)
    await f.service.stop()
  })

  it('marks no other message answered when the folder of the original now points at a mailbox with the same UIDVALIDITY, whether or not the two have a Message-ID', async () => {
    for (const messageIds of [{ original: '<archived@x>', other: '<elsewhere@x>' }, { original: undefined, other: undefined }]) {
      const f = await setup()
      const archived = f.imap.put('Archive', { subject: '片付けた相談', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a', messageId: messageIds.original })
      await f.service.syncNow()
      const original = f.service.list({ view: 'archive' }).messages.find((message) => message.subject === '片付けた相談')!
      const result = await f.service.change({ operation: 'reply', id: original.id, body: '了解です。' }, f.signal.signal, 'agent')
      // The archive is pointed at another mailbox, whose UIDVALIDITY and first UID are the same.
      const other = f.imap.addFolder('Archive2', { uidValidity: f.imap.folders.get('Archive')!.uidValidity })
      f.imap.put('Archive2', { uid: archived.uid, subject: '別の箱のメール', from: suzuki, to: me, date: new Date(NOW - HOUR), text: 'b', messageId: messageIds.other })
      await f.service.updateAccount('a1', { folders: { sent: 'Sent', archive: 'Archive2', trash: 'Trash' } })
      await f.service.syncNow()
      const sent = await pressSend(f, (result as { draftId: string }).draftId)
      expect(other.messages.get(archived.uid)?.flags).not.toContain('\\Answered')
      expect((sent as { summary: string }).summary).toContain(t('mail.result.answeredFailed', { reason: t('mail.errors.message.notFound') }))
      await f.service.stop()
    }
  })

  it('does not mark the original answered, and says so, when the server refuses the flag', async () => {
    const f = await setup()
    const result = await f.service.change({ operation: 'reply', id: f.ids.question, body: '了解です。' }, f.signal.signal, 'agent')
    const draftId = (result as { draftId: string }).draftId
    // The message has gone from the server while the cache still lists it, so the STORE matches nothing.
    f.imap.folders.get('INBOX')!.messages.delete(f.question.uid)
    const sent = await pressSend(f, draftId)
    expect(sent).toMatchObject({ saved: true, operation: 'reply' })
    expect((sent as { summary: string }).summary).toContain(t('mail.result.answeredFailed', { reason: t('mail.errors.change.rejected') }))
    expect(f.cache.get(f.ids.question)?.answered).toBe(false)
    await f.service.stop()
  })

  it('names a failure that happened before sending, and asks the user to check instead of resending when the message may already be out', async () => {
    const f = await setup()
    f.smtp.send.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))
    await expect(f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.send.sendFailed', { reason: 'Invalid login' }))
    f.smtp.send.mockRejectedValueOnce(new Error('connection reset after DATA'))
    await expect(f.service.change({ operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.send.sendUnknown', { reason: 'connection reset after DATA' }))
    expect(f.smtp.send).toHaveBeenCalledTimes(2)
    await f.service.stop()
  })

  it('archives inbox messages only, and fails before the confirmation when the account has no target folder', async () => {
    const f = await setup()
    await expect(f.service.change({ operation: 'archive', id: f.ids.sent }, f.signal.signal, 'agent')).rejects.toThrow(errorText('mail.errors.change.notInInbox'))
    f.saveSettings({ ...f.settings(), accounts: [account({ folders: { sent: 'Sent', archive: null, trash: null } })] })
    await expect(f.service.change({ operation: 'archive', id: f.ids.question }, f.signal.signal, 'agent')).rejects.toThrow(errorText('mail.errors.folder.archiveMissing'))
    await expect(f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'agent')).rejects.toThrow(errorText('mail.errors.folder.trashMissing'))
    expect(f.confirm).not.toHaveBeenCalled()
    await f.service.stop()
  })
})

describe('drafts', () => {
  it('turns an agent send into a draft, sends it when the card asks, and then removes the draft', async () => {
    const f = await setup()
    const result = await f.service.change({ operation: 'send', to: ['田中 <t@example.com>'], subject: '季節のご挨拶', body: '拝啓' }, f.signal.signal, 'agent')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.smtp.send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ drafted: true, saved: false })
    const draftId = (result as { draftId: string }).draftId
    expect(f.drafts.get(draftId)).toMatchObject({ accountId: 'a1', to: ['田中 <t@example.com>'], subject: '季節のご挨拶', body: '拝啓', reply: null, origin: 'agent' })
    expect(f.events.some((event) => event.type === 'drafts' && event.drafts.length === 1)).toBe(true)
    f.service.draftUpdate(draftId, { body: '拝啓\n時節柄ご自愛ください。' })
    const sent = await pressSend(f, draftId)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.outgoing()).toMatchObject({ to: [{ name: '田中', address: 't@example.com' }], subject: '季節のご挨拶', text: '拝啓\n時節柄ご自愛ください。' })
    expect(sent).toMatchObject({ saved: true, operation: 'send' })
    expect(f.drafts.get(draftId)).toBeNull()
    await expect(pressSend(f, draftId)).rejects.toThrow(errorText('mail.errors.draft.gone'))
    await f.service.stop()
  })

  it('settles an agent reply draft from the original, keeps its recipients and subject through an edit, and sends it with the quotation', async () => {
    const f = await setup()
    const result = await f.service.change({ operation: 'reply', id: f.ids.question, body: '了解です。', replyAll: true }, f.signal.signal, 'agent')
    const draftId = (result as { draftId: string }).draftId
    expect(f.drafts.get(draftId)).toMatchObject({
      reply: {
        id: f.ids.question,
        subject: '見積もりの相談',
        from: { name: '田中', address: 't@example.com' },
        replyAll: true,
        to: [{ name: '田中', address: 't@example.com' }],
        cc: [{ name: '鈴木', address: 's@example.com' }, { name: '', address: 'cc@example.com' }],
        inReplyTo: '<q@x>'
      },
      to: [],
      subject: ''
    })
    expect(f.service.draftUpdate(draftId, { to: ['x@example.com'], subject: 'x', body: 'では。' })).toMatchObject({ to: [], subject: '', body: 'では。' })
    await pressSend(f, draftId)
    expect(f.outgoing()).toMatchObject({ subject: 'Re: 見積もりの相談', inReplyTo: '<q@x>', references: ['<q@x>'] })
    expect(f.outgoing().text).toMatch(/^では。\n\n.*> 一行目/s)
    expect(f.cache.get(f.ids.question)?.answered).toBe(true)
    await f.service.stop()
  })

  it('sends a reply draft to exactly the addresses the draft shows, which follow Reply-To rather than the sender', async () => {
    const f = await setup()
    const boss = { name: '上司', address: 'boss@company.example' }
    const elsewhere = { name: '上司', address: 'attacker@evil.example' }
    const phishing = f.imap.put('INBOX', { subject: '請求書の件', from: [boss], replyTo: [elsewhere], to: [...me, ...suzuki], date: new Date(NOW - HOUR), text: '至急返信して', messageId: '<m1@x>' })
    await f.service.syncNow()
    const result = await f.service.change({ operation: 'reply', id: messageIdOf('a1', 'inbox', '1', phishing.uid), body: '確認します', replyAll: true }, f.signal.signal, 'agent')
    const draft = f.drafts.get((result as { draftId: string }).draftId)!
    // The card and the composer show these addresses in full; the sender's name alone would hide where the reply goes.
    expect(draft.reply).toMatchObject({ from: boss, to: [elsewhere], cc: suzuki })
    expect((result as { summary: string }).summary).toContain(elsewhere.address)
    await pressSend(f, draft.id)
    expect({ to: f.outgoing().to, cc: f.outgoing().cc }).toEqual({ to: draft.reply!.to, cc: draft.reply!.cc })
    await f.service.stop()
  })

  it('still sends an agent reply draft after the message it answers has been archived', async () => {
    const f = await setup()
    const result = await f.service.change({ operation: 'reply', id: f.ids.question, body: '明日お送りします' }, f.signal.signal, 'agent')
    const draftId = (result as { draftId: string }).draftId
    await f.service.change({ operation: 'archive', id: f.ids.question }, f.signal.signal, 'screen')
    await f.service.syncNow()
    expect(f.cache.get(f.ids.question)).toBeNull()
    await expect(pressSend(f, draftId)).resolves.toMatchObject({ saved: true, operation: 'reply' })
    expect(f.outgoing()).toMatchObject({ to: [{ name: '田中', address: 't@example.com' }], subject: 'Re: 見積もりの相談', inReplyTo: '<q@x>' })
    expect(f.outgoing().text).toMatch(/^明日お送りします\n\n.*> 一行目\n> 二行目\n$/s)
    expect(f.drafts.get(draftId)).toBeNull()
    await f.service.stop()
  })

  it('refuses to send a draft that changed after the version the screen showed, and sends the version it shows', async () => {
    const f = await setup()
    const shown = f.service.draftCreate({ to: ['t@example.com'], subject: '日程', body: '月曜でお願いします' }, 'agent')
    // The Agent's edit reaches main, within the same millisecond, while the screen still draws the version before it.
    f.service.draftUpdate(shown.id, { to: ['other@example.com'], body: '火曜でお願いします' })
    const refused = await f.service.draftSend(shown.id, f.signal.signal, shown.updatedAt).then(
      () => null,
      (error: Error) => error.message
    )
    expect(f.smtp.send).not.toHaveBeenCalled()
    expect(refused).toBe(errorText('mail.errors.draft.changed'))
    expect(f.drafts.get(shown.id)).toMatchObject({ body: '火曜でお願いします', sendStartedAt: null })
    const redrawn = f.drafts.get(shown.id)!
    await expect(f.service.draftSend(shown.id, f.signal.signal, redrawn.updatedAt)).resolves.toMatchObject({ saved: true, operation: 'send' })
    expect(f.outgoing()).toMatchObject({ to: [{ name: '', address: 'other@example.com' }], text: '火曜でお願いします' })
    await f.service.stop()
  })

  it('refuses a second send, an edit and a discard of a draft while its send is under way, and sends it once', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'screen')
    let release!: (value: { messageId: string; raw: Buffer }) => void
    f.smtp.send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    const first = pressSend(f, draft.id)
    await vi.waitFor(() => expect(f.smtp.send).toHaveBeenCalled())
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.draft.sending'))
    expect(() => f.service.draftUpdate(draft.id, { body: 'z' })).toThrow(errorText('mail.errors.draft.sending'))
    expect(() => f.service.draftRemove(draft.id)).toThrow(errorText('mail.errors.draft.sending'))
    release({ messageId: '<sent-1@me>', raw: Buffer.from('raw') })
    await expect(first).resolves.toMatchObject({ saved: true, operation: 'send' })
    expect(f.smtp.send).toHaveBeenCalledOnce()
    expect(f.outgoing().text).toBe('y')
    expect(f.drafts.get(draft.id)).toBeNull()
    await f.service.stop()
  })

  it('never sends a draft again once it went out, even when removing it fails, and says in the result that it is left', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'screen')
    // The disk fails once the message has gone out.
    const rename = vi.spyOn(fs, 'renameSync')
    f.smtp.send.mockImplementationOnce(async () => {
      rename.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      return { messageId: '<sent-1@me>', raw: Buffer.from('raw') }
    })
    const sent = await pressSend(f, draft.id)
    expect(sent).toMatchObject({ saved: true, operation: 'send' })
    expect((sent as { summary: string }).summary).toContain(t('mail.result.draftNotRemoved', { reason: 'disk full' }))
    expect(f.drafts.get(draft.id)).not.toBeNull()
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.draft.sendStarted'))
    await f.service.stop()
    // The app starts again with the same drafts file.
    const restarted = await setup({ draftsFile: f.draftsFile })
    await expect(pressSend(restarted, draft.id)).rejects.toThrow(errorText('mail.errors.draft.sendStarted'))
    expect(restarted.smtp.send).not.toHaveBeenCalled()
    restarted.service.draftRemove(draft.id)
    expect(restarted.service.draftList()).toEqual([])
    expect(f.smtp.send).toHaveBeenCalledOnce()
    await restarted.service.stop()
  })

  it('counts a message SMTP accepted as sent whatever fails afterwards, says what failed, and never sends the draft again', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'screen')
    const counts = vi.spyOn(f.cache, 'counts')
    f.smtp.send.mockImplementationOnce(async () => {
      // The SQLite read behind the status that follows a send fails once the message has gone out.
      counts.mockImplementationOnce(() => {
        throw new Error('disk I/O error')
      })
      return { messageId: '<sent-1@me>', raw: Buffer.from('raw') }
    })
    const sent = await pressSend(f, draft.id)
    expect(sent).toMatchObject({ saved: true, operation: 'send' })
    expect((sent as { summary: string }).summary).toContain(t('mail.result.afterSendFailed', { reason: 'disk I/O error' }))
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.draft.gone'))
    expect(f.smtp.send).toHaveBeenCalledOnce()
    await f.service.stop()
  })

  it('refuses to edit a draft whose send started, so that it keeps showing where the mail may have gone', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'agent')
    // What the app finds after it stopped in the middle of sending this draft.
    f.drafts.setSendStartedAt(draft.id, Date.now())
    expect(() => f.service.draftUpdate(draft.id, { body: 'rewritten', to: ['other@example.com'] })).toThrow(errorText('mail.errors.draft.sendStarted'))
    expect(f.drafts.get(draft.id)).toMatchObject({ to: ['t@example.com'], body: 'y' })
    f.service.draftRemove(draft.id)
    expect(f.service.draftList()).toEqual([])
    await f.service.stop()
  })

  it('lets a draft be sent again after a send that failed before sending or whose outcome is unknown', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'screen')
    f.smtp.send.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.send.sendFailed', { reason: 'Invalid login' }))
    f.smtp.send.mockRejectedValueOnce(new Error('connection reset after DATA'))
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.send.sendUnknown', { reason: 'connection reset after DATA' }))
    await expect(pressSend(f, draft.id)).resolves.toMatchObject({ saved: true, operation: 'send' })
    expect(f.smtp.send).toHaveBeenCalledTimes(3)
    expect(f.drafts.get(draft.id)).toBeNull()
    await f.service.stop()
  })

  it('refuses a draft whose failed send could not be recorded as failed, and says why', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['t@example.com'], subject: 'x', body: 'y' }, 'screen')
    const rename = vi.spyOn(fs, 'renameSync')
    f.smtp.send.mockImplementationOnce(async () => {
      rename.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' })
    })
    await expect(pressSend(f, draft.id)).rejects.toThrow(/mail\.errors\.draft\.lockedAfterFailure .*disk full/)
    await expect(pressSend(f, draft.id)).rejects.toThrow(errorText('mail.errors.draft.sendStarted'))
    expect(f.smtp.send).toHaveBeenCalledOnce()
    await f.service.stop()
  })

  it('checks an edit before storing it, so that a recipient it cannot read leaves the stored draft as it was', async () => {
    const f = await setup()
    const draft = f.service.draftCreate({ to: ['Tanaka, Taro <taro@example.com>'], subject: '明日の件', body: 'よろしくお願いします。' }, 'agent')
    expect(() => f.service.draftUpdate(draft.id, { to: ['Tanaka', 'Taro <taro@example.com>'], body: '本文を直した' })).toThrow(errorText('mail.errors.form.badAddress', { text: 'Tanaka' }))
    expect(f.drafts.get(draft.id)).toEqual(draft)
    expect(f.service.draftUpdate(draft.id, { to: ['Tanaka, Taro <taro@example.com>'], body: '本文を直した' })).toMatchObject({ to: ['Tanaka, Taro <taro@example.com>'], body: '本文を直した' })
    await f.service.stop()
  })

  it('validates recipients and account when creating a draft, refuses to send an empty body, and keeps the draft when sending fails', async () => {
    const f = await setup()
    expect(() => f.service.draftCreate({ to: ['not an address'], body: 'x' }, 'screen')).toThrow(errorText('mail.errors.form.badAddress', { text: 'not an address' }))
    expect(() => f.service.draftCreate({ accountId: 'nope', body: 'x' }, 'screen')).toThrow(errorText('mail.errors.account.notFound'))
    const empty = f.service.draftCreate({ to: ['t@example.com'], subject: 'x' }, 'screen')
    await expect(pressSend(f, empty.id)).rejects.toThrow(errorText('mail.errors.draft.emptyBody'))
    f.service.draftUpdate(empty.id, { body: 'y' })
    f.smtp.send.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))
    await expect(pressSend(f, empty.id)).rejects.toThrow(errorText('mail.errors.send.sendFailed', { reason: 'Invalid login' }))
    expect(f.drafts.get(empty.id)).not.toBeNull()
    f.service.draftRemove(empty.id)
    expect(f.service.draftList()).toEqual([])
    await f.service.stop()
  })
})

describe('reading', () => {
  it('downloads a body once, answers the second read from the cache, and never marks the message read', async () => {
    const f = await setup()
    const first = await f.service.read(f.ids.question)
    expect(first.text).toBe('一行目\n二行目')
    expect(first.message.unread).toBe(true)
    const downloads = f.imap.calls.filter((call) => call.startsWith('download:')).length
    await f.service.read(f.ids.question)
    expect(f.imap.calls.filter((call) => call.startsWith('download:')).length).toBe(downloads)
    expect(f.imap.calls.some((call) => call.includes('\\Seen'))).toBe(false)
    await expect(f.service.read('a1:inbox:1:999')).rejects.toThrow(errorText('mail.errors.message.notFound'))
    expect(f.service.thread('a1', f.cache.get(f.ids.question)!.threadId).map((m) => m.id)).toEqual([f.ids.question])
    await f.service.stop()
  })

  it('reports the connection state of each account and the unread count of the inbox', async () => {
    const f = await setup()
    expect(f.service.status()).toMatchObject({ enabled: true, unread: 1, unreadRecent: 1, accounts: [{ id: 'a1', state: 'connected', unread: 1, error: '' }] })
    expect(f.service.list({ view: 'inbox', unreadOnly: true }).messages.map((m) => m.subject)).toEqual(['見積もりの相談'])
    await f.service.stop()
    expect(f.service.status().accounts[0].state).toBe('off')
  })
})

describe('a UIDVALIDITY the server renewed', () => {
  /** The server recreates INBOX: a new UIDVALIDITY, and another message under the UID of the cached question. */
  function recreateInbox(f: Awaited<ReturnType<typeof setup>>) {
    const inbox = f.imap.folders.get('INBOX')!
    inbox.uidValidity += 1n
    inbox.messages.clear()
    return f.imap.put('INBOX', { uid: f.question.uid, subject: '別のメール', from: suzuki, to: me, date: new Date(NOW - HOUR), text: '別の本文', messageId: '<other@x>' })
  }

  it('lets no operation by UID reach the message of the new generation before the next fetch', async () => {
    const operations: Array<(f: Awaited<ReturnType<typeof setup>>) => Promise<unknown>> = [
      (f) => f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen'),
      (f) => f.service.change({ operation: 'archive', id: f.ids.question }, f.signal.signal, 'screen'),
      (f) => f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen'),
      (f) => f.service.change({ operation: 'markRead', ids: [f.ids.question], read: true }, f.signal.signal, 'screen'),
      (f) => f.service.read(f.ids.question),
      (f) => f.service.replySettle(f.ids.question, false)
    ]
    for (const operation of operations) {
      const f = await setup()
      const other = recreateInbox(f)
      await expect(operation(f)).rejects.toThrow(errorText('mail.errors.message.notFound'))
      expect(f.imap.folders.get('INBOX')!.messages.get(other.uid)).toMatchObject({ subject: '別のメール', flags: [] })
      expect(f.imap.folders.get('Trash')!.messages.size + f.imap.folders.get('Archive')!.messages.size).toBe(0)
      expect(f.imap.calls.filter((call) => call.startsWith('download:') || call.startsWith('flags'))).toEqual([])
      await f.service.stop()
    }
  })

  it('drops the folder from the cache at once and fetches the new generation without announcing it as new mail', async () => {
    const f = await setup()
    recreateInbox(f)
    await expect(f.service.change({ operation: 'star', id: f.ids.question, starred: true }, f.signal.signal, 'screen')).rejects.toThrow()
    expect(f.service.list({ view: 'inbox' }).total).toBe(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.service.list({ view: 'inbox' }).messages.map((m) => m.subject)).toEqual(['別のメール'])
    expect(f.events.filter((event) => event.type === 'arrived')).toEqual([])
    await f.service.stop()
  })

  it('reaches neither by an operation nor by a read the message a resync filed under the UID of one the screen still shows', async () => {
    const operations: Array<(f: Awaited<ReturnType<typeof setup>>, id: string) => Promise<unknown>> = [
      (f, id) => f.service.change({ operation: 'star', id, starred: true }, f.signal.signal, 'screen'),
      (f, id) => f.service.change({ operation: 'markRead', ids: [id], read: true }, f.signal.signal, 'screen'),
      (f, id) => f.service.change({ operation: 'archive', id }, f.signal.signal, 'screen'),
      (f, id) => f.service.change({ operation: 'trash', id }, f.signal.signal, 'agent'),
      (f, id) => f.service.read(id),
      (f, id) => f.service.replySettle(id, false)
    ]
    for (const operation of operations) {
      const f = await setup()
      const shown = f.service.list({ view: 'inbox' }).messages.find((message) => message.subject === '見積もりの相談')!.id
      const other = recreateInbox(f)
      await f.service.syncNow()
      expect(f.service.list({ view: 'inbox' }).messages.map((message) => message.subject)).toEqual(['別のメール'])
      await expect(operation(f, shown)).rejects.toThrow(errorText('mail.errors.message.notFound'))
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.imap.folders.get('INBOX')!.messages.get(other.uid)).toMatchObject({ subject: '別のメール', flags: [] })
      expect(f.imap.calls.filter((call) => call.startsWith('download:') || call.startsWith('flags') || call.startsWith('move:'))).toEqual([])
      await f.service.stop()
    }
  })

  it('stops an operation whose message a fetch replaced while its confirmation was open', async () => {
    const f = await setup()
    f.confirm.mockImplementationOnce(async () => {
      recreateInbox(f)
      await f.service.syncNow()
      return true
    })
    await expect(f.service.change({ operation: 'trash', id: f.ids.question }, f.signal.signal, 'screen')).rejects.toThrow(errorText('mail.errors.message.notFound'))
    expect(f.imap.folders.get('Trash')!.messages.size).toBe(0)
    await f.service.stop()
  })
})

describe('accounts', () => {
  it('finds the folders by their role when probing, leaves a missing one null, and reports why a connection failed', async () => {
    const f = await setup({ provider: 'icloud' })
    const input = { label: '個人', email: 'other@example.com', name: '', provider: 'icloud' as const, imap: account().imap, smtp: account().smtp, password: 'pw' }
    expect(await f.service.probe(input)).toEqual({ folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' }, gmail: false, mailboxes: ['INBOX', 'Sent', 'Archive', 'Trash'] })
    f.imap.folders.delete('Archive')
    expect((await f.service.probe(input)).folders.archive).toBeNull()
    f.imap.failConnect = new Error('Invalid credentials')
    await expect(f.service.probe(input)).rejects.toThrow(errorText('mail.errors.account.connectFailed', { reason: 'Invalid credentials' }))
    await expect(f.service.probe({ ...input, password: '' })).rejects.toThrow(errorText('mail.errors.form.password'))
    await f.service.stop()
  })

  it('stores password and settings only after a successful connection, and removing an account deletes its settings, password and cached mail', async () => {
    const f = await setup({ provider: 'icloud' })
    const input = { label: '個人', email: 'other@example.com', name: '', provider: 'icloud' as const, imap: account().imap, smtp: account().smtp, password: 'pw2' }
    const added = await f.service.addAccount(input)
    expect(added).toMatchObject({ id: 'new-id', label: '個人', folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' } })
    expect(f.secrets.data.get('new-id')).toBe('pw2')
    expect(f.settings().accounts.map((a) => a.id)).toEqual(['a1', 'new-id'])
    await expect(f.service.addAccount({ ...input, email: 'ME@example.com' })).rejects.toThrow(errorText('mail.errors.account.duplicate'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.status().accounts.map((a) => a.id)).toEqual(['a1', 'new-id'])
    await f.service.removeAccount('a1')
    expect(f.settings()).toMatchObject({ accounts: [{ id: 'new-id' }], defaultAccountId: 'new-id' })
    expect(f.secrets.data.has('a1')).toBe(false)
    expect(f.cache.counts('a1', NOW)).toEqual({ unread: 0, unreadRecent: 0 })
    expect(f.service.list({ view: 'inbox', accountId: 'a1' }).total).toBe(0)
    await expect(f.service.removeAccount('a1')).rejects.toThrow(errorText('mail.errors.account.notFound'))
    await f.service.stop()
  })

  it('reports a connection the probe lost after the login by the reason the client emitted, and lets no error event escape', async () => {
    /**
     * imapflow emits 'error' from the socket's handler, where an EventEmitter with no listener throws it as an
     * uncaught exception of the main process, and rejects the command waiting on the socket only with
     * "Connection not available".
     */
    class LostAfterLogin extends FakeImap {
      escaped: unknown = null
      override async list(): ReturnType<FakeImap['list']> {
        try {
          this.emit('error', new Error('read ECONNRESET'))
        } catch (error) {
          this.escaped = error
        }
        throw new Error('Connection not available')
      }
    }
    const imap = new LostAfterLogin()
    const service = new MailService({
      settings: () => ({ enabled: true, accounts: [], defaultAccountId: null, syncDays: 30, notifyNewMail: true }),
      saveSettings: vi.fn(),
      secrets: memorySecrets(),
      cache: new MailCache(':memory:'),
      drafts: new MailDraftStore({ filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asist-drafts-')), 'mail-drafts.json') }),
      createClient: () => imap.asClient(),
      smtp: { send: vi.fn() },
      confirm: vi.fn(async () => true),
      emit: () => undefined
    })
    const input = { label: '個人', email: 'other@example.com', name: '', provider: 'custom' as const, imap: account().imap, smtp: account().smtp, password: 'pw' }
    const failure = await service.probe(input).then(
      () => null,
      (error: unknown) => error
    )
    expect(imap.escaped).toBeNull()
    expect(failure).toEqual(new Error(errorText('mail.errors.account.connectFailed', { reason: 'read ECONNRESET' })))
  })

  it('refuses an account past the limit before connecting, and leaves neither its password nor the account when one of the two writes fails', async () => {
    const f = await setup({ provider: 'icloud' })
    const input = { label: '個人', email: 'other@example.com', name: '', provider: 'icloud' as const, imap: account().imap, smtp: account().smtp, password: 'pw2' }
    const full = Array.from({ length: MAX_MAIL_ACCOUNTS - 1 }, (_, index) => account({ id: `more-${index}`, email: `more${index}@example.com` }))
    f.saveSettings({ ...f.settings(), accounts: [...f.settings().accounts, ...full] })
    f.saveSettings.mockClear()
    const connects = (): number => f.server.instances.flatMap((instance) => instance.calls).filter((call) => call === 'connect').length
    const before = connects()
    await expect(f.service.addAccount(input)).rejects.toThrow(errorText('mail.errors.form.tooManyAccounts', { count: MAX_MAIL_ACCOUNTS }))
    expect(connects()).toBe(before)
    expect(f.saveSettings).not.toHaveBeenCalled()
    expect(f.secrets.data.has('new-id')).toBe(false)
    // A settings file that cannot be written keeps the password out as well.
    f.saveSettings({ ...f.settings(), accounts: f.settings().accounts.slice(0, 1) })
    f.saveSettings.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    await expect(f.service.addAccount(input)).rejects.toThrow('EACCES')
    expect(f.secrets.data.has('new-id')).toBe(false)
    // A password that cannot be stored keeps the account out of the settings, so it can be added again.
    vi.spyOn(f.secrets, 'set').mockImplementationOnce(() => {
      throw new Error(errorText('mail.errors.account.encryptionUnavailable'))
    })
    await expect(f.service.addAccount(input)).rejects.toThrow(errorText('mail.errors.account.encryptionUnavailable'))
    expect(f.settings()).toMatchObject({ accounts: [{ id: 'a1' }], defaultAccountId: 'a1' })
    await expect(f.service.addAccount(input)).resolves.toMatchObject({ id: 'new-id' })
    expect(f.secrets.data.get('new-id')).toBe('pw2')
    await f.service.stop()
  })

  it('connects with the new password before storing it and reconnects the sync', async () => {
    const f = await setup()
    f.imap.failConnect = new Error('bad password')
    await expect(f.service.updateAccount('a1', undefined, 'wrong')).rejects.toThrow(errorText('mail.errors.account.connectFailed', { reason: 'bad password' }))
    expect(f.secrets.data.get('a1')).toBe('app-password')
    f.imap.failConnect = null
    const updated = await f.service.updateAccount('a1', { label: '会社' }, 'new-password')
    expect(updated.label).toBe('会社')
    expect(f.secrets.data.get('a1')).toBe('new-password')
    expect(f.settings().accounts[0].label).toBe('会社')
    await f.service.stop()
  })

  it('lists and trashes the messages of the newly chosen Sent folder once the setting points at another mailbox with the same UIDVALIDITY', async () => {
    const f = await setup()
    await vi.advanceTimersByTimeAsync(500)
    // Both mailboxes were created together, and Dovecot, for one, derives UIDVALIDITY from the creation time.
    f.imap.addFolder('Sent Messages', { uidValidity: f.imap.folders.get('Sent')!.uidValidity })
    const other = f.imap.put('Sent Messages', { uid: 1, subject: '別の送信済み', from: me, to: suzuki, date: new Date(NOW - 4 * HOUR), text: '別の本文', flags: ['\\Seen'] })
    expect(f.service.list({ view: 'sent' }).messages.map((m) => m.uid)).toEqual([other.uid])
    await f.service.updateAccount('a1', { folders: { sent: 'Sent Messages', archive: 'Archive', trash: 'Trash' } })
    await f.service.syncNow()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.service.list({ view: 'sent' }).messages.map((m) => m.subject)).toEqual(['別の送信済み'])
    await expect(f.service.read(f.ids.sent)).resolves.toMatchObject({ text: '別の本文' })
    await f.service.change({ operation: 'trash', id: f.ids.sent }, f.signal.signal, 'screen')
    expect(f.imap.folders.get('Sent')!.messages.size).toBe(1)
    expect([...f.imap.folders.get('Trash')!.messages.values()].map((m) => m.subject)).toEqual(['別の送信済み'])
    await f.service.stop()
  })
})
