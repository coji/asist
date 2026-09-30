import { describe, expect, it } from 'vitest'
import type { TurnEvent } from '@shared/ipc'
import { MINI_APPS, TASK_VIEWS, openMiniAppSchema, placeMiniApp, type MiniAppView } from '@shared/mini-apps'
import { ToolError } from '@shared/tool-registry'
import { describeOpenApp, miniAppTools, openAppNote, parseTarget } from '../src/main/services/brain/mini-app-tools'
import { openMiniApp, reportOpenMiniApp } from '../src/main/services/mini-app-view'

/**
 * Runs a tool against a renderer that answers each app event with the report of what it then shows:
 * the requested view, or the view it had when `keep` stands for a user who keeps a draft.
 */
async function run(name: string, input: Record<string, unknown> = {}, keep = false): Promise<{ result: unknown; events: TurnEvent[] }> {
  const events: TurnEvent[] = []
  const tool = miniAppTools('en', MINI_APPS).find((def) => def.name === name)!
  const emit = (event: TurnEvent): void => {
    events.push(event)
    if (event.type !== 'app') return
    const before = openMiniApp()
    queueMicrotask(() => reportOpenMiniApp(keep ? before : event.open ? placeMiniApp(before, event.open) : null))
  }
  const result = await tool.run(input, { turnId: 7, signal: new AbortController().signal, emit }, new AbortController().signal)
  return { result, events }
}

const views: MiniAppView[] = [
  { app: 'notes', noteId: 'note-1', editing: false },
  { app: 'tasks', view: 'board', taskId: 'task-1' },
  { app: 'mail', box: 'inbox', accountId: 'acct', query: 'invoice', pane: { kind: 'draft', id: 'draft-1' } },
  { app: 'calendar', view: 'week', date: '2026-09-22', eventId: 'event-1' },
  { app: 'jobs', jobId: 'job-1' },
  { app: 'memory', file: 'pages/tanaka.md' },
  { app: 'settings', page: 'connections' }
]

describe('open_app', () => {
  it('asks the renderer to open the mini app at the place the fields name, and says so once the screen shows it', async () => {
    reportOpenMiniApp(null)
    const { result, events } = await run('open_app', { app: 'calendar', view: 'week', date: '2026-09-29', eventId: 'event-1' })
    expect(events).toEqual([{ type: 'app', turnId: 7, open: { app: 'calendar', view: 'week', date: '2026-09-29', eventId: 'event-1' } }])
    expect(result).toEqual({ opened: 'calendar' })
  })

  it('says it did not open, and what the screen still shows, when the user keeps a draft', async () => {
    const editing: MiniAppView = { app: 'notes', noteId: 'note-1', editing: true }
    reportOpenMiniApp(editing)
    expect((await run('open_app', { app: 'tasks' }, true)).result).toEqual({ opened: null, kept: describeOpenApp(editing, 'en') })
    // Another note in the same mini app is turned down the same way, though Notes stays open.
    expect((await run('open_app', { app: 'notes', noteId: 'note-2' }, true)).result).toEqual({ opened: null, kept: describeOpenApp(editing, 'en') })
  })

  it('opens every mini app with no field at all', () => {
    for (const app of MINI_APPS) expect(parseTarget({ app }, MINI_APPS)).toEqual({ app })
  })

  it('refuses a field of another mini app, a value outside its list, a malformed date and a message with a draft', () => {
    expect(() => parseTarget({ app: 'notes', taskId: 'task-1' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'tasks', view: 'week' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'mail', box: 'spam' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'settings', page: 'secrets' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'calendar', date: 'next monday' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'mail', messageId: 'm', draftId: 'd' }, MINI_APPS)).toThrow(ToolError)
    expect(() => parseTarget({ app: 'browser' }, MINI_APPS)).toThrow(ToolError)
  })

  it('refuses a day that does not exist, so the renderer never has to report a view it cannot parse', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-10']) {
      expect(() => parseTarget({ app: 'calendar', date }, MINI_APPS), date).toThrow(ToolError)
    }
    const leapDay = parseTarget({ app: 'calendar', date: '2028-02-29' }, MINI_APPS)
    expect(openMiniAppSchema.safeParse(placeMiniApp(null, leapDay)).success).toBe(true)
  })

  it('neither names nor opens a mini app the machine lacks', () => {
    const withoutCalendar = MINI_APPS.filter((app) => app !== 'calendar')
    const openApp = miniAppTools('en', withoutCalendar).find((def) => def.name === 'open_app')!
    const properties = (openApp.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(properties.app.enum).toEqual(withoutCalendar)
    expect(properties.view.enum).toEqual([...TASK_VIEWS])
    expect(Object.keys(properties)).not.toContain('eventId')
    expect(JSON.stringify(openApp.description)).not.toContain('calendar')
    expect(() => parseTarget({ app: 'calendar' }, withoutCalendar)).toThrow(ToolError)
  })

  it('sends nothing to the renderer when the input is refused', async () => {
    await expect(run('open_app', { app: 'notes', jobId: 'job-1' })).rejects.toThrow(ToolError)
  })
})

describe('close_app', () => {
  it('asks the renderer to close the open mini app, and says whether the screen closed it', async () => {
    reportOpenMiniApp(views[1])
    const closed = await run('close_app')
    expect(closed.events).toEqual([{ type: 'app', turnId: 7, open: null }])
    expect(closed.result).toEqual({ closed: true })
    reportOpenMiniApp(views[5])
    expect((await run('close_app', {}, true)).result).toEqual({ closed: false, kept: describeOpenApp(views[5], 'en') })
  })
})

describe('the open mini app', () => {
  it('names the id of what each mini app shows, so the model can pass it to that mini app\'s tools', () => {
    const shown = ['note-1', 'task-1', 'draft-1', 'event-1', 'job-1', 'pages/tanaka.md', 'connections']
    views.forEach((view, index) => expect(describeOpenApp(view, 'en')).toContain(shown[index]))
    expect(describeOpenApp(views[3], 'en')).toContain('2026-09-22')
  })

  it('is what get_open_app returns after the renderer reports it, and nothing once it reports none', async () => {
    reportOpenMiniApp(views[0])
    expect((await run('get_open_app')).result).toMatchObject({ open: views[0] })
    expect(openAppNote('en-US')).toContain('note-1')
    reportOpenMiniApp(null)
    expect((await run('get_open_app')).result).toEqual({ open: null })
    expect(openAppNote('en-US')).toBeNull()
  })

  it('refuses a report that does not describe a mini app, and keeps the last good one', () => {
    reportOpenMiniApp(views[1])
    expect(() => reportOpenMiniApp({ app: 'notes', noteId: 5 })).toThrow()
    expect(() => reportOpenMiniApp({ app: 'browser' })).toThrow()
    expect(openMiniApp()).toEqual(views[1])
  })

  it('accepts every view the renderer can report', () => {
    for (const view of views) expect(openMiniAppSchema.parse(view)).toEqual(view)
  })
})
