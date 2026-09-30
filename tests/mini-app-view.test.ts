// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJob } from '@shared/ipc'
import type { AppSettings } from '@shared/settings'
import type { CalendarEvent } from '@shared/calendar'
import type { MailListQuery } from '@shared/mail'
import { summarizeNote } from '@shared/notes'
import { openMiniAppSchema, placeMiniApp, type MiniAppTarget, type MiniAppView } from '@shared/mini-apps'
import { NotesView } from '../src/renderer/src/ui/notes/NotesView'
import { MailView } from '../src/renderer/src/ui/mail/MailView'
import { CalendarView } from '../src/renderer/src/ui/calendar/CalendarView'
import { TasksView } from '../src/renderer/src/ui/tasks/TasksView'
import { JobsView } from '../src/renderer/src/ui/JobsView'
import { useJobStore, useMailStore, useNoteStore, useSettingsStore, useTaskStore, useToastStore } from '../src/renderer/src/state/stores'
import { startMiniAppReports, useViewStore } from '../src/renderer/src/state/view'
import { DEMO_MAIL_ACCOUNTS, DEMO_MAIL_BODIES, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGES, demoMailStatus } from '../src/renderer/src/demo/fixtures/mail'

describe('placing a mini app at a target', () => {
  const today = new Date(2026, 8, 23, 9, 30)

  it('opens each mini app at the place the target names, as a view the report schema accepts', () => {
    const cases: Array<[MiniAppTarget, MiniAppView]> = [
      [{ app: 'notes', noteId: 'n1' }, { app: 'notes', noteId: 'n1', editing: false }],
      [{ app: 'tasks', view: 'list', taskId: 't1' }, { app: 'tasks', view: 'list', taskId: 't1' }],
      [{ app: 'mail', messageId: 'm1' }, { app: 'mail', box: 'inbox', accountId: null, query: '', pane: { kind: 'message', id: 'm1' } }],
      [{ app: 'mail', draftId: 'd1' }, { app: 'mail', box: 'drafts', accountId: null, query: '', pane: { kind: 'draft', id: 'd1' } }],
      [{ app: 'mail', box: 'sent' }, { app: 'mail', box: 'sent', accountId: null, query: '', pane: null }],
      [{ app: 'calendar', view: 'week', date: '2026-10-05', eventId: 'e1' }, { app: 'calendar', view: 'week', date: '2026-10-05', eventId: 'e1' }],
      [{ app: 'calendar' }, { app: 'calendar', view: 'month', date: '2026-09-23', eventId: null }],
      [{ app: 'jobs', jobId: 'j1' }, { app: 'jobs', jobId: 'j1' }],
      [{ app: 'memory', file: 'pages/旅行.md' }, { app: 'memory', file: 'pages/旅行.md' }],
      [{ app: 'settings', page: 'voice' }, { app: 'settings', page: 'voice' }],
      [{ app: 'settings' }, { app: 'settings', page: 'overview' }]
    ]
    for (const [target, expected] of cases) {
      const view = placeMiniApp(null, target, today)
      expect(view).toEqual(expected)
      expect(openMiniAppSchema.parse(view)).toEqual(view)
    }
  })

  it('keeps what the open mini app shows for the fields a target leaves out', () => {
    expect(placeMiniApp({ app: 'tasks', view: 'list', taskId: 't1' }, { app: 'tasks', taskId: 't2' })).toEqual({ app: 'tasks', view: 'list', taskId: 't2' })
    expect(placeMiniApp({ app: 'notes', noteId: 'n1', editing: true }, { app: 'notes' })).toEqual({ app: 'notes', noteId: 'n1', editing: true })
    expect(placeMiniApp({ app: 'notes', noteId: 'n1', editing: true }, { app: 'notes', noteId: 'n2' })).toEqual({ app: 'notes', noteId: 'n2', editing: false })
    const mail: MiniAppView = { app: 'mail', box: 'inbox', accountId: 'work', query: '見積', pane: { kind: 'message', id: 'm1' } }
    expect(placeMiniApp(mail, { app: 'mail', box: 'sent' })).toEqual({ ...mail, box: 'sent', pane: null })
    expect(placeMiniApp(mail, { app: 'mail', messageId: 'm2' })).toEqual({ ...mail, pane: { kind: 'message', id: 'm2' } })
    const calendar: MiniAppView = { app: 'calendar', view: 'week', date: '2026-10-05', eventId: 'e1' }
    expect(placeMiniApp(calendar, { app: 'calendar', eventId: 'e2' })).toEqual({ ...calendar, eventId: 'e2' })
    // Details left open on another day would point at a chip the calendar no longer draws.
    expect(placeMiniApp(calendar, { app: 'calendar', date: '2026-10-12' })).toEqual({ ...calendar, date: '2026-10-12', eventId: null })
    // Another mini app starts from what it shows by itself.
    expect(placeMiniApp(mail, { app: 'tasks' })).toEqual({ app: 'tasks', view: 'board', taskId: null })
  })

  it('opens and closes through the Dock toggle, one mini app at a time', () => {
    const view = useViewStore.getState()
    view.closeApp()
    view.openApp({ app: 'settings', page: 'apiKeys' })
    view.toggleApp('notes')
    expect(useViewStore.getState().open).toEqual({ app: 'notes', noteId: null, editing: false })
    useViewStore.getState().toggleApp('notes')
    expect(useViewStore.getState().open).toBeNull()
  })

  it('drops a change for a mini app that is not open, so a view leaving the screen does not open itself again', () => {
    useViewStore.getState().openApp({ app: 'tasks' })
    useViewStore.getState().update('notes', { noteId: 'n1' })
    expect(useViewStore.getState().open?.app).toBe('tasks')
  })
})

const TRIP = '20260920-073000-0c9e'
const PLAN = '20260922-181030-b71c'
const day = (d: number, h = 0): number => new Date(2026, 8, d, h).getTime()
const calEvent = (id: string, title: string, start: number, end: number): CalendarEvent => ({
  id,
  calendarId: 'work',
  calendarTitle: '仕事',
  title,
  start,
  end,
  allDay: false,
  location: '',
  notes: '',
  timeZone: 'Asia/Tokyo',
  revision: 'r',
  recurring: false,
  hasAttendees: false,
  writable: true
})
const review = calEvent('ev-review', '予約画面 レビュー', day(15, 10), day(15, 11))
const release = calEvent('ev-release', 'リリース判定', new Date(2026, 9, 20, 15).getTime(), new Date(2026, 9, 20, 16).getTime())
const job = (id: string, startedAt: number): AgentJob =>
  ({ id, title: `調査 ${id}`, cwd: `/jobs/${id}`, status: 'done', engine: 'codex', prompt: '', readonly: true, startedAt }) as AgentJob

const reportMiniAppView = vi.fn(async (view: MiniAppView | null) => void view)
const api = {
  reportMiniAppView,
  notesList: vi.fn(),
  notesSearch: vi.fn(async () => []),
  noteRead: vi.fn(async (id: string) => (id === TRIP ? '# 旅行の持ち物\n\n充電器と傘\n' : '# 提案書の構成\n\n日程の案\n')),
  mailList: vi.fn(async (query: MailListQuery) => {
    const list = DEMO_MAIL_MESSAGES.filter((m) => m.folder === (query.view ?? 'inbox')).sort((a, b) => b.date - a.date)
    return { messages: list, total: list.length, unread: list.filter((m) => m.unread).length }
  }),
  mailThread: vi.fn(async (accountId: string, threadId: string) => DEMO_MAIL_MESSAGES.filter((m) => m.accountId === accountId && m.threadId === threadId)),
  mailRead: vi.fn(async (id: string) => ({ message: DEMO_MAIL_MESSAGES.find((m) => m.id === id)!, text: DEMO_MAIL_BODIES.get(id) ?? '' })),
  mailChange: vi.fn(async () => ({ saved: true, operation: 'markRead', id: 'x', summary: '' })),
  mailStatus: vi.fn(async () => demoMailStatus(DEMO_MAIL_MESSAGES)),
  mailDraftList: vi.fn(async () => DEMO_MAIL_DRAFTS),
  calendarStatus: vi.fn(async () => ({ signIn: 'signedIn', calendars: [{ id: 'work', title: '仕事', writable: true }], account: 'me@example.com' })),
  calendarEvents: vi.fn(async ({ start, end }: { start: string; end: string }) =>
    [review, release].filter((e) => e.start < Date.parse(end) && e.end > Date.parse(start))
  ),
  tasksList: vi.fn(async () => useTaskStore.getState().tasks),
  jobLog: vi.fn(async () => [])
}

let container: HTMLDivElement
let root: Root
let stopReports: () => void

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 15, 10, 24), toFake: ['Date'] })
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  useNoteStore.setState({
    notes: [summarizeNote(PLAN, '# 提案書の構成\n\n日程の案\n', 2), summarizeNote(TRIP, '# 旅行の持ち物\n\n充電器と傘\n', 1)],
    loaded: true,
    error: ''
  })
  useSettingsStore.setState({
    settings: {
      mail: { enabled: true, accounts: DEMO_MAIL_ACCOUNTS, defaultAccountId: 'demo-work', syncDays: 30, notifyNewMail: true },
      calendar: { enabled: true, readCalendarIds: ['work'], writeCalendarId: 'work' }
    } as AppSettings
  })
  useMailStore.setState({ status: demoMailStatus(DEMO_MAIL_MESSAGES), revision: 0, drafts: DEMO_MAIL_DRAFTS, draftsLoaded: true })
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  stopReports = startMiniAppReports()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  stopReports()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await act(async () => {})
}
async function show(view: React.FC<{ open: boolean }>): Promise<void> {
  await act(async () => root.render(React.createElement(view, { open: true })))
  await settle()
}
const reports = (): Array<MiniAppView | null> => reportMiniAppView.mock.calls.map(([view]) => view)
const lastReport = (): MiniAppView | null | undefined => reports().at(-1)

describe('the report of the open mini app', () => {
  it('reports once at the start, and nothing again until what is shown changes', () => {
    expect(reports()).toEqual([null])
    useViewStore.getState().closeApp()
    expect(reports()).toEqual([null])
  })

  it('follows the note the user selects, including the newest note shown in place of one the list does not have, and reports null on close', async () => {
    useViewStore.getState().openApp({ app: 'notes', noteId: TRIP })
    await show(NotesView)
    expect(container.querySelector('.my-doc-head h2')?.textContent).toBe('旅行の持ち物')
    expect(lastReport()).toEqual({ app: 'notes', noteId: TRIP, editing: false })

    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.my-item')][0].click())
    await settle()
    expect(lastReport()).toEqual({ app: 'notes', noteId: PLAN, editing: false })

    useViewStore.getState().openApp({ app: 'notes', noteId: 'missing' })
    await settle()
    expect(container.querySelector('.my-doc-head h2')?.textContent).toBe('提案書の構成')
    expect(lastReport()).toEqual({ app: 'notes', noteId: PLAN, editing: false })

    useViewStore.getState().closeApp()
    expect(lastReport()).toBeNull()
    for (const view of reports()) expect(openMiniAppSchema.parse(view)).toEqual(view)
  })

  it('opens a message in the reader, follows a switch of mail box, and reports a search term once the typing stops', async () => {
    const message = DEMO_MAIL_MESSAGES.find((m) => m.folder === 'inbox')!
    useViewStore.getState().openApp({ app: 'mail', messageId: message.id })
    await show(MailView)
    expect(container.querySelector('.ml-reader')?.textContent).toContain(message.subject)
    expect(lastReport()).toEqual({ app: 'mail', box: 'inbox', accountId: null, query: '', pane: { kind: 'message', id: message.id } })

    await act(async () => container.querySelectorAll<HTMLButtonElement>('.ml-view')[2].click())
    expect(container.querySelector('.ml-reader')).toBeNull()
    expect(lastReport()).toEqual({ app: 'mail', box: 'sent', accountId: null, query: '', pane: null })

    const before = reports().length
    const input = container.querySelector<HTMLInputElement>('.ml-search input')!
    for (const value of ['見', '見積', '見積書']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(reports()).toHaveLength(before)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(reports().slice(before)).toEqual([{ app: 'mail', box: 'sent', accountId: null, query: '見積書', pane: null }])
  })

  it('opens a draft in the composer on the drafts box, and closes the pane for a draft main does not have', async () => {
    useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[0].id })
    await show(MailView)
    expect(lastReport()).toMatchObject({ box: 'drafts', pane: { kind: 'draft', id: DEMO_MAIL_DRAFTS[0].id } })
    useViewStore.getState().openApp({ app: 'mail', draftId: 'missing' })
    await settle()
    expect(lastReport()).toMatchObject({ box: 'drafts', pane: null })
  })

  it('places the calendar on the day with the event open, follows the arrows, and moves to an event outside the range', async () => {
    useViewStore.getState().openApp({ app: 'calendar', view: 'week', date: '2026-09-15', eventId: review.id })
    await show(CalendarView)
    expect(container.querySelector('.cal-pop.is-event')?.textContent).toContain(review.title)
    expect(lastReport()).toEqual({ app: 'calendar', view: 'week', date: '2026-09-15', eventId: review.id })

    await act(async () => container.querySelectorAll<HTMLButtonElement>('.cal-arrow')[1].click())
    await settle()
    expect(container.querySelector('.cal-pop.is-event')).toBeNull()
    expect(lastReport()).toEqual({ app: 'calendar', view: 'week', date: '2026-09-22', eventId: null })

    useViewStore.getState().openApp({ app: 'calendar', eventId: release.id })
    await settle(10)
    expect(lastReport()).toEqual({ app: 'calendar', view: 'week', date: '2026-10-20', eventId: release.id })
    expect(container.querySelector('.cal-pop.is-event')?.textContent).toContain(release.title)

    useViewStore.getState().openApp({ app: 'calendar', view: 'month', eventId: 'missing' })
    await settle(10)
    expect(lastReport()).toEqual({ app: 'calendar', view: 'month', date: '2026-10-20', eventId: null })
    expect(container.querySelector('.cal-pop.is-event')).toBeNull()
  })

  it('closes the task editor for a task the list does not have, and shows the newest job in place of an unknown one', async () => {
    useTaskStore.setState({ tasks: [], loaded: true, error: '' })
    useViewStore.getState().openApp({ app: 'tasks', view: 'list', taskId: 'missing' })
    await show(TasksView)
    expect(lastReport()).toEqual({ app: 'tasks', view: 'list', taskId: null })

    await act(async () => root.render(React.createElement('div')))
    useJobStore.setState({ jobs: [job('new', 2), job('old', 1)], logs: {} })
    useViewStore.getState().openApp({ app: 'jobs', jobId: 'missing' })
    await show(JobsView)
    expect(lastReport()).toEqual({ app: 'jobs', jobId: 'new' })
  })
})
