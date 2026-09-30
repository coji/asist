import {
  calendarChangeSchema,
  calendarListSchema,
  calendarSearchSchema,
  type CalendarChange,
  type CalendarChangeResult,
  type CalendarEvent,
  type CalendarStatus
} from '@shared/calendar'
import { overlaps } from '@shared/calendar-layout'
import { errorText } from '@shared/i18n/error-text'
import type { AppSettings } from '@shared/settings'
import { t } from './i18n'
import { getSettings } from './settings'
import { formatLocaleOf } from '@shared/conversation-locale'
import { CalendarWriteRejected, type GoogleCalendar } from './google-calendar'

interface Dependencies {
  settings: () => AppSettings['calendar']
  calendar: Pick<GoogleCalendar, 'status' | 'requestAccess' | 'events' | 'event' | 'write'>
  confirm: (detail: string, signal: AbortSignal, destructive: boolean) => Promise<boolean>
}

function describe(
  event: Pick<
    CalendarEvent,
    'title' | 'start' | 'end' | 'allDay' | 'timeZone' | 'location' | 'notes'
  >
): string {
  const format = new Intl.DateTimeFormat(formatLocaleOf(getSettings().uiLocale, getSettings().region), {
    timeZone: event.timeZone,
    dateStyle: 'full',
    timeStyle: 'short'
  })
  const none = t('calendar.confirm.none')
  return [
    event.title,
    `${format.format(event.start)} → ${format.format(event.end)}`,
    event.allDay ? t('calendar.confirm.allDayZone', { zone: event.timeZone }) : event.timeZone,
    t('calendar.confirm.location', { location: event.location || none }),
    t('calendar.confirm.notes', { notes: event.notes || none })
  ].join('\n')
}

const SEARCH_EVENT_LIMIT = 200

export class CalendarService {
  private changing = false
  constructor(private readonly deps: Dependencies) {}

  status(requestAccess = false): Promise<CalendarStatus> {
    return requestAccess ? this.deps.calendar.requestAccess() : this.deps.calendar.status()
  }

  private enabled(): AppSettings['calendar'] {
    const settings = this.deps.settings()
    if (!settings.enabled) throw new Error(errorText('calendar.errors.disabled'))
    return settings
  }

  async search(
    value: unknown,
    signal?: AbortSignal
  ): Promise<{ events: CalendarEvent[]; total: number }> {
    const input = calendarSearchSchema.parse(value)
    const events = (await this.eventsIn(input.start, input.end, signal)).filter(
      (event) =>
        !input.query ||
        `${event.title}\n${event.location}`
          .toLocaleLowerCase()
          .includes(input.query.toLocaleLowerCase())
    )
    // Never silently truncate a calendar: callers must narrow their range when it is too large.
    if (events.length > SEARCH_EVENT_LIMIT)
      throw new Error(errorText('calendar.errors.tooManyEvents', { limit: SEARCH_EVENT_LIMIT }))
    return { events, total: events.length }
  }

  /** The events in the range the calendar screen shows. Unlike a search it has no count limit, and the range reaches 62 days. */
  async list(value: unknown, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const input = calendarListSchema.parse(value)
    return this.eventsIn(input.start, input.end, signal)
  }

  private async eventsIn(start: string, end: string, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const settings = this.enabled()
    if (!settings.readCalendarIds.length) throw new Error(errorText('calendar.errors.noReadCalendars'))
    const events = await this.deps.calendar.events(settings.readCalendarIds, start, end, signal)
    // Google is asked from a minute before the range, so that an event without length at its start is
    // matched however Google tests overlap, and the range is applied here, by the rule the calendar screen
    // puts an event on a day with.
    return events.filter((event) => overlaps(event, Date.parse(start), Date.parse(end)))
  }

  async change(value: unknown, signal: AbortSignal): Promise<CalendarChangeResult> {
    const input: CalendarChange = calendarChangeSchema.parse(value)
    if (this.changing) throw new Error(errorText('calendar.errors.confirmInProgress'))
    this.changing = true
    try {
      signal.throwIfAborted()
      const settings = this.enabled()
      const configuration = JSON.stringify(settings)
      const status = await this.status()
      if (status.signIn === 'unreadable') throw new Error(errorText('calendar.errors.tokenUnreadable'))
      if (status.signIn === 'signedOut') throw new Error(errorText('calendar.errors.googleSignedOut'))
      let before: CalendarEvent | undefined
      let calendarId: string
      if (input.operation === 'create') {
        if (!settings.writeCalendarId)
          throw new Error(errorText('calendar.errors.noWriteCalendar'))
        calendarId = settings.writeCalendarId
      } else {
        before = await this.deps.calendar.event(input.eventId, signal)
        if (!settings.readCalendarIds.includes(before.calendarId))
          throw new Error(errorText('calendar.errors.notReadable'))
        if (before.recurring || before.hasAttendees)
          throw new Error(errorText('calendar.errors.locked'))
        calendarId = before.calendarId
      }
      const calendar = status.calendars.find(
        (candidate) => candidate.id === calendarId
      )
      if (!calendar?.writable)
        throw new Error(errorText('calendar.errors.destinationUnwritable'))
      // Google keeps events on a writable calendar that its API does not let anyone change, such as a
      // birthday or an out-of-office block.
      if (before && !before.writable) throw new Error(errorText('calendar.errors.locked'))
      const after =
        input.operation === 'delete'
          ? undefined
          : {
              ...input.event,
              start: Date.parse(input.event.start),
              end: Date.parse(input.event.end)
            }
      const detail = [
        t(`calendar.confirm.${input.operation}`, { calendar: calendar.title }),
        before ? `${t('calendar.confirm.before')}\n${describe(before)}` : '',
        after ? `${t('calendar.confirm.after')}\n${describe(after)}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      signal.throwIfAborted()
      if (!(await this.deps.confirm(detail, signal, input.operation === 'delete')))
        return { cancelled: true, saved: false }
      signal.throwIfAborted()
      if (JSON.stringify(this.deps.settings()) !== configuration)
        throw new Error(errorText('calendar.errors.settingsChanged'))
      // Once dispatched, do not cancel or retry a write: a lost response cannot prove it was not saved.
      let event: CalendarEvent
      try {
        event = await this.deps.calendar.write(
          input.operation === 'create'
            ? { operation: 'create', calendar, event: input.event }
            : input.operation === 'update'
              ? { operation: 'update', before: before!, event: input.event }
              : { operation: 'delete', before: before! }
        )
      } catch (error) {
        if (error instanceof CalendarWriteRejected) throw error
        throw new Error(errorText('calendar.errors.resultUnknown'), { cause: error })
      }
      return {
        saved: true,
        operation: input.operation,
        event,
        sync: t('calendar.saved.toGoogle')
      }
    } finally {
      this.changing = false
    }
  }
}
