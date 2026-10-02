import { z } from 'zod'
import { dateLabel, type ConversationLocale, type PromptText } from './conversation-locale'
import { bilingual } from './tool-registry'

/**
 * What a weather card holds, whichever source filled it. The Japan Meteorological Agency and Open-Meteo
 * publish different things, so a field one of them has and the other lacks is nullable and the card
 * shows what is there. Neither source's values are turned into the other's.
 */

export const weatherInputSchema = z.object({
  location: z
    .string()
    .min(1)
    .describe(
      bilingual({
        ja: '天気を知りたい場所。日本は正式な都道府県名または市区町村名(例: 北海道、札幌市、東京都府中市)。日本以外は都市名で、同名の都市があるなら国名を添える(例: Munich, Germany)。省略・通称・現在地は不可',
        en: 'The place to show the weather for. In Japan the full name of a prefecture or municipality, in Japanese or in romaji, with its prefecture after a comma when several share the name (for example "Fuchu, Tokyo"); elsewhere a city, with its country when several cities share the name (for example "Munich, Germany"). A nickname or "here" is not accepted.'
      })
    ),
  date: z.enum(['today', 'tomorrow']).default('today'),
  replacesLocation: z
    .string()
    .min(1)
    .optional()
    .describe(
      bilingual({
        ja: '地域を訂正するときだけ、置き換える直前の天気カードの地域名を指定する',
        en: 'Only when correcting the place: the place of the weather card shown just before, which this one replaces.'
      })
    )
})
export type WeatherInput = z.infer<typeof weatherInputSchema>

export type WeatherIcon = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm'

/** The sky as the interface names it, for a source that publishes a code instead of words. */
export type WeatherWord =
  | 'clear'
  | 'mainlyClear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'rimeFog'
  | 'lightDrizzle'
  | 'drizzle'
  | 'heavyDrizzle'
  | 'lightFreezingDrizzle'
  | 'freezingDrizzle'
  | 'lightRain'
  | 'rain'
  | 'heavyRain'
  | 'lightFreezingRain'
  | 'freezingRain'
  | 'lightSnow'
  | 'snow'
  | 'heavySnow'
  | 'snowGrains'
  | 'lightShowers'
  | 'showers'
  | 'violentShowers'
  | 'lightSnowShowers'
  | 'snowShowers'
  | 'thunderstorm'
  | 'thunderstormHail'
  | 'heavyThunderstormHail'

export interface WeatherCondition {
  /** The words the source published, kept as it wrote them. Null where the source publishes a code. */
  label: string | null
  /** The key the interface and the model name the sky by, for a source that publishes a code. */
  word: WeatherWord | null
  icons: WeatherIcon[]
  /** Whether the words describe a change during the period rather than one state. */
  transition: boolean
}

/**
 * The weather codes of WMO table 4677 that Open-Meteo returns, each with the word for it and the icons
 * the card already has. There is no icon for fog or for hail, so those fall to the nearest sky the set
 * draws and the word carries the rest.
 */
export const WMO_WEATHER: Record<number, { word: WeatherWord; icons: WeatherIcon[] }> = {
  0: { word: 'clear', icons: ['clear'] },
  1: { word: 'mainlyClear', icons: ['clear'] },
  2: { word: 'partlyCloudy', icons: ['clear', 'cloudy'] },
  3: { word: 'overcast', icons: ['cloudy'] },
  45: { word: 'fog', icons: ['cloudy'] },
  48: { word: 'rimeFog', icons: ['cloudy'] },
  51: { word: 'lightDrizzle', icons: ['rain'] },
  53: { word: 'drizzle', icons: ['rain'] },
  55: { word: 'heavyDrizzle', icons: ['rain'] },
  56: { word: 'lightFreezingDrizzle', icons: ['rain'] },
  57: { word: 'freezingDrizzle', icons: ['rain'] },
  61: { word: 'lightRain', icons: ['rain'] },
  63: { word: 'rain', icons: ['rain'] },
  65: { word: 'heavyRain', icons: ['rain'] },
  66: { word: 'lightFreezingRain', icons: ['rain'] },
  67: { word: 'freezingRain', icons: ['rain'] },
  71: { word: 'lightSnow', icons: ['snow'] },
  73: { word: 'snow', icons: ['snow'] },
  75: { word: 'heavySnow', icons: ['snow'] },
  77: { word: 'snowGrains', icons: ['snow'] },
  80: { word: 'lightShowers', icons: ['rain'] },
  81: { word: 'showers', icons: ['rain'] },
  82: { word: 'violentShowers', icons: ['rain'] },
  85: { word: 'lightSnowShowers', icons: ['snow'] },
  86: { word: 'snowShowers', icons: ['snow'] },
  95: { word: 'thunderstorm', icons: ['storm'] },
  96: { word: 'thunderstormHail', icons: ['storm'] },
  99: { word: 'heavyThunderstormHail', icons: ['storm'] }
}

/** The sky a weather code stands for, or null for a code the table does not name, which counts as missing. */
export function wmoCondition(code: unknown): WeatherCondition | null {
  const found = typeof code === 'number' ? WMO_WEATHER[code] : undefined
  return found ? { label: null, word: found.word, icons: found.icons, transition: false } : null
}

interface WeatherPlace {
  /** The name the call asked for, which the card shows as its heading. */
  requested: string
  /** What tells one card's place from another's: two calls that land on the same place share a card. */
  cardId: string
  /** The zone the hours of this forecast are in. The card reads its clock in it wherever the Mac stands. */
  timeZone: string
  /** The place as the source names it, which can differ from what was asked for. */
  name: string
}

/** A place of the Japan Meteorological Agency's table: a municipality, its forecast area and its station. */
export interface JmaWeatherLocation extends WeatherPlace {
  source: 'jma'
  municipalityCode: string
  prefecture: string
  prefectureId: string
  forecastAreaCode: string
  forecastAreaName: string
  officeCode: string
  stationId: string
  stationName: string
  usedRepresentative: boolean
}

/** A place anywhere, as Open-Meteo's geocoding returned it. */
export interface GlobalWeatherLocation extends WeatherPlace {
  source: 'open-meteo'
  /** The state or province and the country, so the card can say which of the places of that name it found. */
  admin: string | null
  country: string | null
  countryCode: string | null
  latitude: number
  longitude: number
}

export type WeatherLocation = JmaWeatherLocation | GlobalWeatherLocation

export interface WeatherIssue {
  status: 'location_not_found' | 'location_ambiguous' | 'location_unavailable'
  requestedLocation: string
  /** What the model is told to do next, in both prompt languages; show_weather picks the one of the turn. */
  hint: PromptText
  candidates?: Array<{ location: string; municipalityCode: string }>
}
export interface WeatherSource {
  product: 'forecast' | 'hourly' | 'observation'
  issuedAt: string | null
  fetchedAt: string
  status: 'ready' | 'missing' | 'error' | 'stale'
  url: string
  message?: string
}
export interface WeatherDay {
  date: string
  condition: WeatherCondition | null
  min: number | null
  max: number | null
  percent: number | null
}

/**
 * The units the numbers of this card carry. They are taken from what the source answered with rather
 * than from the region, so the card names what it was actually given.
 */
export interface WeatherUnits {
  temperature: string
  /** Null where the source publishes no wind. */
  wind: string | null
}

export interface WeatherData {
  location: WeatherLocation
  targetDate: string
  date: 'today' | 'tomorrow'
  fetchedAt: string
  units: WeatherUnits
  /**
   * The weather right now: a station's measurement where the source observes, and the analysis of the
   * current hour where it models. `station` is the name of the station, and null where there is none.
   */
  observation: {
    at: string
    station: string | null
    temperature: number | null
    humidity: number | null
    wind: { speed: number | null; direction: number | null } | null
  } | null
  hourly: Array<{
    at: string
    until: string
    temperature: number | null
    condition: WeatherCondition | null
  }>
  temperaturePoint: string | null
  precipitationPeriods: Array<{ from: string; to: string; percent: number | null }>
  day: WeatherDay
  daily: WeatherDay[]
  sources: WeatherSource[]
}

/** An instant as the clock of the place reads it, written like "2026-10-03 06:00". */
function placeClock(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/**
 * The weather as show_weather answers the model. Every day carries its weekday and every time is the
 * clock of the place, so the model reads them rather than works them out: given bare dates, Gemini Live
 * answered a question about Saturday from Sunday's forecast (2026-10-02), and the sources write some
 * times in UTC beside others with the place's offset, so an hour reads as the day before. What only the
 * card uses, such as the codes of the place, the icons and the addresses of the sources, is left out:
 * with it a day of Fukuoka came to 3,936 characters (2026-10-02), past the 3,000 a panel's result may
 * hold, and the result reached the model with its days cut short. The card keeps the data as fetched and
 * reads its instants in the place's zone itself.
 */
export function weatherForModel(data: WeatherData, locale: ConversationLocale) {
  const clock = (iso: string): string => placeClock(iso, data.location.timeZone)
  const date = (value: string): string => {
    const [year, month, day] = value.split('-').map(Number)
    return dateLabel(locale, new Date(year, month - 1, day))
  }
  // The words of the source, or the key a source of codes names the sky by.
  const sky = (condition: WeatherCondition | null): string | null => condition && (condition.label ?? condition.word)
  const ofDay = (day: WeatherDay) => ({ date: date(day.date), condition: sky(day.condition), min: day.min, max: day.max, percent: day.percent })
  const place = data.location
  return {
    location:
      place.source === 'jma'
        ? {
            requested: place.requested,
            name: place.name,
            prefecture: place.prefecture,
            forecastAreaName: place.forecastAreaName,
            stationName: place.stationName,
            usedRepresentative: place.usedRepresentative,
            timeZone: place.timeZone
          }
        : { requested: place.requested, name: place.name, admin: place.admin, country: place.country, timeZone: place.timeZone },
    date: data.date,
    targetDate: date(data.targetDate),
    fetchedAt: clock(data.fetchedAt),
    units: data.units,
    observation: data.observation && { ...data.observation, at: clock(data.observation.at) },
    hourly: data.hourly.map((hour) => ({ at: clock(hour.at), until: clock(hour.until), temperature: hour.temperature, condition: sky(hour.condition) })),
    temperaturePoint: data.temperaturePoint,
    precipitationPeriods: data.precipitationPeriods.map((period) => ({ from: clock(period.from), to: clock(period.to), percent: period.percent })),
    day: ofDay(data.day),
    daily: data.daily.map(ofDay),
    sources: data.sources.map((source) => ({
      product: source.product,
      issuedAt: source.issuedAt === null ? null : clock(source.issuedAt),
      status: source.status,
      ...(source.message ? { message: source.message } : {})
    }))
  }
}

/** The key of the card a place and a target date share. */
export const weatherCardKeyOf = (cardId: string, date: string): string => `weather:${cardId}:${date}`
export const weatherCardKey = (location: WeatherLocation, date: string): string =>
  weatherCardKeyOf(location.cardId, date)

/**
 * What identifies a place a worldwide forecast is asked for by name. It is the name itself, because a
 * call that replaces a card names the place it replaces and must not have to geocode it again.
 */
export const placeCardId = (requested: string): string =>
  `place:${requested.trim().toLowerCase().replace(/\s+/g, ' ')}`

export function japanDate(at: number): string {
  return new Date(at + 9 * 3600_000).toISOString().slice(0, 10)
}

/** The calendar date a moment falls on in a zone, as `YYYY-MM-DD`. */
export function zonedDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(at)
}
