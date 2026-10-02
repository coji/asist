import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeatherData } from '@shared/weather'
import { readErrorText } from '@shared/i18n/error-text'
import geocoding from './fixtures/weather/munich-geocoding.json'
import forecast from './fixtures/weather/munich-forecast.json'
import fahrenheit from './fixtures/weather/munich-forecast-fahrenheit.json'
import namesakeAnswers from './fixtures/weather/namesakes-geocoding.json'

/**
 * The recorded answers stand in for the network: the geocoding one holds the three places called Munich
 * that Open-Meteo returns, and the forecast ones hold two September days of Munich in each set of units.
 * The namesakes are the geocoding's answers of 2026-10-02 for names that several countries share, keyed
 * by the language asked in and the name.
 */
const namesakes = namesakeAnswers as Record<string, { results: unknown[] }>

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
