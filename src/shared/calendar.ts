import { z } from 'zod'
import { addDays, dayKey, lastInstant, parseDayKey } from './calendar-layout'
import { dateLabel, promptText, type ConversationLocale, type PromptText } from './conversation-locale'
import type { Translate } from './i18n'
import { errorText } from './i18n/error-text'
import { bilingual } from './tool-registry'

export const calendarSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  readCalendarIds: z
    .array(z.string().min(1))
    .refine((ids) => new Set(ids).size === ids.length),
  writeCalendarId: z.string().min(1).nullable()
})
/** One calendar of the Google account. */
export interface CalendarAccount {
  id: string
  title: string
  writable: boolean
}
export interface CalendarStatus {
  /** `unreadable`: a sign-in is saved, but another build encrypted it, so this one cannot read it. */
  signIn: 'signedIn' | 'signedOut' | 'unreadable'
  /** The calendars of the account, empty unless signed in. */
  calendars: CalendarAccount[]
  /** The address of the account, which is the id of its primary calendar, or null when it has none or is signed out. */
  account: string | null
}
export const calendarEventSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  calendarTitle: z.string(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  location: z.string(),
  notes: z.string(),
  timeZone: z.string(),
  revision: z.string(),
  recurring: z.boolean(),
  hasAttendees: z.boolean(),
  writable: z.boolean()
})
export type CalendarEvent = z.infer<typeof calendarEventSchema>
const instant = z.iso.datetime({ offset: true })
const day = z.iso.date()
/**
 * An event as change_calendar and the editor give it. An event with times runs between two instants, and
 * an all-day event over days, from its first to its last, as Google keeps it. The days are not given as
 * the instants they begin at, which the model gets wrong where a clock skips midnight: asked on 2026-10-02
 * for an all-day event on 2026-09-06 in America/Santiago, where that day begins at 01:00, Gemini 3.8 Flash
 * wrote instants that day does not begin at in 32 of 40 runs, and the day itself right in 40 of 40.
 */
export const calendarEventInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(500),
    start: z.string().describe(
      bilingual({
        ja: '時刻のある予定はUTCオフセット付きISO日時。終日の予定は初日(YYYY-MM-DD)',
        en: 'For an event with times, an ISO timestamp carrying its offset from UTC. For an all-day event, its first day (YYYY-MM-DD).'
      })
    ),
    end: z.string().describe(
      bilingual({
        ja: '時刻のある予定は終了日時。終日の予定は最終日(YYYY-MM-DD)',
        en: 'For an event with times, when it ends. For an all-day event, its last day (YYYY-MM-DD).'
      })
    ),
    allDay: z.boolean(),
    timeZone: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value })
          return true
        } catch {
          return false
        }
      }, errorText('calendar.errors.timeZoneUnknown')),
    location: z.string().max(2000),
    notes: z.string().max(10000)
  })
  .refine(
    (value) => [value.start, value.end].every((bound) => (value.allDay ? day : instant).safeParse(bound).success),
    errorText('calendar.errors.boundsFormat')
  )
  // zod runs a check of the whole object even after a field failed its own, and a bound that is not a
  // date or an instant has no order.
  .refine((value) => (value.allDay ? value.end >= value.start : Date.parse(value.end) > Date.parse(value.start)), {
    message: errorText('calendar.errors.endBeforeStart'),
    when: (payload) => payload.issues.length === 0
  })
export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>
export const calendarChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    event: calendarEventInputSchema
  }),
  z.strictObject({
    operation: z.literal('update'),
    eventId: z.string().min(1),
    event: calendarEventInputSchema
  }),
  z.strictObject({ operation: z.literal('delete'), eventId: z.string().min(1) })
])
export type CalendarChange = z.infer<typeof calendarChangeSchema>

const MAX_SEARCH_DAYS = 366
const MAX_LIST_DAYS = 62

export const calendarSearchSchema = z
  .strictObject({
    start: instant,
    end: instant,
    query: z.string().max(500).optional()
  })
  .refine(
    (value) =>
      Date.parse(value.end) > Date.parse(value.start) &&
      Date.parse(value.end) - Date.parse(value.start) <= MAX_SEARCH_DAYS * 86400000,
    errorText('calendar.errors.searchRange', { days: MAX_SEARCH_DAYS })
  )

/** The range the calendar screen shows, at most the six weeks of a month view. The end is exclusive. */
export const calendarListSchema = z
  .strictObject({ start: instant, end: instant })
  .refine(
    (value) =>
      Date.parse(value.end) > Date.parse(value.start) &&
      Date.parse(value.end) - Date.parse(value.start) <= MAX_LIST_DAYS * 86400000,
    errorText('calendar.errors.listRange', { days: MAX_LIST_DAYS })
  )
export type CalendarListRange = z.infer<typeof calendarListSchema>
export type CalendarChangeResult =
  | { cancelled: true; saved: false }
  | {
      saved: true
      operation: CalendarChange['operation']
      event: CalendarEvent
      sync: string
    }

export type CalendarRange = 'today' | 'week' | 'next-week'
export const CALENDAR_RANGES = ['today', 'week', 'next-week'] as const
const DAY_MS = 86400000

/**
 * The window behind "今日", "今週" and "来週" for the card and for show_calendar. The end is exclusive.
 * A week is the calendar week containing today and starts on Monday, the same definition the month
 * view uses. When "今週" on a Sunday evening might really mean next week, next week's events are
 * attached as a note and the LLM decides from the conversation; see `nextWeek` in
 * summarizeCalendarEvents.
 */
export function calendarWindow(now: Date, range: CalendarRange): { fromMs: number; untilMs: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range !== 'today') start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + (range === 'next-week' ? 7 : 0))
  const end = new Date(start)
  end.setDate(end.getDate() + (range === 'today' ? 1 : 7))
  return { fromMs: start.getTime(), untilMs: end.getTime() }
}

/** On a Saturday or Sunday, a question about "今週" also fetches next week's events to attach. */
export const includesNextWeek = (now: Date, range: CalendarRange | 'custom'): boolean =>
  range === 'week' && (now.getDay() === 0 || now.getDay() === 6)

/** The input of show_calendar: either `range`, or `from` and `to` as local calendar days with `to` included. */
export interface CalendarRangeInput {
  range?: CalendarRange
  from?: string
  to?: string
}
export interface CalendarResolvedRange {
  range: CalendarRange | 'custom'
  fromMs: number
  untilMs: number
}

/**
 * The window the card and the fetch actually use. `from` and `to` win over `range`, which defaults to
 * today, and are local calendar days of this machine that show_calendar's schema has checked exist.
 */
export function resolveCalendarRange(input: CalendarRangeInput, now: Date): CalendarResolvedRange {
  if (input.from && input.to) {
    const fromMs = parseDayKey(input.from).getTime()
    const untilMs = addDays(parseDayKey(input.to), 1).getTime()
    if (!(untilMs > fromMs)) throw new Error(errorText('calendar.errors.rangeOrder'))
    if (untilMs - fromMs > MAX_SEARCH_DAYS * DAY_MS)
      throw new Error(errorText('calendar.errors.rangeTooLong', { days: MAX_SEARCH_DAYS }))
    return { range: 'custom', fromMs, untilMs }
  }
  if (input.from || input.to) throw new Error(errorText('calendar.errors.rangeBothNeeded'))
  const range = input.range ?? 'today'
  return { range, ...calendarWindow(now, range) }
}

/** What the LLM is told the window it received covers. The screen words the same ranges itself. */
export const CALENDAR_RANGE_TITLES: Record<CalendarRange | 'custom', PromptText> = {
  today: { ja: '今日', en: 'today' },
  week: { ja: '今週', en: 'this week' },
  'next-week': { ja: '来週', en: 'next week' },
  custom: { ja: '期間', en: 'the range asked for' }
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  allDay: { ja: '終日', en: 'All day' },
  /** What stands between the first and the last day of a range that spans several days. */
  between: { ja: ' 〜 ', en: ' to ' }
} as const satisfies Record<string, PromptText>

const pad2 = (n: number): string => String(n).padStart(2, '0')
const clock = (at: number | Date): string => {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** One event as the LLM reads it. Dates and times are strings in this machine's local time; no epoch number is passed. */
export interface CalendarEventSummary {
  id: string
  title: string
  date: string
  time: string
  location?: string
  calendar: string
}
/**
 * One event as show_calendar and change_calendar return it. It also carries what an update or a delete
 * needs, in the form change_calendar takes it: the bounds, the time zone and the flags.
 */
export interface CalendarEventDetail extends CalendarEventSummary {
  start: string
  end: string
  timeZone: string
  allDay: boolean
  notes: string
  recurring: boolean
  hasAttendees: boolean
  writable: boolean
}

type ClockField = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'timeZoneName'

/** What a clock in the time zone reads at an instant, each field zero-padded, the hour from 00 to 23. */
function clockIn(at: number, timeZone: string): Record<ClockField, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  ) as Record<ClockField, string>
}

/** An ISO timestamp with the offset of the given time zone, like "2026-09-15T10:00:00+09:00". */
export function isoWithOffset(at: number, timeZone: string): string {
  const clock = clockIn(at, timeZone)
  const offset = clock.timeZoneName === 'GMT' ? '+00:00' : clock.timeZoneName.replace('GMT', '')
  return `${clock.year}-${clock.month}-${clock.day}T${clock.hour}:${clock.minute}:${clock.second}${offset}`
}

/**
 * When an event happens, as the confirmation window writes it. An event with times shows its start and its
 * end on the clock of its time zone, and an all-day event the days it covers, as the event card does.
 */
function describeWhen(t: Translate, locale: string, event: CalendarEventInput): string {
  if (!event.allDay) {
    const format = new Intl.DateTimeFormat(locale, { timeZone: event.timeZone, dateStyle: 'full', timeStyle: 'short' })
    return `${format.format(Date.parse(event.start))} → ${format.format(Date.parse(event.end))}`
  }
  // Date.parse reads a date without a time as the beginning of that day in UTC.
  const format = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'full' })
  const date = (day: string): string => format.format(Date.parse(day))
  return event.start === event.end ? date(event.start) : t('calendar.dateRange', { from: date(event.start), until: date(event.end) })
}

/** An event as the confirmation window of a change shows it, in the language of `t` and the formats of `locale`. */
export function describeCalendarEvent(t: Translate, locale: string, event: CalendarEventInput): string {
  const none = t('calendar.confirm.none')
  return [
    event.title,
    describeWhen(t, locale, event),
    event.allDay ? t('calendar.allDay') : event.timeZone,
    t('calendar.confirm.location', { location: event.location || none }),
    t('calendar.confirm.notes', { notes: event.notes || none })
  ].join('\n')
}

/**
 * A moment as the conversation reads it: the same form in the time zone of this machine. The utterance
 * carries local time, so a UTC stamp would put mail that arrived, or a task finished, before 9 a.m. in
 * Japan on the day before.
 */
export const localIsoWithOffset = (at: number): string =>
  isoWithOffset(at, Intl.DateTimeFormat().resolvedOptions().timeZone)

/**
 * An event in the form change_calendar and the editor give it. An event with times is written in this
 * machine's time zone, as everything else the model reads is, whatever zone it is kept in. An all-day
 * event, which ASIST places at the beginning of its days on this machine, is written as those days, the
 * last one included; an event without length covers the day it starts on, as lastInstant has it. Given
 * the instant such a day begins at, which is 01:00 on 2026-09-06 in America/Santiago, and asked in English
 * when the event starts, Gemini 3.8 Flash said one in the morning in 8 of 20 runs on 2026-10-02; given the
 * day, in none of 19.
 */
export function calendarEventInput(event: CalendarEvent): CalendarEventInput {
  return {
    title: event.title,
    start: event.allDay ? dayKey(new Date(event.start)) : localIsoWithOffset(event.start),
    end: event.allDay ? dayKey(new Date(lastInstant(event))) : localIsoWithOffset(event.end),
    allDay: event.allDay,
    timeZone: event.timeZone,
    location: event.location,
    notes: event.notes
  }
}

export function summarizeCalendarEvent(locale: ConversationLocale, event: CalendarEvent): CalendarEventSummary {
  const lastDay = dateLabel(locale, lastInstant(event))
  const date = dateLabel(locale, event.start)
  return {
    id: event.id,
    title: event.title,
    date: lastDay === date ? date : `${date}${promptText(locale, TEXTS.between)}${lastDay}`,
    time: event.allDay ? promptText(locale, TEXTS.allDay) : `${clock(event.start)}–${clock(event.end)}`,
    ...(event.location ? { location: event.location } : {}),
    calendar: event.calendarTitle
  }
}

export function detailCalendarEvent(locale: ConversationLocale, event: CalendarEvent): CalendarEventDetail {
  const { start, end } = calendarEventInput(event)
  return {
    ...summarizeCalendarEvent(locale, event),
    start,
    end,
    timeZone: event.timeZone,
    allDay: event.allDay,
    notes: event.notes,
    recurring: event.recurring,
    hasAttendees: event.hasAttendees,
    writable: event.writable
  }
}

/** The current time attached to a tool result, written like "2026-09-20(日) 15:58". */
export const calendarNowLabel = (locale: ConversationLocale, now: Date): string =>
  `${dateLabel(locale, now)} ${clock(now)}`

export interface CalendarSummary {
  today: string
  /** What the window covers, as CALENDAR_RANGE_TITLES words it. */
  title: string
  /** The dates of the range, written like "2026-09-14(月) 〜 2026-09-20(日)". */
  range: string
  count: number
  events: CalendarEventDetail[]
  /** Next week's events, present when "今週" was asked on a weekend and the search range was extended by a week. */
  nextWeek?: { range: string; events: CalendarEventDetail[] }
}

function rangeLabel(locale: ConversationLocale, fromMs: number, untilMs: number): string {
  const first = dateLabel(locale, fromMs)
  const last = dateLabel(locale, untilMs - 1)
  return first === last ? first : `${first}${promptText(locale, TEXTS.between)}${last}`
}

/**
 * The result of show_calendar and the material for the prefetched note. Each event's date and time
 * becomes a string like "2026-09-15(火) 10:00–11:00", and today and the range are strings as well.
 * With raw epoch milliseconds the LLM does the arithmetic in its head and gets the date wrong; on
 * 2026-09-20 it was off by a week and wrote out the calculation until it hit the output limit.
 * Each event also carries the ISO timestamps and the id that an update or a delete needs, so no
 * separate search tool is required. Events are split at the window: anything after it goes into
 * `nextWeek`, which is only reached when includesNextWeek holds.
 */
export function summarizeCalendarEvents(
  locale: ConversationLocale,
  events: CalendarEvent[],
  now: Date,
  window: CalendarResolvedRange
): CalendarSummary {
  const sorted = [...events].sort((a, b) => a.start - b.start)
  const detail = (event: CalendarEvent): CalendarEventDetail => detailCalendarEvent(locale, event)
  const inWindow = sorted.filter((event) => event.start < window.untilMs).map(detail)
  const later = sorted.filter((event) => event.start >= window.untilMs).map(detail)
  const summary: CalendarSummary = {
    today: calendarNowLabel(locale, now),
    title: promptText(locale, CALENDAR_RANGE_TITLES[window.range]),
    range: rangeLabel(locale, window.fromMs, window.untilMs),
    count: inWindow.length,
    events: inWindow
  }
  if (includesNextWeek(now, window.range)) {
    summary.nextWeek = { range: rangeLabel(locale, window.untilMs, addDays(new Date(window.untilMs), 7).getTime()), events: later }
  }
  return summary
}
