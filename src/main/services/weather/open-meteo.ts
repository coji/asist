import type { PromptText } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import {
  placeCardId,
  wmoCondition,
  zonedDate,
  zonedHour,
  type GlobalWeatherLocation,
  type WeatherData,
  type WeatherDay
} from '@shared/weather'
import { WeatherCache } from './cache'
import { WeatherIssueError } from './issue'

/**
 * The weather anywhere outside Japan, from Open-Meteo (https://open-meteo.com). It needs no key and
 * publishes under CC BY 4.0, which the card's footer credits. It names the sky with the weather codes
 * of WMO table 4677 and has neither a written overview nor warnings, so the card leaves those out
 * rather than inventing them.
 */

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
/** How far ahead the card shows, which is the seven columns of its weekly row. */
const DAYS = 7
/** The step of the hourly row, which is the step the card of Japan already draws. */
const HOURS_STEP = 3

const cache = new WeatherCache()

/** What the model is told when the geocoding knows no place of the name, in both prompt languages. */
const NOT_FOUND_HINT: PromptText = {
  ja: 'その名前の場所が見つかりません。どこの天気か、都市名と国名をユーザーに確かめてください。',
  en: 'No place has that name. Ask the user which city and country they mean.'
}
const json = (text: string): Record<string, unknown> => {
  const data: unknown = JSON.parse(text)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(errorText('cardsWeather.errors.badData'))
  return data as Record<string, unknown>
}

interface GeocodingResult {
  name?: unknown
  latitude?: unknown
  longitude?: unknown
  timezone?: unknown
  country?: unknown
  country_code?: unknown
  admin1?: unknown
  population?: unknown
}
const text =(value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Open-Meteo writes miles per hour as "mp/h" (seen on 2026-09-22); everyone else writes mph. The other units are passed on as they are. */
const windUnit = (unit: string | null): string | null => (unit === 'mp/h' ? 'mph' : unit)

/** A place as Open-Meteo's geocoding knows it, with the zone its clock keeps. */
export type GeocodedPlace = Omit<GlobalWeatherLocation, 'source' | 'requested' | 'cardId'>

/** The request for the places a name may stand for, named in the language given. */
export const geocodingUrl = (name: string, language: string): string =>
  `${GEOCODING}?name=${encodeURIComponent(name.trim())}&count=10&language=${encodeURIComponent(language)}&format=json`

/**
 * How many times smaller than the first result a place in the user's region may be and still be taken
 * instead of it. In the geocoding's answers of 2026-10-02, the places a user of the region most likely
 * means were at most 7.1 times smaller (Kingston, Ontario beside Kingston, Jamaica; Córdoba in Spain beside
 * the one in Argentina; Birmingham, Alabama beside the English one), and the namesakes of world cities at
 * least 14.8 times (Guadalajara in Spain beside the Mexican one; London, Ontario 21 times; Paris, Texas 86).
 */
const REGION_PLACE_MAX_SHORTFALL = 10

/**
 * The place a name stands for, from the `results` of the geocoding's answer, or null when none of them
 * will do. A result without a zone is passed over, because neither a clock nor a forecast can be read
 * for it, and the geocoding gives such results (Coral Sea Marine Park came first and without one on
 * 2026-10-02). The geocoding answers with the best match first. A place in the user's own region is
 * taken instead only when it is about as large, because a namesake in the region is what the user means
 * when the two are comparable (Cambridge for an American), but a small town named after a world city is
 * not what anyone asks the time or the weather of. A place without a population counts as empty, so a
 * hill called Tokyo never stands beside Tokyo. A name with its country after a comma ("Paris, France")
 * is resolved by the geocoding itself.
 */
export function chooseGeocoded(results: unknown, region: string): GeocodedPlace | null {
  const usable = (Array.isArray(results) ? (results as GeocodingResult[]) : []).filter(
    (place) =>
      text(place.name) !== null &&
      number(place.latitude) !== null &&
      number(place.longitude) !== null &&
      text(place.timezone) !== null
  )
  const first = usable[0]
  if (!first) return null
  const population = (place: GeocodingResult): number => number(place.population) ?? 0
  const chosen =
    usable.find(
      (place) =>
        place.country_code === region &&
        population(place) * REGION_PLACE_MAX_SHORTFALL >= population(first)
    ) ?? first
  return {
    timeZone: text(chosen.timezone)!,
    name: text(chosen.name)!,
    admin: text(chosen.admin1),
    country: text(chosen.country),
    countryCode: text(chosen.country_code),
    latitude: number(chosen.latitude)!,
    longitude: number(chosen.longitude)!
  }
}

export async function geocodePlace(
  requested: string,
  language: string,
  region: string,
  signal: AbortSignal
): Promise<GlobalWeatherLocation> {
  const results = await cache.read(geocodingUrl(requested, language), 24 * 3600_000, signal, (body) => json(body).results)
  const place = chooseGeocoded(results, region)
  if (!place)
    throw new WeatherIssueError({ status: 'location_not_found', requestedLocation: requested, hint: NOT_FOUND_HINT })
  return { source: 'open-meteo', requested, cardId: placeCardId(requested), ...place }
}

interface Series {
  time: string[]
  [field: string]: unknown
}
const series = (value: unknown): Series => {
  const found = value as Series | undefined
  if (!found || !Array.isArray(found.time)) throw new Error(errorText('cardsWeather.errors.badData'))
  return found
}
const column = (from: Series, field: string): unknown[] =>
  Array.isArray(from[field]) ? (from[field] as unknown[]) : []

/** `+09:00` for the offset the forecast's own hours are written in, which its times carry no sign of. */
function offsetTag(seconds: number): string {
  const pad = (value: number): string => String(Math.floor(value)).padStart(2, '0')
  return `${seconds < 0 ? '-' : '+'}${pad(Math.abs(seconds) / 3600)}:${pad((Math.abs(seconds) % 3600) / 60)}`
}
/**
 * The moment a time of the answer stands for. Open-Meteo writes times without a zone (`2026-09-21T21:30`),
 * and every one of them in the single offset of `utc_offset_seconds`, even past a change of the clocks:
 * its answer for Sydney of 2026-10-02 wrote 2026-10-04 in +10:00 throughout, with a 02:00 that Sydney's
 * clocks skip that night. The moment is right, but the date and hour as written are an hour off the
 * place's clock after the change, so the place's day and hours are read from its zone.
 */
const instant = (local: string, offset: string): string =>
  `${local}${local.length === 16 ? ':00' : ''}${offset}`

export interface GlobalWeatherRequest {
  place: string
  date: 'today' | 'tomorrow'
  /** The language the place is named in, which is the language of the conversation. */
  language: string
  /** The region the user set: it decides both which of two places of a name is meant and the units. */
  region: string
}

export async function fetchGlobalWeather(
  request: GlobalWeatherRequest,
  signal: AbortSignal
): Promise<WeatherData> {
  const location = await geocodePlace(request.place, request.language, request.region, signal)
  signal.throwIfAborted()
  // Fahrenheit and miles per hour are what the United States reads; every other region takes the
  // metric answer, which is Open-Meteo's own default.
  const imperial = request.region === 'US'
  const url =
    `${FORECAST}?latitude=${location.latitude}&longitude=${location.longitude}` +
    `&timezone=auto&forecast_days=${DAYS}` +
    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m' +
    '&hourly=temperature_2m,weather_code,precipitation_probability' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    (imperial ? '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' : '')
  const now = Date.now()
  const fetchedAt = new Date(now).toISOString()
  const data = await cache.read(url, 5 * 60_000, signal, json)
  signal.throwIfAborted()

  const offsetSeconds = number(data.utc_offset_seconds)
  const timeZone = text(data.timezone)
  if (offsetSeconds === null || timeZone === null)
    throw new Error(errorText('cardsWeather.errors.badData'))
  const offset = offsetTag(offsetSeconds)
  const daily = series(data.daily)
  const today = zonedDate(now, timeZone)
  const todayIndex = daily.time.indexOf(today)
  const targetIndex = todayIndex + (request.date === 'tomorrow' ? 1 : 0)
  const targetDate = daily.time[targetIndex]
  if (todayIndex < 0 || targetDate === undefined)
    throw new Error(errorText('cardsWeather.errors.badData'))

  const dailyCodes = column(daily, 'weather_code')
  const dailyMax = column(daily, 'temperature_2m_max')
  const dailyMin = column(daily, 'temperature_2m_min')
  const dailyPercent = column(daily, 'precipitation_probability_max')
  const days: WeatherDay[] = daily.time.map((date, i) => ({
    date,
    condition: wmoCondition(dailyCodes[i]),
    max: number(dailyMax[i]),
    min: number(dailyMin[i]),
    percent: number(dailyPercent[i])
  }))

  const hours = series(data.hourly)
  const hourCodes = column(hours, 'weather_code')
  const hourTemperature = column(hours, 'temperature_2m')
  const hourPercent = column(hours, 'precipitation_probability')
  // The card shows the target day from the hour that is still running, as the card of Japan does, in
  // steps of three hours of the place's clock, counted from that hour today and from midnight tomorrow.
  // The steps lie on that grid of the clock, so an hour the clock skips or repeats changes how many hours
  // its own step holds and never moves the steps after it: a step whose first hour is skipped begins
  // with the hour after it.
  const kept = hours.time.flatMap((local, i) => {
    const at = Date.parse(instant(local, offset))
    if (zonedDate(at, timeZone) !== targetDate || at + 3600_000 <= now) return []
    return [{ at, clock: zonedHour(at, timeZone), index: i }]
  })
  const base = request.date === 'today' && kept.length ? kept[0].clock : 0
  const steps = new Map<number, typeof kept>()
  for (const hour of kept) {
    const step = Math.floor((hour.clock - base) / HOURS_STEP)
    steps.set(step, [...(steps.get(step) ?? []), hour])
  }
  const hourly: WeatherData['hourly'] = []
  const precipitationPeriods: WeatherData['precipitationPeriods'] = []
  for (const step of steps.values()) {
    const { at, index } = step[0]
    const from = new Date(at).toISOString()
    // A step ends with its last hour, so the last step of the day ends at the place's midnight.
    const until = new Date(step[step.length - 1].at + 3600_000).toISOString()
    hourly.push({
      at: from,
      until,
      temperature: number(hourTemperature[index]),
      condition: wmoCondition(hourCodes[index])
    })
    // Open-Meteo gives a probability for each single hour, so the value shown for the period is the
    // highest of the hours it covers rather than a probability computed for the period itself.
    const inside = step
      .map((hour) => number(hourPercent[hour.index]))
      .filter((value): value is number => value !== null)
    precipitationPeriods.push({ from, to: until, percent: inside.length ? Math.max(...inside) : null })
  }

  const current = (data.current ?? {}) as Record<string, unknown>
  const currentAt = text(current.time)
  const units = (data.hourly_units ?? {}) as Record<string, unknown>
  const currentUnits = (data.current_units ?? {}) as Record<string, unknown>
  const day = days[targetIndex]
  if (!day.condition && day.max === null && day.min === null && hourly.length === 0)
    throw new Error(errorText('cardsWeather.errors.unavailable'))
  return {
    location,
    date: request.date,
    targetDate,
    fetchedAt,
    units: {
      temperature: text(units.temperature_2m) ?? '°C',
      wind: windUnit(text(currentUnits.wind_speed_10m))
    },
    // Tomorrow's card shows no reading of the present, the same rule the card of Japan follows.
    observation:
      request.date === 'today' && currentAt
        ? {
            at: instant(currentAt, offset),
            // Open-Meteo models the current hour on a grid instead of reading it off a station.
            station: null,
            temperature: number(current.temperature_2m),
            humidity: number(current.relative_humidity_2m),
            wind: {
              speed: number(current.wind_speed_10m),
              direction: number(current.wind_direction_10m)
            }
          }
        : null,
    hourly,
    temperaturePoint: null,
    precipitationPeriods,
    day,
    daily: days,
    sources: [{ product: 'forecast', url, fetchedAt, issuedAt: null, status: 'ready' }]
  }
}
