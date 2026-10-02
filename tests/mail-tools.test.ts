import { createTranslator } from '@shared/i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnEvent } from '@shared/ipc'
import type { ToolContext } from '../src/main/services/brain/tools'
import { FETCHER_TIMEOUT_MS, LOCAL_TIMEOUT_MS } from '@shared/tool-registry'
import type { MailMessage, MailStatus } from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'

const message: MailMessage = {
  id: 'a1:inbox:5',
  accountId: 'a1',
  folder: 'inbox',
  uid: 5,
  messageId: '<5@x>',
  threadId: 'm:<5@x>',
  subject: '打合せ',
  from: { name: '田中', address: 't@example.com' },
  to: [{ name: '', address: 'me@example.com' }],
  cc: [],
  replyTo: [],
  date: Date.UTC(2026, 8, 16, 1),
  snippet: '来週の候補日です',
  unread: true,
  starred: false,
  answered: false,
  attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 10 }],
  size: 100,
  labels: [],
  bodyFetched: true
}
const status: MailStatus = {
  enabled: true,
  accounts: [{ id: 'a1', label: '仕事', email: 'me@example.com', otherAddresses: [], provider: 'gmail', state: 'connected', error: '', lastSyncAt: 1, unread: 1, unreadRecent: 1 }],
  unread: 1,
  unreadRecent: 1
}

const mocks = vi.hoisted(() => ({
  fetchPanel: vi.fn(),
  service: {
    status: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    change: vi.fn(),
    draftUpdate: vi.fn()
  }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/mail', () => ({ getMailService: () => mocks.service }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ agentMode: 'readonly', conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/memory', () => ({}))
vi.mock('../src/main/services/agent', () => ({}))
vi.mock('../src/main/services/panel-fetchers', () => ({ fetchPanel: mocks.fetchPanel }))
vi.mock('../src/main/services/timers', () => ({}))
vi.mock('../src/main/services/user-local-data', () => ({}))
vi.mock('../src/main/services/user-tasks', () => ({}))
vi.mock('../src/main/services/project-index', () => ({}))

/** The tools module, called in the conversation language the settings hold. */
async function load() {
  const module = await import('../src/main/services/brain/tools')
  return {
    toolRegistry: () => module.toolRegistry('ja-JP'),
    executeClientTool: (name: string, input: Record<string, unknown>, ctx: ToolContext) => module.executeClientTool(name, input, ctx, 'ja-JP')
  }
}
const ctx = (): { turnId: number; signal: AbortSignal; emit: (event: TurnEvent) => void } => ({ turnId: 1, signal: new AbortController().signal, emit: () => {} })

describe('mail tools', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.service.status.mockReturnValue(status)
    mocks.service.list.mockReturnValue({ messages: [message], total: 1, unread: 1 })
    mocks.service.read.mockResolvedValue({ message, text: '本文です' })
    mocks.service.change.mockResolvedValue({ saved: true, operation: 'markRead', id: message.id, summary: '既読にしました' })
  })

  it('registers listing and reading as parallel, and the change tool as serial with a timeout long enough for the confirmation', async () => {
    const { toolRegistry } = await load()
    const registry = toolRegistry()
    expect(registry.find('list_mail')).toMatchObject({ parallel: true, timeoutMs: LOCAL_TIMEOUT_MS })
    expect(registry.find('read_mail')).toMatchObject({ parallel: true, timeoutMs: FETCHER_TIMEOUT_MS })
    expect(registry.find('change_mail')).toMatchObject({ parallel: false, timeoutMs: 300_000 })
  })

  it('puts up the list card and the message card only when asked, with the list and the body still returned', async () => {
    mocks.service.status.mockReturnValue(status)
    mocks.service.list.mockReturnValue({ messages: [message], total: 1 })
    mocks.service.read.mockResolvedValue({ message, text: '候補日は火曜です' })
    mocks.fetchPanel.mockResolvedValue({ props: { loaded: true }, source: 'LOCAL' })
    const { executeClientTool } = await load()
    const events: TurnEvent[] = []
    const withEvents = { ...ctx(), emit: (event: TurnEvent) => events.push(event) }
    await executeClientTool('list_mail', {}, withEvents)
    expect(events).toEqual([])
    const list = await executeClientTool('list_mail', { unreadOnly: true, card: true }, withEvents)
    expect(JSON.parse(list.content)).toMatchObject({ count: 1 })
    const read = await executeClientTool('read_mail', { id: message.id, card: true }, withEvents)
    expect(JSON.parse(read.content)).toMatchObject({ text: '候補日は火曜です' })
    const created = events.flatMap((event) => (event.type === 'panel' && event.event.op === 'create' ? [event.event] : []))
    expect(created.map((event) => [event.type, event.props])).toEqual([
      ['mail', { unreadOnly: true, view: 'inbox', query: '' }],
      ['mail-message', { id: message.id }]
    ])
  })

  it('fails the call and marks the card as failed when the card cannot load', async () => {
    mocks.service.status.mockReturnValue(status)
    mocks.service.list.mockReturnValue({ messages: [message], total: 1 })
    mocks.fetchPanel.mockRejectedValue(new Error('cache closed'))
    const { executeClientTool } = await load()
    const events: TurnEvent[] = []
    const result = await executeClientTool('list_mail', { card: true }, { ...ctx(), emit: (event: TurnEvent) => events.push(event) })
    expect(result.isError).toBe(true)
    expect(events.some((event) => event.type === 'panel' && event.event.op === 'patch' && event.event.state === 'error')).toBe(true)
  })

  it('returns a summary carrying the account label from list_mail, and the body from read_mail', async () => {
    const { executeClientTool } = await load()
    const list = await executeClientTool('list_mail', { unreadOnly: true }, ctx())
    expect(list.isError).toBe(false)
    expect(mocks.service.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'inbox', unreadOnly: true, limit: 20 }))
    expect(JSON.parse(list.content)).toMatchObject({
      count: 1,
      total: 1,
      accounts: [{ id: 'a1', label: '仕事', email: 'me@example.com', unread: 1 }],
      messages: [{ id: 'a1:inbox:5', account: '仕事', from: '田中 <t@example.com>', subject: '打合せ', unread: true, attachments: ['a.pdf'], snippet: '来週の候補日です' }]
    })
    const read = await executeClientTool('read_mail', { id: 'a1:inbox:5' }, ctx())
    expect(JSON.parse(read.content)).toMatchObject({ id: 'a1:inbox:5', account: '仕事', from: '田中 <t@example.com>', text: '本文です', attachments: ['a.pdf'] })
  })

  it('tells the model the other addresses the user sends from with an account, which are the user’s as much as its own', async () => {
    mocks.service.status.mockReturnValue({ ...status, accounts: [{ ...status.accounts[0], otherAddresses: ['me@company.example'] }] })
    const { executeClientTool } = await load()
    const list = await executeClientTool('list_mail', {}, ctx())
    expect(JSON.parse(list.content).accounts).toMatchObject([{ id: 'a1', email: 'me@example.com', otherAddresses: ['me@company.example'] }])
  })

  it('validates the input before handing a change to main as an agent operation, and returns the reason when it fails', async () => {
    const { executeClientTool } = await load()
    const ok = await executeClientTool('change_mail', { operation: 'markRead', ids: ['a1:inbox:5'], read: true }, ctx())
    expect(ok.isError).toBe(false)
    expect(mocks.service.change).toHaveBeenCalledWith({ operation: 'markRead', ids: ['a1:inbox:5'], read: true }, expect.any(AbortSignal), 'agent')
    const invalid = await executeClientTool('change_mail', { operation: 'send', to: [], subject: 'x', body: 'y' }, ctx())
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toContain(createTranslator('ja-JP')('mail.errors.form.recipientRequired'))
    expect(invalid.content).not.toContain('[asist:')
    expect(mocks.service.change).toHaveBeenCalledOnce()
    mocks.service.change.mockRejectedValueOnce(new Error(errorText('mail.errors.folder.archiveMissing')))
    const failed = await executeClientTool('change_mail', { operation: 'archive', id: 'a1:inbox:5' }, ctx())
    expect(failed.isError).toBe(true)
    // The model reads the reason as a Japanese sentence, without the key the renderer uses.
    expect(failed.content).toContain(createTranslator('ja-JP')('mail.errors.folder.archiveMissing'))
    expect(failed.content).not.toContain('[asist:')
  })

  it('turns a send into a draft and opens the draft card, and the update tool brings that same card forward', async () => {
    mocks.service.change.mockResolvedValueOnce({ drafted: true, saved: false, draftId: 'd1', summary: '下書きにしました' })
    const { executeClientTool } = await load()
    const events: TurnEvent[] = []
    const context = { ...ctx(), emit: (event: TurnEvent) => events.push(event) }
    const result = await executeClientTool('change_mail', { operation: 'send', to: ['t@example.com'], subject: 'x', body: 'y' }, context)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ drafted: true, draftId: 'd1' })
    expect(events).toEqual([{ type: 'panel', turnId: 1, event: { op: 'create', key: 'mail-draft:d1', type: 'mail-draft', slot: 'right', props: { draftId: 'd1' }, state: 'ready' } }])
    mocks.service.draftUpdate.mockReturnValueOnce({ id: 'd1', to: ['t@example.com'], subject: 'x', body: 'z', reply: null })
    const updated = await executeClientTool('update_mail_draft', { draftId: 'd1', body: 'z' }, context)
    expect(updated.isError).toBe(false)
    expect(mocks.service.draftUpdate).toHaveBeenCalledWith('d1', { body: 'z' })
    expect(JSON.parse(updated.content)).toMatchObject({ draftId: 'd1', body: 'z' })
    expect(events).toHaveLength(2)
    const invalid = await executeClientTool('update_mail_draft', { draftId: 'd1' }, context)
    expect(invalid.isError).toBe(true)
  })

  it('gives the model the date of a message in local time with its offset, so that mail from early morning in Japan keeps its day', async () => {
    const early = { ...message, date: Date.parse('2026-09-16T07:30:00+09:00') }
    mocks.service.list.mockReturnValue({ messages: [early], total: 1, unread: 1 })
    mocks.service.read.mockResolvedValue({ message: early, text: '本文です' })
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      const { executeClientTool } = await load()
      const list = await executeClientTool('list_mail', {}, ctx())
      expect(JSON.parse(list.content).messages[0].date).toBe('2026-09-16T07:30:00+09:00')
      const read = await executeClientTool('read_mail', { id: early.id }, ctx())
      expect(JSON.parse(read.content).date).toBe('2026-09-16T07:30:00+09:00')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('tells the model where a reply draft goes after an edit, and with which subject: the addresses it was settled with, and one "Re:"', async () => {
    const reply = {
      id: 'a1:inbox:5',
      subject: 'Re: 打合せ',
      from: { name: '田中', address: 't@example.com' },
      replyAll: false,
      to: [{ name: '事務局', address: 'office@example.com' }],
      cc: [],
      inReplyTo: '<5@x>',
      references: ['<5@x>'],
      quote: ''
    }
    mocks.service.draftUpdate.mockReturnValueOnce({ id: 'd2', to: [], cc: [], subject: '', body: 'では。', reply })
    const { executeClientTool } = await load()
    const updated = await executeClientTool('update_mail_draft', { draftId: 'd2', body: 'では。' }, ctx())
    expect(JSON.parse(updated.content)).toMatchObject({ draftId: 'd2', subject: 'Re: 打合せ', to: ['事務局 <office@example.com>'], body: 'では。' })
  })

  it('points at the settings screen when mail is not configured', async () => {
    mocks.service.status.mockReturnValue({ enabled: false, accounts: [], unread: 0, unreadRecent: 0 })
    const { executeClientTool } = await load()
    const result = await executeClientTool('list_mail', {}, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('設定画面')
    expect(mocks.service.list).not.toHaveBeenCalled()
  })
})
