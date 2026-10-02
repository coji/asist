// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings'
import { MAX_BULK_CHANGE, mailListQuerySchema, messageIdOf, type MailListQuery, type MailMessage } from '@shared/mail'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { MailView, readRows } from '../src/renderer/src/ui/mail/MailView'
import { mailDraftCard } from '../src/renderer/src/panels/builtin/mail-draft'
import { useMailStore, useSettingsStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { useConfirmStore } from '../src/renderer/src/state/confirm'
import { DEMO_MAIL_ACCOUNTS, DEMO_MAIL_BODIES, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGES, DEMO_UID_VALIDITY, demoMailStatus, demoReplyOf } from '../src/renderer/src/demo/fixtures/mail'

const t = createTranslator('ja-JP')
const inbox = (): MailMessage[] => DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'inbox').sort((a, b) => b.date - a.date)
const demoList = async (query: MailListQuery) => {
  const view = query.view ?? 'inbox'
  const list = DEMO_MAIL_MESSAGES.filter((m) => (view === 'starred' ? m.starred : m.folder === view))
    .filter((m) => !query.accountId || m.accountId === query.accountId)
    .filter((m) => !query.unreadOnly || m.unread)
    .sort((a, b) => b.date - a.date)
  return { messages: list, total: list.length, unread: list.filter((m) => m.unread).length }
}
const draftUpdate = async (id: string, patch: Record<string, unknown>) => ({ ...DEMO_MAIL_DRAFTS.find((d) => d.id === id)!, ...patch })
const api = {
  mailList: vi.fn(demoList),
  mailThread: vi.fn(async (accountId: string, threadId: string) => DEMO_MAIL_MESSAGES.filter((m) => m.accountId === accountId && m.threadId === threadId).sort((a, b) => a.date - b.date)),
  mailRead: vi.fn(async (id: string) => ({ message: DEMO_MAIL_MESSAGES.find((m) => m.id === id)!, text: DEMO_MAIL_BODIES.get(id) ?? '' })),
  mailChange: vi.fn(async (change: { operation: string }) => ({ saved: true, operation: change.operation, id: 'x', summary: '済み' })),
  mailReplySettle: vi.fn(async (id: string, replyAll: boolean) => demoReplyOf(DEMO_MAIL_MESSAGES.find((m) => m.id === id)!, replyAll)),
  mailReplySend: vi.fn(async () => ({ saved: true, operation: 'reply', id: '<x>', summary: '済み' })),
  mailStatus: vi.fn(async () => demoMailStatus(DEMO_MAIL_MESSAGES)),
  mailSyncNow: vi.fn(async () => {}),
  mailDraftList: vi.fn(async () => DEMO_MAIL_DRAFTS),
  mailDraftCreate: vi.fn(async () => DEMO_MAIL_DRAFTS[0]),
  mailDraftUpdate: vi.fn(draftUpdate),
  mailDraftRemove: vi.fn(async () => {}),
  mailDraftSend: vi.fn(async () => ({ saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '田中' }) }))
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  api.mailList.mockImplementation(demoList)
  api.mailDraftUpdate.mockImplementation(draftUpdate)
  useSettingsStore.setState({
    settings: { mail: { enabled: true, accounts: DEMO_MAIL_ACCOUNTS, defaultAccountId: 'demo-work', syncDays: 30, notifyNewMail: true } } as AppSettings
  })
  useMailStore.setState({ status: demoMailStatus(DEMO_MAIL_MESSAGES), revision: 0, drafts: DEMO_MAIL_DRAFTS, draftsLoaded: true, sending: [] })
  useToastStore.setState({ toasts: [] })
  useConfirmStore.setState({ queue: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'mail' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(MailView, { open: true })))
  await act(async () => {})
  return container.querySelector<HTMLElement>('[aria-label="MAIL"]')!
}
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const texts = (selector: string): string[] => [...container.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '')

/**
 * Enter in a text field as Chromium handles it and happy-dom does not: unless the keydown is cancelled,
 * HTML's implicit submission clicks the form's default button, its first submit button, when that button
 * is enabled, and submits a form without one when a single field blocks implicit submission.
 */
function pressEnter(input: HTMLInputElement): void {
  input.focus()
  if (!input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))) return
  const form = input.form
  if (!form) return
  const fields = [...form.elements]
  const button = fields.find((el): el is HTMLButtonElement | HTMLInputElement => (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === 'submit')
  if (button) {
    if (!button.disabled) button.click()
    return
  }
  const blocking = fields.filter((el) => el instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(el.type))
  if (blocking.length === 1) form.requestSubmit()
}

/** Answers the confirmation on screen, as a button of the confirm sheet does. */
function answer(approved: boolean): void {
  const [shown] = useConfirmStore.getState().queue
  shown.resolve!(approved)
  useConfirmStore.getState().close(shown.id)
}

describe('the message list', () => {
  it('shows the inbox newest first, marks the unread rows, and filters by folder and by account', async () => {
    const view = await render()
    expect(api.mailList).toHaveBeenCalledWith(expect.objectContaining({ view: 'inbox', accountId: null, query: '' }))
    expect(texts('.ml-row-subject')).toEqual(inbox().map((m) => m.subject))
    expect(view.querySelectorAll('.ml-row[data-unread]')).toHaveLength(inbox().filter((m) => m.unread).length)
    expect(view.querySelector('.ml-count')?.textContent).toBe(t('mail.messageCount', { count: inbox().length }))
    expect(view.querySelector('.ml-view[aria-pressed="true"]')?.textContent).toContain(t('mail.boxes.inbox'))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.sent')))!.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'sent' }))
    expect(texts('.ml-row-subject')).toEqual(DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'sent').map((m) => m.subject))
    expect(view.querySelector('.ml-row-from')?.textContent).toContain('To: 田中 誠')
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.inbox')))!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-account[data-state]')!.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'inbox', accountId: 'demo-work' }))
    expect(texts('.ml-row-subject')).toEqual(inbox().filter((m) => m.accountId === 'demo-work').map((m) => m.subject))
  })

  it('flips the star on the click, puts it back when main rejects the change, and reloads the list when the sync reports a change', async () => {
    const view = await render()
    const first = inbox()[0]
    let release!: (value: { saved: boolean }) => void
    api.mailChange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-star')!.click())
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'star', id: first.id, starred: !first.starred })
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    await act(async () => release({ saved: true }))
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    api.mailChange.mockRejectedValueOnce(new Error('IMAP サーバーが応答しません'))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-star')!.click())
    expect(api.mailChange).toHaveBeenLastCalledWith({ operation: 'star', id: first.id, starred: first.starred })
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', body: 'IMAP サーバーが応答しません' })
    const calls = api.mailList.mock.calls.length
    await act(async () => useMailStore.getState().bump())
    expect(api.mailList.mock.calls.length).toBe(calls + 1)
  })

  it('collects the ids of every unread message matching the filter behind the mark-all-read button, sends them in one call, and clears the rows at once', async () => {
    const view = await render()
    const unread = inbox().filter((m) => m.unread)
    const button = view.querySelector<HTMLButtonElement>('.ml-read-all')!
    expect(button.textContent).toContain(t('mail.list.markAllRead', { count: unread.length }))
    let release!: (value: { saved: boolean }) => void
    api.mailChange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await act(async () => button.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'inbox', unreadOnly: true, limit: 1000 }))
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'markRead', ids: unread.map((m) => m.id), read: true })
    expect(view.querySelectorAll('.ml-row[data-unread]')).toHaveLength(0)
    expect(view.querySelector('.ml-read-all')).toBeNull()
    await act(async () => release({ saved: true }))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.list.markedRead', { count: unread.length }) })
  })

  it('loads no list without an account and opens the settings on the page where accounts are added', async () => {
    useSettingsStore.setState({ settings: { mail: { enabled: true, accounts: [], defaultAccountId: null, syncDays: 30, notifyNewMail: true } } as AppSettings })
    const view = await render()
    expect(api.mailList).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-notice')?.textContent).toContain(t('mail.empty.noAccounts'))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-notice button')!.click())
    expect(useViewStore.getState().open).toEqual({ app: 'settings', page: 'connections' })
  })
})

describe('loading more', () => {
  const HOUR = 3_600_000
  const NOW = Date.UTC(2026, 8, 16, 6)
  /** The order of main's list: newest first, then the higher uid, then the id. */
  const order = (a: MailMessage, b: Pick<MailMessage, 'date' | 'uid' | 'id'>): number => b.date - a.date || b.uid - a.uid || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  /** Inbox rows of the first demo account, served the way main's cache serves a page after a cursor. */
  function serve(dates: number[]): MailMessage[] {
    const all = dates
      .map((date, index): MailMessage => {
        const uid = index + 1
        return {
          id: messageIdOf('demo-work', 'inbox', DEMO_UID_VALIDITY, uid),
          accountId: 'demo-work',
          folder: 'inbox',
          uid,
          messageId: `<${uid}@x>`,
          threadId: `m:<${uid}@x>`,
          subject: `件名${uid}`,
          from: { name: '田中', address: 't@example.com' },
          to: [{ name: '', address: 'me@example.com' }],
          cc: [],
          replyTo: [],
          date,
          snippet: '',
          unread: true,
          starred: false,
          answered: false,
          attachments: [],
          size: 100,
          labels: [],
          bodyFetched: false
        }
      })
      .sort(order)
    api.mailList.mockImplementation(async (value: MailListQuery) => {
      const query = mailListQuerySchema.parse(value)
      const cursor = query.before
      const rest = cursor ? all.filter((m) => order(m, cursor) > 0) : all
      return { messages: rest.slice(0, query.limit).map((m) => ({ ...m })), total: all.length, unread: all.filter((m) => m.unread).length }
    })
    return all
  }
  const rows = (): number => container.querySelectorAll('.ml-row').length
  const loadMore = async (): Promise<void> => {
    await act(async () => container.querySelector<HTMLButtonElement>('.ml-more')!.click())
    await act(async () => {})
  }

  it('reaches the rows that share a date across the page boundary, and keeps every loaded row when the cache reports a change', async () => {
    // The 47th message and every older one carry one date, so the first page ends inside that run.
    const all = serve(Array.from({ length: 70 }, (_, index) => NOW - Math.min(index + 1, 47) * HOUR))
    await render()
    expect(rows()).toBe(50)
    await loadMore()
    expect(texts('.ml-row-subject')).toEqual(all.map((m) => m.subject))
    // Opening a message on the second page marks it read, and the sync reports the change.
    all[60].unread = false
    await act(async () => useMailStore.getState().bump())
    await act(async () => {})
    expect(rows()).toBe(70)
    expect(container.querySelectorAll('.ml-row[data-unread]')).toHaveLength(69)
  })

  it('reads more rows than one query returns in parts that continue one another', async () => {
    const count = MAX_BULK_CHANGE + 60
    const all = serve(Array.from({ length: count }, (_, index) => NOW - (index + 1) * 60_000))
    const result = await readRows({ view: 'inbox', accountId: null, query: '' }, count)
    expect(result.messages.map((m) => m.id)).toEqual(all.map((m) => m.id))
    expect(result.total).toBe(count)
  })
})

describe('reading', () => {
  it('opens the thread on a row click, loads the body, marks an unread message read, and hands the reply body to main', async () => {
    const view = await render()
    const first = inbox()[0]
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    expect(api.mailRead).toHaveBeenCalledWith(first.id)
    expect(api.mailThread).toHaveBeenCalledWith(first.accountId, first.threadId)
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'markRead', ids: [first.id], read: true })
    const reader = view.querySelector('.ml-reader')!
    expect(reader.querySelector('h2')?.textContent).toBe(first.subject)
    // The thread holds two received messages and one sent message.
    expect(reader.querySelectorAll('.ml-message')).toHaveLength(3)
    expect(reader.querySelector('.ml-message[data-open] .ml-text')?.textContent).toContain('火曜 14時か水曜 10時')
    await act(async () => [...reader.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.reply')))!.click())
    const form = reader.querySelector<HTMLFormElement>('.ml-reply')!
    expect(api.mailReplySettle).toHaveBeenCalledWith(first.id, false)
    await act(async () => setValue(form.querySelector('textarea')!, '火曜 14時でお願いします。'))
    await act(async () => form.requestSubmit())
    expect(api.mailReplySend).toHaveBeenCalledWith({ reply: demoReplyOf(first, false), body: '火曜 14時でお願いします。' })
    expect(api.mailChange).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'reply' }))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.done.reply') })
    expect(reader.querySelector('.ml-reply')).toBeNull()
  })

  it('shows in the reply form the To and Cc main settled, keeps them in step with a switch to reply-all, and sends that same reply', async () => {
    const view = await render()
    const withReplyTo = inbox()[1]
    await act(async () => view.querySelectorAll<HTMLButtonElement>('.ml-row-main')[1].click())
    await act(async () => {})
    const reader = view.querySelector('.ml-reader')!
    const button = (key: 'mail.reply' | 'mail.replyAll'): HTMLButtonElement => [...reader.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.trim() === t(key))!
    let answerReply!: (reply: ReturnType<typeof demoReplyOf>) => void
    api.mailReplySettle.mockImplementationOnce(() => new Promise((resolve) => (answerReply = resolve)))
    await act(async () => button('mail.reply').click())
    const form = reader.querySelector<HTMLFormElement>('.ml-reply')!
    const send = (): HTMLButtonElement => form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(form.querySelectorAll('.ml-static')).toHaveLength(0)
    await act(async () => setValue(form.querySelector('textarea')!, '9/25(木) でお願いします。'))
    expect(send().disabled).toBe(true)
    await act(async () => button('mail.replyAll').click())
    // The answer for plain reply arrives after the switch and is dropped, so the form keeps the reply-all it shows.
    await act(async () => answerReply(demoReplyOf(withReplyTo, false)))
    const shown = [...form.querySelectorAll('.ml-static')].map((field) => field.textContent)
    expect(shown).toEqual(['採用チーム <recruiting@example.co.jp>', '田中 誠 <tanaka@example.co.jp>'])
    expect(form.querySelector('textarea')!.value).toBe('9/25(木) でお願いします。')
    await act(async () => form.requestSubmit())
    expect(api.mailReplySend).toHaveBeenCalledWith({ reply: demoReplyOf(withReplyTo, true), body: '9/25(木) でお願いします。' })
  })

  it('says why a reply cannot be settled and keeps the send button off', async () => {
    api.mailReplySettle.mockRejectedValueOnce(new Error(errorText('mail.errors.account.off')))
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.trim() === t('mail.reply'))!.click())
    const form = view.querySelector<HTMLFormElement>('.ml-reply')!
    await act(async () => setValue(form.querySelector('textarea')!, '了解です。'))
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(t('mail.errors.account.off'))
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await act(async () => form.requestSubmit())
    expect(api.mailReplySend).not.toHaveBeenCalled()
  })

  it('closes the reader after an archive and keeps it open when the confirmation is cancelled', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    api.mailChange.mockResolvedValueOnce({ cancelled: true, saved: false })
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.trash')))!.click())
    expect(view.querySelector('.ml-reader')).not.toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: t('mail.change.cancelled') })
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.archive')))!.click())
    expect(api.mailChange).toHaveBeenLastCalledWith({ operation: 'archive', id: inbox()[0].id })
    expect(view.querySelector('.ml-reader')).toBeNull()
  })
})

describe('composing and Escape', () => {
  it('splits the recipients of a composed message and closes the form once it is sent', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const form = view.querySelector<HTMLElement>('.ml-composer')!
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.to')}"]`)!, '田中 <t@example.co.jp>, hana@example.co.jp'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.subject')}"]`)!, '候補日'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.body')}"]`)!, '火曜でお願いします。'))
    await act(async () => form.querySelector<HTMLButtonElement>('.cal-primary')!.click())
    expect(api.mailChange).toHaveBeenCalledWith({
      operation: 'send',
      accountId: 'demo-work',
      to: ['田中 <t@example.co.jp>', 'hana@example.co.jp'],
      cc: [],
      subject: '候補日',
      body: '火曜でお願いします。'
    })
    expect(view.querySelector('.ml-composer')).toBeNull()
  })

  it('offers no send for a draft whose send started, says it can only be discarded, and discards it', async () => {
    const started = DEMO_MAIL_DRAFTS.find((draft) => draft.sendStartedAt !== null)!
    const view = await render()
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: started.id }))
    const form = view.querySelector<HTMLElement>('.ml-composer')!
    expect(form.querySelector('[role="status"]')?.textContent).toBe(t('mail.drafts.sendStarted'))
    expect(form.querySelector('.cal-primary')).toBeNull()
    expect(form.querySelector<HTMLTextAreaElement>(`[aria-label="${t('mail.fields.body')}"]`)?.disabled).toBe(true)
    await act(async () => [...form.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('mail.composer.discard'))!.click())
    expect(api.mailDraftRemove).toHaveBeenCalledWith(started.id)
  })

  it('shows the composer a send under way from the draft card on the same draft, not a send that started and was left', async () => {
    const draft = DEMO_MAIL_DRAFTS[0]
    let finish!: (value: unknown) => void
    api.mailDraftSend.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)) as never)
    const card = { key: `mail-draft:${draft.id}`, type: 'mail-draft', slot: 'right' as const, state: 'ready' as const, props: { draftId: draft.id }, createdAt: 0, updatedAt: 0 }
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: draft.id }))
    await act(async () =>
      root.render(React.createElement(React.Fragment, null, React.createElement(MailView, { open: true }), React.createElement('div', { className: 'card-host' }, React.createElement(mailDraftCard.Body, { spec: card, size: 'l' }))))
    )
    await act(async () => container.querySelector<HTMLButtonElement>('.card-host .card-action')!.click())
    // Main records the start of the send in the draft while it runs.
    await act(async () => useMailStore.setState({ drafts: DEMO_MAIL_DRAFTS.map((item) => (item.id === draft.id ? { ...item, sendStartedAt: Date.now() } : item)) }))
    const form = container.querySelector<HTMLElement>('.ml-composer')!
    expect(form.querySelector('[role="status"]')).toBeNull()
    const submit = form.querySelector<HTMLButtonElement>('.cal-primary')!
    expect([submit.textContent, submit.disabled]).toEqual([t('mail.sending'), true])
    expect([...form.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('mail.composer.discard'))?.disabled).toBe(true)
    // The mail goes out and main cannot remove the draft, which keeps the start of its send.
    await act(async () => finish({ saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '田中' }) }))
    expect(form.querySelector('[role="status"]')?.textContent).toBe(t('mail.drafts.sendStarted'))
    expect(form.querySelector('.cal-primary')).toBeNull()
    expect(api.mailDraftSend).toHaveBeenCalledOnce()
  })

  it('creates the draft in main and closes the composer when the save-as-draft button is pressed', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const form = view.querySelector<HTMLElement>('.ml-composer')!
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.to')}"]`)!, 't@example.co.jp'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.body')}"]`)!, '書きかけ'))
    await act(async () => [...form.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(t('mail.composer.saveDraft')))!.click())
    expect(api.mailDraftCreate).toHaveBeenCalledWith({ accountId: 'demo-work', to: ['t@example.co.jp'], cc: [], subject: '', body: '書きかけ' })
    expect(api.mailChange).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-composer')).toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.composer.draftSaved') })
  })

  it('lists the drafts held by main, reopens the one that is clicked in the composer, and asks main to send that draft', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.drafts')))!.click())
    expect(view.querySelector('.ml-view[aria-pressed="true"]')?.textContent).toContain(`${t('mail.boxes.drafts')}${DEMO_MAIL_DRAFTS.length}`)
    // The reply answers a message whose subject already starts with "Re:", and the row shows the subject it is sent with.
    expect(texts('.ml-row-subject')).toEqual(['季節のご挨拶', 'Re: 採用面談の候補日', '打合せの資料'])
    // A reply's row names where it goes, which Reply-To moved away from the sender of the original.
    expect(texts('.ml-row-from')[1]).toBe('To: 採用チーム')
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    const form = view.querySelector<HTMLElement>('.ml-composer')!
    expect(form.querySelector<HTMLInputElement>(`[aria-label="${t('mail.fields.subject')}"]`)?.value).toBe('季節のご挨拶')
    await act(async () => form.querySelector<HTMLButtonElement>('.cal-primary')!.click())
    expect(api.mailDraftSend).toHaveBeenCalledWith(DEMO_MAIL_DRAFTS[0].id, DEMO_MAIL_DRAFTS[0].updatedAt)
    expect(api.mailChange).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.done.send') })
    expect(view.querySelector('.ml-composer')).toBeNull()
    // Opening the screen from a draft card opens the composer on that draft.
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[1].id }))
    expect(view.querySelector('.ml-composer h2')?.textContent).toBe(t('mail.composer.replyDraft'))
    expect(view.querySelector('.ml-composer .ml-reply-to')?.textContent).toContain(t('mail.composer.replyToAll', { name: '鈴木 花', subject: 'Re: 採用面談の候補日' }))
    // The addresses shown before the send are the ones the draft is sent to: Reply-To and the reply-all's Cc, not the sender.
    expect(texts('.ml-composer .ml-field .ml-static').slice(1)).toEqual(['採用チーム <recruiting@example.co.jp>', '田中 誠 <tanaka@example.co.jp>'])
  })

  it('keeps a recipient whose name holds a comma as one recipient when a message is composed', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const form = view.querySelector<HTMLElement>('.ml-composer')!
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.to')}"]`)!, 'Tanaka, Taro <taro@example.com>, "Sato, Hana" <hana@example.co.jp>; s@example.com、'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.body')}"]`)!, 'よろしくお願いします。'))
    await act(async () => form.querySelector<HTMLButtonElement>('.cal-primary')!.click())
    expect(api.mailChange).toHaveBeenCalledWith(expect.objectContaining({ to: ['Tanaka, Taro <taro@example.com>', '"Sato, Hana" <hana@example.co.jp>', 's@example.com'] }))
  })

  it('does not send a draft when Enter confirms an address typed into Cc', async () => {
    const view = await render()
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[0].id }))
    const cc = view.querySelector<HTMLInputElement>('.ml-composer [aria-label="Cc"]')!
    await act(async () => setValue(cc, 'suzuki@example.co.jp'))
    await act(async () => pressEnter(cc))
    expect(api.mailDraftSend).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-composer')).not.toBeNull()
  })

  it('does not send a new message when Enter is pressed in its subject after the body was written', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const field = (key: 'mail.fields.to' | 'mail.fields.subject' | 'mail.fields.body') => view.querySelector<HTMLInputElement>(`.ml-composer [aria-label="${t(key)}"]`)!
    await act(async () => setValue(field('mail.fields.to'), 't@example.co.jp'))
    await act(async () => setValue(field('mail.fields.body'), '火曜でお願いします。'))
    await act(async () => setValue(field('mail.fields.subject'), '候補日'))
    await act(async () => pressEnter(field('mail.fields.subject')))
    expect(api.mailChange).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-composer')).not.toBeNull()
  })

  it('asks before a typed new message is closed or left for another box, message or mini app, and keeps it while the user declines', async () => {
    const body = '来週の打合せですが、火曜の午後でいかがでしょうか。'
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const textarea = (): HTMLTextAreaElement | null => view.querySelector<HTMLTextAreaElement>(`.ml-composer [aria-label="${t('mail.fields.body')}"]`)
    await act(async () => setValue(textarea()!, body))
    const leaves: Array<() => void> = [
      () => textarea()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      () => view.querySelector<HTMLButtonElement>(`.ml-composer [aria-label="${t('common.close')}"]`)!.click(),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.sent')))!.click(),
      () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click(),
      () => void useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[0].id }),
      () => void useViewStore.getState().openApp({ app: 'notes' })
    ]
    for (const leave of leaves) {
      await act(async () => leave())
      expect(useConfirmStore.getState().queue).toHaveLength(1)
      await act(async () => answer(false))
      expect(textarea()?.value).toBe(body)
      expect(useViewStore.getState().open).toMatchObject({ app: 'mail', box: 'inbox', pane: { kind: 'compose' } })
    }
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.sent')))!.click())
    await act(async () => answer(true))
    expect(view.querySelector('.ml-composer')).toBeNull()
    expect(useViewStore.getState().open).toMatchObject({ app: 'mail', box: 'sent', pane: null })
  })

  it('saves a change typed into a draft just before its composer closes, and says so when the save fails', async () => {
    const draft = DEMO_MAIL_DRAFTS[0]
    const view = await render()
    const typeAndClose = async (body: string): Promise<void> => {
      await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: draft.id }))
      await act(async () => setValue(view.querySelector(`.ml-composer [aria-label="${t('mail.fields.body')}"]`)!, body))
      await act(async () => view.querySelector<HTMLButtonElement>(`.ml-composer [aria-label="${t('common.close')}"]`)!.click())
      expect(view.querySelector('.ml-composer')).toBeNull()
    }
    await typeAndClose(`${draft.body}\n追伸`)
    expect(api.mailDraftUpdate).toHaveBeenCalledWith(draft.id, expect.objectContaining({ body: `${draft.body}\n追伸` }))
    api.mailDraftUpdate.mockRejectedValueOnce(new Error(errorText('mail.errors.form.badAddress', { text: 'suzuki@' })))
    await typeAndClose(`${draft.body}\n追伸2`)
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: t('mail.composer.draftSaveFailed'), body: t('mail.errors.form.badAddress', { text: 'suzuki@' }) })
  })

  it('saves nothing more of a draft that is discarded or sent right after typing into it', async () => {
    // Main tells the renderer that the draft is gone before the removal or the send returns.
    const gone = async (id: string): Promise<void> => {
      useMailStore.getState().applyDrafts(useMailStore.getState().drafts.filter((draft) => draft.id !== id))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    api.mailDraftRemove.mockImplementationOnce(gone)
    api.mailDraftSend.mockImplementationOnce(async (id: string) => {
      await gone(id)
      return { saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '採用チーム' }) }
    })
    const view = await render()
    const typeAndPress = async (id: string, button: string): Promise<void> => {
      await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: id }))
      await act(async () => setValue(view.querySelector(`.ml-composer [aria-label="${t('mail.fields.body')}"]`)!, '書き直しました。'))
      await act(async () => view.querySelector<HTMLButtonElement>(button)!.click())
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(view.querySelector('.ml-composer')).toBeNull()
    }
    await typeAndPress(DEMO_MAIL_DRAFTS[0].id, '.ml-composer .cal-btn.is-danger')
    expect(api.mailDraftUpdate).not.toHaveBeenCalled()
    // Sending saves the change first, and that one save is all.
    await typeAndPress(DEMO_MAIL_DRAFTS[1].id, '.ml-composer .cal-primary')
    expect(api.mailDraftSend).toHaveBeenCalledWith(DEMO_MAIL_DRAFTS[1].id, DEMO_MAIL_DRAFTS[1].updatedAt)
    expect(api.mailDraftUpdate).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts.filter((toast) => toast.kind === 'error')).toEqual([])
  })

  it('asks before a draft whose change main refused to save is closed or left, and saves nothing more once the user gives the change up', async () => {
    api.mailDraftUpdate.mockRejectedValue(new Error(errorText('mail.errors.form.badAddress', { text: 'suzuki@' })))
    const view = await render()
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[0].id }))
    const field = (label: string) => view.querySelector<HTMLInputElement & HTMLTextAreaElement>(`.ml-composer [aria-label="${label}"]`)
    await act(async () => setValue(field('Cc')!, 'suzuki@'))
    await act(async () => setValue(field(t('mail.fields.body'))!, '追記しました。'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 700)))
    expect(view.querySelector('.ml-composer [role="alert"]')?.textContent).toBe(t('mail.errors.form.badAddress', { text: 'suzuki@' }))
    const leaves: Array<() => void> = [
      () => view.querySelector<HTMLButtonElement>(`.ml-composer [aria-label="${t('common.close')}"]`)!.click(),
      () => field(t('mail.fields.body'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click(),
      () => void useViewStore.getState().openApp({ app: 'notes' })
    ]
    for (const leave of leaves) {
      await act(async () => leave())
      expect(useConfirmStore.getState().queue).toHaveLength(1)
      await act(async () => answer(false))
      expect(field(t('mail.fields.body'))?.value).toBe('追記しました。')
    }
    const saves = api.mailDraftUpdate.mock.calls.length
    await act(async () => view.querySelector<HTMLButtonElement>(`.ml-composer [aria-label="${t('common.close')}"]`)!.click())
    await act(async () => answer(true))
    expect(view.querySelector('.ml-composer')).toBeNull()
    expect(api.mailDraftUpdate.mock.calls.length).toBe(saves)
    expect(useToastStore.getState().toasts.filter((toast) => toast.kind === 'error')).toEqual([])
  })

  it('asks before a typed reply is thrown away by Escape, cancel, closing the reader or leaving it, and keeps it while the user declines', async () => {
    const reply = '火曜 14時でお願いします。'
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    const reader = (): Element => view.querySelector('.ml-reader')!
    // Every message of the thread is opened, so that another one offers its own reply.
    for (const head of reader().querySelectorAll<HTMLButtonElement>('.ml-message:not([data-open]) .ml-message-head')) await act(async () => head.click())
    const replyTo = (message: Element): HTMLButtonElement => [...message.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.trim() === t('mail.reply'))!
    await act(async () => replyTo(reader().querySelector('.ml-message:last-child')!).click())
    const textarea = (): HTMLTextAreaElement | null => view.querySelector<HTMLTextAreaElement>('.ml-reply textarea')
    await act(async () => setValue(textarea()!, reply))
    const leaves: Array<() => void> = [
      () => textarea()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      () => [...view.querySelectorAll<HTMLButtonElement>('.ml-reply button')].find((el) => el.textContent === t('common.cancel'))!.click(),
      () => replyTo(reader().querySelector('.ml-message:first-child')!).click(),
      () => reader().querySelector<HTMLButtonElement>(`.ml-reader-head [aria-label="${t('common.close')}"]`)!.click(),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => view.querySelectorAll<HTMLButtonElement>('.ml-row-main')[1].click(),
      () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.sent')))!.click(),
      () => void useViewStore.getState().openApp({ app: 'notes' })
    ]
    for (const leave of leaves) {
      await act(async () => leave())
      expect(useConfirmStore.getState().queue).toHaveLength(1)
      await act(async () => answer(false))
      expect(textarea()?.value).toBe(reply)
      expect(useViewStore.getState().open).toMatchObject({ app: 'mail', pane: { kind: 'message' } })
    }
    await act(async () => textarea()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await act(async () => answer(true))
    expect(textarea()).toBeNull()
    expect(view.querySelector('.ml-reader')).not.toBeNull()
  })

  it('keeps the composer, the reply form and the reader on the Escape that cancels an IME conversion in them', async () => {
    // Chromium on macOS sends the Escape that cancels an IME conversion with isComposing set.
    const cancelConversion = (field: Element): boolean => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const body = view.querySelector<HTMLTextAreaElement>(`.ml-composer [aria-label="${t('mail.fields.body')}"]`)!
    await act(async () => setValue(body, 'よろしく'))
    await act(async () => void cancelConversion(body))
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(view.querySelector('.ml-composer')).not.toBeNull()
    expect(body.value).toBe('よろしく')

    await act(async () => useViewStore.getState().update('mail', { pane: null }))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.reply')))!.click())
    const reply = view.querySelector<HTMLTextAreaElement>('.ml-reply textarea')!
    await act(async () => setValue(reply, 'かようび'))
    await act(async () => void cancelConversion(reply))
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(view.querySelector('.ml-reply')).not.toBeNull()
    expect(view.querySelector('.ml-reader')).not.toBeNull()
    expect(useViewStore.getState().open?.app).toBe('mail')
  })

  it('closes the reader on the first Escape and the screen on the second', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(view.querySelector('.ml-reader')).toBeNull()
    expect(useViewStore.getState().open?.app).toBe('mail')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('mail')
  })
})
