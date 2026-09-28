import { describe, expect, it } from 'vitest'
import { messageIdOf, type MailListQuery, type MailMessage } from '@shared/mail'
import { MailCache, type MailBodyParts } from '../src/main/services/mail-cache'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 16, 6)
let seq = 0
const message = (folder: MailMessage['folder'], patch: Partial<MailMessage> = {}, accountId = 'a1'): MailMessage & { parts: MailBodyParts } => {
  const uid = patch.uid ?? ++seq
  return {
    id: messageIdOf(accountId, folder, uid),
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
    cache.setBody(messageIdOf('a1', 'inbox', 2), '本文にだけ ある言葉')
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
    expect(cache.get(messageIdOf('a1', 'inbox', 1))).toMatchObject({ unread: false, starred: true, answered: true })
    cache.setFlags(messageIdOf('a1', 'inbox', 2), { unread: true })
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
      { uid: 1, textPart: null, htmlPart: '2' },
      { uid: 2, textPart: '1', htmlPart: null }
    ])
    expect(cache.body(messageIdOf('a1', 'inbox', 1))).toBeNull()
    cache.setBody(messageIdOf('a1', 'inbox', 1), '本文の一行目\n\n> 引用\n二行目')
    expect(cache.body(messageIdOf('a1', 'inbox', 1))).toBe('本文の一行目\n\n> 引用\n二行目')
    expect(cache.get(messageIdOf('a1', 'inbox', 1))).toMatchObject({ snippet: '本文の一行目 二行目', bodyFetched: true })
    expect(cache.pendingBodies('a1', 'inbox', 10, []).map((item) => item.uid)).toEqual([2])
    expect(cache.pendingBodies('a1', 'inbox', 10, [2])).toEqual([])
    expect(cache.thread('a1', 't').map((m) => m.uid)).toEqual([3, 2, 1])
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
