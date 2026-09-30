import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '../src/shared/i18n'
import { errorText, readErrorText } from '../src/shared/i18n/error-text'

// The service writes the confirmation window in the language of the interface, which it reads from the settings.
const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-calendar-service-'))
})
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))

import { openStoredContent } from '../src/shared/stored-format'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { CalendarService } from '../src/main/services/calendar-service'
import type { CalendarWrite } from '../src/main/services/google-calendar'
import {
  calendarEventInputSchema,
  calendarWindow,
  detailCalendarEvent,
  includesNextWeek,
  isoWithOffset,
  resolveCalendarRange,
  summarizeCalendarEvents,
  type CalendarEvent,
  type CalendarStatus
} from '../src/shared/calendar'

const event = {
  id: 'event-1',
  calendarId: 'work',
  calendarTitle: '仕事',
  title: '打合せ',
  start: Date.parse('2026-09-15T10:00:00+09:00'),
  end: Date.parse('2026-09-15T11:00:00+09:00'),
  allDay: false,
  location: '会議室',
  notes: '議題',
  timeZone: 'Asia/Tokyo',
  revision: 'r1',
  recurring: false,
  hasAttendees: false,
  writable: true
}
const fields = {
  title: event.title,
  start: '2026-09-15T10:00:00+09:00',
  end: '2026-09-15T11:00:00+09:00',
  allDay: false,
  timeZone: 'Asia/Tokyo',
  location: '',
  notes: ''
}
function fixture(patch = {}) {
  const settings = {
    enabled: true,
    readCalendarIds: ['work'],
    writeCalendarId: 'work',
    ...patch
  }
  const current = { ...event }
  const status: CalendarStatus = {
    signIn: 'signedIn',
    calendars: [{ id: 'work', title: '仕事', writable: true }],
    account: 'me@example.com'
  }
  const calendar = {
    status: vi.fn(async () => status),
    requestAccess: vi.fn(async () => status),
    events: vi.fn(async (_calendarIds: string[], _start: string, _end: string): Promise<CalendarEvent[]> => [current]),
    event: vi.fn(async () => current),
    write: vi.fn(async (change: CalendarWrite) => (change.operation === 'delete' ? change.before : current))
  }
  const confirm = vi.fn(async () => true)
  const service = new CalendarService({
    settings: () => settings,
    calendar,
    confirm
  })
  const signal = new AbortController()
  const writes = () => calendar.write.mock.calls.map(([change]) => change)
  const untouched = () => Object.values(calendar).every((call) => call.mock.calls.length === 0)
  return { service, settings, current, status, calendar, confirm, signal, writes, untouched }
}
describe('CalendarService', () => {
  it('disabled integration never reads calendar data', async () => {
    const f = fixture({ enabled: false })
    await expect(
      f.service.search({ start: fields.start, end: fields.end })
    ).rejects.toThrow()
    expect(f.untouched()).toBe(true)
  })
  it('reads only selected calendars and filters search results', async () => {
    const f = fixture()
    expect(
      await f.service.search({
        start: fields.start,
        end: fields.end,
        query: '別件の相談'
      })
    ).toEqual({ events: [], total: 0 })
    expect(f.calendar.events.mock.calls[0][0]).toEqual(['work'])
  })
  it('does not interpret an empty selection as all calendars', async () => {
    const f = fixture({ readCalendarIds: [] })
    await expect(
      f.service.search({ start: fields.start, end: fields.end })
    ).rejects.toThrow()
    expect(f.untouched()).toBe(true)
  })
  it('lists the screen range from selected calendars only, within 62 days', async () => {
    const f = fixture()
    f.status.calendars.push({ id: 'private', title: '個人', writable: true })
    const start = '2026-08-31T00:00:00+09:00'
    expect(await f.service.list({ start, end: '2026-10-05T00:00:00+09:00' })).toEqual([f.current])
    expect(f.calendar.events.mock.calls[0][0]).toEqual(['work'])
    await expect(f.service.list({ start, end: '2026-11-15T00:00:00+09:00' })).rejects.toThrow()
    await expect(fixture({ readCalendarIds: [] }).service.list({ start, end: '2026-09-07T00:00:00+09:00' })).rejects.toThrow()
    await expect(fixture({ enabled: false }).service.list({ start, end: '2026-09-07T00:00:00+09:00' })).rejects.toThrow()
  })
  it('keeps an event without length at the first instant of the range and trims what Google returns just outside it', async () => {
    const f = fixture()
    const start = '2026-09-14T00:00:00+09:00'
    const end = '2026-09-21T00:00:00+09:00'
    const reminder = { ...event, id: 'reminder', start: Date.parse(start), end: Date.parse(start) }
    // Google is asked from a minute before the range, so it also returns what ends in that minute.
    const endsAtStart = { ...event, id: 'late', start: Date.parse('2026-09-13T22:00:00+09:00'), end: Date.parse(start) }
    const minuteBefore = { ...event, id: 'before', start: Date.parse('2026-09-13T23:59:00+09:00'), end: Date.parse('2026-09-13T23:59:00+09:00') }
    const startsAtEnd = { ...event, id: 'next', start: Date.parse(end), end: Date.parse(end) }
    f.calendar.events.mockImplementation(async () => [endsAtStart, minuteBefore, reminder, f.current, startsAtEnd])
    expect(await f.service.list({ start, end })).toEqual([reminder, f.current])
    expect((await f.service.search({ start, end })).events).toEqual([reminder, f.current])
  })
  it('shows the destination and exact content before saving', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      expect(f.writes()).toHaveLength(0)
      return true
    })
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).resolves.toMatchObject({ saved: true })
    expect(f.confirm.mock.calls[0]?.[0]).toContain('仕事')
    expect(f.confirm.mock.calls[0]?.[2]).toBe(false)
    expect(f.writes()[0]).toMatchObject({
      operation: 'create',
      calendar: { id: 'work' },
      event: fields
    })
  })
  it('marks only a delete as a destructive confirmation', async () => {
    const f = fixture()
    await f.service.change({ operation: 'delete', eventId: f.current.id }, f.signal.signal)
    expect(f.confirm.mock.calls[0]?.[2]).toBe(true)
  })
  it('does not write on cancellation', async () => {
    const f = fixture()
    f.confirm.mockResolvedValue(false)
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).resolves.toMatchObject({ cancelled: true })
    expect(f.writes()).toHaveLength(0)
  })
  it('does not write after the turn is aborted while approval is open', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.signal.abort()
      return true
    })
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow()
    expect(f.writes()).toHaveLength(0)
  })
  it('invalidates approval if settings change', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.settings.enabled = false
      return true
    })
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow(errorText('calendar.errors.settingsChanged'))
    expect(f.writes()).toHaveLength(0)
  })
  it.each(['recurring', 'hasAttendees'] as const)(
    'blocks %s events before confirmation',
    async (flag) => {
      const f = fixture()
      f.current[flag] = true
      await expect(
        f.service.change(
          { operation: 'delete', eventId: event.id },
          f.signal.signal
        )
      ).rejects.toThrow()
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.writes()).toHaveLength(0)
    }
  )
  it('blocks events outside selected calendars', async () => {
    const f = fixture()
    f.current.calendarId = 'private'
    await expect(
      f.service.change(
        { operation: 'delete', eventId: event.id },
        f.signal.signal
      )
    ).rejects.toThrow()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('preserves the original destination and passes the approved revision', async () => {
    const f = fixture({ writeCalendarId: 'other' })
    await f.service.change(
      { operation: 'update', eventId: event.id, event: fields },
      f.signal.signal
    )
    expect(f.writes()[0]).toMatchObject({
      operation: 'update',
      before: { calendarId: 'work', revision: 'r1' }
    })
  })
  it('writes nothing and asks for nothing when Google is not signed in', async () => {
    const f = fixture()
    f.status.signIn = 'signedOut'
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow(errorText('calendar.errors.googleSignedOut'))
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.writes()).toHaveLength(0)
    f.status.signIn = 'unreadable'
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow(errorText('calendar.errors.tokenUnreadable'))
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('rejects a read-only destination', async () => {
    const f = fixture()
    f.status.calendars[0].writable = false
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('never retries an ambiguous write failure', async () => {
    const f = fixture()
    f.calendar.write.mockRejectedValue(new Error('connection lost'))
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow(errorText('calendar.errors.resultUnknown'))
    expect(f.writes()).toHaveLength(1)
  })
  it('allows only one approval at a time', async () => {
    const f = fixture()
    let release!: (approved: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = f.service.change(
      { operation: 'create', event: fields },
      f.signal.signal
    )
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
    await expect(
      f.service.change({ operation: 'create', event: fields }, f.signal.signal)
    ).rejects.toThrow(errorText('calendar.errors.confirmInProgress'))
    release(false)
    await first
    expect(f.writes()).toHaveLength(0)
  })
})
describe('the calendar of a settings file from before the calendar was Google alone', () => {
  it('drops the calendars the Mac chose and leaves the integration off until the account is signed in', () => {
    const sample = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v5.json'), 'utf8')) as Record<string, unknown>
    const macCalendars = { enabled: true, readCalendarIds: ['6A1F0C2E-3B4D-4E5F-8A9B-0C1D2E3F4A5B'], writeCalendarId: '6A1F0C2E-3B4D-4E5F-8A9B-0C1D2E3F4A5B' }
    expect(openStoredContent(SETTINGS_FORMAT, { ...sample, calendar: macCalendars }).value.calendar).toEqual({
      enabled: false,
      readCalendarIds: [],
      writeCalendarId: null
    })
  })
})
const JAPANESE = /[぀-ヿ一-鿿]/
describe('calendar dates', () => {
  it('requires offset, increasing dates, and a valid time zone', () => {
    for (const patch of [
      { end: fields.start },
      { start: '2026-09-15T10:00:00' },
      { timeZone: 'invalid' }
    ]) {
      expect(
        calendarEventInputSchema.safeParse({ ...fields, ...patch }).success
      ).toBe(false)
    }
  })
  /**
   * A rejected event is read by two different readers at once: the screen shows it in the language of
   * the interface, and the model reads it in the language of the conversation. Both are written from
   * the one message the issue carries a key for.
   */
  it('gives a rejected event a reason that reads in the language of the interface and in the language of the conversation', () => {
    const issue = calendarEventInputSchema.safeParse({ ...fields, timeZone: 'invalid' })
    expect(issue.success).toBe(false)
    const message = issue.error!.issues[0].message
    expect(message).toBe(errorText('calendar.errors.timeZoneUnknown'))
    expect(readErrorText(message, 'ja-JP')).toBe(createTranslator('ja-JP')('calendar.errors.timeZoneUnknown'))
    expect(readErrorText(message, 'en-US')).not.toMatch(JAPANESE)
  })

  it('writes the summary sent to the model in the language of the conversation, with no Japanese left in it', () => {
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      const sunday = new Date(2026, 8, 20, 15, 58)
      const english = { ...event, title: 'Standup', location: 'Room 1', notes: '', calendarTitle: 'Work' }
      const allDay = { ...english, id: 'event-2', allDay: true, start: Date.parse('2026-09-19T00:00:00+09:00'), end: Date.parse('2026-09-21T00:00:00+09:00') }
      const summary = summarizeCalendarEvents('en-US', [english, allDay], sunday, resolveCalendarRange({ range: 'week' }, sunday))
      expect(summary).toMatchObject({
        today: '2026-09-20 (Sun) 15:58',
        title: 'this week',
        range: '2026-09-14 (Mon) to 2026-09-20 (Sun)'
      })
      expect(summary.events.map((e) => [e.date, e.time])).toEqual([
        ['2026-09-15 (Tue)', '10:00–11:00'],
        ['2026-09-19 (Sat) to 2026-09-20 (Sun)', 'All day']
      ])
      expect(JSON.stringify(summary)).not.toMatch(JAPANESE)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('requires all-day boundaries in the specified time zone', () => {
    expect(
      calendarEventInputSchema.safeParse({ ...fields, allDay: true }).success
    ).toBe(false)
    expect(
      calendarEventInputSchema.safeParse({
        ...fields,
        allDay: true,
        start: '2026-09-15T00:00:00+09:00',
        end: '2026-09-16T00:00:00+09:00'
      }).success
    ).toBe(true)
  })
  it('resolves "week" to the Monday-start week containing today, and adds next week only on a weekend', () => {
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      const sunday = new Date(2026, 8, 20, 15, 58)
      const week = calendarWindow(sunday, 'week')
      expect(new Date(week.fromMs).getDate()).toBe(14)
      expect(new Date(week.untilMs).getDate()).toBe(21)
      const next = calendarWindow(sunday, 'next-week')
      expect(new Date(next.fromMs).getDate()).toBe(21)
      expect(new Date(next.untilMs).getDate()).toBe(28)
      // from and to are local dates on this machine and to is inclusive; they take precedence over range.
      const custom = resolveCalendarRange({ from: '2026-10-01', to: '2026-10-31' }, sunday)
      expect(custom).toMatchObject({ range: 'custom', fromMs: new Date(2026, 9, 1).getTime(), untilMs: new Date(2026, 10, 1).getTime() })
      expect(resolveCalendarRange({}, sunday)).toMatchObject({ range: 'today', fromMs: new Date(2026, 8, 20).getTime() })
      expect(() => resolveCalendarRange({ from: '2026-10-05', to: '2026-10-01' }, sunday)).toThrow(errorText('calendar.errors.rangeOrder'))
      expect(() => resolveCalendarRange({ from: '2026-10-05' }, sunday)).toThrow(errorText('calendar.errors.rangeBothNeeded'))
      expect(includesNextWeek(sunday, 'week')).toBe(true)
      expect(includesNextWeek(new Date(2026, 8, 19, 12), 'week')).toBe(true)
      expect(includesNextWeek(new Date(2026, 8, 18, 12), 'week')).toBe(false)
      expect(includesNextWeek(sunday, 'today')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('writes dates as local strings in the summary sent to the model and leaves out epoch numbers', () => {
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      const allDay = {
        ...event,
        id: 'event-2',
        title: '出張',
        allDay: true,
        location: '',
        start: Date.parse('2026-09-23T00:00:00+09:00'),
        end: Date.parse('2026-09-25T00:00:00+09:00')
      }
      const sunday = new Date(2026, 8, 20, 15, 58)
      const summary = summarizeCalendarEvents('ja-JP', [allDay, event], sunday, resolveCalendarRange({ range: 'week' }, sunday))
      expect(summary).toMatchObject({
        today: '2026-09-20(日) 15:58',
        title: '今週',
        range: '2026-09-14(月) 〜 2026-09-20(日)',
        count: 1,
        events: [{ id: 'event-1', title: '打合せ', date: '2026-09-15(火)', time: '10:00–11:00', location: '会議室', calendar: '仕事', start: '2026-09-15T10:00:00+09:00' }],
        nextWeek: {
          range: '2026-09-21(月) 〜 2026-09-27(日)',
          events: [{ id: 'event-2', title: '出張', date: '2026-09-23(水) 〜 2026-09-24(木)', time: '終日', calendar: '仕事' }]
        }
      })
      expect(JSON.stringify(summary)).not.toMatch(/\d{12,}/)
      const wednesday = new Date(2026, 8, 16, 9)
      const weekday = summarizeCalendarEvents('ja-JP', [], wednesday, resolveCalendarRange({}, wednesday))
      expect(weekday.range).toBe('2026-09-16(水)')
      expect(weekday.nextWeek).toBeUndefined()
      const october = summarizeCalendarEvents('ja-JP', [], wednesday, resolveCalendarRange({ from: '2026-10-01', to: '2026-10-31' }, wednesday))
      expect(october).toMatchObject({ title: '期間', range: '2026-10-01(木) 〜 2026-10-31(土)' })
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('gives each show_calendar event an ISO time with offset that an edit can take as is', () => {
    expect(isoWithOffset(Date.parse('2026-09-15T10:00:00+09:00'), 'Asia/Tokyo')).toBe('2026-09-15T10:00:00+09:00')
    expect(isoWithOffset(Date.parse('2026-03-07T12:30:00-05:00'), 'America/New_York')).toBe('2026-03-07T12:30:00-05:00')
    expect(isoWithOffset(Date.parse('2026-03-08T12:30:00Z'), 'UTC')).toBe('2026-03-08T12:30:00+00:00')
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      expect(detailCalendarEvent('ja-JP', event)).toMatchObject({
        id: 'event-1',
        date: '2026-09-15(火)',
        time: '10:00–11:00',
        start: '2026-09-15T10:00:00+09:00',
        end: '2026-09-15T11:00:00+09:00',
        timeZone: 'Asia/Tokyo',
        notes: '議題',
        writable: true
      })
      expect(calendarEventInputSchema.safeParse({ ...fields, start: detailCalendarEvent('ja-JP', event).start, end: detailCalendarEvent('ja-JP', event).end }).success).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('uses local midnight across DST and Monday for week boundaries', () => {
    const previous = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const day = calendarWindow(new Date(2026, 2, 8, 12), 'today')
      expect(day.untilMs - day.fromMs).toBe(23 * 3600000)
      const week = calendarWindow(new Date(2026, 8, 16, 12), 'week')
      expect(new Date(week.fromMs).getDay()).toBe(1)
      expect(new Date(week.untilMs).getDate()).toBe(21)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('covers and names whole days in a range that holds a change of daylight saving time', () => {
    const previous = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const fallBack = resolveCalendarRange({ from: '2026-11-01', to: '2026-11-01' }, new Date(2026, 9, 20))
      expect(fallBack.untilMs).toBe(new Date(2026, 10, 2).getTime())
      expect(summarizeCalendarEvents('en-US', [], new Date(2026, 9, 20), fallBack).range).toBe('2026-11-01 (Sun)')
      // Asked about "this week" on a Saturday, next week runs from 2026-03-02 over the day clocks spring forward.
      const saturday = new Date(2026, 1, 28, 12)
      const week = summarizeCalendarEvents('en-US', [], saturday, resolveCalendarRange({ range: 'week' }, saturday))
      expect(week.nextWeek?.range).toBe('2026-03-02 (Mon) to 2026-03-08 (Sun)')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('takes back an all-day event, as Google Calendar gives it and show_calendar shows it, in an update', () => {
    const previous = process.env.TZ
    try {
      process.env.TZ = 'Asia/Tokyo'
      // An all-day event from Google ends at midnight after its last day.
      const holiday = { ...event, allDay: true, start: Date.parse('2026-09-15T00:00:00+09:00'), end: Date.parse('2026-09-16T00:00:00+09:00') }
      const shown = detailCalendarEvent('ja-JP', holiday)
      expect(shown.date).toBe('2026-09-15(火)')
      const update = { title: '祝日', start: shown.start, end: shown.end, allDay: shown.allDay, timeZone: shown.timeZone, location: '', notes: '' }
      expect(calendarEventInputSchema.safeParse(update).success).toBe(true)
      const trip = detailCalendarEvent('ja-JP', { ...holiday, end: Date.parse('2026-09-18T00:00:00+09:00') })
      expect(trip.date).toBe('2026-09-15(火) 〜 2026-09-17(木)')
      expect(calendarEventInputSchema.safeParse({ ...update, end: trip.end }).success).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
  it('tells the model that an event ending at midnight is on the day it starts', () => {
    const previous = process.env.TZ
    try {
      process.env.TZ = 'Asia/Tokyo'
      const late = { ...event, start: Date.parse('2026-09-15T22:00:00+09:00'), end: Date.parse('2026-09-16T00:00:00+09:00') }
      expect(detailCalendarEvent('ja-JP', late)).toMatchObject({ date: '2026-09-15(火)', time: '22:00–00:00' })
      const overnight = { ...late, end: Date.parse('2026-09-16T02:00:00+09:00') }
      expect(detailCalendarEvent('ja-JP', overnight).date).toBe('2026-09-15(火) 〜 2026-09-16(水)')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})
