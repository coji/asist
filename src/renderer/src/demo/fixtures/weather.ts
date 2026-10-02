import { zonedDate, type WeatherCondition, type WeatherData, type WeatherDay, type WeatherWord } from '@shared/weather'

/**
 * The fixed weather used by the demo mode and by the display tests. It is invented data written as
 * though it had been issued at 17:00 on 2026-09-15, not a real forecast. Nagano stands for today, with
 * an observation but no published high and low, and Tokyo for tomorrow, with no observation, so that
 * both shapes of the card appear. Munich stands for the worldwide source, whose card has no landscape,
 * no issue time and no station, and which names the sky by a weather code instead of in words.
 */

const condition = (
  label: string,
  icons: WeatherCondition['icons'],
  transition = false
): WeatherCondition => ({ label, word: null, icons, transition })
const coded = (word: WeatherWord, icons: WeatherCondition['icons']): WeatherCondition => ({
  label: null,
  word,
  icons,
  transition: false
})
const RAIN = condition('雨', ['rain'])
const CLOUDY = condition('くもり', ['cloudy'])
const CLEAR = condition('晴れ', ['clear'])
const RAIN_THEN_CLOUDY = condition('雨のちくもり', ['rain', 'cloudy'], true)
const CLOUDY_THEN_CLEAR = condition('くもりのち晴れ', ['cloudy', 'clear'], true)
const CLEAR_THEN_CLOUDY = condition('晴れのちくもり', ['clear', 'cloudy'], true)
const OVERCAST = coded('overcast', ['cloudy'])
const PARTLY_CLOUDY = coded('partlyCloudy', ['clear', 'cloudy'])
const LIGHT_RAIN = coded('lightRain', ['rain'])
const SHOWERS = coded('showers', ['rain'])
const MAINLY_CLEAR = coded('mainlyClear', ['clear'])

const JAPAN = '+09:00'
const at = (date: string, hour: number, offset = JAPAN): string =>
  `${date}T${String(hour).padStart(2, '0')}:00:00${offset}`
const nextDay = (date: string): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const hours = (
  date: string,
  rows: Array<[number, number, WeatherCondition]>,
  offset = JAPAN
): WeatherData['hourly'] =>
  rows.map(([h, temperature, cond]) => ({
    at: at(date, h, offset),
    until: h + 3 >= 24 ? at(nextDay(date), 0, offset) : at(date, h + 3, offset),
    temperature,
    condition: cond
  }))
const day = (
  date: string,
  cond: WeatherCondition,
  max: number | null,
  min: number | null,
  percent: number | null
): WeatherDay => ({ date, condition: cond, max, min, percent })
const week = (start: string, days: Array<[WeatherCondition, number, number, number]>): WeatherDay[] =>
  days.map(([cond, max, min, percent], i) => {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
    return day(date, cond, max, min, percent)
  })
/** The card for tomorrow fetches no observation, as in the main process, so it carries no observation entry. */
const sources = (issued: string, observed: string | null): WeatherData['sources'] => [
  {
    product: 'forecast',
    issuedAt: issued,
    fetchedAt: at('2026-09-15', 18),
    status: 'ready',
    url: 'https://www.jma.go.jp/bosai/forecast/'
  },
  {
    product: 'hourly',
    issuedAt: issued,
    fetchedAt: at('2026-09-15', 18),
    status: 'ready',
    url: 'https://www.jma.go.jp/bosai/jmatile/'
  },
  ...(observed
    ? [
        {
          product: 'observation' as const,
          issuedAt: observed,
          fetchedAt: at('2026-09-15', 18),
          status: 'ready' as const,
          url: 'https://www.jma.go.jp/bosai/amedas/'
        }
      ]
    : [])
]
const CELSIUS: WeatherData['units'] = { temperature: '°C', wind: null }

export const DEMO_WEATHER_NAGANO: WeatherData = {
  location: {
    source: 'jma',
    requested: '長野県',
    cardId: '20201',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '20201',
    name: '長野市',
    prefecture: '長野県',
    prefectureId: 'nagano',
    forecastAreaCode: '200010',
    forecastAreaName: '北部',
    officeCode: '200000',
    stationId: '48156',
    stationName: '長野',
    usedRepresentative: true
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: {
    at: at('2026-09-15', 18),
    station: '長野',
    temperature: 23.4,
    humidity: 95,
    wind: null
  },
  hourly: hours('2026-09-15', [
    [18, 24, RAIN],
    [21, 23, CLOUDY]
  ]),
  temperaturePoint: '長野',
  precipitationPeriods: [{ from: at('2026-09-15', 18), to: at('2026-09-16', 0), percent: 60 }],
  day: day('2026-09-15', RAIN_THEN_CLOUDY, null, null, 60),
  daily: week('2026-09-16', [
    [CLOUDY, 27, 21, 30],
    [CLOUDY_THEN_CLEAR, 29, 20, 20],
    [CLEAR, 30, 21, 10],
    [CLEAR, 31, 22, 10],
    [CLOUDY, 28, 22, 40],
    [RAIN, 25, 21, 70],
    [CLOUDY, 27, 20, 30]
  ]),
  sources: sources(at('2026-09-15', 17), at('2026-09-15', 18))
}

export const DEMO_WEATHER_TOKYO: WeatherData = {
  location: {
    source: 'jma',
    requested: '東京都',
    cardId: '13101',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '13101',
    name: '千代田区',
    prefecture: '東京都',
    prefectureId: 'tokyo',
    forecastAreaCode: '130010',
    forecastAreaName: '東京地方',
    officeCode: '130000',
    stationId: '44132',
    stationName: '東京',
    usedRepresentative: true
  },
  targetDate: '2026-09-16',
  date: 'tomorrow',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: null,
  hourly: hours('2026-09-16', [
    [0, 23, RAIN],
    [3, 22, RAIN],
    [6, 21, RAIN],
    [9, 22, RAIN],
    [12, 23, RAIN],
    [15, 23, RAIN],
    [18, 22, RAIN],
    [21, 21, RAIN_THEN_CLOUDY]
  ]),
  temperaturePoint: '東京',
  precipitationPeriods: [
    { from: at('2026-09-16', 0), to: at('2026-09-16', 6), percent: 80 },
    { from: at('2026-09-16', 6), to: at('2026-09-16', 12), percent: 80 },
    { from: at('2026-09-16', 12), to: at('2026-09-16', 18), percent: 80 },
    { from: at('2026-09-16', 18), to: at('2026-09-17', 0), percent: 70 }
  ],
  day: day('2026-09-16', RAIN, 24, 21, 80),
  daily: week('2026-09-16', [
    [RAIN, 24, 21, 80],
    [CLOUDY, 26, 21, 40],
    [CLEAR_THEN_CLOUDY, 29, 22, 20],
    [CLEAR, 30, 23, 10],
    [CLOUDY, 28, 23, 30],
    [RAIN, 25, 22, 60],
    [CLOUDY, 27, 21, 40]
  ]),
  sources: sources(at('2026-09-15', 17), null)
}

/** A clear day, the sample used to judge how bright the sky and the landscape look. */
export const DEMO_WEATHER_MIYAGI: WeatherData = {
  location: {
    source: 'jma',
    requested: '宮城県',
    cardId: '04100',
    timeZone: 'Asia/Tokyo',
    municipalityCode: '04100',
    name: '仙台市',
    prefecture: '宮城県',
    prefectureId: 'miyagi',
    forecastAreaCode: '040010',
    forecastAreaName: '東部',
    officeCode: '040000',
    stationId: '34392',
    stationName: '仙台',
    usedRepresentative: true
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18),
  units: CELSIUS,
  observation: {
    at: at('2026-09-15', 18),
    station: '仙台',
    temperature: 29.1,
    humidity: 52,
    wind: null
  },
  hourly: hours('2026-09-15', [
    [18, 29, CLEAR],
    [21, 26, CLEAR]
  ]),
  temperaturePoint: '仙台',
  precipitationPeriods: [{ from: at('2026-09-15', 18), to: at('2026-09-16', 0), percent: 0 }],
  day: day('2026-09-15', CLEAR, 32, 24, 0),
  daily: week('2026-09-16', [
    [CLEAR, 32, 24, 0],
    [CLEAR_THEN_CLOUDY, 31, 24, 10],
    [CLOUDY, 29, 23, 30],
    [CLOUDY_THEN_CLEAR, 30, 23, 20],
    [CLEAR, 31, 23, 10],
    [CLEAR, 32, 24, 0],
    [CLOUDY, 30, 24, 40]
  ]),
  sources: sources(at('2026-09-15', 17), at('2026-09-15', 18))
}

const BERLIN = '+02:00'
/**
 * The worldwide source works a day out from its hours, so the first day holds the light rain and the 60 per
 * cent of its 21:00 step below.
 */
const MUNICH_WEEK = week('2026-09-15', [
  [LIGHT_RAIN, 16, 12, 60],
  [PARTLY_CLOUDY, 17, 9, 10],
  [SHOWERS, 15, 8, 70],
  [OVERCAST, 14, 7, 40],
  [MAINLY_CLEAR, 18, 8, 5],
  [PARTLY_CLOUDY, 19, 10, 15],
  [LIGHT_RAIN, 16, 11, 55]
])
/** A place the worldwide source answers for: no landscape, no station, no issue time, and wind. */
export const DEMO_WEATHER_MUNICH: WeatherData = {
  location: {
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
  },
  targetDate: '2026-09-15',
  date: 'today',
  fetchedAt: at('2026-09-15', 18, BERLIN),
  units: { temperature: '°C', wind: 'km/h' },
  observation: {
    at: at('2026-09-15', 18, BERLIN),
    station: null,
    temperature: 14.8,
    humidity: 71,
    wind: { speed: 11, direction: 270 }
  },
  hourly: hours(
    '2026-09-15',
    [
      [18, 15, OVERCAST],
      [21, 13, LIGHT_RAIN]
    ],
    BERLIN
  ),
  temperaturePoint: null,
  precipitationPeriods: [
    { from: at('2026-09-15', 18, BERLIN), to: at('2026-09-15', 21, BERLIN), percent: 35 },
    { from: at('2026-09-15', 21, BERLIN), to: at('2026-09-16', 0, BERLIN), percent: 60 }
  ],
  day: MUNICH_WEEK[0],
  daily: MUNICH_WEEK,
  sources: [
    {
      product: 'forecast',
      issuedAt: null,
      fetchedAt: at('2026-09-15', 18, BERLIN),
      status: 'ready',
      url: 'https://api.open-meteo.com/v1/forecast'
    }
  ]
}

/** Picks the weather the demo shows from the utterance the user typed. */
export const demoWeatherFor = (text: string): WeatherData =>
  /Munich|ミュンヘン/i.test(text)
    ? DEMO_WEATHER_MUNICH
    : /東京/.test(text)
      ? DEMO_WEATHER_TOKYO
      : /宮城|仙台/.test(text)
        ? DEMO_WEATHER_MIYAGI
        : DEMO_WEATHER_NAGANO

/**
 * The weather moved by whole days, so that the day it was fetched on is today at the place. The card names
 * its day as today or tomorrow by the date at the place when it is drawn, so on any other day the demo
 * would show the fixed days as days gone by; the tests keep the fixed days.
 */
export function onDemoDay(weather: WeatherData, now = Date.now()): WeatherData {
  const zone = weather.location.timeZone
  const days = Math.round(
    (Date.parse(zonedDate(now, zone)) - Date.parse(zonedDate(Date.parse(weather.fetchedAt), zone))) / 86_400_000
  )
  const shift = (value: unknown): unknown => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
      return new Date(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) + value.slice(10)
    if (Array.isArray(value)) return value.map(shift)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry)]))
    return value
  }
  return shift(weather) as WeatherData
}
