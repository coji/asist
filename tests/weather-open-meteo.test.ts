import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { weatherForModel, zonedDate, type WeatherData } from '@shared/weather'
import { readErrorText } from '@shared/i18n/error-text'
import geocoding from './fixtures/weather/munich-geocoding.json'
import forecast from './fixtures/weather/munich-forecast.json'
import fahrenheit from './fixtures/weather/munich-forecast-fahrenheit.json'
import fallBack from './fixtures/weather/munich-forecast-fall-back.json'
import sydney from './fixtures/weather/sydney-forecast.json'
import helsinki from './fixtures/weather/helsinki-forecast-spring-forward.json'
import chatham from './fixtures/weather/chatham-forecast-spring-forward.json'
import santiago from './fixtures/weather/santiago-forecast-midnight-skipped.json'
import clockChangeAnswers from './fixtures/weather/clock-change-geocoding.json'
import namesakeAnswers from './fixtures/weather/namesakes-geocoding.json'

/**
 * The recorded answers stand in for the network: the geocoding one holds the three places called Munich
 * that Open-Meteo returns, and the forecast ones hold two September days of Munich in each set of units.
 * The namesakes are the geocoding's answers of 2026-10-02 for names that several countries share, keyed
 * by the language asked in and the name. Five answers hold a day on which the clocks change, each written
 * in one offset throughout. Sydney's forecast of 2026-10-02 is in the offset before its change on
 * 2026-10-04 at 02:00. The others are Open-Meteo's historical forecasts, asked for on 2026-10-02 and
 * written in the offset each place kept that day: Helsinki's around its change on 2026-03-29 at 03:00, the
 * Chatham Islands' (Waitangi) around 2025-09-28 at 02:45, Santiago's around 2025-09-07, whose midnight its
 * clocks skip, and Munich's around 2025-10-26, when its clocks went back, since no zone's clocks go back
 * within a week of the day they were recorded. The clock-change geocoding holds the answers for their
 * names.
 */
const namesakes = namesakeAnswers as Record<string, { results: unknown[] }>
const clockChangePlaces = clockChangeAnswers as Record<string, { results: unknown[] }>

const NOW = Date.parse('2026-09-15T18:20:00+02:00')
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

function serve(answers: { places?: unknown; days?: unknown; status?: number } = {}) {
  const fetch = vi.fn(async (url: string) => {
    if (answers.status) return new Response('', { status: answers.status })
    if (url.startsWith('https://geocoding-api.'))
      return Response.json(answers.places ?? geocoding)
    return Response.json(answers.days ?? forecast)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const urls = (fetch: ReturnType<typeof serve>): string[] => fetch.mock.calls.map((call) => String(call[0]))

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
    expect(w.observation).toEqual({
      at: '2026-09-15T18:15:00+02:00',
      station: null,
      temperature: 15.1,
      humidity: 71,
      wind: { speed: 11.2, direction: 270 }
    })
    expect(w.day).toEqual({
      date: '2026-09-15',
      max: 16.7,
      min: 12,
      percent: 60,
      condition: { label: null, word: 'overcast', icons: ['cloudy'], transition: false }
    })
    expect(w.daily.map((d) => d.date)).toEqual([
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21'
    ])
    expect(w.daily.map((d) => d.condition?.word)).toEqual([
      'overcast',
      'partlyCloudy',
      'lightShowers',
      'overcast',
      'mainlyClear',
      'partlyCloudy',
      'lightRain'
    ])
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

  it('shows the rest of the day in the steps the card draws, and the highest chance of rain of each step', async () => {
    serve()
    const { fetchGlobalWeather } = await import('../src/main/services/weather/open-meteo')
    const w = await fetchGlobalWeather(
      { place: 'Munich', date: 'today', language: 'de', region: 'DE' },
      signal()
    )
    expect(w.hourly.map((h) => h.at)).toEqual([
      '2026-09-15T16:00:00.000Z',
      '2026-09-15T19:00:00.000Z'
    ])
    expect(w.hourly.map((h) => h.temperature)).toEqual([14.9, 13.3])
    expect(w.hourly.map((h) => h.condition?.word)).toEqual(['overcast', 'lightRain'])
    expect(w.precipitationPeriods).toEqual([
      { from: '2026-09-15T16:00:00.000Z', to: '2026-09-15T19:00:00.000Z', percent: 40 },
      { from: '2026-09-15T19:00:00.000Z', to: '2026-09-15T22:00:00.000Z', percent: 60 }
    ])
  })

  it('ends the last step at the midnight of the place however few hours of the day are left', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-15T20:20:00+02:00'))
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
    expect(w.targetDate).toBe('2026-09-16')
    expect(w.observation).toBeNull()
    expect(w.hourly).toHaveLength(8)
    expect(w.day.max).toBe(16.3)
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
    expect(w.observation?.temperature).toBe(59.2)
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

describe('a day on which the clocks change', () => {
  interface Answer {
    place: string
    region: string
    places: unknown
    days: unknown
  }
  const SYDNEY: Answer = { place: 'Sydney', region: 'AU', places: namesakes['en:Sydney'], days: sydney }
  const HELSINKI: Answer = { place: 'Helsinki', region: 'FI', places: clockChangePlaces.Helsinki, days: helsinki }
  const CHATHAM: Answer = { place: 'Waitangi', region: 'NZ', places: clockChangePlaces.Waitangi, days: chatham }
  const SANTIAGO: Answer = { place: 'Santiago', region: 'CL', places: clockChangePlaces.Santiago, days: santiago }
  const MUNICH: Answer = { place: 'Munich', region: 'DE', places: geocoding, days: fallBack }
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
    ['Munich moves its clocks back', MUNICH, ['2025-10-24T12:00:00+02:00', '2025-10-25T12:00:00+02:00', '2025-10-26T12:00:00+01:00'], '2025-10-26', null]
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
    ['go back', MUNICH, '2025-10-26T01:20:00+02:00', '2025-10-25T01:20:00+02:00', null]
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
