import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { weatherForModel, wmoCondition, zonedDate, type WeatherData, type WeatherDay } from '@shared/weather'
import { readErrorText } from '@shared/i18n/error-text'
import geocoding from './fixtures/weather/munich-geocoding.json'
import munichForecast from './fixtures/weather/munich-forecast.json'
import munichFahrenheit from './fixtures/weather/munich-forecast-fahrenheit.json'
import munichFallBack from './fixtures/weather/munich-forecast-fall-back.json'
import sydneyForecast from './fixtures/weather/sydney-forecast.json'
import helsinkiForecast from './fixtures/weather/helsinki-forecast-spring-forward.json'
import chathamForecast from './fixtures/weather/chatham-forecast-spring-forward.json'
import santiagoForecast from './fixtures/weather/santiago-forecast-midnight-skipped.json'
import clockChangeAnswers from './fixtures/weather/clock-change-geocoding.json'
import namesakeAnswers from './fixtures/weather/namesakes-geocoding.json'

/**
 * The recorded answers stand in for the network: the geocoding one holds the three places called Munich
 * that Open-Meteo returns, and the forecasts of Munich in each set of units are its answers of 2026-10-02
 * at 13:00 there, a day before and eight ahead as the source asks. The namesakes are the geocoding's
 * answers of 2026-10-02 for names that several countries share, keyed by the language asked in and the
 * name. Five answers hold a day on which the clocks change, each written in one offset throughout.
 * Sydney's forecast of 2026-10-02 is in the offset before its change on 2026-10-04 at 02:00. The others are
 * Open-Meteo's historical forecasts, asked for on 2026-10-02 and written in the offset each place kept
 * that day: Helsinki's around its change on 2026-03-29 at 03:00, the Chatham Islands' (Waitangi) around
 * 2025-09-28 at 02:45, Santiago's around 2025-09-07, whose midnight its clocks skip, and Munich's around
 * 2025-10-26, when its clocks went back, since no zone's clocks go back within a week of the day they were
 * recorded. The clock-change geocoding holds the answers for their names. Every forecast was recorded
 * with Open-Meteo's own daily values as well, which the source no longer asks for, so that the days it
 * works out can be compared with them. The fake service cuts each recording to the days a request asks
 * for, and the values the tests expect are read from the recordings.
 */
const namesakes = namesakeAnswers as Record<string, { results: unknown[] }>
const clockChangePlaces = clockChangeAnswers as Record<string, { results: unknown[] }>

/** The parts of a recorded forecast the tests read, and cut as the service would. */
interface Series {
  time: string[]
  [column: string]: unknown[]
}
interface Recorded {
  utc_offset_seconds: number
  timezone: string
  current?: { time: string; [field: string]: unknown }
  hourly: Series
  daily?: Series
}
const recording = (answer: unknown): Recorded => answer as Recorded
const forecast = recording(munichForecast)
const fahrenheit = recording(munichFahrenheit)
const fallBack = recording(munichFallBack)

/** `+02:00` for an offset in seconds, which the times of an answer leave out. */
function offsetTag(seconds: number): string {
  const pad = (value: number): string => String(Math.floor(value)).padStart(2, '0')
  return `${seconds < 0 ? '-' : '+'}${pad(Math.abs(seconds) / 3600)}:${pad((Math.abs(seconds) % 3600) / 60)}`
}
/** The moment a time of an answer stands for, and the time an answer writes for a moment. */
const momentOf = (answer: Recorded, local: string): number => Date.parse(`${local}:00Z`) - answer.utc_offset_seconds * 1000
const writtenAt = (answer: Recorded, at: number): string =>
  new Date(at + answer.utc_offset_seconds * 1000).toISOString().slice(0, 16)
const dateAfter = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
/** What a recording holds in a column for the hour that begins at a moment. */
const valueAt = (answer: Recorded, column: string, at: number): unknown =>
  answer.hourly[column][answer.hourly.time.indexOf(writtenAt(answer, at))]

/**
 * What Open-Meteo answers a request with, cut from a recording as the service cuts its answers: whole days
 * of the answer's one offset, from `past_days` before the day it is there by the service's clock to
 * `forecast_days` from it, as many of them as the recording holds. `ahead` sets the service's clock that
 * far ahead of the Mac's.
 */
function answerTo(url: string, answer: Recorded, ahead: number): Recorded {
  if (!answer.hourly) return answer
  const query = new URL(url).searchParams
  const today = writtenAt(answer, Date.now() + ahead).slice(0, 10)
  const first = dateAfter(today, -Number(query.get('past_days') ?? 0))
  const last = dateAfter(today, Number(query.get('forecast_days') ?? 7) - 1)
  const cut = (series: Series): Series => {
    const kept = series.time.map((time) => time.slice(0, 10) >= first && time.slice(0, 10) <= last)
    return Object.fromEntries(
      Object.entries(series).map(([column, values]) => [column, values.filter((_, i) => kept[i])])
    ) as Series
  }
  return { ...answer, hourly: cut(answer.hourly), ...(answer.daily && { daily: cut(answer.daily) }) }
}

const NOW = momentOf(forecast, forecast.current!.time) + 5 * 60_000
const TODAY = zonedDate(NOW, forecast.timezone)
const mocks = vi.hoisted(() => ({ settings: { region: 'DE', conversationLocale: 'de-DE' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))

const signal = (): AbortSignal => new AbortController().signal
beforeEach(() => {
  vi.resetModules()
  mocks.settings = { region: 'DE', conversationLocale: 'de-DE' }
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function serve(answers: { places?: unknown; days?: unknown; status?: number; ahead?: number } = {}) {
  const fetch = vi.fn(async (url: string) => {
    if (answers.status) return new Response('', { status: answers.status })
    if (url.startsWith('https://geocoding-api.'))
      return Response.json(answers.places ?? geocoding)
    return Response.json(answerTo(url, recording(answers.days ?? forecast), answers.ahead ?? 0))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const urls = (fetch: ReturnType<typeof serve>): string[] => fetch.mock.calls.map((call) => String(call[0]))

/** A date's values over its hours on the place's clock, by the rules Open-Meteo works its own days out by. */
function placeDay(answer: Recorded, date: string): WeatherDay {
  const hours = answer.hourly.time.flatMap((local, i) =>
    zonedDate(momentOf(answer, local), answer.timezone) === date ? [i] : []
  )
  const values = (column: string): number[] =>
    hours.map((i) => answer.hourly[column][i]).filter((value): value is number => typeof value === 'number')
  return {
    date,
    condition: wmoCondition(Math.max(...values('weather_code'))),
    max: Math.max(...values('temperature_2m')),
    min: Math.min(...values('temperature_2m')),
    percent: Math.max(...values('precipitation_probability'))
  }
}
/** Open-Meteo's own values of a date in a recording, which it works out over the day as it writes it. */
function openMeteoDay(answer: Recorded, date: string): WeatherDay {
  const daily = answer.daily!
  const i = daily.time.indexOf(date)
  return {
    date,
    condition: wmoCondition(daily.weather_code[i]),
    max: daily.temperature_2m_max[i] as number,
    min: daily.temperature_2m_min[i] as number,
    percent: daily.precipitation_probability_max[i] as number
  }
}
/** Whether the hours a recording writes on a date are the hours of that date on the place's clock. */
const keepsOffset = (answer: Recorded, date: string): boolean =>
  answer.hourly.time.every(
    (local) => (local.slice(0, 10) === date) === (zonedDate(momentOf(answer, local), answer.timezone) === date)
  )

/** The hour a moment reads on the clock of a zone, which is how the card reads every hour it shows. */
const clockHour = (iso: string, timeZone: string): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric' }).format(new Date(iso)))
const hoursOf = (w: WeatherData): number[] => w.hourly.map((h) => clockHour(h.at, w.location.timeZone))

/**
 * Checks that the steps of a card lie on its day at the place and follow one another from the first hour
 * shown to the midnight that ends the day, each with its chance of rain over the same hours.
 */
function expectRestOfDay(w: WeatherData): void {
  const zone = w.location.timeZone
  expect(w.hourly.filter((h) => zonedDate(Date.parse(h.at), zone) !== w.targetDate)).toEqual([])
  expect(w.precipitationPeriods.map((p) => [p.from, p.to])).toEqual(w.hourly.map((h) => [h.at, h.until]))
  expect(w.hourly.slice(1).map((h) => h.at)).toEqual(w.hourly.slice(0, -1).map((h) => h.until))
  const end = Date.parse(w.hourly.at(-1)!.until)
  expect(zonedDate(end - 1, zone)).toBe(w.targetDate)
  expect(zonedDate(end, zone)).not.toBe(w.targetDate)
}
const forecastUrl = (fetch: ReturnType<typeof serve>): string =>
  urls(fetch).find((url) => url.startsWith('https://api.open-meteo.com'))!

describe('the worldwide weather source', () => {
  it('fills the card data from one answer and names the sky by the weather code, not in words of its own', async () => {
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'de', region: 'DE' },
      signal()
    )
    expect(w.location).toEqual({
      source: 'open-meteo',
      requested: 'Munich',
      cardId: 'place:munich',
      timeZone: 'Europe/Berlin',
      name: 'München',
      admin: 'Bayern',
      country: 'Deutschland',
      countryCode: 'DE',
      latitude: 48.13743,
      longitude: 11.57549
    })
    expect(w.units).toEqual({ temperature: '°C', wind: 'km/h' })
    const current = forecast.current!
    expect(w.observation).toEqual({
      at: `${current.time}:00${offsetTag(forecast.utc_offset_seconds)}`,
      station: null,
      temperature: current.temperature_2m,
      humidity: current.relative_humidity_2m,
      wind: { speed: current.wind_speed_10m, direction: current.wind_direction_10m }
    })
    // The week runs from today, and each day's sky is the word for its weather code.
    expect(w.daily.length).toBeGreaterThan(1)
    expect(w.daily).toEqual(w.daily.map((_, n) => placeDay(forecast, dateAfter(TODAY, n))))
    expect(w.day).toEqual(w.daily[0])
    // The agency of Japan fills these two and Open-Meteo does not publish them, so they stay empty.
    expect(w.temperaturePoint).toBeNull()
    expect(w.sources).toEqual([
      {
        product: 'forecast',
        issuedAt: null,
        fetchedAt: expect.any(String),
        status: 'ready',
        url: expect.stringContaining('api.open-meteo.com')
      }
    ])
  })

  it('shows the rest of the day in the steps the card draws', async () => {
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'de', region: 'DE' },
      signal()
    )
    // The steps begin with the running hour and every three hours of the clock after it, each with the
    // temperature and sky of its first hour.
    const running = clockHour(new Date(NOW).toISOString(), forecast.timezone)
    expect(hoursOf(w)).toEqual(Array.from({ length: Math.ceil((24 - running) / 3) }, (_, k) => running + 3 * k))
    expect(w.hourly.map((h) => h.temperature)).toEqual(
      w.hourly.map((h) => valueAt(forecast, 'temperature_2m', Date.parse(h.at)))
    )
    expect(w.hourly.map((h) => h.condition)).toEqual(
      w.hourly.map((h) => wmoCondition(valueAt(forecast, 'weather_code', Date.parse(h.at))))
    )
  })

  it('gives each step the highest chance of rain of its hours', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 2 * 86_400_000)
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'tomorrow', language: 'de', region: 'DE' },
      signal()
    )
    const percent = (at: number): number => valueAt(forecast, 'precipitation_probability', at) as number
    const highest = w.precipitationPeriods.map((p) => {
      const hours = (Date.parse(p.to) - Date.parse(p.from)) / 3_600_000
      return Math.max(...Array.from({ length: hours }, (_, k) => percent(Date.parse(p.from) + k * 3_600_000)))
    })
    expect(w.precipitationPeriods.map((p) => p.percent)).toEqual(highest)
    // The recording holds a step on that day whose first hour is not its highest.
    expect(highest).not.toEqual(w.precipitationPeriods.map((p) => percent(Date.parse(p.from))))
  })

  it('ends the last step at the midnight of the place however few hours of the day are left', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(momentOf(forecast, `${TODAY}T20:20`))
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'de', region: 'DE' },
      signal()
    )
    expectRestOfDay(w)
  })

  it('covers the whole of the next day and shows no reading of the present on it', async () => {
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'tomorrow', language: 'de', region: 'DE' },
      signal()
    )
    expect(w.targetDate).toBe(dateAfter(TODAY, 1))
    expect(w.observation).toBeNull()
    expect(w.hourly).toHaveLength(8)
    expect(w.day).toEqual(placeDay(forecast, dateAfter(TODAY, 1)))
  })

  it('asks in the language of the conversation and takes the place of the region when the name has several', async () => {
    const fetch = serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const german = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'de', region: 'DE' },
      signal()
    )
    const american = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'en', region: 'US' },
      signal()
    )
    // Open-Meteo answers with the town in North Dakota first, which is what a region with no match takes.
    const french = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'fr', region: 'FR' },
      signal()
    )
    expect(german.location.name).toBe('München')
    expect(american.location).toMatchObject({ name: 'Munich', countryCode: 'US' })
    expect(french.location).toMatchObject({ name: 'Munich', countryCode: 'US' })
    expect(urls(fetch)[0]).toContain('language=de')
    expect(urls(fetch).some((url) => url.includes('language=fr'))).toBe(true)
  })

  it.each([
    ['en:Tokyo', 'US', 'JP'],
    ['en:London', 'US', 'GB'],
    ['en:London', 'CA', 'GB'],
    ['en:Paris', 'US', 'FR'],
    ['en:Berlin', 'US', 'DE'],
    ['en:Moscow', 'US', 'RU'],
    ['en:Rome', 'US', 'IT'],
    ['en:Sydney', 'US', 'AU'],
    ['en:Sydney', 'CA', 'AU'],
    ['en:Sydney', 'GB', 'AU'],
    ['en:Perth', 'GB', 'AU'],
    ['en:Seoul', 'CA', 'KR']
  ] as const)('reads %s as the world city for a user in %s, not as a small namesake of that country', async (answer, region, country) => {
    const { chooseGeocoded } = await import('../src/main/services/weather/open-meteo')
    expect(chooseGeocoded(namesakes[answer].results, region)?.countryCode).toBe(country)
  })

  it.each([
    ['en:Cambridge', 'US'],
    ['en:Hamilton', 'NZ'],
    ['en:Richmond', 'CA'],
    ['fr:Saint-Denis', 'FR']
  ] as const)('reads %s as the place in the region of a user in %s when it stands beside the first', async (answer, region) => {
    const { chooseGeocoded } = await import('../src/main/services/weather/open-meteo')
    expect(chooseGeocoded(namesakes[answer].results, region)?.countryCode).toBe(region)
  })

  it('asks the United States for its own units and shows the ones the answer carries', async () => {
    const fetch = serve({ days: fahrenheit })
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'en', region: 'US' },
      signal()
    )
    expect(forecastUrl(fetch)).toContain('temperature_unit=fahrenheit')
    expect(forecastUrl(fetch)).toContain('wind_speed_unit=mph')
    expect(forecastUrl(fetch)).toContain('timezone=auto')
    expect(w.units).toEqual({ temperature: '°F', wind: 'mph' })
    expect(w.observation?.temperature).toBe(fahrenheit.current!.temperature_2m)
  })

  it('asks every other region for the metric answer', async () => {
    const fetch = serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    await fetchGlobalWeather({ place: 'Munich', date: 'today', language: 'de', region: 'DE' }, signal())
    expect(forecastUrl(fetch)).not.toContain('temperature_unit')
    expect(forecastUrl(fetch)).not.toContain('wind_speed_unit')
  })

  it('says which place it could not find, as the table of Japan does for a name it does not know', async () => {
    serve({ places: { results: [] } })
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const { WeatherIssueError } = await import('../src/main/services/weather/issue')
    const error = (await fetchGlobalWeather({ place: 'Nowhere', date: 'today', language: 'de', region: 'DE' }, signal()).catch(
      (err: unknown) => err
    )) as InstanceType<typeof WeatherIssueError>
    expect(error).toBeInstanceOf(WeatherIssueError)
    expect(error.issue).toMatchObject({ status: 'location_not_found', requestedLocation: 'Nowhere', hint: { ja: expect.any(String), en: expect.any(String) } })
    expect(readErrorText(error.message, 'en-US')).toContain('Nowhere')
  })

  it('fails when the service cannot be reached', async () => {
    serve({ status: 503 })
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    await expect(
      fetchGlobalWeather({ place: 'Munich', date: 'today', language: 'de', region: 'DE' }, signal())
    ).rejects.toThrow('[asist:cardsWeather.errors.fetchFailed {"status":503}]')
  })

  it('fails on an answer that carries no forecast rather than showing an empty card', async () => {
    serve({ days: { utc_offset_seconds: 7200, timezone: 'Europe/Berlin' } })
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    await expect(
      fetchGlobalWeather({ place: 'Munich', date: 'today', language: 'de', region: 'DE' }, signal())
    ).rejects.toThrow('[asist:cardsWeather.errors.badData]')
  })
})

interface Answer {
  place: string
  region: string
  places: unknown
  days: Recorded
}
const MUNICH: Answer = { place: 'Munich', region: 'DE', places: geocoding, days: forecast }
const SYDNEY: Answer = { place: 'Sydney', region: 'AU', places: namesakes['en:Sydney'], days: recording(sydneyForecast) }
const HELSINKI: Answer = { place: 'Helsinki', region: 'FI', places: clockChangePlaces.Helsinki, days: recording(helsinkiForecast) }
const CHATHAM: Answer = { place: 'Waitangi', region: 'NZ', places: clockChangePlaces.Waitangi, days: recording(chathamForecast) }
const SANTIAGO: Answer = { place: 'Santiago', region: 'CL', places: clockChangePlaces.Santiago, days: recording(santiagoForecast) }
const MUNICH_FALL_BACK: Answer = { place: 'Munich', region: 'DE', places: geocoding, days: fallBack }
/**
 * The card of a place with the clock set to a moment, written with the place's offset at that moment. The
 * module is loaded afresh for each card, because its cache keeps the fetch it was loaded with.
 */
async function cardAt(now: string, date: 'today' | 'tomorrow', answer: Answer): Promise<WeatherData> {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
  serve({ places: answer.places, days: answer.days })
  vi.resetModules()
  const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
  return fetchGlobalWeather({ place: answer.place, date, language: 'en', region: answer.region }, signal())
}
/**
 * A recording as Open-Meteo would write it in another offset: the same hours under other times. Its own
 * daily values are left out, since they would be taken over other days and no test reads them here.
 */
function writtenIn(answer: Recorded, seconds: number): Recorded {
  const time = answer.hourly.time.map((local) => writtenAt({ ...answer, utc_offset_seconds: seconds }, momentOf(answer, local)))
  return { utc_offset_seconds: seconds, timezone: answer.timezone, hourly: { ...answer.hourly, time } }
}

describe('the days of the week', () => {
  it.each([
    ['Munich', MUNICH, '2026-10-02T13:05:00+02:00'],
    ['Sydney', SYDNEY, '2026-10-02T21:00:00+10:00'],
    ['Munich in the week its clocks went back', MUNICH_FALL_BACK, '2025-10-24T12:00:00+02:00'],
    ['Helsinki', HELSINKI, '2026-03-30T12:00:00+03:00'],
    ['the Chatham Islands', CHATHAM, '2025-09-29T12:00:00+13:45'],
    ['Santiago', SANTIAGO, '2025-09-08T12:00:00-03:00']
  ] as const)('works out each day of %s as Open-Meteo does where the clock keeps the offset the answer is written in', async (_, answer, now) => {
    // Today's card counts the hours that have passed too: Munich's low of 2026-10-02 came before 13:05.
    const w = await cardAt(now, 'today', answer)
    const kept = w.daily.filter((day) => keepsOffset(answer.days, day.date))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(kept.map((day) => openMeteoDay(answer.days, day.date)))
    expect(w.day).toEqual(w.daily[0])
  })

  it.each([
    // Recorded on 2026-10-02: Open-Meteo's own day ends at 23:00 with a low of 6.1, the place's 25 hours reach 6.0.
    ['the day Munich moved its clocks back, 25 hours long', MUNICH_FALL_BACK, '2025-10-25T12:00:00+02:00'],
    // Open-Meteo's own day, an hour behind the clock, has a low of 15.4, the place's day 16.1.
    ['a day after Sydney moved its clocks forward, which the answer writes in its old offset', SYDNEY, '2026-10-05T12:00:00+11:00'],
    // Open-Meteo's own day, an hour ahead of the clock, reads 2.8 and 4 per cent, the place's day 2.5 and 3.
    ['a day before Helsinki moved its clocks forward, which the answer writes in its new offset', HELSINKI, '2026-03-26T12:00:00+02:00'],
    // Open-Meteo's own day reads light rain (61) and 7.3, the place's day heavy drizzle (55) and 7.0.
    ['a day before the Chatham Islands moved their clocks forward, which the answer writes in their new offset', CHATHAM, '2025-09-26T12:00:00+12:45']
  ] as const)('works out %s over the hours of the place\'s day, not over Open-Meteo\'s', async (_, answer, now) => {
    const w = await cardAt(now, 'tomorrow', answer)
    expect(w.day).toEqual(placeDay(answer.days, w.targetDate))
    expect(w.day).not.toEqual(openMeteoDay(answer.days, w.targetDate))
    expect(w.daily[1]).toEqual(w.day)
  })

  it('shows today whole from an answer written after the clocks went back that morning', async () => {
    // Written in +01:00, the answer's day before begins at 01:00 of it on the clock, and today's first hour,
    // 00:00 in +02:00, is the last hour the answer writes on the day before.
    const answer = { ...MUNICH_FALL_BACK, days: writtenIn(fallBack, 3600) }
    const w = await cardAt('2025-10-26T12:00:00+01:00', 'today', answer)
    expect(w.day).toEqual(placeDay(fallBack, '2025-10-26'))
  })

  it('shows a week as long as any other in the week the clocks go back', async () => {
    // Written in +02:00, the answer's last day ends at 23:00 of the place's day before it.
    const ordinary = await cardAt(new Date(NOW).toISOString(), 'today', MUNICH)
    const w = await cardAt('2025-10-24T12:00:00+02:00', 'today', MUNICH_FALL_BACK)
    expect(w.daily.map((day) => day.date)).toEqual(ordinary.daily.map((_, n) => dateAfter('2025-10-24', n)))
  })

  it('shows only the days the answer holds whole, so a week that reaches the end of the answer stops short', async () => {
    // The recording's last date, 2025-11-03, holds 23 of its 24 hours.
    const w = await cardAt('2025-10-28T12:00:00+01:00', 'today', MUNICH_FALL_BACK)
    expect(w.daily.map((day) => day.date)).toEqual(['2025-10-28', '2025-10-29', '2025-10-30', '2025-10-31', '2025-11-01', '2025-11-02'])
  })

  it('keeps a whole week when an answer fetched before midnight is read from the cache after it', async () => {
    const midnight = momentOf(forecast, `${dateAfter(TODAY, 1)}T00:00`)
    vi.spyOn(Date, 'now').mockReturnValue(midnight - 2 * 60_000)
    const fetch = serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const request = { place: 'Munich', date: 'today', language: 'de', region: 'DE' } as const
    const before = await fetchGlobalWeather(request, signal())
    vi.spyOn(Date, 'now').mockReturnValue(midnight + 2 * 60_000)
    const after = await fetchGlobalWeather(request, signal())
    expect(urls(fetch).filter((url) => url.startsWith('https://api.open-meteo.com'))).toHaveLength(1)
    expect(after.daily.map((day) => day.date)).toEqual(before.daily.map((day) => dateAfter(day.date, 1)))
  })

  it('shows today when the date of the service has turned just before midnight at the place', async () => {
    // The service's clock 30 seconds ahead answers from the day it already counts as today, minus one.
    vi.spyOn(Date, 'now').mockReturnValue(momentOf(forecast, `${dateAfter(TODAY, 1)}T00:00`) - 15_000)
    serve({ ahead: 30_000 })
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather({ place: 'Munich', date: 'today', language: 'de', region: 'DE' }, signal())
    expect(w.day).toEqual(placeDay(forecast, TODAY))
  })
})

describe('a day on which the clocks change', () => {
  /**
   * The hours of another day as they read on a day whose clock skips an hour: a step that would begin with
   * the skipped hour begins with the hour after it, and every other step begins where it always does.
   */
  const skipping = (hours: number[], skipped: number | null): number[] =>
    hours.map((hour) => (hour === skipped ? hour + 1 : hour))

  it.each([
    ['Sydney moves its clocks forward at 02:00', SYDNEY, ['2026-10-02T12:00:00+10:00', '2026-10-03T12:00:00+10:00', '2026-10-04T12:00:00+11:00'], '2026-10-04', 2],
    ['Helsinki moves its clocks forward at 03:00', HELSINKI, ['2026-03-27T12:00:00+02:00', '2026-03-28T12:00:00+02:00', '2026-03-29T12:00:00+03:00'], '2026-03-29', 3],
    ['the Chatham Islands move their clocks forward at 02:45', CHATHAM, ['2025-09-26T12:00:00+12:45', '2025-09-27T12:00:00+12:45', '2025-09-28T12:00:00+13:45'], '2025-09-28', 3],
    ['Santiago skips its midnight', SANTIAGO, ['2025-09-05T12:00:00-04:00', '2025-09-06T12:00:00-04:00', '2025-09-07T12:00:00-03:00'], '2025-09-07', 0],
    ['Munich moves its clocks back', MUNICH_FALL_BACK, ['2025-10-24T12:00:00+02:00', '2025-10-25T12:00:00+02:00', '2025-10-26T12:00:00+01:00'], '2025-10-26', null]
  ] as const)('shows the day %s, and the day after, at the hours of the day before but the one it skips', async (_, answer, moments, changeDate, skipped) => {
    const [before, change, after] = [
      await cardAt(moments[0], 'tomorrow', answer),
      await cardAt(moments[1], 'tomorrow', answer),
      await cardAt(moments[2], 'tomorrow', answer)
    ]
    expect(change.targetDate).toBe(changeDate)
    expect(hoursOf(change)).toEqual(skipping(hoursOf(before), skipped))
    expect(hoursOf(after)).toEqual(hoursOf(before))
    for (const w of [before, change, after]) expectRestOfDay(w)
  })

  it.each([
    ['go forward at 02:00', SYDNEY, '2026-10-04T01:20:00+10:00', '2026-10-03T01:20:00+10:00', 2],
    ['go forward at 03:00', HELSINKI, '2026-03-29T00:20:00+02:00', '2026-03-28T00:20:00+02:00', 3],
    ['go back', MUNICH_FALL_BACK, '2025-10-26T01:20:00+02:00', '2025-10-25T01:20:00+02:00', null]
  ] as const)('shows the rest of the day from the running hour when the clocks %s later that day', async (_, answer, change, dayBefore, skipped) => {
    const w = await cardAt(change, 'today', answer)
    expect(hoursOf(w)).toEqual(skipping(hoursOf(await cardAt(dayBefore, 'today', answer)), skipped))
    expectRestOfDay(w)
  })

  it.each([
    ['Sydney', SYDNEY, '2026-10-02T12:00:00+10:00', '2026-10-03T12:00:00+10:00', 2],
    ['Helsinki', HELSINKI, '2026-03-27T12:00:00+02:00', '2026-03-28T12:00:00+02:00', 3]
  ] as const)('tells the model the hours of the day %s moves its clocks forward on the clock of the place', async (_, answer, dayBefore, change, skipped) => {
    // Each period as the hours of the place's clock it runs between, with the end of the day as 24.
    const periods = (w: WeatherData): number[][] =>
      weatherForModel(w, 'en-US').precipitationPeriods.map((period) =>
        [period.from, period.to].map((time) => (time.slice(0, 10) === w.targetDate ? Number(time.slice(11, 13)) : 24))
      )
    const before = periods(await cardAt(dayBefore, 'tomorrow', answer))
    expect(periods(await cardAt(change, 'tomorrow', answer))).toEqual(before.map((period) => skipping(period, skipped)))
  })
})

describe('the source the region chooses', () => {
  it('reads a region other than Japan from the worldwide source', async () => {
    const fetch = serve()
    const { weatherPanelProps } = await import('../src/main/services/weather')
    const { props } = await weatherPanelProps({ location: 'Munich', date: 'today' }, signal())
    const w = props.weather as WeatherData
    expect(w.location.source).toBe('open-meteo')
    expect(urls(fetch).some((url) => url.includes('jma.go.jp'))).toBe(false)
  })

  it('keeps Japan on the agency and its table of municipalities', async () => {
    mocks.settings.region = 'JP'
    const fetch = serve()
    const { weatherPanelProps } = await import('../src/main/services/weather')
    await expect(
      weatherPanelProps({ location: 'Munich', date: 'today' }, signal())
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('identifies the card of a place abroad by the name it was asked for, so a correction can replace it', async () => {
    serve()
    const { resolveWeatherCard } = await import('../src/main/services/weather')
    expect(resolveWeatherCard(' Munich ')).toEqual({ cardId: 'place:munich' })
    mocks.settings.region = 'JP'
    expect(resolveWeatherCard('東京都')).toMatchObject({ cardId: '13101' })
    expect(resolveWeatherCard('Munich')).toMatchObject({ status: 'location_not_found' })
  })
})
