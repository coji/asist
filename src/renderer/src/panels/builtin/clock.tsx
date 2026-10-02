import { useEffect, useState } from 'react'
import type { PanelSpec } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import { useT, useFormatLocale } from '@/i18n'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, Facts } from '../primitives/Card'
import './clock.css'

interface ClockProps {
  city: string
  timezone: string
  country?: string
}
type Phase = 'night' | 'dawn' | 'day' | 'dusk'
type CityKey =
  | 'tokyo' | 'london' | 'newYork' | 'losAngeles' | 'paris' | 'berlin'
  | 'singapore' | 'shanghai' | 'seoul' | 'sydney' | 'dubai' | 'honolulu'

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONE_CITY: Record<string, CityKey> = {
  'Asia/Tokyo': 'tokyo', 'Europe/London': 'london', 'America/New_York': 'newYork',
  'America/Los_Angeles': 'losAngeles', 'Europe/Paris': 'paris', 'Europe/Berlin': 'berlin',
  'Asia/Singapore': 'singapore', 'Asia/Shanghai': 'shanghai', 'Asia/Seoul': 'seoul',
  'Australia/Sydney': 'sydney', 'Asia/Dubai': 'dubai', 'Pacific/Honolulu': 'honolulu'
}
const OTHER_ZONES = ['Asia/Tokyo', 'Europe/London', 'America/New_York']

const propsOf = (spec: PanelSpec): ClockProps => spec.props as unknown as ClockProps
const pad = (n: number): string => String(n).padStart(2, '0')
/** The city's name in the interface language, falling back to the zone for a city with no name of its own. */
const cityIn = (zone: string, t: Translate): string =>
  ZONE_CITY[zone] ? t(`cardsTime.clock.cities.${ZONE_CITY[zone]}`) : zone

interface Zoned {
  hour: number
  minute: number
  second: number
  /** The date as a YYYYMMDD number, so that two days can be compared. */
  day: number
}

export function zoned(at: Date, zone: string): Zoned {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value)
  return {
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    day: get('year') * 10000 + get('month') * 100 + get('day')
  }
}

/** The zone's offset from UTC, in minutes. */
export function offsetMinutes(zone: string, at: Date): number {
  const z = zoned(at, zone)
  const y = Math.floor(z.day / 10000)
  const m = Math.floor((z.day % 10000) / 100) - 1
  const d = z.day % 100
  const asUtc = Date.UTC(y, m, d, z.hour, z.minute, z.second)
  return Math.round((asUtc - at.getTime()) / 60_000)
}

const hoursText = (minutes: number, t: Translate): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? t('cardsTime.duration.hoursMinutes', { hours: h, minutes: m }) : t('cardsTime.duration.hours', { hours: h })
}
/** A time difference, signed, or the words for no difference at all. */
export const diffLabel = (minutes: number, t: Translate): string =>
  minutes === 0 ? t('cardsTime.clock.sameTime') : `${minutes > 0 ? '+' : '−'}${hoursText(Math.abs(minutes), t)}`
const offsetLabel = (minutes: number): string => {
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${minutes >= 0 ? '+' : '−'}${h}${m ? `:${pad(m)}` : ''}`
}
export const phaseOf = (hour: number): Phase =>
  hour < 5 ? 'night' : hour < 7 ? 'dawn' : hour < 17 ? 'day' : hour < 19 ? 'dusk' : 'night'

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** The shell's backdrop: the sky of the city's time of day. */
function Sky({ spec, size }: CardContext): React.JSX.Element {
  const now = useNow(60_000)
  const phase = phaseOf(zoned(now, propsOf(spec).timezone).hour)
  return (
    <div className="ck-scene" data-phase={phase} data-size={size}>
      <i className="ck-orb" />
      <div className="ck-shade" />
    </div>
  )
}

function Offset({ spec }: CardContext): React.JSX.Element {
  return <span className="ck-offset">{offsetLabel(offsetMinutes(propsOf(spec).timezone, new Date()))}</span>
}

const dateIn = (at: Date, zone: string, locale: string): string =>
  at.toLocaleDateString(locale, { timeZone: zone, month: 'long', day: 'numeric', weekday: 'short' })

function ClockBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const { city, timezone, country } = propsOf(spec)
  const now = useNow(1000)
  const z = zoned(now, timezone)
  const local = zoned(now, LOCAL_ZONE)
  const phase = phaseOf(z.hour)
  const diff = offsetMinutes(timezone, now) - offsetMinutes(LOCAL_ZONE, now)
  const sameZone = timezone === LOCAL_ZONE
  const localCity = cityIn(LOCAL_ZONE, t)
  const localTime = `${pad(local.hour)}:${pad(local.minute)}`
  const relation =
    z.day === local.day
      ? null
      : t(z.day > local.day ? 'cardsTime.clock.dayAhead' : 'cardsTime.clock.dayBehind', { city })
  const others = OTHER_ZONES.filter((zone) => zone !== timezone)
  const showOthers = size !== 's' || sameZone
  return (
    <div className="card ck" data-size={size} data-phase={phase}>
      <div className="card-hero ui-on-scene">
        <h3>{city}</h3>
        <p>
          {country && <span>{country} · </span>}
          <b>{timezone}</b>
        </p>
        <div className="card-big">
          <strong>
            <time dateTime={now.toISOString()}>
              {pad(z.hour)}:{pad(z.minute)}
            </time>
            <small>{pad(z.second)}</small>
          </strong>
        </div>
        <p className="card-note">
          {t('cardsTime.clock.dateAndPhase', {
            date: dateIn(now, timezone, locale),
            phase: t(`cardsTime.clock.phases.${phase}`)
          })}
        </p>
      </div>
      {!sameZone && (
        <Box
          title={t('cardsTime.clock.differenceFrom', { city: localCity })}
          note={offsetLabel(offsetMinutes(timezone, now))}
        >
          <Facts
            columns={1}
            items={[
              [
                t('cardsTime.clock.timeIn', { city: localCity }),
                relation ? t('cardsTime.clock.timeWithRelation', { time: localTime, relation }) : localTime
              ],
              [t('cardsTime.clock.difference'), diffLabel(diff, t)]
            ]}
          />
        </Box>
      )}
      {showOthers && (
        <Box title={t('cardsTime.clock.otherCities')} note={t('cardsTime.clock.differenceFrom', { city })}>
          <ul className="card-rows ck-others">
            {others.map((zone) => {
              const oz = zoned(now, zone)
              return (
                <li key={zone} className="card-row">
                  <span className="ck-other-name">{cityIn(zone, t)}</span>
                  <span className="ck-other-time">
                    {pad(oz.hour)}:{pad(oz.minute)}
                  </span>
                  <span className="ck-other-diff">
                    {diffLabel(offsetMinutes(zone, now) - offsetMinutes(timezone, now), t)}
                  </span>
                </li>
              )
            })}
          </ul>
        </Box>
      )}
    </div>
  )
}

export const clockCard: CardDefinition = {
  Body: ClockBody,
  kicker: 'WORLD CLOCK',
  className: 'ck-card',
  meta: Offset,
  backdrop: Sky
}
