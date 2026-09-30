import type { CSSProperties } from 'react'
import type { CalendarEvent } from '@shared/calendar'
import type { BarSegment } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { fmtTime, fmtTimeRange } from './format'

export type OpenEvent = (event: CalendarEvent, el: HTMLElement) => void

const tinted = (color: string, style?: CSSProperties): CSSProperties =>
  ({ ...style, '--c': color }) as CSSProperties

/** An event with a time: a colored dot, the time and the title. */
export function TimedChip({
  event,
  color,
  style,
  onOpen
}: {
  event: CalendarEvent
  color: string
  style?: CSSProperties
  onOpen: OpenEvent
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const range = fmtTimeRange(locale, event.start, event.end, (start, end) => t('calendar.timeRange', { start, end }))
  return (
    <button
      className="cal-ev is-timed"
      data-event-id={event.id}
      style={tinted(color, style)}
      title={`${event.title} ${range}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(event, e.currentTarget)
      }}
    >
      <i className="cal-ev-dot" />
      <time>{fmtTime(locale, event.start)}</time>
      <span>{event.title}</span>
    </button>
  )
}

/** An all-day event, drawn as a colored bar. An end that continues into the week before or after is squared off. */
export function BarChip({
  bar,
  color,
  style,
  onOpen
}: {
  bar: BarSegment
  color: string
  style?: CSSProperties
  onOpen: OpenEvent
}): React.JSX.Element {
  return (
    <button
      className={`cal-ev is-bar${bar.contLeft ? ' is-cont-left' : ''}${bar.contRight ? ' is-cont-right' : ''}`}
      data-event-id={bar.event.id}
      style={tinted(color, style)}
      title={bar.event.title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(bar.event, e.currentTarget)
      }}
    >
      <span>{bar.event.title}</span>
    </button>
  )
}

/** One row of the schedule view. */
export function RowChip({
  event,
  color,
  onOpen
}: {
  event: CalendarEvent
  color: string
  onOpen: OpenEvent
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  return (
    <button className="cal-ev is-row" data-event-id={event.id} style={tinted(color)} onClick={(e) => onOpen(event, e.currentTarget)}>
      <i className="cal-ev-dot" />
      <time>
        {event.allDay
          ? t('calendar.allDay')
          : fmtTimeRange(locale, event.start, event.end, (start, end) => t('calendar.timeRange', { start, end }))}
      </time>
      <span>{event.title}</span>
      {event.location && <small>{event.location}</small>}
    </button>
  )
}
