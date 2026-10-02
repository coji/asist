import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { messageIdOf, type MailListQuery, type MailMessage } from '@shared/mail'
import { MailCache, type MailBodyParts } from '../src/main/services/mail-cache'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 16, 6)
let seq = 0
const message = (folder: MailMessage['folder'], patch: Partial<MailMessage> = {}, accountId = 'a1'): MailMessage & { parts: MailBodyParts } => {
  const uid = patch.uid ?? ++seq
  return {
    id: messageIdOf(accountId, folder, '1', uid),
    accountId,
    folder,
    uid,
    messageId: `<${uid}@x>`,
    threadId: `m:<${uid}@x>`,
    subject: `件名${uid}`,
    from: { name: '田中', address: 't@example.com' },
    to: [{ name: '', address: 'me@example.com' }],
    cc: [],
    replyTo: [],
    date: NOW - uid * HOUR,
    snippet: '',
    unread: false,
    starred: false,
    answered: false,
    attachments: [],
    size: 100,
    labels: [],
    bodyFetched: false,
    parts: { textPart: '1', htmlPart: null },
    ...patch
  }
}

/** A cache of 2000 messages whose pages from `from` to `to` (byte offsets, given the page count) are overwritten. */
function damagedCache(dir: string, name: string, from: (pages: number) => number, to: (pages: number) => number): string {
  const file = path.join(dir, name)
  const filled = new MailCache(file)
  filled.upsert(Array.from({ length: 2000 }, (_, index) => message('inbox', { uid: index + 1, subject: 'x'.repeat(400) })))
  filled.close()
  const bytes = fs.readFileSync(file)
  const pages = bytes.length / 4096
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, from(pages)), Buffer.alloc(to(pages) - from(pages), 7), bytes.subarray(to(pages))]))
  return file
}

describe('MailCache', () => {
  it('returns each view newest first and keeps the All Mail copies of inbox and sent messages out of archive and starred', () => {
    const cache = new MailCache(':memory:')
    cache.upsert([
      message('inbox', { uid: 1, unread: true, starred: true }),
      message('inbox', { uid: 2 }),
      message('sent', { uid: 3 }),
      message('archive', { uid: 4, labels: ['\\Inbox'], starred: true }),
      message('archive', { uid: 5, labels: ['\\Important'] }),
      message('inbox', { uid: 6 }, 'a2')
    ])
    const ids = (view: 'inbox' | 'starred' | 'sent' | 'archive', extra = {}) => cache.list({ view, ...extra }).messages.map((m) => m.uid)
    expect(ids('inbox')).toEqual([1, 2, 6])
    expect(ids('inbox', { accountId: 'a1' })).toEqual([1, 2])
    expect(ids('inbox', { unreadOnly: true })).toEqual([1])
    expect(ids('sent')).toEqual([3])
    expect(ids('archive')).toEqual([5])
    expect(ids('starred')).toEqual([1])
    const page = cache.list({ view: 'inbox', limit: 2 })
    expect(page).toMatchObject({ total: 3 })
    const { date, uid, id } = page.messages[0]
    expect(cache.list({ view: 'inbox', limit: 2, before: { date, uid, id } }).messages.map((m) => m.uid)).toEqual([2, 6])
  })

  it('reaches every message exactly once page by page, when messages share a date and, across accounts and folders, a uid', () => {
    const cache = new MailCache(':memory:')
    // A Date header counts whole seconds, so a batch sent at once carries one date.
    const sent = NOW - HOUR
    cache.upsert([
      message('inbox', { uid: 1, date: NOW }),
      message('inbox', { uid: 2, date: sent }),
      message('inbox', { uid: 3, date: sent, starred: true }),
      message('inbox', { uid: 3, date: sent, starred: true }, 'a2'),
      message('inbox', { uid: 2, date: sent }, 'a2'),
      message('sent', { uid: 3, date: sent, starred: true }),
      message('inbox', { uid: 4, date: NOW - 2 * HOUR })
    ])
    for (const view of ['inbox', 'starred'] as const) {
      const whole = cache.list({ view, limit: 50 }).messages.map((m) => m.id)
      const paged: string[] = []
      let before: MailListQuery['before'] = null
      for (;;) {
        const page = cache.list({ view, limit: 2, before })
        if (page.messages.length === 0) break
        paged.push(...page.messages.map((m) => m.id))
        const { date, uid, id } = page.messages.at(-1)!
        before = { date, uid, id }
      }
      expect(paged).toEqual(whole)
    }
    expect(cache.list({ view: 'inbox', limit: 50 }).total).toBe(6)
  })

  it('searches subject, sender, snippet and body by substring, treating % and _ as ordinary characters', () => {
    const cache = new MailCache(':memory:')
    cache.upsert([message('inbox', { uid: 1, subject: '100%の確率' }), message('inbox', { uid: 2, subject: 'ほか' }), message('inbox', { uid: 3, from: { name: '鈴木', address: 's@example.com' } })])
    cache.setBody(messageIdOf('a1', 'inbox', '1', 2), '本文にだけ ある言葉')
    expect(cache.list({ view: 'inbox', query: '100%' }).messages.map((m) => m.uid)).toEqual([1])
    expect(cache.list({ view: 'inbox', query: '%' }).messages.map((m) => m.uid)).toEqual([1])
    expect(cache.list({ view: 'inbox', query: 'ある言葉' }).messages.map((m) => m.uid)).toEqual([2])
    expect(cache.list({ view: 'inbox', query: '鈴木' }).messages.map((m) => m.uid)).toEqual([3])
    expect(cache.list({ view: 'inbox', query: 's@example' }).messages.map((m) => m.uid)).toEqual([3])
  })

  it('updates and removes flags, and drops a folder when its UIDVALIDITY changes', () => {
    const cache = new MailCache(':memory:')
    cache.setUidValidity('a1', 'inbox', '10')
    cache.upsert([message('inbox', { uid: 1, unread: true }), message('inbox', { uid: 2 })])
    cache.updateFlags('a1', 'inbox', [{ uid: 1, unread: false, starred: true, answered: true, labels: [] }])
    expect(cache.get(messageIdOf('a1', 'inbox', '1', 1))).toMatchObject({ unread: false, starred: true, answered: true })
    cache.setFlags(messageIdOf('a1', 'inbox', '1', 2), { unread: true })
    expect(cache.flagsIn('a1', 'inbox').get(2)).toEqual({ unread: true, starred: false, answered: false, labels: [] })
    cache.removeUids('a1', 'inbox', [2])
    expect(cache.flagsIn('a1', 'inbox').size).toBe(1)
    cache.setUidValidity('a1', 'inbox', '10')
    expect(cache.flagsIn('a1', 'inbox').size).toBe(1)
    cache.setUidValidity('a1', 'inbox', '11')
    expect(cache.flagsIn('a1', 'inbox').size).toBe(0)
    expect(cache.uidValidity('a1', 'inbox')).toBe('11')
  })

  it('derives the snippet when a body arrives, lists messages still missing a body newest first, and orders a thread oldest first', () => {
    const cache = new MailCache(':memory:')
    cache.upsert([
      message('inbox', { uid: 1, threadId: 't', parts: { textPart: null, htmlPart: '2' } }),
      message('inbox', { uid: 2, threadId: 't' }),
      message('sent', { uid: 3, threadId: 't' }),
      message('archive', { uid: 4, threadId: 't', labels: ['\\Inbox'] })
    ])
    expect(cache.pendingBodies('a1', 'inbox', 10, [])).toEqual([
      { id: messageIdOf('a1', 'inbox', '1', 1), uid: 1, textPart: null, htmlPart: '2' },
      { id: messageIdOf('a1', 'inbox', '1', 2), uid: 2, textPart: '1', htmlPart: null }
    ])
    expect(cache.body(messageIdOf('a1', 'inbox', '1', 1))).toBeNull()
    cache.setBody(messageIdOf('a1', 'inbox', '1', 1), '本文の一行目\n\n> 引用\n二行目')
    expect(cache.body(messageIdOf('a1', 'inbox', '1', 1))).toBe('本文の一行目\n\n> 引用\n二行目')
    expect(cache.get(messageIdOf('a1', 'inbox', '1', 1))).toMatchObject({ snippet: '本文の一行目 二行目', bodyFetched: true })
    expect(cache.pendingBodies('a1', 'inbox', 10, []).map((item) => item.uid)).toEqual([2])
    expect(cache.pendingBodies('a1', 'inbox', 10, [2])).toEqual([])
    expect(cache.thread('a1', 't').map((m) => m.uid)).toEqual([3, 2, 1])
  })

  it('starts over from an empty cache when its file is not a database or its schema is damaged, and keeps a file it cannot open for another reason', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-mail-cache-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const notDatabase = path.join(dir, 'not-a-database.sqlite')
      fs.writeFileSync(notDatabase, 'text written over the cache, long enough to fill the header of a database file')
      const schemaPage = damagedCache(dir, 'schema-page.sqlite', () => 100, () => 4096)
      for (const file of [notDatabase, schemaPage]) {
        const cache = new MailCache(file)
        expect(cache.list({ view: 'inbox' }).total).toBe(0)
        cache.upsert([message('inbox', { uid: 1 })])
        cache.close()
        const reopened = new MailCache(file)
        expect(reopened.list({ view: 'inbox' }).messages.map((m) => m.uid)).toEqual([1])
        reopened.close()
      }
      // A folder in place of the file says nothing about the cache being broken.
      const folder = path.join(dir, 'folder.sqlite')
      fs.mkdirSync(folder)
      expect(() => new MailCache(folder)).toThrow()
      expect(fs.statSync(folder).isDirectory()).toBe(true)
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds damage in the pages past the schema with its check, and starts over from an empty cache when told to', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-mail-cache-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const intact = new MailCache(path.join(dir, 'intact.sqlite'))
      intact.upsert([message('inbox', { uid: 1 })])
      expect(await intact.check()).toBeNull()
      intact.close()
      const file = damagedCache(dir, 'data-pages.sqlite', (pages) => Math.floor(pages * 0.2) * 4096, (pages) => Math.floor(pages * 0.3) * 4096)
      const cache = new MailCache(file)
      const damage = await cache.check()
      expect(damage).not.toBeNull()
      expect(() => cache.list({ view: 'inbox' })).toThrow()
      cache.replace(damage!)
      expect(cache.list({ view: 'inbox' }).total).toBe(0)
      cache.upsert([message('inbox', { uid: 1 })])
      cache.close()
      const reopened = new MailCache(file)
      expect(reopened.list({ view: 'inbox' }).messages.map((m) => m.uid)).toEqual([1])
      expect(await reopened.check()).toBeNull()
      reopened.close()
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts unread inbox messages and the unread ones from the last 24 hours, and clearing an account removes all of them', () => {
    const cache = new MailCache(':memory:')
    cache.upsert([
      message('inbox', { uid: 1, unread: true, date: NOW - HOUR }),
      message('inbox', { uid: 2, unread: true, date: NOW - 30 * HOUR }),
      message('inbox', { uid: 3, unread: false, date: NOW - HOUR }),
      message('sent', { uid: 4, unread: true, date: NOW - HOUR }),
      message('inbox', { uid: 5, unread: true, date: NOW - HOUR }, 'a2')
    ])
    expect(cache.counts('a1', NOW)).toEqual({ unread: 2, unreadRecent: 1 })
    expect(cache.counts('a2', NOW)).toEqual({ unread: 1, unreadRecent: 1 })
    cache.clearAccount('a1')
    expect(cache.counts('a1', NOW)).toEqual({ unread: 0, unreadRecent: 0 })
    expect(cache.counts('a2', NOW)).toEqual({ unread: 1, unreadRecent: 1 })
  })
})
