import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarChangeResult, CalendarEvent } from '@shared/calendar'
import type { ConversationLocale } from '@shared/conversation-locale'
import { executeClientTool } from '../src/main/services/brain/tools'

const mocks = vi.hoisted(() => ({ changeCalendar: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/memory', () => ({}))
vi.mock('../src/main/services/agent', () => ({}))
vi.mock('../src/main/services/project-index', () => ({}))
vi.mock('../src/main/services/panel-fetchers', () => ({}))
vi.mock('../src/main/services/timers', () => ({}))
vi.mock('../src/main/services/user-notes', () => ({}))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => ({}) }))
vi.mock('../src/main/services/calendar', () => ({ changeCalendar: mocks.changeCalendar }))

const zone = process.env.TZ
afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const saved: Omit<CalendarEvent, 'start' | 'end' | 'allDay' | 'timeZone'> = {
  id: 'me@example.com ev1',
  calendarId: 'me@example.com',
  calendarTitle: 'me@example.com',
  title: '休み',
  location: '',
  notes: '',
  revision: '"1"',
  recurring: false,
  hasAttendees: false,
  writable: true
}

/** What the model reads back from change_calendar when Google saved the event. */
async function savedAs(event: CalendarEvent, locale: ConversationLocale): Promise<Record<string, unknown>> {
  const result: CalendarChangeResult = { saved: true, operation: 'create', event, sync: 'Google' }
  mocks.changeCalendar.mockResolvedValueOnce(result)
  const ctx = { turnId: 1, signal: new AbortController().signal, emit: () => {} }
  const input = { operation: 'create', event: { title: event.title, start: '2026-09-06', end: '2026-09-06', allDay: true, timeZone: event.timeZone, location: '', notes: '' } }
  const execution = await executeClientTool('change_calendar', input, ctx, locale)
  expect(execution.isError).toBe(false)
  return JSON.parse(execution.content)
}

describe('change_calendar', () => {
  it('tells the model the days of an all-day event it saved, with no time of day, where the first day begins at 01:00', async () => {
    // Chile moves its clock from 00:00 to 01:00 on 2026-09-06, so that day begins at 01:00.
    process.env.TZ = 'America/Santiago'
    const holiday = { ...saved, allDay: true, timeZone: 'America/Santiago', start: new Date(2026, 8, 6).getTime(), end: new Date(2026, 8, 7).getTime() }
    const result = await savedAs(holiday, 'ja-JP')
    expect(result).toMatchObject({
      saved: true,
      operation: 'create',
      event: { id: holiday.id, title: '休み', date: '2026-09-06(日)', time: '終日', start: '2026-09-06', end: '2026-09-06', allDay: true }
    })
    expect(JSON.stringify(result)).not.toMatch(/\d{10,}|T\d\d:/)
  })

  it("tells the model the start and end of an event with times it saved on this computer's clock, whatever zone keeps it", async () => {
    process.env.TZ = 'Asia/Tokyo'
    const call = { ...saved, title: 'Call', allDay: false, timeZone: 'America/New_York', start: Date.parse('2026-09-15T09:00:00-04:00'), end: Date.parse('2026-09-15T10:00:00-04:00') }
    const result = await savedAs(call, 'en-US')
    expect(result).toMatchObject({
      event: { date: '2026-09-15 (Tue)', time: '22:00–23:00', start: '2026-09-15T22:00:00+09:00', end: '2026-09-15T23:00:00+09:00', timeZone: 'America/New_York' }
    })
    expect(JSON.stringify(result)).not.toMatch(/\d{10,}/)
  })
})
