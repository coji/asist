import type { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { messageIdOf, type MailSettings } from '@shared/mail'
import { MailCache } from '../src/main/services/mail-cache'
import { FakeImap } from './helpers/fake-imap'

/** The mail integration as Electron starts it, with the IMAP connection replaced by a fake. */

const mocks = vi.hoisted(() => ({ userData: '', server: null as unknown as ReturnType<FakeImap['reconnectable']>, openCaches: new Set<{ close(): void }>() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { getPath: () => mocks.userData, once: () => undefined },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: { isSupported: () => false },
    powerMonitor: new EventEmitter(),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (plain: string) => Buffer.from(plain), decryptString: (data: Buffer) => data.toString() },
    shell: { openExternal: async () => undefined }
  }
})
const settings: MailSettings = {
  enabled: true,
  accounts: [
    {
      id: 'a1',
      label: '仕事',
      email: 'me@example.com',
      otherAddresses: [],
      name: '私',
      provider: 'custom',
      imap: { host: 'imap.example.com', port: 993, secure: true },
      smtp: { host: 'smtp.example.com', port: 465, secure: true },
      folders: { sent: null, archive: null, trash: null }
    }
  ],
  defaultAccountId: 'a1',
  syncDays: 30,
  notifyNewMail: false
}
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'ja-JP', mail: settings }), saveSettings: () => undefined }))
vi.mock('../src/main/services/mail-secrets', () => ({ createMailSecretStore: () => ({ get: () => 'app-password', set: () => undefined, remove: () => undefined }) }))
// The app keeps its cache file open until its process ends, and Windows refuses to delete a file that is still
// open, so each test closes what its launch left open, as the end of the process does.
vi.mock('../src/main/services/mail-cache', async (importOriginal) => {
  const { MailCache } = await importOriginal<typeof import('../src/main/services/mail-cache')>()
  return {
    MailCache: class extends MailCache {
      constructor(file: string) {
        super(file)
        mocks.openCaches.add(this)
      }

      close(): void {
        super.close()
        mocks.openCaches.delete(this)
      }
    }
  }
})
vi.mock('../src/main/services/mail-imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/mail-imap')>()),
  createImapClient: () => mocks.server.next().asClient()
}))

const tanaka = [{ name: '田中', address: 't@example.com' }]
const me = [{ name: '', address: 'me@example.com' }]
let stopMail: () => Promise<void> = async () => undefined

/** Starts the mail integration of a fresh module, as a launch of the app does, and waits for the first sync. */
async function launch(imap: FakeImap) {
  mocks.server = imap.reconnectable()
  vi.resetModules()
  const { powerMonitor } = await import('electron')
  const mail = await import('../src/main/services/mail')
  mail.initMail()
  const service = mail.getMailService()
  stopMail = async () => {
    for (const instance of mocks.server.instances) instance.close()
    await service.stop()
  }
  // The syncs start once the cache file has been checked in a worker thread.
  await vi.waitFor(() => expect(service.status().accounts[0].state).toBe('connected'))
  const inbox = () => service.list({ view: 'inbox' }).messages.map((message) => message.subject)
  return { service, inbox, wake: () => (powerMonitor as unknown as EventEmitter).emit('resume') }
}

beforeEach(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-mail-wake-'))
  vi.useFakeTimers({ now: new Date('2026-09-16T06:00:00Z') })
})
afterEach(async () => {
  await stopMail()
  for (const cache of mocks.openCaches) cache.close()
  vi.useRealTimers()
  rmSync(mocks.userData, { recursive: true, force: true })
})

it('syncs over a new connection when the machine wakes and the one it held across sleep no longer answers', async () => {
  const imap = new FakeImap()
  const { service, inbox, wake } = await launch(imap)
  // The server and the network forgot the connection during sleep, and nothing on this side noticed.
  imap.silent = true
  imap.put('INBOX', { subject: '寝ている間に届いた', from: tanaka, to: me, date: new Date(), text: 'x' })
  wake()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(inbox()).toEqual(['寝ている間に届いた'])
  expect(service.status().accounts[0].state).toBe('connected')
}, 20_000)

it('starts the syncs over an empty cache when the check at launch finds the cache file damaged past its schema', async () => {
  const file = path.join(mocks.userData, 'mail-cache.sqlite')
  const filled = new MailCache(file)
  filled.upsert(
    Array.from({ length: 2000 }, (_, index) => ({
      id: messageIdOf('a1', 'inbox', '1', index + 1),
      accountId: 'a1',
      folder: 'inbox' as const,
      uid: index + 1,
      messageId: `<${index + 1}@x>`,
      threadId: `m:<${index + 1}@x>`,
      subject: 'x'.repeat(400),
      from: tanaka[0],
      to: me,
      cc: [],
      replyTo: [],
      date: Date.now() - index,
      snippet: '',
      unread: false,
      starred: false,
      answered: false,
      attachments: [],
      size: 1,
      labels: [],
      bodyFetched: false,
      parts: { textPart: '1', htmlPart: null }
    }))
  )
  filled.close()
  const bytes = readFileSync(file)
  const pages = bytes.length / 4096
  writeFileSync(file, Buffer.concat([bytes.subarray(0, Math.floor(pages * 0.2) * 4096), Buffer.alloc(Math.floor(pages * 0.1) * 4096, 7), bytes.subarray((Math.floor(pages * 0.2) + Math.floor(pages * 0.1)) * 4096)]))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const imap = new FakeImap()
  imap.put('INBOX', { subject: '届いている', from: tanaka, to: me, date: new Date(), text: 'x' })
  const { inbox } = await launch(imap)
  expect(inbox()).toEqual(['届いている'])
  warn.mockRestore()
}, 20_000)

it('keeps the connection when it still answers after the machine wakes, so nothing under way on it is cut', async () => {
  const imap = new FakeImap()
  const { inbox, wake } = await launch(imap)
  imap.put('INBOX', { subject: '寝ている間に届いた', from: tanaka, to: me, date: new Date(), text: 'x' })
  wake()
  await vi.advanceTimersByTimeAsync(100)
  expect(inbox()).toEqual(['寝ている間に届いた'])
  expect(mocks.server.instances).toHaveLength(1)
  expect(imap.usable).toBe(true)
}, 20_000)

it('keeps a connection whose command under way still receives data after the machine wakes, though the NOOP waits behind that command', async () => {
  const imap = new FakeImap()
  const { inbox, wake } = await launch(imap)
  // imapflow sends one command at a time, so the NOOP waits behind a long FETCH whose data keeps arriving.
  imap.noop = async () => {
    imap.calls.push('noop')
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
  const fetching = setInterval(() => (imap.received += 4096), 1_000)
  imap.put('INBOX', { subject: '寝ている間に届いた', from: tanaka, to: me, date: new Date(), text: 'x' })
  wake()
  await vi.advanceTimersByTimeAsync(15_000)
  clearInterval(fetching)
  expect(mocks.server.instances).toHaveLength(1)
  expect(imap.usable).toBe(true)
  expect(inbox()).toEqual(['寝ている間に届いた'])
}, 20_000)

it('gives up a connection still being made when the machine wakes, instead of waiting behind its handshake', async () => {
  const imap = new FakeImap()
  const { inbox, wake } = await launch(imap)
  // The connection drops, and the machine sleeps while the next one is being made.
  imap.hangConnect = true
  imap.drop('socket hang up')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(mocks.server.instances).toHaveLength(2)
  imap.hangConnect = false
  imap.put('INBOX', { subject: '起きたあとに届いた', from: tanaka, to: me, date: new Date(), text: 'x' })
  wake()
  await vi.advanceTimersByTimeAsync(100)
  expect(inbox()).toEqual(['起きたあとに届いた'])
}, 20_000)
