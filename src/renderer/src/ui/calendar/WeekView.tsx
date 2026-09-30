import { useEffect, useRef, type MutableRefObject } from 'react'
import type { CalendarEvent } from '@shared/calendar'
import { HOUR_PX, dayKey, layoutBlocks, mondayOf, weekLayout } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { BarChip, type OpenEvent } from './EventChips'
import { dayClasses, fmtDateWd, fmtHour, fmtTimeRange, weekdayNames } from './format'
import { colorOf } from './palette'

/** The week view, with the weekdays, the dates and the all-day bars on top and the hour grid below. */
export function WeekView({
  selected,
  events,
  today,
  now,
  colors,
  scrollTop,
  onOpenEvent,
  onOpenDay,
  onCreateAllDay,
  onCreateAt
}: {
  selected: Date
  events: CalendarEvent[]
  today: Date
  now: Date
  colors: Map<string, string>
  /** Keeps the scroll position of the hour grid across a change of view. */
  scrollTop: MutableRefObject<number>
  onOpenEvent: OpenEvent
  onOpenDay: (day: string, el: HTMLElement) => void
  onCreateAllDay: (day: string, el: HTMLElement) => void
  onCreateAt: (day: string, hour: number, el: HTMLElement) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTop.current
  }, [scrollTop])

  const { bars, days, laneCount } = weekLayout(mondayOf(selected), events)
  const weekdays = weekdayNames(locale, 'short')
  const todayKey = dayKey(today)
  const rangeOf = (event: CalendarEvent): string =>
    fmtTimeRange(locale, event.start, event.end, (start, end) => t('calendar.timeRange', { start, end }))
  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <div className="cal-gutter-label">GMT{formatOffset(now)}</div>
        {days.map((day) => (
          <div key={dayKey(day.date)} className={`cal-week-day${dayClasses(day.date, today)}`}>
            <span className="wd">{weekdays[day.date.getDay()]}</span>
            <button
              className="cal-week-num"
              aria-label={t('calendar.eventsOn', { date: fmtDateWd(locale, day.date) })}
              onClick={(e) => onOpenDay(dayKey(day.date), e.currentTarget)}
            >
              {day.date.getDate()}
            </button>
          </div>
        ))}
      </div>
      <div className="cal-week-allday" style={{ gridTemplateRows: `repeat(${Math.max(1, laneCount)}, 22px)` }}>
        <div className="cal-gutter-label" style={{ gridRow: '1 / -1' }}>
          {t('calendar.allDay')}
        </div>
        {days.map((day, c) => (
          <div
            key={dayKey(day.date)}
            className="cal-allday-cell"
            style={{ gridColumn: c + 2, gridRow: '1 / -1' }}
            onClick={(e) => onCreateAllDay(dayKey(day.date), e.currentTarget)}
          />
        ))}
        {bars.map((bar) => (
          <BarChip
            key={`${bar.event.id}:${bar.c0}`}
            bar={bar}
            color={colorOf(colors, bar.event.calendarId)}
            style={{ gridColumn: `${bar.c0 + 2} / ${bar.c1 + 3}`, gridRow: bar.lane + 1 }}
            onOpen={onOpenEvent}
          />
        ))}
      </div>
      <div
        ref={scrollRef}
        className="cal-week-scroll"
        onScroll={(e) => {
          scrollTop.current = e.currentTarget.scrollTop
        }}
      >
        <div className="cal-week-grid">
          <div className="cal-gutter">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * HOUR_PX }}>
                {fmtHour(locale, i + 1)}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const key = dayKey(day.date)
            return (
              <div
                key={key}
                className={`cal-daycol${dayClasses(day.date, today)}`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const hour = Math.max(0, Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_PX)))
                  onCreateAt(key, hour, e.currentTarget)
                }}
              >
                {layoutBlocks(day.timed, day.date).map((block) => {
                  const height = Math.max(22, ((block.endMin - block.startMin) / 60) * HOUR_PX - 2)
                  const width = 100 / block.cols
                  return (
                    <button
                      key={block.event.id}
                      className={`cal-block${height < 36 ? ' is-compact' : ''}`}
                      data-event-id={block.event.id}
                      data-fit="data"
                      style={{
                        ['--c' as string]: colorOf(colors, block.event.calendarId),
                        top: (block.startMin / 60) * HOUR_PX,
                        height,
                        left: `${block.col * width}%`,
                        width: `calc(${width}% - 3px)`
                      }}
                      title={`${block.event.title} ${rangeOf(block.event)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenEvent(block.event, e.currentTarget)
                      }}
                    >
                      <b>{block.event.title}</b>
                      <span>{rangeOf(block.event)}</span>
                    </button>
                  )
                })}
                {key === todayKey && (
                  <div className="cal-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  return abs % 60 === 0 ? `${sign}${hours}` : `${sign}${hours}:${String(abs % 60).padStart(2, '0')}`
}
