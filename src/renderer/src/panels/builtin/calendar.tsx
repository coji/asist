import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { PanelSpec } from '@shared/ipc'
import type { CalendarRange } from '@shared/calendar'
import { useT } from '@/i18n'
import { usePanelStore } from '@/state/stores'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, Empty, More } from '../primitives/Card'
import { clockTime, dayLabel, relativeDayLabel, shortDayLabel } from '../primitives/format'
import './calendar.css'

/**
 * Calendar card. The events of the fetched range are listed in time order, and a listing that spans several
 * days carries a heading per day. Anything that refers to the present is drawn only when the range contains
 * now: a "いま 14:17" line or a "1件が残り" note on another day's events reads as if that day were today
 * (seen on 2026-09-21 on a Thursday listing).
 * - When the range contains now, the hero shows the next event, today's listing carries the "now" line, and
 *   events that have finished are dimmed.
 * - For a day ahead or a day past, the heading is the date with its distance from today, such as "3日後",
 *   and the hero shows the first event.
 */

/** What the summary and the heading call the range. The words the LLM reads live in `CALENDAR_RANGE_TITLES`. */
const SUBJECT = {
  today: 'calendar.card.subject.today',
  week: 'calendar.card.subject.week',
  'next-week': 'calendar.card.subject.nextWeek',
  custom: 'calendar.card.subject.custom'
} as const satisfies Record<CalendarRange | 'custom', MessageKey>

interface CardEvent {
  title: string
  start: number
  end?: number | null
  allDay: boolean
  location?: string | null
  /** The event started before the fetched range and is still going. */
  ongoing?: boolean
}
interface CalendarProps {
  range?: CalendarRange | 'custom'
  /** The fetched window. The dates in the heading come from it, because the card computes no window of its own. */
  fromMs?: number
  untilMs?: number
  query?: string
  events?: CardEvent[]
}

const LIMIT: Record<CardContext['size'], number> = { l: 8, m: 6, s: 4, focus: Infinity }
const propsOf = (spec: PanelSpec): CalendarProps => spec.props as unknown as CalendarProps
const endOf = (event: CardEvent): number => event.end ?? event.start
const dayKey = (at: number): string => new Date(at).toDateString()

function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function CalendarBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const props = propsOf(spec)
  const range = props.range ?? 'today'
  const events = [...(props.events ?? [])].sort((a, b) => a.start - b.start)
  const setFocused = usePanelStore((s) => s.setFocused)
  const now = useNow()
  const { fromMs, untilMs } = props
  const single = range === 'today' || (fromMs !== undefined && untilMs !== undefined && dayKey(fromMs) === dayKey(untilMs - 1))
  // When the props carry no range, today and this week are taken to contain now and next week is not.
  const containsNow = fromMs === undefined || untilMs === undefined ? range !== 'next-week' : fromMs <= now && now < untilMs
  const ahead = !containsNow && (fromMs === undefined || fromMs > now)
  const upcoming = events.find((e) => !e.allDay && e.start > now)
  const finished = containsNow ? events.filter((e) => endOf(e) <= now).length : 0
  const shown = events.slice(0, LIMIT[size])
  const rest = events.length - shown.length

  const startLabel = (event: CardEvent): string =>
    event.allDay ? t('calendar.allDay') : event.ongoing ? t('calendar.card.ongoing') : clockTime(event.start)
  // The column is as wide as its longest label, so that the titles line up whatever the language writes there:
  // "09:00" takes five columns and "12:30 p. m." eleven. 8 is the width the column has in Japanese.
  const timeWidth = Math.max(8, ...shown.map((event) => columnsOf(startLabel(event))))

  const rows: ReactNode[] = []
  let nowShown = !single || !containsNow
  let lastDay = ''
  shown.forEach((event, i) => {
    if (!single) {
      const key = dayKey(event.start)
      if (key !== lastDay) {
        lastDay = key
        rows.push(
          <li key={`day-${key}`} className="ca-day">
            {shortDayLabel(event.start)}
          </li>
        )
      }
    }
    if (!nowShown && event.start > now) {
      nowShown = true
      rows.push(<NowLine key="now" now={now} />)
    }
    // In the listing of a day that has passed every event has finished, so dimming them all would say nothing.
    const past = containsNow && endOf(event) <= now
    const current = !event.allDay && !past && event.start <= now
    rows.push(
      <li key={i} className="card-row ca-event" data-past={past || undefined} data-current={current || undefined}>
        <time className="ca-time">
          {startLabel(event)}
          {!event.allDay && !event.ongoing && event.end != null && <small>–{clockTime(event.end)}</small>}
        </time>
        <span className="card-row-main">
          <span className="card-row-title">{event.title}</span>
          {event.location && <span className="card-row-meta">{event.location}</span>}
        </span>
      </li>
    )
  })
  if (!nowShown && shown.length && rest === 0) rows.push(<NowLine key="now" now={now} />)

  const named = range !== 'custom' || fromMs === undefined || untilMs === undefined
  const subject = named ? t(SUBJECT[range]) : t(single ? 'calendar.card.subject.day' : 'calendar.card.subject.range')
  // The time of a day other than today carries its date.
  const when = (event: CardEvent): string => {
    const time = event.allDay ? t('calendar.allDay') : clockTime(event.start)
    return dayKey(event.start) === dayKey(now) || (single && !containsNow) ? time : `${shortDayLabel(event.start)} ${time}`
  }
  const first = events.find((e) => !e.allDay) ?? events[0]
  const summary = !events.length
    ? t('calendar.card.free', { subject })
    : !containsNow
      ? ahead
        ? t('calendar.card.first', { when: when(first), title: first.title })
        : t(single ? 'calendar.card.pastDay' : 'calendar.card.pastRange')
      : upcoming
        ? t('calendar.card.next', { when: when(upcoming), title: upcoming.title })
        : finished === events.length
          ? t('calendar.card.allFinished', { subject })
          : t('calendar.card.inProgress')
  const dates =
    fromMs === undefined || untilMs === undefined
      ? dayLabel(now)
      : single
        ? dayLabel(fromMs)
        : `${shortDayLabel(fromMs)} – ${shortDayLabel(untilMs - 1)}`
  // A heading of "この期間の予定" says nothing about which days, so an unnamed range uses the dates themselves.
  const title = props.query
    ? t('calendar.card.titleQuery', { query: props.query })
    : named
      ? t('calendar.card.title', { subject: t(SUBJECT[range]) })
      : t('calendar.card.titleDates', { dates })
  const under =
    !named && !props.query
      ? single
        ? relativeDayLabel(fromMs, now)
        : t('calendar.card.days', { count: Math.round((untilMs - fromMs) / 86400000) })
      : dates
  return (
    <div className="card ca" data-size={size}>
      <div className="card-hero">
        <h3>{title}</h3>
        <p>{under}</p>
        <p className="card-note">{t('calendar.card.note', { count: events.length, summary })}</p>
      </div>
      <Box
        title={t('calendar.card.box')}
        note={events.length && containsNow ? t('calendar.card.remaining', { count: events.length - finished }) : undefined}
      >
        {events.length === 0 ? (
          <Empty note={t('calendar.card.emptyNote')}>{t('calendar.card.empty')}</Empty>
        ) : (
          <ul className="card-rows" style={{ '--ca-time-width': `${timeWidth}ch` } as React.CSSProperties}>
            {rows}
          </ul>
        )}
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('calendar.card.moreLabel')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
    </div>
  )
}

/** The width of a text in the columns of a monospaced font, where a full-width character takes two. */
function columnsOf(text: string): number {
  let columns = 0
  for (const char of text) columns += /[\u1100-\uffdc]/.test(char) ? 2 : 1
  return columns
}

function NowLine({ now }: { now: number }): React.JSX.Element {
  const t = useT()
  return (
    <li className="ca-now" aria-hidden>
      <span>{t('calendar.card.now', { time: clockTime(now) })}</span>
    </li>
  )
}

function FetchedAt({ spec }: CardContext): React.JSX.Element {
  const t = useT()
  return <span className="ca-at">{t('calendar.card.fetchedAt', { time: clockTime(spec.updatedAt) })}</span>
}

export const calendarCard: CardDefinition = {
  Body: CalendarBody,
  kicker: 'CALENDAR',
  className: 'ca-card',
  meta: FetchedAt
}
