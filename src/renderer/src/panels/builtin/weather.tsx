import { useEffect, useState, type CSSProperties } from 'react'
import type { PanelSpec } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { zonedDate, zonedHour, type WeatherCondition, type WeatherData, type WeatherUnits } from '@shared/weather'
import { useT, useFormatLocale } from '@/i18n'
import { usePanelStore } from '@/state/stores'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, More } from '../primitives/Card'
import { timeFields } from '../primitives/format'
import './weather.css'

const landscapes = import.meta.glob<string>('../../assets/weather/landscapes/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})
const icons = import.meta.glob<string>('../../assets/weather/icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})
const skies = import.meta.glob<string>('../../assets/weather/conditions/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})
function asset(files: Record<string, string>, id: string): string {
  const path = Object.keys(files).find((p) => p.endsWith(`/${id}.png`))
  if (!path) throw new Error(errorText('panels.errors.weatherImageMissing', { id }))
  return files[path]
}
const weatherOf = (spec: PanelSpec): WeatherData => spec.props.weather as WeatherData
const number = (value: number | null): string => (value === null ? '—' : String(Math.round(value)))
/** The degree sign alone reads as Celsius, so only another unit is named beside the number. */
const degree = (units: WeatherUnits): string => (units.temperature === '°C' ? '°' : units.temperature)
const hour = (at: string, timeZone: string): number => zonedHour(Date.parse(at), timeZone)
/**
 * The hour a period ends at, as 24 when it ends with its day. That end is not always 0:00 on the clock:
 * where the next day's midnight is skipped (Santiago, 2025-09-07), the day ends at 1:00.
 */
const endHour = (from: string, to: string, timeZone: string): number =>
  zonedDate(Date.parse(to), timeZone) !== zonedDate(Date.parse(from), timeZone) ? 24 : hour(to, timeZone)
const time = (at: string, locale: string, timeZone: string): string =>
  new Date(at).toLocaleTimeString(locale, { ...timeFields(locale), timeZone })
const dayOf = (date: string, locale: string, fields: Intl.DateTimeFormatOptions): string =>
  new Date(`${date}T00:00:00`).toLocaleDateString(locale, fields)
const dayAfter = (date: string): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * Today's date at the place, which moves on at the place's midnight while the card stands. The card names
 * its day from it when drawn, rather than keeping the today or tomorrow of the fetch, which would name the
 * wrong day after midnight. It is read once a minute, so the word changes within a minute of midnight.
 */
function usePlaceToday(timeZone: string): string {
  const [today, setToday] = useState(() => zonedDate(Date.now(), timeZone))
  useEffect(() => {
    const read = (): void => setToday(zonedDate(Date.now(), timeZone))
    read()
    const timer = setInterval(read, 60_000)
    return () => clearInterval(timer)
  }, [timeZone])
  return today
}

/** The word for the forecast's day as the place counts days now, or none once that day has passed. */
function dayWord(targetDate: string, today: string): 'cardsWeather.today' | 'cardsWeather.tomorrow' | null {
  if (targetDate === today) return 'cardsWeather.today'
  if (targetDate === dayAfter(today)) return 'cardsWeather.tomorrow'
  return null
}
/** What the card calls a sky: the source's own words, or the interface's word for the code it published. */
const conditionName = (value: WeatherCondition, t: Translate): string =>
  value.word ? t(`cardsWeather.words.${value.word}`) : (value.label ?? '')

function Condition({ value }: { value: WeatherCondition | null }): React.JSX.Element {
  const t = useT()
  if (!value) return <span aria-label={t('cardsWeather.conditionMissing')}>—</span>
  const name = conditionName(value, t)
  const label = t('cardsWeather.conditionForecast', { condition: name })
  return (
    <span className="wx-icons" role="img" aria-label={label} title={name}>
      {value.icons.map((id, i) => (
        <span key={id}>
          {i > 0 && value.transition && <small aria-hidden>›</small>}
          <img src={asset(icons, id)} alt="" />
        </span>
      ))}
    </span>
  )
}

/**
 * The landscape and sky laid into the shell's backdrop. They continue under the header. Only the
 * prefectures of Japan have a landscape painted for them, so a place elsewhere keeps the sky alone.
 */
function Scene({ spec, size }: CardContext): React.JSX.Element {
  const w = weatherOf(spec)
  const appearance = w.hourly[0]?.condition?.icons[0] ?? w.day.condition?.icons[0]
  return (
    <div className="wx-scene" data-weather={appearance} data-size={size}>
      {appearance && <img className="wx-sky" src={asset(skies, appearance)} alt="" />}
      {appearance === 'clear' && <div className="wx-sun" />}
      {w.location.source === 'jma' ? (
        <img className="wx-land" src={asset(landscapes, w.location.prefectureId)} alt="" />
      ) : (
        <div className="wx-horizon" />
      )}
      <div className="wx-shade" />
    </div>
  )
}

/**
 * The note at the right of the header: when the daily forecast was issued, or, where the source
 * publishes no issue time, which of the places of that name it found.
 */
function Issued({ spec }: CardContext): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const w = weatherOf(spec)
  if (w.location.source === 'open-meteo') {
    const place = [w.location.name, w.location.admin, w.location.country].filter(Boolean)
    return <span className="wx-issued">{place.join(' · ')}</span>
  }
  const issued = w.sources.find((s) => s.product === 'forecast')?.issuedAt
  return (
    <span className="wx-issued">
      {issued
        ? t('cardsWeather.issued', { time: time(issued, locale, w.location.timeZone) })
        : t('cardsWeather.issuedMissing')}
    </span>
  )
}

/**
 * The line under the large number: when and where the present reading was taken, and the wind where the
 * source publishes one. Tomorrow's card has no present reading and says that its number is a forecast.
 */
function currentLine(w: WeatherData, locale: string, t: Translate): string {
  if (w.date !== 'today') return t('cardsWeather.forecastHigh')
  const now = w.observation
  if (!now) return t('cardsWeather.observationMissing')
  const at = time(now.at, locale, w.location.timeZone)
  const parts = [
    now.station
      ? t('cardsWeather.observed', { time: at, station: now.station })
      : t('cardsWeather.currentAt', { time: at })
  ]
  if (now.wind?.speed !== null && now.wind && w.units.wind)
    parts.push(t('cardsWeather.wind', { speed: `${number(now.wind.speed)} ${w.units.wind}` }))
  return parts.join(' · ')
}

/** The products that failed, named in the reading order of the language. */
function failedSources(products: Array<WeatherData['sources'][number]['product']>, locale: string, t: Translate): string {
  const names = products.map((product) => t(`cardsWeather.sources.${product}`))
  return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(names)
}

function WeatherBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const w = weatherOf(spec)
  const zone = w.location.timeZone
  const word = dayWord(w.targetDate, usePlaceToday(zone))
  const date = dayOf(w.targetDate, locale, { month: 'long', day: 'numeric', weekday: 'short' })
  const unit = degree(w.units)
  const setFocused = usePanelStore((s) => s.setFocused)
  const hourly = w.hourly
  const style = { '--wx-columns': Math.max(hourly.length, 1) } as CSSProperties
  const wide = size === 'l' || size === 'focus'
  const weekly = size !== 's'
  const headline = w.date === 'today' ? (w.observation?.temperature ?? null) : w.day.max
  const shown: Array<number | WeatherCondition | null> = [
    headline,
    w.day.max,
    w.day.min,
    w.day.condition,
    ...(w.observation ? [w.observation.humidity] : []),
    ...hourly.flatMap((h) => [h.temperature, h.condition]),
    ...w.precipitationPeriods.map((p) => p.percent),
    ...(weekly ? w.daily.flatMap((d) => [d.max, d.min, d.condition, ...(wide ? [d.percent] : [])]) : [])
  ]
  const hasMissing = shown.some((value) => value === null)
  const failed = w.sources.filter((s) => s.status !== 'ready')
  return (
    <div className="card wx" data-size={size}>
      <div className="wx-hero ui-on-scene">
        <h3>{w.location.requested}</h3>
        <p>{word ? t('cardsWeather.heroDate', { day: t(word), date }) : date}</p>
        <div className="wx-current">
          <strong>
            {number(headline)}
            <sup>{unit}</sup>
          </strong>
          <Condition value={w.day.condition} />
        </div>
        <div className="wx-details">
          <span>
            {number(w.day.max)}° / {number(w.day.min)}°
          </span>
          {w.observation && <span>{t('cardsWeather.humidity', { percent: number(w.observation.humidity) })}</span>}
        </div>
        <p className="wx-observation">{currentLine(w, locale, t)}</p>
      </div>
      <Box title={t('cardsWeather.hourly.title')} note={t('cardsWeather.hourly.note')}>
        {hourly.length ? (
          <div className="wx-scroll">
            <div className="wx-hours" style={style}>
              {hourly.map((h, i) => (
                <div className="wx-hour" key={h.at} style={{ gridColumn: i + 1, gridRow: 1 }}>
                  <time dateTime={h.at}>{t('cardsWeather.hourly.hour', { hour: hour(h.at, zone) })}</time>
                  <Condition value={h.condition} />
                  <b>{number(h.temperature)}°</b>
                </div>
              ))}
              {w.precipitationPeriods.map((p) => {
                const indexes = hourly.flatMap((h, i) =>
                  Date.parse(h.at) >= Date.parse(p.from) && Date.parse(h.at) < Date.parse(p.to)
                    ? [i]
                    : []
                )
                if (!indexes.length) return null
                return (
                  <div
                    className="wx-pop"
                    key={p.from}
                    style={{ gridColumn: `${indexes[0] + 1} / span ${indexes.length}`, gridRow: 2 }}
                  >
                    <span>
                      {t('cardsWeather.hourly.range', {
                        from: hour(p.from, zone),
                        to: endHour(p.from, p.to, zone)
                      })}
                    </span>
                    <b>{t('cardsWeather.hourly.rain', { percent: number(p.percent) })}</b>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <p className="card-missing">{t('cardsWeather.hourly.missing')}</p>
        )}
        {wide && w.location.source === 'jma' && (
          <p className="wx-area">
            {w.temperaturePoint
              ? t('cardsWeather.area', { area: w.location.forecastAreaName, point: w.temperaturePoint })
              : t('cardsWeather.areaOnly', { area: w.location.forecastAreaName })}
          </p>
        )}
      </Box>
      {weekly ? (
        <Box title={t('cardsWeather.weekly.title')}>
          {w.daily.length ? (
            <div className="wx-scroll">
              <div className="wx-week">
                {w.daily.map((d) => (
                  <div key={d.date}>
                    <time dateTime={d.date}>
                      {dayOf(d.date, locale, { weekday: 'short' })}
                      <small>{dayOf(d.date, locale, { month: 'numeric', day: 'numeric' })}</small>
                    </time>
                    <Condition value={d.condition} />
                    <b>
                      {number(d.max)}°<em>/{number(d.min)}°</em>
                    </b>
                    {wide && <small>{number(d.percent)}%</small>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="card-missing">{t('cardsWeather.weekly.missing')}</p>
          )}
        </Box>
      ) : (
        <More onClick={() => setFocused(spec.key)} label={t('cardsWeather.weekly.moreLabel')}>
          {t('cardsWeather.weekly.more')}
        </More>
      )}
      {failed.length > 0 && (
        <p className="card-missing" role="status">
          {t('cardsWeather.sourcesMissing', { sources: failedSources(failed.map((s) => s.product), locale, t) })}
        </p>
      )}
      <footer className="wx-footer">
        <span>
          {w.location.source === 'jma' ? (
            <a href="https://www.jma.go.jp/bosai/forecast/" target="_blank" rel="noreferrer">
              {t('cardsWeather.attribution')}
            </a>
          ) : (
            <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
              {t('cardsWeather.attributionOpenMeteo')}
            </a>
          )}
          {hasMissing && <small> · {t('cardsWeather.missingMark')}</small>}
        </span>
        <span>{t('cardsWeather.processed')}</span>
      </footer>
    </div>
  )
}

export const weatherCard: CardDefinition = {
  Body: WeatherBody,
  kicker: 'WEATHER',
  className: 'wx-card',
  meta: Issued,
  backdrop: Scene
}
