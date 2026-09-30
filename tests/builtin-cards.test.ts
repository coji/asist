// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { AppTimer, JobDiff, PanelSpec } from '@shared/ipc'
import type { FileItem } from '@shared/files'
import { dayKeyOf, type Task, type TaskStatus } from '@shared/tasks'
import { usePanelStore, useJobStore, useMailStore, useNoteStore, useSettingsStore, useTaskStore, useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { useConfirmStore } from '@/state/confirm'
import type { AppSettings } from '@shared/settings'
import { DEMO_MAIL_ACCOUNTS } from '@/demo/fixtures/mail'
import { Dock } from '@/ui/Dock'
import { FocusOverlay } from '@/ui/FocusOverlay'
import { CARD_SIZE_MIN_HEIGHT } from '@/panels/shell/card'
import { summarizeNote } from '@shared/notes'
import { tableAmounts } from '@/panels/builtin/fx'
import { diffLabel, offsetMinutes, phaseOf, zoned } from '@/panels/builtin/clock'
import { remainingText } from '@/panels/builtin/timer'
import { elapsedLabel } from '@/panels/builtin/agent-job'
import { relativeDayLabel, relativeTime } from '@/panels/primitives/format'
import { DEMO_CALENDAR_CARD } from '@/demo/fixtures/calendar'
import { DEMO_FX } from '@/demo/fixtures/finance'
import { DEMO_JOB, DEMO_JOB_LOG, DEMO_JOBS } from '@/demo/fixtures/jobs'
import { DEMO_FILES_DIR, DEMO_IMAGE_PATHS, DEMO_MIXED_PATHS, DEMO_REPORT_MD, demoFileItems } from '@/demo/fixtures/files'
import { DEMO_MAIL_CARD, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGE_CARD } from '@/demo/fixtures/mail'
import { DEMO_NEWS, DEMO_SEARCH, DEMO_SEARCH_GOOGLE } from '@/demo/fixtures/reading'
import { DEMO_CLOCKS } from '@/demo/fixtures/time'

/**
 * These tests cover what each built-in card folds away per size, how it leads to the focus view, the actions it
 * performs and the calculations behind what it shows. Every card is rendered through the shell (Dock), so it receives
 * the size the shell hands it rather than one the test picks.
 */

const t = createTranslator('ja-JP')
const sendTypedMessage = vi.fn()
vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/conversation', () => ({ sendTypedMessage: (text: string) => sendTypedMessage(text) }))
vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children),
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(
        ({ initial, animate, exit, transition, layout, ...props }, ref) => createElement('div', { ...props, ref })
      )
    }
  }
})

type Observer = { callback: (entries: Array<{ target: Element; contentRect: { height: number } }>) => void; targets: Element[] }
const observers: Observer[] = []
class FakeResizeObserver {
  private readonly entry: Observer
  constructor(callback: Observer['callback']) {
    this.entry = { callback, targets: [] }
    observers.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.targets.push(target)
  }
  disconnect(): void {
    this.entry.targets.length = 0
  }
}

let container: HTMLDivElement
let root: Root
const taskOf = (id: string, title: string, status: TaskStatus, order: number, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  notes: '',
  status,
  due: null,
  order,
  createdAt: Date.now() - 60_000 * (order + 1),
  updatedAt: Date.now(),
  completedAt: status === 'done' ? Date.now() : null,
  ...patch
})
const api = {
  openExternal: vi.fn(async () => {}),
  timerList: vi.fn(async (): Promise<AppTimer[]> => []),
  timerCancel: vi.fn(async () => true),
  onTimerEvent: vi.fn(() => () => {}),
  tasksList: vi.fn(async (): Promise<Task[]> => []),
  taskCreate: vi.fn(async (input: { title: string }): Promise<Task> => taskOf('new', input.title, 'todo', 0)),
  taskUpdate: vi.fn(async (id: string): Promise<Task> => taskOf(id, id, 'done', 0)),
  notesList: vi.fn(async () => []),
  jobLog: vi.fn(async () => []),
  jobDiff: vi.fn(async (): Promise<JobDiff> => ({ commit: 'abc', base: 'a0c', into: 'main', stat: '1 file changed', patch: '', submodules: [], blocked: null })),
  jobMerge: vi.fn(async () => {}),
  jobDiscard: vi.fn(async () => {}),
  jobDiscardPreview: vi.fn(async () => ({ repo: '/r', dir: '/w', branch: 'asist/x', stat: '', submodules: [] as string[] })),
  panelFetch: vi.fn(async (_type: string, props: Record<string, unknown>) => ({ props: { ...props, items: demoFileItems(props.paths as string[]) }, source: 'files' })),
  mailDraftList: vi.fn(async () => DEMO_MAIL_DRAFTS),
  mailDraftUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...DEMO_MAIL_DRAFTS.find((d) => d.id === id)!, ...patch })),
  mailDraftRemove: vi.fn(async () => {}),
  mailDraftSend: vi.fn(async () => ({ saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '田中' }) }))
}

const spec = (type: string, props: Record<string, unknown>, patch: Partial<PanelSpec> = {}): PanelSpec => ({
  key: `${type}:test`,
  type,
  slot: 'right',
  state: 'ready',
  props,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...patch
})

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('window', Object.assign(window, { api }))
  observers.length = 0
  for (const fn of Object.values(api)) fn.mockClear()
  api.jobLog.mockResolvedValue([])
  sendTypedMessage.mockClear()
  usePanelStore.setState({ panels: [], focusedKey: null })
  useJobStore.setState({ jobs: [], logs: {} })
  useTaskStore.setState({ tasks: [], loaded: true, error: '' })
  useNoteStore.setState({ notes: [], loaded: true, error: '' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Renders the card through the shell, reports the given dock height, and returns the card element. */
async function renderAt(panel: PanelSpec, height: number): Promise<HTMLElement> {
  await act(async () => {
    usePanelStore.setState({ panels: [panel], focusedKey: null })
    root.render(React.createElement(Dock, { slot: 'right' }))
  })
  const dock = container.querySelector<HTMLElement>('.dock')!
  await act(async () => {
    for (const observer of observers) {
      if (observer.targets.includes(dock)) observer.callback([{ target: dock, contentRect: { height } }])
    }
  })
  return dock.querySelector<HTMLElement>('.panel-card')!
}
const L = CARD_SIZE_MIN_HEIGHT.l
const S = 0

describe('cards with a list keep fewer rows at size s and turn the rest into a link to the focus view', () => {
  it.each([
    ['news', DEMO_NEWS, 6, 4],
    ['search-results', DEMO_SEARCH, 5, 3],
    ['calendar', DEMO_CALENDAR_CARD, 6, 4],
    ['mail', DEMO_MAIL_CARD, 8, 4]
  ] as const)('%s', async (type, props, total, shownInS) => {
    const large = await renderAt(spec(type, props as unknown as Record<string, unknown>), L)
    expect(large.querySelectorAll('.card-row').length).toBeGreaterThanOrEqual(Math.min(total, 4))
    const small = await renderAt(spec(type, props as unknown as Record<string, unknown>), S)
    expect(small.querySelectorAll('.card-row')).toHaveLength(shownInS)
    const more = small.querySelector<HTMLButtonElement>('.card-more')!
    expect(more.textContent).toContain(t('common.more', { count: total - shownInS }))
    await act(async () => more.click())
    expect(usePanelStore.getState().focusedKey).toBe(`${type}:test`)
  })

  it('shows the snippet of a search result at size l and leaves it out at size s', async () => {
    const large = await renderAt(spec('search-results', DEMO_SEARCH), L)
    expect(large.querySelector('.sr-snippet')?.textContent).toContain('認識の部分結果')
    const small = await renderAt(spec('search-results', DEMO_SEARCH), S)
    expect(small.querySelector('.sr-snippet')).toBeNull()
  })
})

describe('actions on a news or search result row', () => {
  it('opens the headline in the browser, and asks the assistant about it through the bubble button', async () => {
    const card = await renderAt(spec('news', DEMO_NEWS), L)
    await act(async () => card.querySelector<HTMLButtonElement>('.card-row-link')!.click())
    expect(api.openExternal).toHaveBeenCalledWith(DEMO_NEWS.items[0].url)
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="この見出しについて聞く"]')!.click())
    expect(sendTypedMessage).toHaveBeenCalledWith(expect.stringContaining(DEMO_NEWS.items[0].title))
  })
})

describe('a search answered by Gemini', () => {
  it('names the site once, says which sources the answer cites, and shows the Search Suggestions unchanged in a shadow root', async () => {
    const card = await renderAt(spec('search-results', DEMO_SEARCH_GOOGLE), L)
    const rows = [...card.querySelectorAll<HTMLElement>('.card-row')]
    // The title of a Gemini source is its domain, so the meta line does not repeat it and never shows the redirect's host.
    expect(rows[0].querySelector('.card-row-title')?.textContent).toBe('example.com')
    expect(rows[0].querySelector('.card-row-meta')?.textContent).toBe(t('cardsInfo.search.cited'))
    expect(rows[2].querySelector('.card-row-meta')).toBeNull()
    expect(card.textContent).not.toContain('vertexaisearch')
    const host = card.querySelector<HTMLElement>('.sr-suggestions')!
    const asGiven = document.createElement('div')
    asGiven.innerHTML = DEMO_SEARCH_GOOGLE.suggestions
    expect(host.shadowRoot!.innerHTML).toBe(asGiven.innerHTML)
    const chip = host.shadowRoot!.querySelector<HTMLAnchorElement>('a.chip')!
    await act(async () => chip.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })))
    expect(api.openExternal).toHaveBeenCalledWith(chip.href)
  })

  it('leaves the block out of a search that has none', async () => {
    const card = await renderAt(spec('search-results', DEMO_SEARCH), L)
    expect(card.querySelector('.sr-suggestions')).toBeNull()
  })
})

describe('calendar card', () => {
  it('puts the next event at the top, dims the events that are over, and draws the now line before the next event', async () => {
    const card = await renderAt(spec('calendar', DEMO_CALENDAR_CARD), L)
    expect(card.querySelector('.card-note')?.textContent).toContain('次は')
    expect(card.querySelector('.card-note')?.textContent).toContain('ランチ 田中さん')
    const rows = [...card.querySelectorAll<HTMLElement>('.card-rows > li')]
    const past = rows.filter((row) => row.dataset.past !== undefined)
    expect(past.map((row) => row.textContent)).toEqual([expect.stringContaining('定例')])
    const nowIndex = rows.findIndex((row) => row.classList.contains('ca-now'))
    const lunchIndex = rows.findIndex((row) => row.textContent?.includes('ランチ'))
    expect(nowIndex).toBe(lunchIndex - 1)
    expect(rows.find((row) => row.textContent?.includes('レビュー'))?.dataset.current).toBe('true')
  })

  it('leaves out the now line, the remaining count and the next-event note for a single day other than today, and shows the distance from today', async () => {
    const day = 86_400_000
    const today = new Date().setHours(0, 0, 0, 0)
    const at = (offset: number, hour: number): number => today + offset * day + hour * 3_600_000
    const ahead = await renderAt(
      spec('calendar', {
        range: 'custom',
        fromMs: today + 3 * day,
        untilMs: today + 4 * day,
        events: [{ title: '技術コンサル', start: at(3, 12), end: at(3, 13), allDay: false }]
      }),
      L
    )
    expect(ahead.querySelector('.ca-now')).toBeNull()
    expect(ahead.querySelector('.card-box h4 small')).toBeNull()
    expect(ahead.querySelector('.card-note')?.textContent).toContain(t('calendar.card.first', { when: '12:00', title: '技術コンサル' }))
    expect(ahead.querySelector('.card-hero p')?.textContent).toBe(t('cardsTime.inDays', { count: 3 }))

    const behind = await renderAt(
      spec('calendar', {
        range: 'custom',
        fromMs: today - day,
        untilMs: today,
        events: [{ title: '済んだ打合せ', start: at(-1, 10), end: at(-1, 11), allDay: false }]
      }),
      L
    )
    expect(behind.querySelector('.ca-now')).toBeNull()
    expect(behind.querySelector('.card-hero p')?.textContent).toBe(t('cardsTime.yesterday'))
    expect(behind.querySelector<HTMLElement>('.ca-event')?.dataset.past).toBeUndefined()
  })

  it('shows a range of one day as that day when daylight saving time makes the day 25 hours long', async () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const fromMs = new Date(2026, 10, 1).getTime()
      const card = await renderAt(spec('calendar', { range: 'custom', fromMs, untilMs: new Date(2026, 10, 2).getTime(), events: [] }), L)
      expect(card.querySelector('.card-hero p')?.textContent).toBe(relativeDayLabel(fromMs))
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('shows the empty state when there is no event, and gives the week list one heading per day', async () => {
    const empty = await renderAt(spec('calendar', { range: 'today', events: [] }), L)
    expect(empty.querySelector('.card-empty')?.textContent).toContain(t('calendar.card.empty'))
    expect(empty.querySelector('.card-note')?.textContent).toContain(t('calendar.card.free', { subject: t('calendar.card.subject.today') }))

    const day = 86_400_000
    const week = await renderAt(
      spec('calendar', {
        range: 'week',
        events: [
          { title: 'A', start: Date.now() + day, allDay: false },
          { title: 'B', start: Date.now() + 2 * day, allDay: false }
        ]
      }),
      L
    )
    expect(week.querySelectorAll('.ca-day')).toHaveLength(2)
    expect(week.querySelector('.ca-now')).toBeNull()
  })
})

describe('todo and notes cards', () => {
  it('saves a typed entry through main, lists the tasks in progress first, and shows the due date as a chip', async () => {
    const today = dayKeyOf(new Date())
    useTaskStore.setState({
      loaded: true,
      tasks: [taskOf('a', '牛乳を買う', 'todo', 0, { due: '2000-01-01' }), taskOf('b', 'レビュー', 'doing', 0, { due: today }), taskOf('c', '済み', 'done', 0)]
    })
    const card = await renderAt(spec('todo', {}), L)
    expect([...card.querySelectorAll('.card-row-title')].map((el) => el.textContent)).toEqual(['レビュー', '牛乳を買う'])
    expect(card.querySelector('.card-note')?.textContent).toBe(`${t('tasks.card.dueToday', { count: 1 })} · ${t('tasks.card.overdue', { count: 1 })}`)
    expect(card.querySelector('.td-item[data-status="doing"] .tk-due')?.getAttribute('data-state')).toBe('today')
    const input = card.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      // React tracks changes through its own value setter, so the native setter writes the value before the event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '歯医者の予約')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => card.querySelector<HTMLButtonElement>('.card-input .card-action')!.click())
    expect(api.taskCreate).toHaveBeenCalledWith({ title: '歯医者の予約' })
    expect(input.value).toBe('')
  })

  it('completes a task when its circle is pressed, keeps four at size s with the rest in the focus view, and opens the task screen from the organize button', async () => {
    useTaskStore.setState({ loaded: true, tasks: Array.from({ length: 6 }, (_, i) => taskOf(`t${i}`, `タスク${i}`, 'todo', i)) })
    const card = await renderAt(spec('todo', {}), S)
    expect(card.querySelectorAll('.td-item')).toHaveLength(4)
    expect(card.querySelector('.card-more')?.textContent).toContain(t('common.more', { count: 2 }))
    await act(async () => card.querySelector<HTMLButtonElement>(`[aria-label="${t('tasks.card.markDone')}"]`)!.click())
    expect(api.taskUpdate).toHaveBeenCalledWith('t0', { status: 'done' })
    await act(async () => [...card.querySelectorAll<HTMLButtonElement>('.card-action')].find((b) => b.textContent?.includes(t('tasks.card.openWorkspace')))!.click())
    expect(useViewStore.getState().open?.app).toBe('tasks')
  })

  it('says the tasks could not be read rather than that there are none, and reads them again on retry', async () => {
    useTaskStore.setState({ tasks: [], loaded: false, error: '' })
    // A stored task that breaks the schema is reported with the reason the schema gave, which is an error of its own.
    const reason = errorText('tasks.errors.titleTooLong', { limit: 200 })
    api.tasksList.mockRejectedValueOnce(new Error(errorText('tasks.errors.storeItemBroken', { index: 3, message: reason })))
    const card = await renderAt(spec('todo', {}), L)
    await act(async () => {})
    expect(card.textContent).not.toContain(t('tasks.card.empty'))
    expect(card.querySelector('.card-empty')?.textContent).toContain(t('tasks.card.loadFailed'))
    expect(card.querySelector('.card-empty')?.textContent).toContain(
      t('tasks.errors.storeItemBroken', { index: 3, message: t('tasks.errors.titleTooLong', { limit: 200 }) })
    )
    api.tasksList.mockResolvedValueOnce([taskOf('a', '牛乳を買う', 'todo', 0)])
    await act(async () => [...card.querySelectorAll<HTMLButtonElement>('.card-action')].find((b) => b.textContent === t('common.retry'))!.click())
    expect([...card.querySelectorAll('.card-row-title')].map((el) => el.textContent)).toEqual(['牛乳を買う'])
  })

  it('redraws when main delivers the full list it has saved', async () => {
    const card = await renderAt(spec('todo', {}), L)
    expect(card.querySelector('.card-empty')).not.toBeNull()
    await act(async () => useTaskStore.getState().apply([taskOf('x', '配信された項目', 'todo', 0)]))
    expect(card.textContent).toContain('配信された項目')
  })

  it('marks the note add_note just wrote, keeps three at size s with the rest in the focus view, and opens a pressed note in the notes screen', async () => {
    const ids = ['20260923-090000-0001', '20260923-080000-0002', '20260923-070000-0003', '20260923-060000-0004']
    useNoteStore.setState({ notes: ids.map((id, i) => summarizeNote(id, `# メモ${i}\n\n本文${i}\n`, 4 - i)) })
    const card = await renderAt(spec('notes', { focusId: ids[1] }), S)
    expect([...card.querySelectorAll('.nt-item .card-row-title')].map((el) => el.textContent)).toEqual(['メモ0', 'メモ1', 'メモ2'])
    expect(card.querySelector('.nt-item[data-new] .card-row-title')?.textContent).toBe('メモ1')
    expect(card.querySelector('.card-more')?.textContent).toContain(t('common.more', { count: 1 }))
    await act(async () => card.querySelectorAll<HTMLButtonElement>('.nt-open')[2].click())
    expect(useViewStore.getState().open).toEqual({ app: 'notes', noteId: ids[2], editing: false })
  })

  it('says the notes could not be read rather than that there are none, and reads them again on retry', async () => {
    useNoteStore.setState({ notes: [], loaded: false, error: '' })
    const denied = "EACCES: permission denied, scandir '/Users/me/Library/Application Support/ASIST/notes'"
    api.notesList.mockRejectedValueOnce(new Error(`Error invoking remote method 'notes-list': Error: ${denied}`))
    const card = await renderAt(spec('notes', {}), L)
    await act(async () => {})
    expect(card.textContent).not.toContain(t('notes.card.emptyList'))
    expect(card.querySelector('.card-empty')?.textContent).toContain(t('notes.card.loadFailed'))
    expect(card.querySelector('.card-empty')?.textContent).toContain(denied)
    api.notesList.mockResolvedValueOnce([summarizeNote('20260923-090000-0001', '# 買い物\n', 1)])
    await act(async () => [...card.querySelectorAll<HTMLButtonElement>('.card-action')].find((b) => b.textContent === t('common.retry'))!.click())
    expect([...card.querySelectorAll('.nt-item .card-row-title')].map((el) => el.textContent)).toEqual(['買い物'])
  })

  it('redraws when main delivers the notes it has written', async () => {
    const card = await renderAt(spec('notes', {}), L)
    expect(card.querySelector('.card-empty')).not.toBeNull()
    await act(async () => useNoteStore.getState().apply([summarizeNote('20260923-090000-00aa', '# 配信されたメモ\n', 1)]))
    expect(card.textContent).toContain('配信されたメモ')
  })
})

describe('timer card', () => {
  it('counts down the timer it reads from main, and on stop deletes it in main before closing the card', async () => {
    const endsAt = Date.now() + 90_000
    api.timerList.mockResolvedValueOnce([
      { id: 'timer:test', label: 'パスタ', seconds: 180, createdAt: endsAt - 180_000, endsAt, status: 'active' }
    ])
    const card = await renderAt(spec('timer', { seconds: 180, label: 'パスタ' }), L)
    expect(card.querySelector('h3')?.textContent).toBe('パスタ')
    expect(card.querySelector('.card-big time')?.textContent).toMatch(/^01:(29|30)$/)
    expect(card.querySelector('.tm-ring')).not.toBeNull()
    await act(async () => card.querySelector<HTMLButtonElement>('.card-action')!.click())
    expect(api.timerCancel).toHaveBeenCalledWith('timer:test')
    expect(usePanelStore.getState().panels).toHaveLength(0)
  })

  it('shows that the time is up and a close button once the timer is over, and draws no ring at size s', async () => {
    api.timerList.mockResolvedValueOnce([
      { id: 'timer:test', label: '茶', seconds: 60, createdAt: Date.now() - 61_000, endsAt: Date.now() - 1000, status: 'finished' }
    ])
    const card = await renderAt(spec('timer', { seconds: 60, label: '茶' }), S)
    expect(card.querySelector('.card-big time')?.textContent).toBe(t('cardsTime.timer.done'))
    expect(card.querySelector('.card-action')?.textContent).toBe(t('common.close'))
    expect(card.querySelector('.tm-ring')).toBeNull()
  })

  it('says so when main has no such timer', async () => {
    const card = await renderAt(spec('timer', { seconds: 60 }), L)
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(t('cardsTime.timer.notRunning'))
  })
})

describe('agent job card', () => {
  it('shows the tail of the log while the job runs, cut to six rows at size s', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ t: i, event: { kind: 'assistant-text' as const, text: `行${i}` } }))
    api.jobLog.mockResolvedValue(lines as never)
    useJobStore.setState({ jobs: [DEMO_JOB], logs: {} })
    const large = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect(large.querySelectorAll('.aj-log > .jl-row')).toHaveLength(10)
    expect(large.querySelector('.aj-stop')).not.toBeNull()
    const small = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), S)
    const shown = [...small.querySelectorAll('.aj-log > .jl-row')].map((el) => el.textContent)
    expect(shown).toEqual(['行4', '行5', '行6', '行7', '行8', '行9'])
  })

  it('folds each command into a single row while the job runs and puts the command in flight at the top', async () => {
    api.jobLog.mockResolvedValue(DEMO_JOB_LOG.map((event) => ({ t: 1, event })) as never)
    useJobStore.setState({ jobs: [DEMO_JOB], logs: {} })
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    const rows = [...card.querySelectorAll('.aj-log > .jl-row')]
    // A command that emits a start and an end event becomes one row, and consecutive Reads become one row.
    expect(rows.filter((el) => el.getAttribute('data-kind') === 'command')).toHaveLength(3)
    expect(rows.find((el) => el.getAttribute('data-kind') === 'tool')?.textContent).toContain('Read ×2')
    expect(card.querySelector('.jl-row[data-status="error"] .jl-exit')?.textContent).toBe('exit 1')
    expect(card.querySelector('.aj-step')?.textContent).toContain('wc -l README_en.md')
  })

  it('shows only the diff and the merge and discard box while the job waits to be merged, without the summary or the log', async () => {
    useJobStore.setState({
      jobs: [{ ...DEMO_JOB, status: 'done', endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'pending', worktree: { repo: '/r', branch: 'asist/x', base: 'main' }, summary: '英訳を保存しました', numTurns: 4, costUsd: 0.12 }],
      logs: { [DEMO_JOB.id]: DEMO_JOB_LOG.map((event) => ({ t: 1, event })) }
    })
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect(card.getAttribute('data-panel-type')).toBe('agent-job')
    expect(card.querySelector('.aj')?.getAttribute('data-phase')).toBe('merge')
    expect(api.jobDiff).toHaveBeenCalledWith(DEMO_JOB.id)
    expect(card.querySelector('.aj-diff')?.textContent).toContain('1 file changed')
    expect(card.querySelector('.aj-path')?.textContent).toBe(t('jobs.card.merge.path', { branch: 'asist/x', into: 'main', repo: '/r' }))
    await act(async () => card.querySelector<HTMLButtonElement>('.aj-merge .card-action')!.click())
    expect(api.jobMerge).toHaveBeenCalledWith(DEMO_JOB.id, { commit: 'abc', base: 'a0c', into: 'main' })
    expect(card.querySelector('.aj-summary')).toBeNull()
    expect(card.querySelector('.aj-log')).toBeNull()
    expect(card.querySelector('.card-hero p')?.textContent).toContain('1分05秒で完了')
  })

  it('offers no merge for a job that touched submodules, says why and where its commits are, and asks before discarding them', async () => {
    useConfirmStore.setState({ queue: [] })
    useJobStore.setState({
      jobs: [{ ...DEMO_JOB, status: 'done', endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'pending', worktree: { repo: '/r', dir: '/w', branch: 'asist/x', base: 'main', submodules: ['vendor/sub'] } }],
      logs: {}
    })
    const touched: JobDiff = {
      commit: 'abc',
      base: 'a0c',
      into: 'main',
      stat: ' vendor/sub | 2 +-',
      patch: '',
      submodules: ['vendor/sub'],
      blocked: errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch: 'asist/x', dir: '/w' })
    }
    api.jobDiff.mockResolvedValueOnce(touched).mockResolvedValueOnce(touched)
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect(card.querySelector('.aj-merge')?.textContent).toContain(t('jobs.merging.submodules', { paths: 'vendor/sub', branch: 'asist/x', dir: '/w' }))
    const [merge, discard] = [...card.querySelectorAll<HTMLButtonElement>('.aj-merge .card-action')]
    expect(merge.textContent).toBe(t('jobs.card.merge.merge'))
    await act(async () => merge.click())
    expect(api.jobMerge).not.toHaveBeenCalled()

    api.jobDiscardPreview.mockResolvedValueOnce({ repo: '/r', dir: '/w', branch: 'asist/x', stat: '', submodules: ['vendor/sub'] })
    await act(async () => discard.click())
    const [question] = useConfirmStore.getState().queue
    expect(question).toMatchObject({ destructive: true, detail: t('jobs.discard.submoduleWork', { paths: 'vendor/sub' }) })
    expect(api.jobDiscard).not.toHaveBeenCalled()
    await act(async () => question.resolve!(true))
    expect(api.jobDiscard).toHaveBeenCalledWith(DEMO_JOB.id)
    useConfirmStore.setState({ queue: [] })
  })

  it('merges nothing while the repository is not on a branch and says why, and offers the merge into the branch once one is checked out', async () => {
    useJobStore.setState({
      jobs: [{ ...DEMO_JOB, status: 'done', endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'pending', worktree: { repo: '/r', dir: '/w', branch: 'asist/x', base: 'main' } }],
      logs: {}
    })
    const detached: JobDiff = { commit: 'abc', base: 'a0c', into: null, stat: '1 file changed', patch: '', submodules: [], blocked: errorText('jobs.merging.detached') }
    api.jobDiff.mockResolvedValueOnce(detached).mockResolvedValueOnce(detached)
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect(card.querySelector('.aj-merge')?.textContent).toContain(t('jobs.merging.detached'))
    const merge = (): Promise<void> =>
      act(async () => [...card.querySelectorAll<HTMLButtonElement>('.aj-merge .card-action')].find((el) => el.textContent === t('jobs.card.merge.merge'))!.click())
    await merge()
    expect(api.jobMerge).not.toHaveBeenCalled()
    expect(card.querySelector('.aj-merge')?.textContent).toContain(t('jobs.merging.detached'))

    // The user checks out a branch outside ASIST. The first press shows where the merge now goes, the next one merges.
    await merge()
    expect(api.jobMerge).not.toHaveBeenCalled()
    expect(card.querySelector('.aj-path')?.textContent).toBe(t('jobs.card.merge.path', { branch: 'asist/x', into: 'main', repo: '/r' }))
    expect(card.querySelector('.aj-merge')?.textContent).not.toContain(t('jobs.merging.detached'))
    await merge()
    expect(api.jobMerge).toHaveBeenCalledWith(DEMO_JOB.id, { commit: 'abc', base: 'a0c', into: 'main' })
  })

  it('shows the current diff beside the reason when main refuses a merge because the repository moved to another branch', async () => {
    useJobStore.setState({
      jobs: [{ ...DEMO_JOB, status: 'done', endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'pending', worktree: { repo: '/r', dir: '/w', branch: 'asist/x', base: 'main' } }],
      logs: {}
    })
    api.jobMerge.mockRejectedValueOnce(new Error(errorText('jobs.merging.baseChanged')))
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    api.jobDiff
      .mockResolvedValueOnce({ commit: 'abc', base: 'a0c', into: 'main', stat: '1 file changed', patch: '', submodules: [], blocked: null })
      .mockResolvedValueOnce({ commit: 'abc', base: 'b1d', into: 'main', stat: '2 files changed', patch: '', submodules: [], blocked: null })
    await act(async () => card.querySelector<HTMLButtonElement>('.aj-merge .card-action')!.click())
    expect(api.jobDiff).toHaveBeenCalledTimes(3)
    expect(card.querySelector('.aj-diff')?.textContent).toContain('2 files changed')
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(t('jobs.merging.baseChanged'))
  })

  it('asks before discarding a job whose settling failed when main finds possible work in its submodules', async () => {
    useConfirmStore.setState({ queue: [] })
    useJobStore.setState({
      jobs: [{ ...DEMO_JOB, status: 'done', endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'error', worktree: { repo: '/r', dir: '/w', branch: 'asist/x', base: 'main' } }],
      logs: {}
    })
    api.jobDiscardPreview.mockResolvedValueOnce({ repo: '/r', dir: '/w', branch: 'asist/x', stat: '', submodules: ['vendor/sub'] })
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    const discard = [...card.querySelectorAll<HTMLButtonElement>('.aj-merge .card-action')].find((el) => el.textContent === t('jobs.card.merge.discard'))!
    await act(async () => discard.click())
    const [question] = useConfirmStore.getState().queue
    expect(question).toMatchObject({ destructive: true, detail: t('jobs.discard.submoduleWork', { paths: 'vendor/sub' }) })
    await act(async () => question.resolve!(false))
    expect(api.jobDiscard).not.toHaveBeenCalled()
    useConfirmStore.setState({ queue: [] })
  })

  it('offers only discarding a job whose merge conflicted, without showing an error for a diff it cannot merge', async () => {
    // main refuses a merge review for any job not waiting to be merged, as it does for this one.
    api.jobDiff.mockRejectedValueOnce(new Error(errorText('jobs.worktree.reviewStale')))
    const conflicted = { ...DEMO_JOB, status: 'done' as const, endedAt: DEMO_JOB.startedAt + 65_000, mergeState: 'conflict' as const, worktree: { repo: '/r', dir: '/w', branch: 'asist/x', base: 'main' } }
    useJobStore.setState({ jobs: [conflicted], logs: {} })
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect(card.querySelector('.aj')?.getAttribute('data-phase')).toBe('merge')
    expect(card.querySelector('[role="alert"]')).toBeNull()
    expect([...card.querySelectorAll('.aj-merge .card-action')].map((el) => el.textContent)).toEqual([t('jobs.card.merge.discard')])
    await act(async () => card.querySelector<HTMLButtonElement>('.aj-merge .card-action')!.click())
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(api.jobDiscard).toHaveBeenCalledWith(DEMO_JOB.id)
  })

  it('reads the whole log from main when the card appears, even when a line of it already arrived as an event', async () => {
    const lines = Array.from({ length: 4 }, (_, i) => ({ t: i, event: { kind: 'assistant-text' as const, text: `行${i}` } }))
    api.jobLog.mockResolvedValue(lines as never)
    useJobStore.setState({ jobs: [DEMO_JOB], logs: { [DEMO_JOB.id]: lines.slice(-1) } })
    const card = await renderAt(spec('agent-job', { jobId: DEMO_JOB.id }), L)
    expect([...card.querySelectorAll('.aj-log > .jl-row')].map((el) => el.textContent)).toEqual(['行0', '行1', '行2', '行3'])
  })

  it('shows the summary, the artifacts and the number of turns once the job is done, and opens a files card that fetches the contents when an artifact is pressed', async () => {
    const done = DEMO_JOBS.find((job) => job.id === 'demo-job-done')!
    useJobStore.setState({ jobs: [done], logs: {} })
    const card = await renderAt(spec('agent-job', { jobId: done.id }), L)
    expect(card.querySelector('.aj')?.getAttribute('data-phase')).toBe('done')
    expect(card.querySelector('.aj-summary')?.textContent).toContain('主要3社')
    expect(card.querySelector('.aj-cost')?.textContent).toBe('14ターン · $0.620')
    expect(card.querySelector('.aj-log')).toBeNull()
    const artifacts = [...card.querySelectorAll<HTMLButtonElement>('.aj-artifact .card-row-link')]
    expect(artifacts.map((el) => el.querySelector('.card-row-title')?.textContent)).toEqual(['report.md', 'pricing.csv', 'interview.md'])
    await act(async () => artifacts[1].click())
    // All artifacts go into a single files card, with the one that was pressed already selected.
    expect(api.panelFetch).toHaveBeenCalledWith('files', { paths: done.artifacts, title: done.title, selected: 1 })
    const files = usePanelStore.getState().panels.find((panel) => panel.type === 'files')
    expect(files).toMatchObject({ key: `files:${done.artifacts!.join('|')}`, state: 'ready', props: { selected: 1, items: expect.arrayContaining([expect.objectContaining({ name: 'report.md', kind: 'markdown' })]) } })
    const small = await renderAt(spec('agent-job', { jobId: done.id }), S)
    expect(small.querySelector('.aj-artifact')).toBeNull()
  })

  it('shows the reason and the tail of the log when the job failed', async () => {
    const failed = DEMO_JOBS.find((job) => job.id === 'demo-job-failed')!
    api.jobLog.mockResolvedValue(DEMO_JOB_LOG.map((event) => ({ t: 1, event })) as never)
    useJobStore.setState({ jobs: [failed], logs: {} })
    const card = await renderAt(spec('agent-job', { jobId: failed.id }), L)
    expect(card.querySelector('.aj')?.getAttribute('data-phase')).toBe('failed')
    expect(card.querySelector('.aj-failed .aj-summary')?.textContent).toContain('rate limit')
    expect(card.querySelectorAll('.aj-log > .jl-row')).toHaveLength(6)
    expect(card.querySelector('.aj-step')).toBeNull()
  })
})

describe('files card', () => {
  const filesSpec = (paths: string[], title?: string, selected?: number): PanelSpec =>
    spec('files', { paths, ...(title ? { title } : {}), ...(selected === undefined ? {} : { selected }), items: demoFileItems(paths) })

  it('renders a single markdown file as a document with headings, tables, code and lists, in smaller type at size s', async () => {
    const card = await renderAt(filesSpec([`${DEMO_FILES_DIR}/report.md`], '調査レポート'), L)
    expect(card.querySelector('.fl')?.getAttribute('data-layout')).toBe('single')
    expect(card.querySelector('.card-hero h3')?.textContent).toBe('調査レポート')
    const doc = card.querySelector('.fv-doc')!
    expect(doc.querySelector('h1')?.textContent).toBe('競合サービスの比較')
    expect(doc.querySelectorAll('table th')).toHaveLength(5)
    expect(doc.querySelector('pre code')?.textContent).toContain('curl')
    expect(doc.querySelectorAll('ol li')).toHaveLength(3)
    expect(doc.querySelectorAll('input[type="checkbox"]')).toHaveLength(3)
    expect(doc.querySelector('strong')?.textContent).toContain('同時接続数')
    expect(doc.textContent).not.toContain('**')
    await act(async () => doc.querySelector<HTMLAnchorElement>('a')!.click())
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/pricing')
    const small = await renderAt(filesSpec([`${DEMO_FILES_DIR}/report.md`]), S)
    expect(small.querySelector('.fl')?.getAttribute('data-size')).toBe('s')
    expect(small.querySelector('.card-hero h3')?.textContent).toBe('report.md')
  })

  it('renders a csv as a table and right-aligns the numeric columns', async () => {
    const card = await renderAt(filesSpec([`${DEMO_FILES_DIR}/pricing.csv`]), L)
    const table = card.querySelector('.fv-table')!
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['サービス', '月額(USD)', '同時接続', '無料枠', '更新日'])
    expect(table.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(table.querySelector('tbody td:nth-child(2)')?.getAttribute('data-numeric')).toBe('true')
    expect(table.querySelector('tbody td:nth-child(1)')?.getAttribute('data-numeric')).toBeNull()
  })

  it('lays several images out in a grid, keeps two at size s, and selects the one pressed before going to the focus view', async () => {
    const large = await renderAt(filesSpec(DEMO_IMAGE_PATHS, '調査のグラフ'), L)
    expect(large.querySelector('.fl')?.getAttribute('data-layout')).toBe('gallery')
    expect(large.querySelectorAll('.fl-thumb')).toHaveLength(3)
    const small = await renderAt(filesSpec(DEMO_IMAGE_PATHS, '調査のグラフ'), S)
    expect(small.querySelectorAll('.fl-thumb')).toHaveLength(2)
    expect(small.querySelector('.card-more')?.textContent).toContain(t('files.gallery.moreCount', { count: 1 }))
    await act(async () => small.querySelectorAll<HTMLButtonElement>('.fl-thumb')[1].click())
    expect(usePanelStore.getState().focusedKey).toBe('files:test')
    expect(usePanelStore.getState().panels[0].props.selected).toBe(1)
  })

  it('lists mixed files, gives an unreadable entry its reason in red, and keeps four at size s', async () => {
    const large = await renderAt(filesSpec(DEMO_MIXED_PATHS, '競合サービスの調査'), L)
    expect(large.querySelector('.fl')?.getAttribute('data-layout')).toBe('list')
    expect(large.querySelector('.card-hero p')?.textContent).toBe(t('files.list.countFailed', { count: 6, failed: 1 }))
    expect(large.querySelector('.fl-item[data-error="true"] .card-row-meta')?.textContent).toBe(t('files.errors.missing'))
    expect(large.querySelector('.fl-item .fl-item-thumb')).not.toBeNull()
    const small = await renderAt(filesSpec(DEMO_MIXED_PATHS), S)
    expect(small.querySelectorAll('.fl-item')).toHaveLength(4)
    expect(small.querySelector('.card-more')?.textContent).toContain(t('common.more', { count: 2 }))
  })

  it('shows the selected file in the viewer with paging back and forth in the focus view, and an unreadable file as a stub', async () => {
    await renderAt(filesSpec(DEMO_MIXED_PATHS, '競合サービスの調査', 4), L)
    await act(async () => {
      root.render(
        React.createElement(React.Fragment, null, React.createElement(Dock, { slot: 'right' }), React.createElement('section', { 'data-surface': 'focus' }, React.createElement(FocusOverlay)))
      )
      usePanelStore.getState().setFocused('files:test')
    })
    const focus = container.querySelector<HTMLElement>('[data-surface="focus"]')!
    expect(focus.querySelector('.fl-pager-count')?.textContent).toBe('5 / 6')
    expect(focus.querySelector('.fv-stub')?.textContent).toContain(t('files.errors.missing'))
    await act(async () => focus.querySelector<HTMLButtonElement>(`[aria-label="${t('files.focus.previous')}"]`)!.click())
    expect(usePanelStore.getState().panels[0].props.selected).toBe(3)
  })

  it('gives the next file in the focus view a viewer of its own, so a video that could not be played leaves the next one playable', async () => {
    const video = (name: string): FileItem => ({ path: `/Users/me/Movies/${name}`, name, kind: 'video', sizeBytes: 1000, modifiedAt: 1, url: `asist-file:///Users/me/Movies/${name}` })
    const items = [video('broken.mov'), video('fine.mp4')]
    await renderAt(spec('files', { paths: items.map((item) => item.path), items, selected: 0 }), L)
    await act(async () => {
      root.render(
        React.createElement(React.Fragment, null, React.createElement(Dock, { slot: 'right' }), React.createElement('section', { 'data-surface': 'focus' }, React.createElement(FocusOverlay)))
      )
      usePanelStore.getState().setFocused('files:test')
    })
    const focus = container.querySelector<HTMLElement>('[data-surface="focus"]')!
    await act(async () => void focus.querySelector('video')!.dispatchEvent(new Event('error')))
    expect(focus.querySelector('video')).toBeNull()
    await act(async () => focus.querySelector<HTMLButtonElement>(`[aria-label="${t('files.focus.next')}"]`)!.click())
    expect(focus.querySelector('.fl-pager-count')?.textContent).toBe('2 / 2')
    expect(focus.querySelector('video')?.getAttribute('src')).toBe(items[1].url)
  })

  it('lists the contents of a folder and opens a files card for the entry that is pressed', async () => {
    const card = await renderAt(filesSpec([DEMO_FILES_DIR]), L)
    const rows = [...card.querySelectorAll('.fv-entry .card-row-title')].map((el) => el.textContent)
    expect(rows).toEqual(['charts', 'notes', 'build.bin', 'config.json', 'pricing.csv', 'report.md'])
    await act(async () => card.querySelector<HTMLButtonElement>('.fv-entry .card-row-link')!.click())
    expect(api.panelFetch).toHaveBeenCalledWith('files', { paths: [`${DEMO_FILES_DIR}/charts`], selected: 0 })
    expect(usePanelStore.getState().panels.some((panel) => panel.key === `files:${DEMO_FILES_DIR}/charts`)).toBe(true)
  })

  it('writes the markdown fixture in real markdown syntax', () => {
    expect(DEMO_REPORT_MD).toContain('| サービス |')
  })
})

describe('jobs card', () => {
  it('orders the jobs as waiting for a decision, running and recent, keeps four at size s, and opens the card of a job when its row is pressed', async () => {
    useJobStore.setState({ jobs: DEMO_JOBS, logs: {} })
    const large = await renderAt(spec('jobs', {}), L)
    const groups = [...large.querySelectorAll<HTMLElement>('.jb-item')].map((el) => el.dataset.group)
    expect(groups).toEqual(['decision', 'active', 'recent', 'recent', 'recent'])
    expect(large.querySelector('.card-hero p')?.textContent).toBe(t('jobs.list.decisions', { count: 1 }))
    expect([...large.querySelectorAll('.jb-item .card-chip')].map((el) => el.textContent)).toEqual(
      expect.arrayContaining([t('jobs.merge.pending'), t('jobs.status.running'), t('jobs.status.done'), t('jobs.status.error')])
    )
    await act(async () => large.querySelector<HTMLButtonElement>('.jb-item .card-row-link')!.click())
    expect(usePanelStore.getState().panels.find((panel) => panel.type === 'agent-job')).toMatchObject({ key: 'job:demo-job-merge' })

    const small = await renderAt(spec('jobs', {}), S)
    expect(small.querySelectorAll('.jb-item')).toHaveLength(4)
    expect(small.querySelector('.card-more')?.textContent).toContain(t('common.more', { count: 1 }))
  })

  it('shows the empty state when there is no job', async () => {
    useJobStore.setState({ jobs: [], logs: {} })
    const card = await renderAt(spec('jobs', {}), L)
    expect(card.querySelector('.card-empty')?.textContent).toContain(t('jobs.list.empty'))
  })
})

describe('card for a single mail', () => {
  beforeEach(() => {
    useMailStore.setState({ status: null, revision: 0 })
  })

  it('shows the subject, the sender, the recipients and the body, and at size s folds the recipients away, cuts the body to six lines and sends the rest to the focus view', async () => {
    const long = { ...DEMO_MAIL_MESSAGE_CARD, text: Array.from({ length: 12 }, (_, i) => `${i + 1} 行目`).join('\n') }
    const large = await renderAt(spec('mail-message', long), L)
    expect(large.querySelector('.card-hero h3')?.textContent).toBe(long.message.subject)
    expect(large.querySelector('.card-hero p')?.textContent).toContain(long.message.from.name)
    expect(large.querySelector('.card-facts')?.textContent).toContain(long.message.to[0].name)
    expect(large.querySelector('.mm-text')?.textContent).toContain('12 行目')
    expect(large.querySelector('.card-more')).toBeNull()
    const small = await renderAt(spec('mail-message', long), S)
    expect(small.querySelector('.card-facts')).toBeNull()
    await act(async () => small.querySelector<HTMLButtonElement>('.card-more')!.click())
    expect(usePanelStore.getState().focusedKey).toBe('mail-message:test')
  })

  it('opens the mail in the mail screen for a reply, and asks main to archive it before closing the card', async () => {
    const mailChange = vi.fn(async () => ({ saved: true, operation: 'archive', id: DEMO_MAIL_MESSAGE_CARD.id, summary: t('mail.done.archive') }))
    Object.assign(window.api, { mailChange })
    const card = await renderAt(spec('mail-message', DEMO_MAIL_MESSAGE_CARD), L)
    const [reply, archive] = [...card.querySelectorAll<HTMLButtonElement>('.card-action')]
    await act(async () => reply.click())
    expect(useViewStore.getState().open).toMatchObject({ app: 'mail', pane: { kind: 'message', id: DEMO_MAIL_MESSAGE_CARD.id } })
    useViewStore.getState().closeApp()
    await act(async () => archive.click())
    expect(mailChange).toHaveBeenCalledWith({ operation: 'archive', id: DEMO_MAIL_MESSAGE_CARD.id })
    expect(usePanelStore.getState().panels).toHaveLength(0)
  })

  it('puts the query and the number of hits in the heading of a mail search card', async () => {
    const card = await renderAt(spec('mail', { ...DEMO_MAIL_CARD, query: '打合せ', view: 'inbox', total: 2, messages: DEMO_MAIL_CARD.messages.slice(0, 2) }), L)
    expect(card.querySelector('.card-hero h3')?.textContent).toBe(t('mailCards.list.searchTitle', { query: '打合せ' }))
    expect(card.querySelector('.card-hero p')?.textContent).toBe('2件')
    const empty = await renderAt(spec('mail', { ...DEMO_MAIL_CARD, query: 'ない', total: 0, messages: [] }), L)
    expect(empty.querySelector('.card-empty')?.textContent).toContain(t('mail.list.noMatches', { query: 'ない' }))
  })
})

describe('mail draft card', () => {
  const draft = DEMO_MAIL_DRAFTS[0]
  const reply = DEMO_MAIL_DRAFTS[1]
  beforeEach(() => {
    useSettingsStore.setState({ settings: { mail: { enabled: true, accounts: DEMO_MAIL_ACCOUNTS, defaultAccountId: 'demo-work', syncDays: 30, notifyNewMail: true } } as AppSettings })
    useMailStore.setState({ drafts: DEMO_MAIL_DRAFTS, draftsLoaded: true, sending: [] })
    useToastStore.setState({ toasts: [] })
  })

  it('shows the draft from main in the recipient, subject and body fields, saves an edit after a short delay, and sends it through main', async () => {
    vi.useFakeTimers()
    try {
      const card = await renderAt(spec('mail-draft', { draftId: draft.id }), L)
      expect(card.querySelector('.card-hero h3')?.textContent).toBe(t('mailCards.draft.title'))
      expect(card.querySelector<HTMLInputElement>(`[aria-label="${t('mail.fields.to')}"]`)?.value).toBe('田中 誠 <tanaka@example.co.jp>')
      expect(card.querySelector<HTMLTextAreaElement>(`[aria-label="${t('mail.fields.body')}"]`)?.value).toBe(draft.body)
      const body = card.querySelector<HTMLTextAreaElement>(`[aria-label="${t('mail.fields.body')}"]`)!
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(body, '拝啓\n直しました')
        body.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(api.mailDraftUpdate).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      expect(api.mailDraftUpdate).toHaveBeenCalledWith(draft.id, { to: ['田中 誠 <tanaka@example.co.jp>'], cc: [], subject: '季節のご挨拶', body: '拝啓\n直しました' })
      const [send] = [...card.querySelectorAll<HTMLButtonElement>('.card-action')]
      await act(async () => send.click())
      expect(api.mailDraftSend).toHaveBeenCalledWith(draft.id)
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.done.send') })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a recipient whose name holds a comma when only the body is edited', async () => {
    vi.useFakeTimers()
    try {
      const recipients = ['Tanaka, Taro <taro@example.com>', '"Sato, Hana" <hana@example.co.jp>']
      useMailStore.setState({ drafts: [{ ...draft, to: recipients }], draftsLoaded: true })
      const card = await renderAt(spec('mail-draft', { draftId: draft.id }), L)
      const body = card.querySelector<HTMLTextAreaElement>(`[aria-label="${t('mail.fields.body')}"]`)!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, '本文を直した')
        body.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      expect(api.mailDraftUpdate).toHaveBeenCalledWith(draft.id, expect.objectContaining({ to: recipients, body: '本文を直した' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows for a reply draft the message it answers and the full addresses it is sent to, edits only the body, removes it in main on discard, and opens the draft in the mail screen', async () => {
    const card = await renderAt(spec('mail-draft', { draftId: reply.id }), S)
    expect(card.querySelector('.md-reply')?.textContent).toContain(t('mailCards.draft.replyToAll', { name: '鈴木 花', subject: 'Re: 採用面談の候補日' }))
    // Reply-To sends the reply to the team address instead of the sender, and the reply-all adds the Cc.
    expect([...card.querySelectorAll('.md-static')].map((field) => field.textContent)).toEqual(['採用チーム <recruiting@example.co.jp>', '田中 誠 <tanaka@example.co.jp>'])
    expect(card.querySelector(`[aria-label="${t('mail.fields.to')}"]`)).toBeNull()
    const [, discard, open] = [...card.querySelectorAll<HTMLButtonElement>('.card-action')]
    await act(async () => discard.click())
    expect(api.mailDraftRemove).toHaveBeenCalledWith(reply.id)
    await act(async () => open.click())
    expect(useViewStore.getState().open).toMatchObject({ app: 'mail', box: 'drafts', pane: { kind: 'draft', id: reply.id } })
  })

  it('offers no send for a draft whose send started, says it can only be discarded, and discards it', async () => {
    const started = DEMO_MAIL_DRAFTS.find((item) => item.sendStartedAt !== null)!
    const card = await renderAt(spec('mail-draft', { draftId: started.id }), S)
    expect(card.querySelector('[role="status"]')?.textContent).toBe(t('mail.drafts.sendStarted'))
    const actions = [...card.querySelectorAll<HTMLButtonElement>('.card-action')]
    expect(actions.map((action) => action.textContent)).not.toContain(t('mail.send'))
    expect(card.querySelector<HTMLTextAreaElement>(`[aria-label="${t('mail.fields.body')}"]`)?.disabled).toBe(true)
    await act(async () => actions.find((action) => action.textContent === t('mail.composer.discard'))!.click())
    expect(api.mailDraftRemove).toHaveBeenCalledWith(started.id)
    expect(api.mailDraftSend).not.toHaveBeenCalled()
  })

  it('keeps saying the draft is being sent while its own send is under way, though main has recorded the start', async () => {
    let finish!: (value: unknown) => void
    api.mailDraftSend.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)) as never)
    const card = await renderAt(spec('mail-draft', { draftId: draft.id }), L)
    await act(async () => card.querySelector<HTMLButtonElement>('.card-action')!.click())
    await act(async () => useMailStore.setState({ drafts: DEMO_MAIL_DRAFTS.map((item) => (item.id === draft.id ? { ...item, sendStartedAt: Date.now() } : item)) }))
    expect(card.querySelector('.card-action')?.textContent).toBe(t('mail.sending'))
    expect(card.querySelector('[role="status"]')).toBeNull()
    await act(async () => finish({ saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '田中' }) }))
  })

  it('says so when the draft has been sent or discarded', async () => {
    useMailStore.setState({ drafts: [], draftsLoaded: true })
    const card = await renderAt(spec('mail-draft', { draftId: 'gone' }), L)
    expect(card.querySelector('.card-empty')?.textContent).toContain(t('mailCards.draft.gone'))
    expect(card.querySelector('.card-action')).toBeNull()
  })
})

describe('numbers and times on cards', () => {
  it('puts the requested amount first in the currency table and keeps three rows at size s', () => {
    expect(tableAmounts('USD', null, 5)).toEqual([1, 10, 100, 1000, 10000])
    expect(tableAmounts('USD', 250, 3)).toEqual([250, 1, 10])
    expect(tableAmounts('JPY', null, 3)).toEqual([100, 1000, 10000])
  })

  it('highlights the row of the requested amount on the fx card and shows the inverse rate among the facts', async () => {
    const card = await renderAt(spec('fx', DEMO_FX), L)
    expect(card.querySelector('.card-row[aria-current]')?.textContent).toContain('162,350 円')
    expect(card.querySelector('.card-facts')?.textContent).toContain('1 円 = 0.0062 ドル')
    expect(card.querySelector('.panel-meta')?.textContent).toContain(t('cardsFinance.fx.updated', { time: '' }).trim())
  })

  it('computes the time in a zone and its difference from the machine', () => {
    const at = new Date('2026-09-15T00:00:00Z')
    expect(zoned(at, 'Asia/Tokyo')).toMatchObject({ hour: 9, minute: 0, day: 20260915 })
    expect(zoned(at, 'America/New_York')).toMatchObject({ hour: 20, day: 20260914 })
    expect(offsetMinutes('Asia/Tokyo', at)).toBe(540)
    expect(offsetMinutes('America/New_York', at)).toBe(-240)
    expect(offsetMinutes('Asia/Kolkata', at)).toBe(330)
    expect(diffLabel(-780, t)).toBe(`−${t('cardsTime.duration.hours', { hours: 13 })}`)
    expect(diffLabel(330, t)).toBe(`+${t('cardsTime.duration.hoursMinutes', { hours: 5, minutes: 30 })}`)
    expect(diffLabel(0, t)).toBe(t('cardsTime.clock.sameTime'))
    expect([phaseOf(3), phaseOf(6), phaseOf(12), phaseOf(18), phaseOf(22)]).toEqual(['night', 'dawn', 'day', 'dusk', 'night'])
  })

  it('gives the clock card a backdrop for the time of day and leaves its own city out of the other cities', async () => {
    const card = await renderAt(spec('clock', DEMO_CLOCKS.ニューヨーク), L)
    expect(card.querySelector('.panel-backdrop .ck-scene')?.getAttribute('data-phase')).toMatch(/night|dawn|day|dusk/)
    const others = [...card.querySelectorAll('.ck-other-name')].map((el) => el.textContent)
    expect(others).not.toContain(t('cardsTime.clock.cities.newYork'))
    expect(others).toContain(t('cardsTime.clock.cities.tokyo'))
    expect(card.querySelector('.panel-meta')?.textContent).toMatch(/^UTC[+−]\d/)
  })

  it('formats remaining time, elapsed time and relative time', () => {
    const ja = createTranslator('ja-JP')
    expect(remainingText(90)).toBe('01:30')
    expect(remainingText(3725)).toBe('1:02:05')
    expect(elapsedLabel(ja, 48_000)).toBe(ja('jobs.elapsed.seconds', { seconds: 48 }))
    expect(elapsedLabel(ja, 192_000)).toBe(ja('jobs.elapsed.minutes', { minutes: 3, seconds: 12 }))
    expect(elapsedLabel(ja, 3_720_000)).toBe(ja('jobs.elapsed.hours', { hours: 1, minutes: '02' }))
    expect(elapsedLabel(createTranslator('en-US'), 3_720_000)).toBe('1h 02m')
    // A time more than a week old is written as its date in the Mac's time zone, so now is noon on that clock.
    const now = new Date(2026, 8, 15, 12).getTime()
    expect(relativeTime(now - 30_000, now)).toBe(t('cardsTime.justNow'))
    expect(relativeTime(now - 5 * 60_000, now)).toBe(t('cardsTime.minutesAgo', { count: 5 }))
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe(t('cardsTime.hoursAgo', { count: 2 }))
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe(t('cardsTime.daysAgo', { count: 3 }))
    expect(relativeTime(now - 10 * 86_400_000, now)).toBe('9/5')
  })
})

describe('mail card', () => {
  it('shows unread mail first in bold, opens the mail screen for the row that is pressed, and reloads when a sync is signalled', async () => {
    const mailList = vi.fn(async () => ({ messages: DEMO_MAIL_CARD.messages.slice(0, 2), total: 2 }))
    const mailStatus = vi.fn(async () => ({ enabled: true, accounts: [], unread: 1, unreadRecent: 1 }))
    Object.assign(window.api, { mailList, mailStatus })
    useMailStore.setState({ status: null, revision: 0 })
    const card = await renderAt(spec('mail', DEMO_MAIL_CARD), L)
    expect(card.querySelector('.card-hero p')?.textContent).toBe(t('mailCards.list.unreadCount', { count: DEMO_MAIL_CARD.unread }))
    const rows = [...card.querySelectorAll<HTMLElement>('.mc-item')]
    expect(rows.slice(0, 3).every((row) => row.dataset.unread !== undefined)).toBe(true)
    expect(rows[0].textContent).toContain('田中 誠')
    await act(async () => rows[0].querySelector<HTMLButtonElement>('.mc-open')!.click())
    expect(useViewStore.getState().open).toMatchObject({ app: 'mail', pane: { kind: 'message', id: DEMO_MAIL_CARD.messages[0].id } })
    useViewStore.getState().closeApp()
    await act(async () => useMailStore.getState().bump())
    expect(mailList).toHaveBeenCalledWith({ view: 'inbox', query: '', unreadOnly: false, limit: 200 })
    expect(card.querySelectorAll('.mc-item')).toHaveLength(2)
    expect(card.querySelector('.card-hero p')?.textContent).toBe(t('mailCards.list.unreadCount', { count: 1 }))
  })
})
