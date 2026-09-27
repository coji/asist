import { z } from 'zod'
import type { CalendarEvent, CalendarEventInput, CalendarStatus } from '@shared/calendar'
import { parseDayKey } from '@shared/calendar-layout'
import { errorText } from '@shared/i18n/error-text'
import { CalendarWriteRejected, type CalendarBackend, type CalendarWrite } from './calendar-backend'
import { fetchFailure } from './fetch-failure'
import { GoogleSignedOut, SignInReplaced, type GoogleAuth } from './google-oauth'

/**
 * The calendars of one Google account, read through the Google Calendar API when the calendar is used and
 * never in the background. The API allows a project 1,000,000 requests a day, a limit that cannot be
 * raised, so each use asks only for what it shows: the status reads the calendar list once, and a range
 * reads one page of events per chosen calendar.
 */

const API = 'https://www.googleapis.com/calendar/v3'

/** Whether the account's role on a calendar lets it change the events. */
const accessWrites = (role: string): boolean => role === 'owner' || role === 'writer'

const timeSchema = z
  .object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() })
  .refine((time) => (time.date === undefined) !== (time.dateTime === undefined))
const eventSchema = z.object({
  id: z.string(),
  etag: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: timeSchema,
  end: timeSchema,
  recurringEventId: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
  attendees: z.array(z.unknown()).optional(),
  eventType: z.string().optional()
})
type GoogleEvent = z.infer<typeof eventSchema>
const eventStatusSchema = z.object({ status: z.string().optional() })

/**
 * An event Google returned, or null for a cancelled one. A cancelled occurrence of a repeating event can
 * come without its start and end, so the status is read before the rest.
 */
function liveEvent(value: unknown): GoogleEvent | null {
  if (parseGoogle(eventStatusSchema, value).status === 'cancelled') return null
  return parseGoogle(eventSchema, value)
}
const eventsPageSchema = z.object({
  summary: z.string(),
  timeZone: z.string(),
  accessRole: z.string(),
  items: z.array(z.unknown()),
  nextPageToken: z.string().optional()
})
const calendarEntrySchema = z.object({
  id: z.string(),
  summary: z.string(),
  accessRole: z.string(),
  timeZone: z.string(),
  primary: z.boolean().optional()
})
const calendarListSchema = z.object({ items: z.array(calendarEntrySchema), nextPageToken: z.string().optional() })

/** What an event needs to know of its calendar. */
interface CalendarInfo {
  id: string
  title: string
  timeZone: string
  writable: boolean
}

/**
 * The id ASIST gives a Google event. Google's id is unique only inside its calendar, and a change names
 * the event alone, so the id carries the calendar too. Neither Google's calendar ids nor its event ids
 * contain a space.
 */
export const googleEventKey = (calendarId: string, eventId: string): string => `${calendarId} ${eventId}`
function parseEventKey(key: string): { calendarId: string; eventId: string } {
  const parts = key.split(' ')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(errorText('calendar.errors.eventNotFound'))
  return { calendarId: parts[0], eventId: parts[1] }
}

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * An event as the rest of ASIST reads it. An all-day event keeps Google's days, whose end is already the
 * day after the last, and is placed at midnight of this computer, as EventKit places one; a timed event
 * keeps its own time zone, or its calendar's when it has none.
 */
export function toCalendarEvent(item: GoogleEvent, calendar: CalendarInfo): CalendarEvent {
  const allDay = item.start.date !== undefined
  const at = (time: GoogleEvent['start']): number => (allDay ? parseDayKey(time.date!).getTime() : Date.parse(time.dateTime!))
  return {
    id: googleEventKey(calendar.id, item.id),
    calendarId: calendar.id,
    calendarTitle: calendar.title,
    title: item.summary ?? '',
    start: at(item.start),
    end: at(item.end),
    allDay,
    location: item.location ?? '',
    notes: item.description ?? '',
    timeZone: allDay ? localZone() : (item.start.timeZone ?? calendar.timeZone),
    revision: item.etag,
    recurring: item.recurringEventId !== undefined || item.recurrence !== undefined,
    hasAttendees: (item.attendees?.length ?? 0) > 0,
    // Google refuses to change a birthday, a focus time or an out-of-office block through a plain edit.
    writable: calendar.writable && (item.eventType ?? 'default') === 'default'
  }
}

/** The day an instant falls on in a time zone, as Google writes an all-day date. */
function dayIn(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * The fields ASIST edits, as Google's API takes them. A patch sends the other kind of time as null so that
 * an event that turns from timed to all-day, or back, loses the one it had.
 */
export function googleEventBody(event: CalendarEventInput, patch: boolean): Record<string, unknown> {
  const none = patch ? { dateTime: null, timeZone: null } : {}
  const time = (iso: string): Record<string, unknown> =>
    event.allDay ? { date: dayIn(iso, event.timeZone), ...none } : { dateTime: iso, timeZone: event.timeZone, ...(patch ? { date: null } : {}) }
  return { summary: event.title, location: event.location, description: event.notes, start: time(event.start), end: time(event.end) }
}

/** The reasons Google gives in a 403 for a request over a quota, which waiting fixes. */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'])

/** The reasons a request can be refused for, each a message without values. */
type Refusal =
  | 'calendar.errors.calendarNotFound'
  | 'calendar.errors.eventNotFound'
  | 'calendar.errors.changedSinceConfirm'
  | 'calendar.errors.googleRateLimited'
  | 'calendar.errors.destinationUnwritable'

async function refusal(response: Response, notFound: Refusal): Promise<Refusal | null> {
  if (response.status === 404 || response.status === 410) return notFound
  if (response.status === 412) return 'calendar.errors.changedSinceConfirm'
  if (response.status === 429) return 'calendar.errors.googleRateLimited'
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null
    const reasons = body?.error?.errors?.map((error) => error.reason) ?? []
    return reasons.some((reason) => reason && RATE_LIMIT_REASONS.has(reason)) ? 'calendar.errors.googleRateLimited' : 'calendar.errors.destinationUnwritable'
  }
  return null
}

/** The message of a request Google answered with an error. */
async function failure(response: Response, notFound: Refusal): Promise<string> {
  const reason = await refusal(response, notFound)
  return reason === null ? errorText('calendar.errors.googleRequestFailed', { status: response.status }) : errorText(reason)
}

interface Request {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: [string, string][]
  body?: unknown
  ifMatch?: string
  signal?: AbortSignal
  /** A write, which the calendar must be told apart from an unknown result when nothing was sent. */
  write?: boolean
}

/** A write that failed before it was sent, which therefore saved nothing. */
const unsent = (error: unknown): unknown =>
  error instanceof Error ? new CalendarWriteRejected(error.message, { cause: error }) : error

/** Google's JSON read by the schema, or a failure for the user when it does not have the form ASIST reads. */
function parseGoogle<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(errorText('calendar.errors.googleBadResponse'), { cause: parsed.error })
  return parsed.data
}

export interface GoogleCalendarDependencies {
  auth: GoogleAuth
  fetch: typeof fetch
}

export class GoogleCalendarBackend implements CalendarBackend {
  readonly syncNote = null
  readonly savedTo = 'calendar.saved.toGoogle' as const
  constructor(private readonly deps: GoogleCalendarDependencies) {}

  /**
   * One request of the API. A 401 means Google refused the access token before doing anything, so the
   * request is sent once more with a renewed one, a write included. When the renewed one is refused too,
   * the saved sign-in is dropped, so that the status and a new sign-in agree that there is none.
   */
  private async call(path: string, request: Request = {}): Promise<Response> {
    const url = new URL(`${API}${path}`)
    for (const [name, value] of request.query ?? []) url.searchParams.append(name, value)
    const send = async (): Promise<{ response: Response; token: string }> => {
      let token: string
      try {
        token = await this.deps.auth.accessToken()
      } catch (error) {
        throw request.write ? unsent(error) : error
      }
      try {
        const response = await this.deps.fetch(url, {
          method: request.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(request.ifMatch ? { 'if-match': request.ifMatch } : {})
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: request.signal
        })
        return { response, token }
      } catch (error) {
        throw fetchFailure(url.href, error)
      }
    }
    const first = await send()
    if (first.response.status !== 401) return first.response
    this.deps.auth.forgetAccessToken(first.token)
    const second = await send()
    if (second.response.status !== 401) return second.response
    const signedOut = this.deps.auth.signedOutByGoogle()
    throw request.write ? unsent(signedOut) : signedOut
  }

  /** The JSON of a read, or its failure as an error for the user. */
  private async read<T>(path: string, schema: z.ZodType<T>, request: Request, notFound: Refusal): Promise<T> {
    const response = await this.call(path, request)
    if (!response.ok) throw new Error(await failure(response, notFound))
    return parseGoogle(schema, await response.json().catch(() => null))
  }

  private async calendarList(signal?: AbortSignal): Promise<z.infer<typeof calendarEntrySchema>[]> {
    const entries: z.infer<typeof calendarEntrySchema>[] = []
    let pageToken: string | undefined
    do {
      const page = await this.read(
        '/users/me/calendarList',
        calendarListSchema,
        { query: [['maxResults', '250'], ...(pageToken ? [['pageToken', pageToken] as [string, string]] : [])], signal },
        'calendar.errors.calendarNotFound'
      )
      entries.push(...page.items)
      pageToken = page.nextPageToken
    } while (pageToken)
    return entries
  }

  /** Signed out, or signed in with the account's calendars. A saved sign-in Google no longer accepts reads as signed out. */
  async status(signal?: AbortSignal): Promise<CalendarStatus> {
    try {
      const state = this.deps.auth.signInState()
      if (state !== 'signedIn') return { authorization: state === 'unreadable' ? 'unreadable' : 'notDetermined', calendars: [], account: null }
      const entries = await this.calendarList(signal)
      // The id of the primary calendar is the address of the account.
      const account = entries.find((entry) => entry.primary)?.id ?? null
      return {
        authorization: 'fullAccess',
        calendars: entries.map((entry) => ({ id: entry.id, title: entry.summary, source: 'Google', writable: accessWrites(entry.accessRole) })),
        account
      }
    } catch (error) {
      if (error instanceof GoogleSignedOut) return { authorization: 'notDetermined', calendars: [], account: null }
      throw error
    }
  }

  /** Signs in unless a readable sign-in is saved; one another build saved is replaced. */
  async requestAccess(): Promise<CalendarStatus> {
    if (this.deps.auth.signInState() === 'signedIn') return this.status()
    try {
      await this.deps.auth.signIn()
    } catch (error) {
      if (!(error instanceof SignInReplaced)) throw error
    }
    return this.status()
  }

  async signOut(): Promise<CalendarStatus> {
    await this.deps.auth.signOut()
    return this.status()
  }

  async events(calendarIds: string[], start: string, end: string, signal?: AbortSignal): Promise<CalendarEvent[]> {
    // Google compares an event's end with timeMin strictly, so an event without length at the start would
    // be missed; the minute before brings it in, and the service trims to the range.
    const timeMin = new Date(Date.parse(start) - 60_000).toISOString()
    const pages = await Promise.all(calendarIds.map((id) => this.eventsOf(id, timeMin, end, signal)))
    return pages.flat().sort((a, b) => a.start - b.start)
  }

  private async eventsOf(calendarId: string, timeMin: string, timeMax: string, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = []
    let pageToken: string | undefined
    do {
      const page = await this.read(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        eventsPageSchema,
        {
          query: [
            // Every occurrence of a repeating event comes as an event of its own.
            ['singleEvents', 'true'],
            ['orderBy', 'startTime'],
            ['timeMin', timeMin],
            ['timeMax', timeMax],
            ['maxResults', '2500'],
            ...(pageToken ? [['pageToken', pageToken] as [string, string]] : [])
          ],
          signal
        },
        'calendar.errors.calendarNotFound'
      )
      const calendar = { id: calendarId, title: page.summary, timeZone: page.timeZone, writable: accessWrites(page.accessRole) }
      // A working location is a place for the day that Google shows apart from the events.
      for (const item of page.items.map(liveEvent)) if (item && item.eventType !== 'workingLocation') events.push(toCalendarEvent(item, calendar))
      pageToken = page.nextPageToken
    } while (pageToken)
    return events
  }

  async event(eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const key = parseEventKey(eventId)
    const path = `/calendars/${encodeURIComponent(key.calendarId)}`
    const [item, entry] = await Promise.all([
      this.read(`${path}/events/${encodeURIComponent(key.eventId)}`, z.unknown(), { signal }, 'calendar.errors.eventNotFound').then(liveEvent),
      this.read(`/users/me/calendarList/${encodeURIComponent(key.calendarId)}`, calendarEntrySchema, { signal }, 'calendar.errors.calendarNotFound')
    ])
    if (!item) throw new Error(errorText('calendar.errors.eventNotFound'))
    return toCalendarEvent(item, { id: entry.id, title: entry.summary, timeZone: entry.timeZone, writable: accessWrites(entry.accessRole) })
  }

  async write(change: CalendarWrite): Promise<CalendarEvent> {
    if (change.operation === 'create') {
      const saved = await this.send(`/calendars/${encodeURIComponent(change.calendar.id)}/events`, { method: 'POST', body: googleEventBody(change.event, false) })
      return toCalendarEvent(parseGoogle(eventSchema, await saved.json()), { ...change.calendar, timeZone: change.event.timeZone })
    }
    const { before } = change
    const key = parseEventKey(before.id)
    const path = `/calendars/${encodeURIComponent(key.calendarId)}/events/${encodeURIComponent(key.eventId)}`
    // If-Match makes Google refuse with 412 when the event changed after it was read for the confirmation.
    if (change.operation === 'delete') {
      await this.send(path, { method: 'DELETE', ifMatch: before.revision })
      return before
    }
    const saved = await this.send(path, { method: 'PATCH', ifMatch: before.revision, body: googleEventBody(change.event, true) })
    return toCalendarEvent(parseGoogle(eventSchema, await saved.json()), {
      id: before.calendarId,
      title: before.calendarTitle,
      timeZone: change.event.timeZone,
      writable: before.writable
    })
  }

  /**
   * A write. Google answers a 4xx before it changes anything, so that answer is a refusal with its reason;
   * a 5xx or a lost connection leaves it unknown whether the event was saved.
   */
  private async send(path: string, request: Request): Promise<Response> {
    const response = await this.call(path, { ...request, write: true })
    if (response.ok) return response
    if (response.status >= 500) throw new Error(errorText('calendar.errors.googleRequestFailed', { status: response.status }))
    throw new CalendarWriteRejected(await failure(response, 'calendar.errors.eventNotFound'))
  }
}
