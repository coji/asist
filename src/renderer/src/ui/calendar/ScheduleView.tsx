import { useEffect, useRef } from 'react'
import type { CalendarEvent } from '@shared/calendar'
import { addDays, dayKey, daysInMonth, eventsOn, firstOfMonth } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { RowChip, type OpenEvent } from './EventChips'
import { dayClasses, fmtDateWd, fmtMonthName, fmtWeekdayLong } from './format'
import { colorOf } from './palette'

/** The schedule view. Only the days that have events are listed, by date, and opening it starts at today. */
export function ScheduleView({
  cursor,
  events,
  today,
  colors,
  onOpenEvent,
  onOpenDay
}: {
  cursor: Date
  events: CalendarEvent[]
  today: Date
  colors: Map<string, string>
  onOpenEvent: OpenEvent
  onOpenDay: (day: string, el: HTMLElement) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = ref.current
    const row = list?.querySelector<HTMLElement>('.cal-sched-day.is-today')
    if (list && row) list.scrollTop = row.offsetTop - list.offsetTop - 4
  }, [cursor])

  const first = firstOfMonth(cursor)
  const days = Array.from({ length: daysInMonth(first) }, (_, i) => addDays(first, i))
    .map((date) => ({ date, list: eventsOn(events, date) }))
    .filter((day) => day.list.length > 0)
  return (
    <div ref={ref} className="cal-schedule">
      {days.length === 0 && <div className="cal-empty">{t('calendar.schedule.empty')}</div>}
      {days.map(({ date, list }) => {
        const key = dayKey(date)
        return (
          <div key={key} className={`cal-sched-day${dayClasses(date, today)}`}>
            <div className="cal-sched-date">
              <button
                className="cal-sched-num"
                aria-label={t('calendar.eventsOn', { date: fmtDateWd(locale, date) })}
                onClick={(e) => onOpenDay(key, e.currentTarget)}
              >
                {date.getDate()}
              </button>
              <span>
                {t('calendar.schedule.dayHeading', {
                  month: fmtMonthName(locale, date),
                  weekday: fmtWeekdayLong(locale, date)
                })}
              </span>
            </div>
            <div className="cal-sched-events">
              {list.map((event) => (
                <RowChip key={event.id} event={event} color={colorOf(colors, event.calendarId)} onOpen={onOpenEvent} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
