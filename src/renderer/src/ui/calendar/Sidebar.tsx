import { Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { CSSProperties } from 'react'
import { addDays, dayKey, daysInMonth, firstOfMonth, mondayOf, sameDay } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { dayClasses, fmtMonth, weekHead } from './format'
import type { CalendarAccount } from '@shared/calendar'

/** The create button, the mini calendar and the list of calendars. */
export function Sidebar({
  miniCursor,
  selected,
  today,
  calendars,
  colors,
  hidden,
  onMini,
  onSelectDay,
  onToggle,
  onCreate
}: {
  miniCursor: Date
  selected: Date
  today: Date
  calendars: CalendarAccount[]
  colors: Map<string, string>
  hidden: ReadonlySet<string>
  onMini: (months: number) => void
  onSelectDay: (day: Date) => void
  onToggle: (calendarId: string) => void
  onCreate: (el: HTMLElement) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const first = firstOfMonth(miniCursor)
  const rows = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth(first)) / 7)
  const start = mondayOf(first)
  const groups = [
    { title: t('calendar.side.myCalendars'), items: calendars.filter((c) => c.writable) },
    { title: t('calendar.side.otherCalendars'), items: calendars.filter((c) => !c.writable) }
  ].filter((g) => g.items.length > 0)
  return (
    <aside className="cal-side">
      <button className="cal-create" onClick={(e) => onCreate(e.currentTarget)}>
        <Plus size={18} />
        {t('calendar.side.create')}
      </button>
      <div className="cal-mini">
        <div className="cal-mini-head">
          <span>{fmtMonth(locale, first)}</span>
          <span className="cal-mini-nav">
            <button aria-label={t('calendar.side.previousMonth')} onClick={() => onMini(-1)}>
              <ChevronLeft size={14} />
            </button>
            <button aria-label={t('calendar.side.nextMonth')} onClick={() => onMini(1)}>
              <ChevronRight size={14} />
            </button>
          </span>
        </div>
        <div className="cal-mini-grid">
          {weekHead(locale, 'narrow').map((w, i) => (
            <span key={i}>{w}</span>
          ))}
          {Array.from({ length: rows * 7 }, (_, i) => {
            const d = addDays(start, i)
            return (
              <button
                key={dayKey(d)}
                className={`cal-mini-day${dayClasses(d, today, first)}${sameDay(d, selected) ? ' is-selected' : ''}`}
                onClick={() => onSelectDay(d)}
              >
                {d.getDate()}
              </button>
            )
          })}
        </div>
      </div>
      {groups.map((group) => (
        <div key={group.title} className="cal-side-group">
          <div className="cal-side-title">{group.title}</div>
          {group.items.map((c) => (
            <button
              key={c.id}
              className={`cal-side-item${hidden.has(c.id) ? ' is-hidden' : ''}`}
              aria-pressed={!hidden.has(c.id)}
              onClick={() => onToggle(c.id)}
            >
              <i className="cal-check" style={{ '--c': colors.get(c.id) } as CSSProperties}>
                <Check size={12} />
              </i>
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}
