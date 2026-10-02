import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorText } from '../src/shared/i18n/error-text'

// The service and the sign-in page write in the language of the interface, which they read from the settings.
const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-google-calendar-'))
})
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))

import { CalendarService } from '../src/main/services/calendar-service'
import { GoogleCalendar, googleEventKey, toCalendarEvent } from '../src/main/services/google-calendar'
import { GOOGLE_CALENDAR_SCOPES, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GoogleAuth, SignInReplaced, type GoogleTokenId } from '../src/main/services/google-oauth'
import { SecretUnreadableError, type EncryptedSecretStore } from '../src/main/services/encrypted-secrets'
import { googleSignInPage } from '../src/main/services/google-sign-in-page'

const API = 'https://www.googleapis.com/calendar/v3'

/** A token store in memory. `unreadable` stands for a token another build encrypted. */
function memoryTokens(refreshToken: string | null | 'unreadable' = 'refresh-1'): EncryptedSecretStore<GoogleTokenId> & { value: string | null } {
  const store = {
    value: refreshToken,
    get: () => {
      if (store.value === 'unreadable') throw new SecretUnreadableError('unreadable')
      return store.value
    },
    set: (_id: GoogleTokenId, secret: string) => {
      store.value = secret
    },
    remove: () => {
      store.value = null
    }
  }
  return store
}

interface Call {
  method: string
  url: URL
  headers: Record<string, string>
  body: string
}
type Route = (call: Call) => Response | Promise<Response> | undefined

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Google's endpoints as the routes answer them, with every request kept in order. Nothing reaches the network. */
function fakeGoogle(...routes: Route[]): { fetch: typeof fetch; calls: Call[]; api: () => Call[] } {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body === undefined ? '' : String(init.body)
    }
    calls.push(call)
    for (const route of routes) {
      const response = await route(call)
      if (response) return response
    }
    throw new Error(`no route for ${call.method} ${call.url.href}`)
  })
  return { fetch: fetchMock as unknown as typeof fetch, calls, api: () => calls.filter((call) => call.url.href.startsWith(API)) }
}

const refreshes: Route = (call) =>
  call.url.href === GOOGLE_TOKEN_URL && new URLSearchParams(call.body).get('grant_type') === 'refresh_token'
    ? json({ access_token: 'access-1', expires_in: 3599, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' })
    : undefined

const calendarList: Route = (call) =>
  call.method === 'GET' && call.url.pathname === '/calendar/v3/users/me/calendarList'
    ? json({
        items: [
          { id: 'me@example.com', summary: 'me@example.com', accessRole: 'owner', timeZone: 'Asia/Tokyo', primary: true },
          { id: 'team@group.calendar.google.com', summary: 'チーム', accessRole: 'writer', timeZone: 'Asia/Tokyo' },
          { id: 'ja.japanese#holiday@group.v.calendar.google.com', summary: '日本の祝日', accessRole: 'reader', timeZone: 'Asia/Tokyo' }
        ]
      })
    : undefined

const timed = {
  id: 'ev1',
  etag: '"3000"',
  summary: '打合せ',
  location: '会議室',
  description: '議題',
  start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
  end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
  eventType: 'default'
}

const eventsOf = (calendarId: string, items: unknown[]): Route => (call) =>
  call.method === 'GET' && call.url.pathname === `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    ? json({ summary: calendarId === 'me@example.com' ? 'me@example.com' : 'チーム', timeZone: 'Asia/Tokyo', accessRole: 'owner', items })
    : undefined

function calendarWith(google: ReturnType<typeof fakeGoogle>, tokens = memoryTokens(), now = () => Date.parse('2026-09-15T00:00:00Z')) {
  const openBrowser = vi.fn(async () => undefined)
  const auth = new GoogleAuth({ client: { id: 'client-id', secret: 'client-secret' }, tokens, fetch: google.fetch, openBrowser, page: googleSignInPage, now })
  return { calendar: new GoogleCalendar({ auth, fetch: google.fetch }), auth, tokens, openBrowser }
}

function withZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

describe('signing in to Google', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Signs in, answering the browser's return with what `redirect` builds from the URL ASIST opened. */
  async function signIn(redirect: (authorize: URL) => string, ...routes: Route[]) {
    return signInWith(memoryTokens(null), redirect, ...routes)
  }

  async function signInWith(tokens: ReturnType<typeof memoryTokens>, redirect: (authorize: URL) => string, ...routes: Route[]) {
    const google = fakeGoogle(...routes)
    const context = calendarWith(google, tokens)
    let returned: Response | null = null
    context.openBrowser.mockImplementation(async (url: string) => {
      // The browser comes back to the loopback server, which is on this computer.
      void globalThis.fetch(redirect(new URL(url))).then((response) => (returned = response))
    })
    const result = await context.auth.signIn().then(
      () => null,
      (error: unknown) => error as Error
    )
    await vi.waitFor(() => expect(returned).not.toBeNull())
    return { ...context, google, error: result, page: returned! }
  }

  const returnsCode = (authorize: URL): string =>
    `${authorize.searchParams.get('redirect_uri')}/?code=the-code&state=${authorize.searchParams.get('state')}`
  const revokes: Route = (call) => (call.url.href === GOOGLE_REVOKE_URL ? new Response('', { status: 200 }) : undefined)

  const exchanges: Route = (call) =>
    call.url.href === GOOGLE_TOKEN_URL && new URLSearchParams(call.body).get('grant_type') === 'authorization_code'
      ? json({ access_token: 'access-1', refresh_token: 'refresh-new', expires_in: 3599, scope: GOOGLE_CALENDAR_SCOPES.join(' ') })
      : undefined

  it('sends an S256 challenge of the verifier it later exchanges, and a state, to a loopback address', async () => {
    const { error, openBrowser, google, tokens, page } = await signIn(
      (authorize) => `${authorize.searchParams.get('redirect_uri')}/?code=the-code&state=${authorize.searchParams.get('state')}`,
      exchanges
    )
    expect(error).toBeNull()
    const authorize = new URL(openBrowser.mock.calls[0][0])
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('scope')!.split(' ').sort()).toEqual([...GOOGLE_CALENDAR_SCOPES].sort())
    expect(new URL(authorize.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1')
    expect(authorize.searchParams.get('state')!.length).toBeGreaterThanOrEqual(16)
    const exchange = new URLSearchParams(google.calls[0].body)
    expect(exchange.get('code')).toBe('the-code')
    const challenge = createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')
    expect(challenge).toBe(authorize.searchParams.get('code_challenge'))
    expect(exchange.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'))
    expect(tokens.value).toBe('refresh-new')
    expect(page.status).toBe(200)
  })

  it('refuses a return with another state without ending the sign-in, since any page can reach 127.0.0.1, and exchanges only the code Google sent', async () => {
    const google = fakeGoogle(exchanges)
    const tokens = memoryTokens(null)
    const context = calendarWith(google, tokens)
    const strays: number[] = []
    context.openBrowser.mockImplementation(async (url: string) => {
      const authorize = new URL(url)
      strays.push((await globalThis.fetch(`${authorize.searchParams.get('redirect_uri')}/?code=stolen&state=not-the-state`)).status)
      void globalThis.fetch(returnsCode(authorize))
    })
    await context.auth.signIn()
    expect(strays).toEqual([400])
    expect(google.calls.map((call) => new URLSearchParams(call.body).get('code'))).toEqual(['the-code'])
    expect(tokens.value).toBe('refresh-new')
  })

  it('tells a consent the user declined from a failure', async () => {
    const { error, tokens } = await signIn(
      (authorize) => `${authorize.searchParams.get('redirect_uri')}/?error=access_denied&state=${authorize.searchParams.get('state')}`
    )
    expect(error?.message).toBe(errorText('calendar.errors.googleSignInDenied'))
    expect(tokens.value).toBeNull()
  })

  it('revokes and keeps nothing when the user left a calendar scope unchecked', async () => {
    const { error, google, tokens } = await signIn(
      (authorize) => `${authorize.searchParams.get('redirect_uri')}/?code=the-code&state=${authorize.searchParams.get('state')}`,
      (call) =>
        call.url.href === GOOGLE_TOKEN_URL
          ? json({ access_token: 'a', refresh_token: 'partial', expires_in: 3599, scope: GOOGLE_CALENDAR_SCOPES[1] })
          : undefined,
      (call) => (call.url.href === GOOGLE_REVOKE_URL ? json({}) : undefined)
    )
    expect(error?.message).toBe(errorText('calendar.errors.googleScopesMissing'))
    expect(new URLSearchParams(google.calls[1].body).get('token')).toBe('partial')
    expect(tokens.value).toBeNull()
  })

  it('replaces a saved sign-in that this build cannot read, which the status shows as unreadable', async () => {
    const tokens = memoryTokens('unreadable')
    const { calendar } = calendarWith(fakeGoogle(), tokens)
    expect(await calendar.status()).toEqual({ signIn: 'unreadable', calendars: [], account: null })
    const { error } = await signInWith(tokens, returnsCode, exchanges)
    expect(error).toBeNull()
    expect(tokens.value).toBe('refresh-new')
  })

  it('drops an unreadable sign-in on sign-out without asking Google to revoke what it cannot read', async () => {
    const tokens = memoryTokens('unreadable')
    const google = fakeGoogle()
    const { calendar } = calendarWith(google, tokens)
    expect(await calendar.signOut()).toEqual({ signIn: 'signedOut', calendars: [], account: null })
    expect(tokens.value).toBeNull()
    expect(google.calls).toHaveLength(0)
  })

  it('revokes and does not save the grant of a sign-in that a sign-out overtook during the code exchange', async () => {
    let finishExchange!: () => void
    const slowExchange: Route = (call) =>
      call.url.href === GOOGLE_TOKEN_URL
        ? new Promise((resolve) => (finishExchange = () => resolve(exchanges(call)!)))
        : undefined
    const tokens = memoryTokens(null)
    const google = fakeGoogle(slowExchange, revokes)
    const { auth, openBrowser } = calendarWith(google, tokens)
    openBrowser.mockImplementation(async (url: string) => void globalThis.fetch(returnsCode(new URL(url))))
    const signingIn = auth.signIn().catch((error: unknown) => error)
    await vi.waitFor(() => expect(finishExchange).toBeDefined())
    await auth.signOut()
    finishExchange()
    expect(await signingIn).toBeInstanceOf(SignInReplaced)
    expect(tokens.value).toBeNull()
    const revoked = google.calls.filter((call) => call.url.href === GOOGLE_REVOKE_URL)
    expect(revoked.map((call) => new URLSearchParams(call.body).get('token'))).toEqual(['refresh-new'])
  })

  it('gives up waiting for the browser after the time limit and closes the loopback server', async () => {
    const google = fakeGoogle()
    const openBrowser = vi.fn(async () => undefined)
    const auth = new GoogleAuth({ client: { id: 'c', secret: 's' }, tokens: memoryTokens(null), fetch: google.fetch, openBrowser, page: googleSignInPage, signInTimeoutMs: 60 })
    await expect(auth.signIn()).rejects.toThrow(errorText('calendar.errors.googleSignInTimedOut', { minutes: 0 }))
    const redirect = new URL(openBrowser.mock.calls[0][0]).searchParams.get('redirect_uri')!
    await expect(globalThis.fetch(redirect)).rejects.toThrow()
  })

  it('ends a sign-in replaced by a newer one without an error, the newer one signing in', async () => {
    const tokens = memoryTokens(null)
    const google = fakeGoogle(exchanges, calendarList)
    const { calendar, openBrowser } = calendarWith(google, tokens)
    const opened: string[] = []
    openBrowser.mockImplementation(async (url: string) => void opened.push(url))
    const first = calendar.requestAccess()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    const second = calendar.requestAccess()
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    // The first request's browser tab was closed; the second comes back.
    await globalThis.fetch(returnsCode(new URL(opened[1])))
    expect(await second).toMatchObject({ signIn: 'signedIn' })
    expect(await first).toMatchObject({ signIn: expect.any(String) })
    expect(tokens.value).toBe('refresh-new')
  })

  /**
   * Google's token endpoints as its documentation describes revocation: revoking any token takes back
   * every scope the account granted the app, and with it every token issued for them. The exchange of the
   * code `first` waits for `firstExchange`, as on a network that stalls.
   */
  function grantingGoogle(firstExchange: Promise<unknown>) {
    const valid = new Set<string>()
    const route: Route = async (call) => {
      if (call.url.href === GOOGLE_REVOKE_URL) {
        valid.clear()
        return new Response('', { status: 200 })
      }
      if (call.url.href !== GOOGLE_TOKEN_URL) return undefined
      const form = new URLSearchParams(call.body)
      const scope = GOOGLE_CALENDAR_SCOPES.join(' ')
      if (form.get('grant_type') === 'refresh_token')
        return valid.has(form.get('refresh_token')!) ? json({ access_token: 'access-renewed', expires_in: 3599, scope }) : json({ error: 'invalid_grant' }, 400)
      const code = form.get('code')!
      if (code === 'first') await firstExchange
      valid.add(`refresh-${code}`)
      return json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3599, scope })
    }
    return { route, valid }
  }

  /** Signs in with a browser in which the user consents at once, giving the code `first` and then `second`. */
  function consentingAtOnce(google: ReturnType<typeof fakeGoogle>, tokens: ReturnType<typeof memoryTokens>) {
    const context = calendarWith(google, tokens)
    let consents = 0
    context.openBrowser.mockImplementation(async (url: string) => {
      const authorize = new URL(url)
      const code = ++consents === 1 ? 'first' : 'second'
      void globalThis.fetch(`${authorize.searchParams.get('redirect_uri')}/?code=${code}&state=${authorize.searchParams.get('state')}`)
    })
    const exchanging = (code: string): boolean => google.calls.some((call) => new URLSearchParams(call.body).get('code') === code)
    return { ...context, exchanging }
  }

  it('keeps the newer sign-in working when the one a sign-in or a sign-out stopped was still trading its code', async () => {
    for (const between of ['nothing', 'signOut'] as const) {
      const grants = grantingGoogle(new Promise((resolve) => setTimeout(resolve, 200)))
      const google = fakeGoogle(grants.route)
      const tokens = memoryTokens(null)
      const { auth, exchanging } = consentingAtOnce(google, tokens)
      const first = auth.signIn().catch((error: unknown) => error)
      await vi.waitFor(() => expect(exchanging('first')).toBe(true))
      if (between === 'signOut') await auth.signOut()
      await auth.signIn()
      expect(await first).toBeInstanceOf(SignInReplaced)
      expect(tokens.value).toBe('refresh-second')
      auth.forgetAccessToken('access-second')
      await expect(auth.accessToken()).resolves.toBe('access-renewed')
    }
  })

  it('opens the browser for a newer sign-in at once while the one it replaced is still trading its code', async () => {
    let release!: () => void
    const grants = grantingGoogle(new Promise<void>((resolve) => (release = resolve)))
    const google = fakeGoogle(grants.route)
    const tokens = memoryTokens(null)
    const { auth, openBrowser, exchanging } = consentingAtOnce(google, tokens)
    const first = auth.signIn().catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(exchanging('first')).toBe(true))
      const second = auth.signIn()
      await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2))
      await second
      expect(tokens.value).toBe('refresh-second')
    } finally {
      release()
    }
    expect(await first).toBeInstanceOf(SignInReplaced)
    expect(tokens.value).toBe('refresh-second')
  })

  it('opens no browser for a sign-in stopped while its loopback server was starting', async () => {
    const { auth, openBrowser } = calendarWith(fakeGoogle(), memoryTokens(null))
    const signingIn = auth.signIn().catch((error: unknown) => error)
    await auth.signOut()
    expect(await signingIn).toBeInstanceOf(SignInReplaced)
    expect(openBrowser).not.toHaveBeenCalled()
  })
})

describe('the Google sign-in over time', () => {
  it('renews an access token near its expiry with the refresh token, once for requests made together', async () => {
    let now = Date.parse('2026-09-15T00:00:00Z')
    const google = fakeGoogle(refreshes, calendarList)
    const { calendar } = calendarWith(google, memoryTokens(), () => now)
    await Promise.all([calendar.status(), calendar.status()])
    expect(google.calls.filter((call) => call.url.href === GOOGLE_TOKEN_URL)).toHaveLength(1)
    expect(google.api()[0].headers.authorization).toBe('Bearer access-1')
    now += 3599_000 - 30_000
    await calendar.status()
    expect(google.calls.filter((call) => call.url.href === GOOGLE_TOKEN_URL)).toHaveLength(2)
  })

  it('reads a sign-in Google revoked as signed out and forgets it, and a read then says to sign in', async () => {
    const google = fakeGoogle((call) => (call.url.href === GOOGLE_TOKEN_URL ? json({ error: 'invalid_grant' }, 400) : undefined))
    const { calendar, tokens } = calendarWith(google)
    expect(await calendar.status()).toEqual({ signIn: 'signedOut', calendars: [], account: null })
    expect(tokens.value).toBeNull()
    await expect(calendar.events(['me@example.com'], '2026-09-15T00:00:00+09:00', '2026-09-16T00:00:00+09:00')).rejects.toThrow(
      errorText('calendar.errors.googleSignedOut')
    )
  })

  it('forgets a sign-in whose renewed access token Google still refuses, so that a new sign-in can start', async () => {
    const google = fakeGoogle(refreshes, (call) => (call.url.href.startsWith(API) ? new Response('', { status: 401 }) : undefined))
    const { calendar, auth, tokens, openBrowser } = calendarWith(google)
    expect(await calendar.status()).toMatchObject({ signIn: 'signedOut' })
    expect(auth.signInState()).toBe('signedOut')
    expect(tokens.value).toBeNull()
    void calendar.requestAccess().catch(() => undefined)
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce())
    await auth.signOut()
  })

  it('signs out by revoking the refresh token at Google and forgetting it', async () => {
    const google = fakeGoogle((call) => (call.url.href === GOOGLE_REVOKE_URL ? new Response('', { status: 200 }) : undefined))
    const { calendar, tokens } = calendarWith(google)
    expect(await calendar.signOut()).toMatchObject({ signIn: 'signedOut' })
    expect(new URLSearchParams(google.calls[0].body).get('token')).toBe('refresh-1')
    expect(tokens.value).toBeNull()
  })
})

describe('Google events as ASIST reads them', () => {
  const calendar = { id: 'me@example.com', title: 'me@example.com', timeZone: 'America/New_York', writable: true }

  it('keeps a timed event at its instant and in its own time zone, or its calendar zone when it has none', () => {
    const event = toCalendarEvent(timed, calendar)
    expect(event).toMatchObject({
      id: googleEventKey('me@example.com', 'ev1'),
      start: Date.parse('2026-09-15T01:00:00Z'),
      end: Date.parse('2026-09-15T02:00:00Z'),
      allDay: false,
      timeZone: 'Asia/Tokyo',
      revision: '"3000"',
      notes: '議題'
    })
    const zoneless = toCalendarEvent({ ...timed, start: { dateTime: '2026-09-15T10:00:00+09:00' }, end: { dateTime: '2026-09-15T11:00:00+09:00' } }, calendar)
    expect(zoneless.timeZone).toBe('America/New_York')
  })

  it('places an all-day event on its days at midnight of this computer, ending at midnight after the last day', () => {
    const trip = { ...timed, id: 'ev2', start: { date: '2026-09-23' }, end: { date: '2026-09-25' } }
    for (const zone of ['Asia/Tokyo', 'America/Los_Angeles']) {
      const event = withZone(zone, () => toCalendarEvent(trip, calendar))
      expect(event.allDay).toBe(true)
      expect(event.timeZone).toBe(zone)
      expect(withZone(zone, () => [new Date(event.start).getDate(), new Date(event.start).getHours(), new Date(event.end).getDate()])).toEqual([23, 0, 25])
    }
  })

  it('marks an occurrence of a repeating event, an invitation and an event type Google does not let ASIST edit', () => {
    expect(toCalendarEvent({ ...timed, recurringEventId: 'base' }, calendar).recurring).toBe(true)
    expect(toCalendarEvent({ ...timed, attendees: [{ email: 'a@example.com' }] }, calendar).hasAttendees).toBe(true)
    expect(toCalendarEvent({ ...timed, eventType: 'outOfOffice' }, calendar).writable).toBe(false)
    expect(toCalendarEvent(timed, { ...calendar, writable: false }).writable).toBe(false)
  })
})

describe('the Google calendar through CalendarService', () => {
  const settings = { enabled: true, readCalendarIds: ['me@example.com', 'team@group.calendar.google.com'], writeCalendarId: 'me@example.com' }
  const fields = {
    title: '打合せ(変更)',
    start: '2026-09-15T13:00:00+09:00',
    end: '2026-09-15T14:00:00+09:00',
    allDay: false,
    timeZone: 'Asia/Tokyo',
    location: '',
    notes: ''
  }
  const getsEvent: Route = (call) =>
    call.method === 'GET' && call.url.pathname === `/calendar/v3/calendars/me%40example.com/events/ev1` ? json(timed) : undefined
  /** The calendar's own fields of its events page, which is how Google answers a request for those fields alone. */
  const getsCalendar: Route = (call) =>
    call.method === 'GET' && call.url.pathname === '/calendar/v3/calendars/me%40example.com/events'
      ? json({ summary: 'me@example.com', timeZone: 'Asia/Tokyo', accessRole: 'owner' })
      : undefined

  function serviceWith(google: ReturnType<typeof fakeGoogle>, approve = true) {
    const { calendar } = calendarWith(google)
    const confirm = vi.fn(async () => approve)
    return { service: new CalendarService({ settings: () => settings, calendar, confirm }), confirm }
  }

  // The daily quota of the project cannot be raised, so one use reads at most the status and one page of
  // events per chosen calendar, whatever else the reading does.
  it('reads the calendar screen with no more than the status and one request per chosen calendar', async () => {
    const google = fakeGoogle(refreshes, calendarList, eventsOf('me@example.com', [timed]), eventsOf('team@group.calendar.google.com', []))
    const { service } = serviceWith(google)
    expect(await service.status()).toMatchObject({ signIn: 'signedIn', account: 'me@example.com' })
    const events = await service.list({ start: '2026-08-31T00:00:00+09:00', end: '2026-10-12T00:00:00+09:00' })
    expect(events.map((event) => event.title)).toEqual(['打合せ'])
    expect(google.api().length).toBeLessThanOrEqual(1 + settings.readCalendarIds.length)
  })

  it('asks Google for the occurrences of repeating events, not their rules', async () => {
    const google = fakeGoogle(refreshes, eventsOf('me@example.com', []), eventsOf('team@group.calendar.google.com', []))
    const { service } = serviceWith(google)
    await service.list({ start: '2026-09-14T00:00:00+09:00', end: '2026-09-21T00:00:00+09:00' })
    for (const call of google.api()) expect(call.url.searchParams.get('singleEvents')).toBe('true')
  })

  it('follows the pages of a long calendar and keeps every event', async () => {
    const pages: Route = (call) => {
      if (!call.url.pathname.endsWith('/events') || call.method !== 'GET') return undefined
      const second = call.url.searchParams.get('pageToken') === 'page-2'
      const item = { ...timed, id: second ? 'ev-b' : 'ev-a', summary: second ? '二つ目' : '一つ目' }
      return json({ summary: 'me@example.com', timeZone: 'Asia/Tokyo', accessRole: 'owner', items: [item], ...(second ? {} : { nextPageToken: 'page-2' }) })
    }
    const { calendar } = calendarWith(fakeGoogle(refreshes, pages))
    const events = await calendar.events(['me@example.com'], '2026-09-14T00:00:00+09:00', '2026-09-21T00:00:00+09:00')
    expect(events.map((event) => event.title).sort()).toEqual(['一つ目', '二つ目'])
  })

  it('sends a request again once with a renewed access token when Google refuses the first with 401', async () => {
    let refused = false
    const expiredOnce: Route = (call) => {
      if (!call.url.href.startsWith(API) || refused) return undefined
      refused = true
      return new Response('', { status: 401 })
    }
    const google = fakeGoogle(expiredOnce, refreshes, calendarList, (call) =>
      call.method === 'POST' && call.url.href.startsWith(API) ? json({ ...timed, id: 'new' }) : undefined
    )
    const { service } = serviceWith(google)
    await expect(service.change({ operation: 'create', event: fields }, new AbortController().signal)).resolves.toMatchObject({ saved: true })
    expect(google.calls.filter((call) => call.url.href === GOOGLE_TOKEN_URL)).toHaveLength(2)
    expect(google.api().filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('reads nothing but sends no write before the confirmation, and one conditional write after it', async () => {
    const google = fakeGoogle(refreshes, calendarList, getsEvent, getsCalendar, (call) =>
      call.method === 'PATCH' ? json({ ...timed, etag: '"3001"', summary: fields.title, start: { dateTime: fields.start, timeZone: 'Asia/Tokyo' }, end: { dateTime: fields.end, timeZone: 'Asia/Tokyo' } }) : undefined
    )
    const { service, confirm } = serviceWith(google)
    confirm.mockImplementation(async () => {
      expect(google.api().filter((call) => call.method !== 'GET')).toHaveLength(0)
      return true
    })
    const result = await service.change({ operation: 'update', eventId: googleEventKey('me@example.com', 'ev1'), event: fields }, new AbortController().signal)
    expect(confirm).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ saved: true, event: { title: fields.title, revision: '"3001"' } })
    const writes = google.api().filter((call) => call.method !== 'GET')
    expect(writes).toHaveLength(1)
    const patch = writes[0]
    expect(patch.headers['if-match']).toBe('"3000"')
    expect(JSON.parse(patch.body)).toMatchObject({ start: { dateTime: fields.start, timeZone: 'Asia/Tokyo', date: null } })
  })

  it('turns an event changed in Google after the confirmation into changedSinceConfirm, not an unknown result', async () => {
    const google = fakeGoogle(refreshes, calendarList, getsEvent, getsCalendar, (call) =>
      call.method === 'PATCH' || call.method === 'DELETE' ? json({ error: { code: 412, message: 'Precondition Failed' } }, 412) : undefined
    )
    const { service } = serviceWith(google)
    const signal = new AbortController().signal
    const eventId = googleEventKey('me@example.com', 'ev1')
    await expect(service.change({ operation: 'update', eventId, event: fields }, signal)).rejects.toThrow(errorText('calendar.errors.changedSinceConfirm'))
    await expect(service.change({ operation: 'delete', eventId }, signal)).rejects.toThrow(errorText('calendar.errors.changedSinceConfirm'))
  })

  it('leaves the result unknown when Google fails on its side during a write', async () => {
    const google = fakeGoogle(refreshes, calendarList, (call) => (call.method === 'POST' && call.url.href.startsWith(API) ? new Response('', { status: 503 }) : undefined))
    const { service } = serviceWith(google)
    await expect(service.change({ operation: 'create', event: fields }, new AbortController().signal)).rejects.toThrow(
      errorText('calendar.errors.resultUnknown')
    )
  })

  it('writes nothing to Google when the confirmation is declined', async () => {
    const google = fakeGoogle(refreshes, calendarList, getsEvent, getsCalendar)
    const { service, confirm } = serviceWith(google, false)
    await expect(
      service.change({ operation: 'create', event: { ...fields, allDay: true, start: '2026-09-15T00:00:00+09:00', end: '2026-09-16T00:00:00+09:00' } }, new AbortController().signal)
    ).resolves.toEqual({ cancelled: true, saved: false })
    await service.change({ operation: 'delete', eventId: googleEventKey('me@example.com', 'ev1') }, new AbortController().signal)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(google.api().filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('creates an all-day event as Google dates in the event time zone', async () => {
    const google = fakeGoogle(refreshes, calendarList, (call) =>
      call.method === 'POST' && call.url.href.startsWith(API)
        ? json({ ...timed, id: 'new', summary: '休暇', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } })
        : undefined
    )
    const { service } = serviceWith(google)
    const allDay = { ...fields, title: '休暇', allDay: true, start: '2026-09-14T15:00:00Z', end: '2026-09-15T15:00:00Z' }
    await service.change({ operation: 'create', event: allDay }, new AbortController().signal)
    const post = google.api().find((call) => call.method === 'POST')!
    expect(decodeURIComponent(post.url.pathname)).toBe('/calendar/v3/calendars/me@example.com/events')
    expect(JSON.parse(post.body)).toMatchObject({ summary: '休暇', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } })
  })

  it('reports a write whose access token could not be renewed as refused, since nothing was sent', async () => {
    let now = Date.parse('2026-09-15T00:00:00Z')
    let renewals = 0
    const renewsOnce: Route = (call) => {
      if (call.url.href !== GOOGLE_TOKEN_URL) return undefined
      renewals += 1
      return renewals === 1 ? refreshes(call) : new Response('', { status: 503 })
    }
    const google = fakeGoogle(renewsOnce, calendarList)
    const { calendar } = calendarWith(google, memoryTokens(), () => now)
    const confirm = vi.fn(async () => {
      // The access token expires while the confirmation is open.
      now += 2 * 3600_000
      return true
    })
    const service = new CalendarService({ settings: () => settings, calendar, confirm })
    const error = await service.change({ operation: 'create', event: fields }, new AbortController().signal).catch((e: Error) => e)
    expect((error as Error).message).toBe(errorText('calendar.errors.googleRequestFailed', { status: 503 }))
    expect(google.api().filter((call) => call.method !== 'GET')).toHaveLength(0)
  })

  it('lists the calendars, and reads and deletes an event in the zone its list gives, when the calendar list leaves out a zone', async () => {
    // Google's API documents the zone of a calendar list entry as optional, and that of an events page as always there.
    const zonelessList: Route = (call) =>
      call.method === 'GET' && call.url.pathname === '/calendar/v3/users/me/calendarList'
        ? json({
            items: [
              { id: 'me@example.com', summary: 'me@example.com', accessRole: 'owner', primary: true },
              { id: 'team@group.calendar.google.com', summary: 'チーム', accessRole: 'writer', timeZone: 'Asia/Tokyo' }
            ]
          })
        : undefined
    const floating = { ...timed, start: { dateTime: timed.start.dateTime }, end: { dateTime: timed.end.dateTime } }
    const getsFloating: Route = (call) =>
      call.url.pathname === '/calendar/v3/calendars/me%40example.com/events/ev1' ? (call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(floating)) : undefined
    const google = fakeGoogle(refreshes, zonelessList, getsFloating, eventsOf('me@example.com', [floating]), eventsOf('team@group.calendar.google.com', []))
    const { service } = serviceWith(google)
    expect(await service.status()).toEqual({
      signIn: 'signedIn',
      calendars: [
        { id: 'me@example.com', title: 'me@example.com', writable: true },
        { id: 'team@group.calendar.google.com', title: 'チーム', writable: true }
      ],
      account: 'me@example.com'
    })
    const [listed] = await service.list({ start: '2026-09-14T00:00:00+09:00', end: '2026-09-21T00:00:00+09:00' })
    expect(listed.timeZone).toBe('Asia/Tokyo')
    expect(await calendarWith(google).calendar.event(listed.id)).toEqual(listed)
    await expect(service.change({ operation: 'delete', eventId: listed.id }, new AbortController().signal)).resolves.toMatchObject({ saved: true })
  })

  it('finds no event in a cancelled occurrence Google returns without its times', async () => {
    const cancelled: Route = (call) =>
      call.method === 'GET' && call.url.pathname.includes('/events/') ? json({ id: 'ev1_20260915T010000Z', etag: '"9"', status: 'cancelled', recurringEventId: 'ev1' }) : undefined
    const { calendar } = calendarWith(fakeGoogle(refreshes, getsCalendar, cancelled))
    await expect(calendar.event(googleEventKey('me@example.com', 'ev1_20260915T010000Z'))).rejects.toThrow(errorText('calendar.errors.eventNotFound'))
  })

  it('refuses to change one occurrence of a repeating event before asking for the confirmation', async () => {
    const occurrence: Route = (call) =>
      call.method === 'GET' && call.url.pathname.includes('/events/') ? json({ ...timed, id: 'ev1_20260915T010000Z', recurringEventId: 'ev1' }) : undefined
    const google = fakeGoogle(refreshes, calendarList, getsCalendar, occurrence)
    const { service, confirm } = serviceWith(google)
    await expect(
      service.change({ operation: 'delete', eventId: googleEventKey('me@example.com', 'ev1_20260915T010000Z') }, new AbortController().signal)
    ).rejects.toThrow(errorText('calendar.errors.locked'))
    expect(confirm).not.toHaveBeenCalled()
  })
})
