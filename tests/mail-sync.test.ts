import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageIdOf, type MailAccount, type MailMessage } from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'
import { createTranslator } from '@shared/i18n'
import { MailCache } from '../src/main/services/mail-cache'
import { MailAccountSync, type MailSyncState } from '../src/main/services/mail-sync'
import { FakeImap } from './helpers/fake-imap'

// The sync writes its own status text in the interface language, which it reads from the settings.
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'ja-JP' }) }))
const t = createTranslator('ja-JP')

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 16, 6)

const account = (patch: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1',
  label: '仕事',
  email: 'me@example.com',
  name: '私',
  provider: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' },
  ...patch
})

const tanaka = [{ name: '田中', address: 't@example.com' }]
const me = [{ name: '', address: 'me@example.com' }]

function setup(options: { gmail?: boolean; account?: Partial<MailAccount>; password?: () => string } = {}) {
  const imap = new FakeImap({ gmail: options.gmail })
  imap.addFolder('Sent', { specialUse: '\\Sent' })
  imap.addFolder('Archive', { specialUse: options.gmail ? '\\All' : '\\Archive' })
  imap.addFolder('Trash', { specialUse: '\\Trash' })
  const cache = new MailCache(':memory:')
  const states: Array<[MailSyncState, string]> = []
  const arrived: MailMessage[][] = []
  const onChanged = vi.fn()
  const server = imap.reconnectable()
  const sync = new MailAccountSync({
    account: account(options.account),
    password: options.password ?? (() => 'app-password'),
    cache,
    createClient: () => server.next().asClient(),
    syncDays: () => 30,
    now: () => Date.now(),
    intervals: { periodicMs: 60_000, reconnectMs: [1_000, 5_000], debounceMs: 100 },
    onStatus: (state, error) => states.push([state, error]),
    onChanged,
    onArrived: (messages) => arrived.push(messages)
  })
  return { imap, cache, sync, states, arrived, onChanged, server }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MailAccountSync', () => {
  it('lists only the messages inside the sync window on the first pass, fetches the bodies afterwards, and announces no new mail for them', async () => {
    const { imap, cache, sync, states, arrived, onChanged } = setup()
    imap.put('INBOX', { subject: '新しい', from: tanaka, to: me, date: new Date(NOW - HOUR), text: '本文A\r\n\r\n> 引用', messageId: '<a@x>' })
    imap.put('INBOX', { subject: 'HTMLだけ', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), html: '<p>こんにちは<br>世界</p><img src="x">', flags: ['\\Seen'] })
    imap.put('INBOX', { subject: '古い', from: tanaka, to: me, date: new Date(NOW - 40 * DAY), text: '古い本文' })
    imap.put('Sent', { subject: '送った', from: me, to: tanaka, date: new Date(NOW - 3 * HOUR), text: '送った本文', attachments: [{ filename: 'a.pdf', type: 'application/pdf', size: 10 }] })
    sync.start()
    await sync.syncNow()
    expect(sync.state).toBe('connected')
    expect(sync.lastSyncAt).toBe(NOW)
    expect(states.slice(0, 3).map(([state]) => state)).toEqual(['connecting', 'syncing', 'connected'])
    expect(states.some(([state]) => state === 'error')).toBe(false)
    const inbox = cache.list({ view: 'inbox' }).messages
    expect(inbox.map((m) => m.subject)).toEqual(['新しい', 'HTMLだけ'])
    expect(inbox[0]).toMatchObject({ unread: true, messageId: '<a@x>', threadId: 'm:<a@x>', from: { name: '田中', address: 't@example.com' }, bodyFetched: false })
    expect(cache.list({ view: 'sent' }).messages[0]).toMatchObject({ subject: '送った', attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 10 }] })
    expect(arrived).toEqual([])
    // Bodies are queued and downloaded on a later tick, so nothing is fetched until the timers advance.
    expect(imap.calls.some((call) => call.startsWith('download:'))).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(cache.body(inbox[0].id)).toBe('本文A\n\n> 引用')
    expect(cache.get(inbox[0].id)).toMatchObject({ snippet: '本文A', bodyFetched: true })
    expect(cache.body(inbox[1].id)).toBe('こんにちは\n世界')
    expect(cache.body(cache.list({ view: 'sent' }).messages[0].id)).toBe('送った本文')
    expect(onChanged).toHaveBeenCalled()
    await sync.stop()
    expect(imap.calls.at(-1)).toBe('logout')
    await expect(sync.syncNow()).rejects.toThrow(errorText('mail.errors.sync.stopped'))
  })

  it('applies only the added, removed and reflagged messages on a later pass, and announces the unread that just arrived as new mail', async () => {
    const { imap, cache, sync, arrived } = setup()
    const first = imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    const second = imap.put('INBOX', { subject: 'B', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'b' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    first.flags = ['\\Seen', '\\Flagged']
    imap.folders.get('INBOX')!.messages.delete(second.uid)
    imap.put('INBOX', { subject: '新着', from: tanaka, to: me, date: new Date(NOW - 10 * 60_000), text: 'c' })
    imap.put('INBOX', { subject: '昔に届いた未読', from: tanaka, to: me, date: new Date(NOW - 3 * DAY), text: 'd' })
    imap.put('INBOX', { subject: '既読で届いた', from: tanaka, to: me, date: new Date(NOW - 60_000), text: 'e', flags: ['\\Seen'] })
    await sync.syncNow()
    const inbox = cache.list({ view: 'inbox' }).messages
    expect(inbox.map((m) => m.subject)).toEqual(['既読で届いた', '新着', 'A', '昔に届いた未読'])
    expect(cache.get(messageIdOf('a1', 'inbox', '1', first.uid))).toMatchObject({ unread: false, starred: true })
    expect(arrived).toHaveLength(1)
    expect(arrived[0].map((m) => m.subject)).toEqual(['新着'])
  })

  it('refetches the inbox alone, after a short wait, when mail arrives in the open inbox', async () => {
    const { imap, cache, sync, arrived } = setup()
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const before = imap.calls.length
    imap.arrive('INBOX', { subject: 'IDLE で来た', from: tanaka, to: me, date: new Date(NOW), text: 'x' })
    await vi.advanceTimersByTimeAsync(50)
    expect(cache.list({ view: 'inbox' }).total).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(cache.list({ view: 'inbox' }).messages[0].subject).toBe('IDLE で来た')
    expect(arrived[0].map((m) => m.subject)).toEqual(['IDLE で来た'])
    expect(imap.calls.slice(before).filter((call) => call.startsWith('open:'))).toEqual(['open:INBOX', 'open:INBOX'])
  })

  it('writes a flag notification carrying a uid straight into the cache, and refetches the folder when the notification has none', async () => {
    const { imap, cache, sync, onChanged } = setup()
    const first = imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const id = messageIdOf('a1', 'inbox', '1', first.uid)
    const fetches = imap.calls.filter((call) => call.startsWith('fetch:')).length
    onChanged.mockClear()
    imap.emit('flags', { path: 'INBOX', seq: 1, uid: first.uid, flags: new Set(['\\Seen', '\\Flagged']) })
    expect(cache.get(id)).toMatchObject({ unread: false, starred: true })
    expect(onChanged).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(imap.calls.filter((call) => call.startsWith('fetch:')).length).toBe(fetches)
    // A second notification with the same flags changes nothing.
    imap.emit('flags', { path: 'INBOX', seq: 1, uid: first.uid, flags: new Set(['\\Seen', '\\Flagged']) })
    expect(onChanged).toHaveBeenCalledTimes(1)
    // A notification without a uid refetches the folder.
    first.flags = ['\\Seen']
    imap.emit('flags', { path: 'INBOX', seq: 1, flags: new Set(['\\Seen']) })
    await vi.advanceTimersByTimeAsync(200)
    expect(cache.get(id)).toMatchObject({ unread: false, starred: false })
    expect(imap.calls.filter((call) => call.startsWith('fetch:')).length).toBe(fetches + 1)
    // A notification for a folder that is not open is ignored.
    imap.emit('flags', { path: 'Drafts', seq: 1, uid: 1, flags: new Set() })
    await vi.advanceTimersByTimeAsync(200)
    expect(imap.calls.filter((call) => call.startsWith('fetch:')).length).toBe(fetches + 1)
  })

  it('rewrites nothing on a Gmail resync when nothing changed, and updates a message whose labels changed', async () => {
    const { imap, cache, sync, onChanged } = setup({ gmail: true })
    const first = imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a', labels: ['\\Inbox'] })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    onChanged.mockClear()
    await sync.syncNow()
    expect(onChanged).not.toHaveBeenCalled()
    first.labels = ['\\Inbox', '\\Important']
    await sync.syncNow()
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(cache.get(messageIdOf('a1', 'inbox', '1', first.uid))?.labels).toEqual(['\\Inbox', '\\Important'])
  })

  it('drops and refetches a folder whose UIDVALIDITY changed', async () => {
    const { imap, cache, sync } = setup()
    imap.put('INBOX', { uid: 5, subject: '前の世代', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(cache.list({ view: 'inbox' }).messages[0]).toMatchObject({ uid: 5, subject: '前の世代' })
    const inbox = imap.folders.get('INBOX')!
    inbox.uidValidity = 2n
    inbox.messages.clear()
    imap.put('INBOX', { uid: 5, subject: '新しい世代', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'b' })
    await sync.syncNow()
    expect(cache.list({ view: 'inbox' }).messages.map((m) => m.subject)).toEqual(['新しい世代'])
    expect(cache.uidValidity('a1', 'inbox')).toBe('2')
  })

  it('asks the list to reload when a new UIDVALIDITY empties a folder, whether or not anything of the new generation is fetched', async () => {
    const { imap, cache, sync, onChanged } = setup()
    imap.put('INBOX', { uid: 5, subject: '前の世代', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const inbox = imap.folders.get('INBOX')!
    inbox.uidValidity = 2n
    inbox.messages.clear()
    onChanged.mockClear()
    await sync.syncNow()
    expect(cache.list({ view: 'inbox' }).total).toBe(0)
    expect(onChanged).toHaveBeenCalled()
    // The message list of the new generation cannot be read, and the old messages are gone all the same.
    imap.put('INBOX', { subject: '二つ目の世代', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'b' })
    await sync.syncNow()
    expect(cache.list({ view: 'inbox' }).total).toBe(1)
    inbox.uidValidity = 3n
    imap.failSearch = true
    onChanged.mockClear()
    await sync.syncNow()
    expect(sync.state).toBe('error')
    expect(cache.list({ view: 'inbox' }).total).toBe(0)
    expect(onChanged).toHaveBeenCalled()
    await sync.stop()
  })

  it('uses the thread id and labels the Gmail server reports, and keeps the All Mail copy of an inbox message out of archive', async () => {
    const { imap, cache, sync } = setup({ gmail: true })
    imap.put('INBOX', { subject: '見積もりの相談', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'q', threadId: '77', labels: ['\\Inbox'], messageId: '<q@x>' })
    imap.put('Archive', { subject: '見積もりの相談', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'q', threadId: '77', labels: ['\\Inbox'], messageId: '<q@x>' })
    imap.put('Archive', { subject: '片付けた', from: tanaka, to: me, date: new Date(NOW - 5 * HOUR), text: 'z', threadId: '78', labels: ['\\Important'] })
    imap.put('Archive', { subject: '送信の写し', from: me, to: tanaka, date: new Date(NOW - 6 * HOUR), text: 's', threadId: '77', labels: ['\\Sent'] })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(cache.list({ view: 'inbox' }).messages[0]).toMatchObject({ threadId: 'g:77', labels: ['\\Inbox'] })
    expect(cache.list({ view: 'archive' }).messages.map((m) => m.subject)).toEqual(['片付けた'])
    expect(cache.thread('a1', 'g:77').map((m) => m.folder)).toEqual(['inbox'])
    expect(imap.calls.some((call) => call.startsWith('fetch:Archive'))).toBe(true)
  })

  it('moves the All Mail copy of a message into archive once Gmail takes it out of the inbox, and out again when it returns', async () => {
    const { imap, cache, sync } = setup({ gmail: true })
    const inInbox = imap.put('INBOX', { subject: '見積もりの相談', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'q', threadId: '77', labels: ['\\Inbox'], messageId: '<q@x>' })
    const copy = imap.put('Archive', { subject: '見積もりの相談', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'q', threadId: '77', labels: ['\\Inbox'], messageId: '<q@x>' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(cache.list({ view: 'archive' }).total).toBe(0)

    imap.folders.get('INBOX')!.messages.delete(inInbox.uid)
    copy.labels = []
    await sync.syncNow()
    expect(cache.list({ view: 'archive' }).messages.map((m) => m.uid)).toEqual([copy.uid])

    copy.labels = ['\\Inbox']
    await sync.syncNow()
    expect(cache.list({ view: 'archive' }).total).toBe(0)
  })

  it('reports a dropped connection as an error, reconnects after a wait and resyncs, and waits longer while it still cannot connect', async () => {
    const { imap, cache, sync, states, server } = setup()
    imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    imap.drop('socket hang up')
    expect(sync.state).toBe('error')
    expect(states.at(-1)).toEqual(['error', 'socket hang up'])
    imap.put('INBOX', { subject: '切断中に届いた', from: tanaka, to: me, date: new Date(NOW), text: 'b' })
    await vi.advanceTimersByTimeAsync(999)
    expect(sync.state).toBe('error')
    await vi.advanceTimersByTimeAsync(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.state).toBe('connected')
    expect(cache.list({ view: 'inbox' }).messages.map((m) => m.subject)).toEqual(['切断中に届いた', 'A'])
    // The reconnect waits 1 second for the first attempt and 5 seconds for the next one.
    expect(server.instances).toHaveLength(2)
    server.instances[1].drop('gone')
    imap.failConnect = new Error('auth failed')
    await vi.advanceTimersByTimeAsync(1_001)
    expect(sync.state).toBe('error')
    expect(sync.error).toContain('auth failed')
    const connects = () => server.instances.flatMap((client) => client.calls).filter((call) => call === 'connect').length
    const attemptsBefore = connects()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(connects()).toBe(attemptsBefore)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(connects()).toBe(attemptsBefore + 1)
    await sync.stop()
  })

  it('shows a failed refetch that IDLE started as the account error, fetches the folder again on the periodic sync, and reconnects when the connection broke', async () => {
    const { imap, cache, sync, server } = setup()
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(sync.state).toBe('connected')
    imap.failSearch = true
    imap.arrive('INBOX', { subject: '届いた', from: tanaka, to: me, date: new Date(NOW), text: 'x' })
    await vi.advanceTimersByTimeAsync(150)
    expect(sync.state).toBe('error')
    expect(sync.error).toBe(t('mail.errors.sync.folderFailed', { box: t('mail.boxes.inbox'), reason: t('mail.errors.sync.noMessageList') }))
    imap.failSearch = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync.state).toBe('connected')
    expect(cache.list({ view: 'inbox' }).messages.map((m) => m.subject)).toEqual(['届いた'])
    // The connection breaks during the next refetch.
    imap.search = async () => {
      imap.drop('socket hang up')
      throw new Error('socket hang up')
    }
    imap.arrive('INBOX', { subject: '切れる前に届いた', from: tanaka, to: me, date: new Date(NOW), text: 'y' })
    await vi.advanceTimersByTimeAsync(150)
    expect(sync.state).toBe('error')
    expect(sync.error).toBe('socket hang up')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.instances).toHaveLength(2)
    expect(sync.state).toBe('connected')
    expect(cache.list({ view: 'inbox' }).messages.map((m) => m.subject)).toEqual(['切れる前に届いた', '届いた'])
    await sync.stop()
  })

  it('keeps the error of a folder that failed while another folder is fetched successfully', async () => {
    const { imap, sync } = setup({ account: { folders: { sent: 'Missing', archive: null, trash: null } } })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const sentFailed = t('mail.errors.sync.folderFailed', { box: t('mail.boxes.sent'), reason: 'no such mailbox: Missing' })
    expect(sync.error).toBe(sentFailed)
    imap.arrive('INBOX', { subject: '届いた', from: tanaka, to: me, date: new Date(NOW), text: 'x' })
    await vi.advanceTimersByTimeAsync(150)
    expect(sync.state).toBe('error')
    expect(sync.error).toBe(sentFailed)
    await sync.stop()
  })

  it('ends a connection that opens after stop() was called, and runs nothing on it', async () => {
    const { imap, sync } = setup()
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    const connect = imap.connect.bind(imap)
    imap.connect = async () => {
      await opened
      await connect()
    }
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.state).toBe('connecting')
    const stopping = sync.stop()
    open()
    await stopping
    expect(imap.usable).toBe(false)
    expect(imap.calls).toContain('logout')
    expect(imap.calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(sync.state).toBe('off')
  })

  it('returns a cached body, downloads one that is missing, and throws for a message that is not there', async () => {
    const { imap, cache, sync } = setup()
    const mail = imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await sync.syncNow()
    const id = messageIdOf('a1', 'inbox', '1', mail.uid)
    expect(cache.body(id)).toBeNull()
    await expect(sync.fetchBody(messageIdOf('a1', 'inbox', '1', mail.uid))).resolves.toBe('a')
    const downloads = imap.calls.filter((call) => call.startsWith('download:')).length
    await expect(sync.fetchBody(messageIdOf('a1', 'inbox', '1', mail.uid))).resolves.toBe('a')
    expect(imap.calls.filter((call) => call.startsWith('download:')).length).toBe(downloads)
    await expect(sync.fetchBody(messageIdOf('a1', 'inbox', '1', 999))).rejects.toThrow(errorText('mail.errors.message.notFound'))
    await sync.stop()
  })

  it('syncs the remaining folders when one cannot be read and keeps the reason', async () => {
    const { imap, cache, sync } = setup({ account: { folders: { sent: 'Missing', archive: null, trash: null } } })
    imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.state).toBe('error')
    expect(sync.error).toBe(t('mail.errors.sync.folderFailed', { box: t('mail.boxes.sent'), reason: 'no such mailbox: Missing' }))
    expect(cache.list({ view: 'inbox' }).total).toBe(1)
    await sync.stop()
  })

  it('keeps the cached folder and announces nothing again when the server rejects the search', async () => {
    const { imap, cache, sync, arrived } = setup()
    const mail = imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const id = messageIdOf('a1', 'inbox', '1', mail.uid)
    expect(cache.body(id)).toBe('a')
    imap.failSearch = true
    await sync.syncNow()
    expect(sync.state).toBe('error')
    expect(sync.error).toBe(t('mail.errors.sync.folderFailed', { box: t('mail.boxes.inbox'), reason: t('mail.errors.sync.noMessageList') }))
    expect(cache.list({ view: 'inbox' }).messages.map((m) => m.id)).toEqual([id])
    expect(cache.body(id)).toBe('a')
    imap.failSearch = false
    await sync.syncNow()
    expect(sync.state).toBe('connected')
    expect(arrived).toEqual([])
    await sync.stop()
  })

  it('returns to the inbox after working in another folder, so mail arriving in the inbox is still noticed', async () => {
    const { imap, cache, sync, arrived } = setup()
    imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    imap.put('Sent', { subject: '送った', from: me, to: tanaka, date: new Date(NOW - 2 * HOUR), text: 's' })
    const archived = imap.put('Archive', { subject: '片付けた', from: tanaka, to: me, date: new Date(NOW - 3 * HOUR), text: 'z' })
    sync.start()
    // The bodies of the inbox, then of sent mail and the archive, are fetched on this tick.
    await vi.advanceTimersByTimeAsync(300)
    expect(cache.body(messageIdOf('a1', 'archive', '1', archived.uid))).toBe('z')
    imap.arrive('INBOX', { subject: '届いた', from: tanaka, to: me, date: new Date(NOW), text: 'x' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(arrived.flat().map((m) => m.subject)).toEqual(['届いた'])
    // Opening a sent message whose body has not been fetched yet selects Sent.
    const later = imap.put('Sent', { subject: 'また送った', from: me, to: tanaka, date: new Date(NOW), text: 't' })
    await sync.syncNow()
    await expect(sync.fetchBody(messageIdOf('a1', 'sent', '1', later.uid))).resolves.toBe('t')
    imap.arrive('INBOX', { subject: 'もう一通', from: tanaka, to: me, date: new Date(NOW), text: 'y' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(arrived.flat().map((m) => m.subject)).toEqual(['届いた', 'もう一通'])
    await sync.stop()
  })

  it('fetches the other bodies when one cannot be downloaded or turned into text, and tries that one again when it is opened', async () => {
    const { imap, cache, sync } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // html-to-text recurses once per level of nesting and throws RangeError on this.
    const deep = imap.put('INBOX', { subject: '深いHTML', from: tanaka, to: me, date: new Date(NOW - HOUR), html: '<div>'.repeat(6_000) + 'x' + '</div>'.repeat(6_000) })
    const refused = imap.put('INBOX', { subject: '拒まれる', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: '拒まれた本文' })
    const older = imap.put('INBOX', { subject: '週報', from: tanaka, to: me, date: new Date(NOW - 3 * HOUR), text: '普通の本文' })
    // Its own uid, so that its download is not counted with those of the inbox.
    const sent = imap.put('Sent', { uid: 50, subject: '送った', from: me, to: tanaka, date: new Date(NOW - 4 * HOUR), text: '送った本文' })
    imap.failDownload.add(refused.uid)
    sync.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cache.body(messageIdOf('a1', 'inbox', '1', older.uid))).toBe('普通の本文')
    expect(cache.body(messageIdOf('a1', 'sent', '1', sent.uid))).toBe('送った本文')
    // Neither broken message is stored as having an empty body, and neither is retried pass after pass.
    for (const uid of [deep.uid, refused.uid]) {
      expect(cache.get(messageIdOf('a1', 'inbox', '1', uid))?.bodyFetched).toBe(false)
      expect(imap.calls.filter((call) => call.startsWith(`download:${uid}:`))).toHaveLength(1)
    }
    await expect(sync.fetchBody(messageIdOf('a1', 'inbox', '1', deep.uid))).rejects.toThrow(RangeError)
    imap.failDownload.delete(refused.uid)
    await expect(sync.fetchBody(messageIdOf('a1', 'inbox', '1', refused.uid))).resolves.toBe('拒まれた本文')
    warn.mockRestore()
    await sync.stop()
  })

  it('reads an HTML-only body whose MIME header names no charset as a browser does: by its BOM, then by a meta tag the Encoding Standard knows', async () => {
    const { imap, cache, sync } = setup()
    // 「見積もりの件です」 in each encoding.
    const encoded = {
      shiftJis: Buffer.from('8ca990cf82e082e882cc8c8f82c582b7', 'hex'),
      eucJp: Buffer.from('b8abc0d1a4e2a4eaa4ceb7efa4c7a4b9', 'hex'),
      utf8: Buffer.from('見積もりの件です'),
      utf16le: Buffer.from('見積もりの件です', 'utf16le')
    }
    const html = (meta: string, text: Buffer) => Buffer.concat([Buffer.from(`<html><head>${meta}</head><body><p>`), text, Buffer.from('</p></body></html>')])
    const cases: Array<[string, Buffer]> = [
      ['http-equiv', html('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">', encoded.shiftJis)],
      ['charset', html("<meta charset='euc-jp'>", encoded.eucJp)],
      ['none', html('', encoded.utf8)],
      // cp932 is no label of the Encoding Standard, so the next meta tag decides.
      ['unknown label', html('<meta charset="cp932"><meta charset="shift_jis">', encoded.shiftJis)],
      ['only an unknown label', html('<meta charset="cp932">', encoded.utf8)],
      // A browser reads a document that declares UTF-16 in a meta tag as UTF-8.
      ['utf-16 declared', html('<meta charset="utf-16">', encoded.utf8)],
      ['bom over meta', Buffer.concat([Buffer.from('efbbbf', 'hex'), html('<meta charset="shift_jis">', encoded.utf8)])],
      ['utf-16 bom', Buffer.concat([Buffer.from('fffe', 'hex'), Buffer.from('<p>', 'utf16le'), encoded.utf16le, Buffer.from('</p>', 'utf16le')])]
    ]
    cases.forEach(([subject, body], index) => imap.put('INBOX', { subject, from: tanaka, to: me, date: new Date(NOW - (index + 1) * HOUR), html: body }))
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const bodies = cache.list({ view: 'inbox' }).messages.map((message) => [message.subject, cache.body(message.id)])
    expect(bodies).toEqual(cases.map(([subject]) => [subject, '見積もりの件です']))
    await sync.stop()
  })

  it('keeps a reply whose mailer wrote In-Reply-To without References in the thread of the message it answers, whichever arrives first', async () => {
    const { imap, cache, sync } = setup()
    imap.put('INBOX', { subject: '打合せ', from: tanaka, to: me, date: new Date(NOW - 5 * HOUR), text: 'a', messageId: '<a@x>' })
    imap.put('INBOX', { subject: 'Re: 打合せ', from: tanaka, to: me, date: new Date(NOW - 4 * HOUR), text: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', references: '<a@x>' })
    // Sent is fetched before the inbox, so this reply is cached before the message it answers.
    imap.put('Sent', { subject: 'Re: 打合せ', from: me, to: tanaka, date: new Date(NOW - 3 * HOUR), text: 'c', messageId: '<c@me>', inReplyTo: '<b@x>' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    // This one is fetched after the message it answers.
    imap.put('INBOX', { subject: 'Re: Re: 打合せ', from: tanaka, to: me, date: new Date(NOW - 2 * HOUR), text: 'd', messageId: '<d@x>', inReplyTo: '<c@me>' })
    await sync.syncNow()
    const first = cache.list({ view: 'inbox' }).messages.find((message) => message.messageId === '<a@x>')!
    expect(cache.thread('a1', first.threadId).map((message) => message.messageId)).toEqual(['<a@x>', '<b@x>', '<c@me>', '<d@x>'])
    await sync.stop()
  })

  it('applies a flag notice to the generation of the folder as it is open, after the connection went back to an inbox the server renewed', async () => {
    const { imap, cache, sync } = setup()
    const old = imap.put('INBOX', { subject: '前の世代', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    imap.put('Sent', { subject: '送った', from: me, to: tanaka, date: new Date(NOW - HOUR), text: 's' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    const oldId = cache.list({ view: 'inbox' }).messages[0].id
    // The server recreates the inbox, and another message takes over the UID.
    const inbox = imap.folders.get('INBOX')!
    inbox.uidValidity = 2n
    inbox.messages.clear()
    imap.put('INBOX', { uid: old.uid, subject: '新しい世代', from: tanaka, to: me, date: new Date(NOW), text: 'b' })
    // An operation on a sent message selects Sent, and the connection then goes back to the inbox.
    await sync.byUid('sent', cache.uidValidity('a1', 'sent')!, async () => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(imap.mailbox && imap.mailbox.path).toBe('INBOX')
    imap.emit('flags', { path: 'INBOX', seq: 1, uid: old.uid, flags: new Set(['\\Seen', '\\Flagged']) })
    expect(cache.get(oldId)).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(cache.list({ view: 'inbox' }).messages.map((message) => message.subject)).toEqual(['新しい世代'])
    await sync.stop()
  })

  it('shows as the account error a folder whose server gives no UIDVALIDITY, and files none of its messages under an id no operation accepts', async () => {
    const { imap, cache, sync } = setup()
    ;(imap.folders.get('INBOX') as unknown as { uidValidity: unknown }).uidValidity = undefined
    imap.put('INBOX', { subject: 'A', from: tanaka, to: me, date: new Date(NOW - HOUR), text: 'a' })
    sync.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(cache.list({ view: 'inbox' }).total).toBe(0)
    expect(sync.state).toBe('error')
    expect(sync.error).toBe(t('mail.errors.sync.folderFailed', { box: t('mail.boxes.inbox'), reason: t('mail.errors.folder.noUidValidity', { path: 'INBOX' }) }))
    await sync.stop()
  })

  it('reports why it cannot connect, instead of staying in "connecting", when the password cannot be read', async () => {
    const { sync, states } = setup({
      password: () => {
        throw new Error(errorText('mail.errors.account.passwordMissing'))
      }
    })
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual(['error', t('mail.errors.account.passwordMissing')])
    expect(sync.state).toBe('error')
    await sync.stop()
  })
})
