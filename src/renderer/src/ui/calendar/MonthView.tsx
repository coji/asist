import { useEffect, useRef, useState } from 'react'
import type { CalendarEvent } from '@shared/calendar'
import {
  MONTH_HEADER_PX,
  MONTH_LANE_PX,
  cellPlan,
  dayKey,
  lanesForHeight,
  monthWeeks,
  weekLayout
} from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { BarChip, TimedChip, type OpenEvent } from './EventChips'
import { dayClasses, fmtDateWd, fmtMonthDay, weekHead } from './format'
import { colorOf } from './palette'

/**
 * The month view. Every week is a grid row whose first line holds the dates and whose further lines
 * hold the events. An all-day bar spans across columns, and the events with a time line up under the
 * bars of their day.
 */
export function MonthView({
  cursor,
  events,
  today,
  colors,
  onOpenEvent,
  onOpenDay,
  onCreate
}: {
  cursor: Date
  events: CalendarEvent[]
  today: Date
  colors: Map<string, string>
  onOpenEvent: OpenEvent
  onOpenDay: (day: string, el: HTMLElement) => void
  onCreate: (day: string, el: HTMLElement) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const rowsRef = useRef<HTMLDivElement>(null)
  const [lanes, setLanes] = useState(3)
  useEffect(() => {
    const rows = rowsRef.current
    if (!rows) return
    const measure = (): void => {
      const row = rows.querySelector<HTMLElement>('.cal-week-row')
      if (row) setLanes(lanesForHeight(row.clientHeight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rows)
    return () => observer.disconnect()
  }, [])

  const weeks = monthWeeks(cursor)
  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {weekHead(locale, 'short').map((w, i) => (
          <span key={i} className={i === 5 ? 'is-sat' : i === 6 ? 'is-sun' : ''}>
            {w}
          </span>
        ))}
      </div>
      <div ref={rowsRef} className="cal-month-rows" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((weekStart) => {
          const { bars, days } = weekLayout(weekStart, events)
          return (
            <div
              key={dayKey(weekStart)}
              className="cal-week-row"
              style={{ gridTemplateRows: `${MONTH_HEADER_PX}px repeat(${lanes}, ${MONTH_LANE_PX}px)` }}
            >
              {days.map((day, c) => {
                const key = dayKey(day.date)
                const cls = dayClasses(day.date, today, cursor)
                const plan = cellPlan(day, lanes)
                const column = c + 1
                return (
                  <div key={key} style={{ display: 'contents' }}>
                    <div
                      className={`cal-cell${cls}${c === 6 ? ' is-last' : ''}`}
                      style={{ gridColumn: column, gridRow: '1 / -1' }}
                      onClick={(e) => onCreate(key, e.currentTarget)}
                    />
                    <button
                      className={`cal-daynum${cls}`}
                      style={{ gridColumn: column, gridRow: 1 }}
                      aria-label={t('calendar.eventsOn', { date: fmtDateWd(locale, day.date) })}
                      onClick={(e) => onOpenDay(key, e.currentTarget)}
                    >
                      {day.date.getDate() === 1 ? fmtMonthDay(locale, day.date) : day.date.getDate()}
                    </button>
                    {plan.shown.map((event, i) => (
                      <TimedChip
                        key={event.id}
                        event={event}
                        color={colorOf(colors, event.calendarId)}
                        style={{ gridColumn: column, gridRow: day.firstFree + i + 2 }}
                        onOpen={onOpenEvent}
                      />
                    ))}
                    {plan.more > 0 && plan.moreLane !== null && (
                      <button
                        className="cal-more"
                        style={{ gridColumn: column, gridRow: plan.moreLane + 2 }}
                        onClick={(e) => onOpenDay(key, e.currentTarget)}
                      >
                        {t('common.more', { count: plan.more })}
                      </button>
                    )}
                  </div>
                )
              })}
              {bars
                .filter((bar) => bar.lane < lanes)
                .map((bar) => (
                  <BarChip
                    key={`${bar.event.id}:${bar.c0}`}
                    bar={bar}
                    color={colorOf(colors, bar.event.calendarId)}
                    style={{ gridColumn: `${bar.c0 + 1} / ${bar.c1 + 2}`, gridRow: bar.lane + 2 }}
                    onOpen={onOpenEvent}
                  />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
