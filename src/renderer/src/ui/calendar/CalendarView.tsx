import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { MessageKey } from '@shared/i18n'
import type { CalendarAccount, CalendarChange, CalendarEvent, CalendarStatus } from '@shared/calendar'
import type { CalendarViewMode } from '@shared/mini-apps'
import {
  HOUR_PX,
  addDays,
  addMonths,
  firstOfMonth,
  dayKey,
  daysInMonth,
  mondayOf,
  parseDayKey,
  sameMonth,
  startOfDay,
  visibleRange
} from '@shared/calendar-layout'
import { useSettingsStore, useToastStore } from '@/state/stores'
import { useMiniApp, useViewStore } from '@/state/view'
import { keyForApp } from '@/ui/key-for-app'
import {
  Card,
  DayCard,
  EditorCard,
  EventCard,
  anchorOf,
  changeFromDraft,
  draftFromEvent,
  newDraft,
  type Anchor,
  type Draft
} from './cards'
import { fmtMonth } from './format'
import { MonthView } from './MonthView'
import { Notice } from './Notice'
import { calendarColors, colorOf } from './palette'
import { ScheduleView } from './ScheduleView'
import { Sidebar } from './Sidebar'
import { WeekView } from './WeekView'
import { useT, useFormatLocale } from '@/i18n'
import { displayError } from '@/display-error'

/** The cards other than an event's details, which the store holds as the eventId of what the calendar shows. */
type Popover = { type: 'day'; day: string; anchor: Anchor } | { type: 'editor'; draft: Draft; anchor: Anchor }

const VIEWS = [
  ['month', 'calendar.screen.month'],
  ['week', 'calendar.screen.week'],
  ['list', 'calendar.screen.list']
] as const satisfies ReadonlyArray<readonly [CalendarViewMode, MessageKey]>

/**
 * How far either side of the day the calendar is placed on an event it was asked to show is looked for,
 * when the range on screen does not hold it. main lists at most 62 days at a time.
 */
const LOOKUP_DAYS = 30

/** The same day of another month, or that month's last day when it is shorter. */
function shiftMonths(day: Date, n: number): Date {
  const month = addMonths(day, n)
  return new Date(month.getFullYear(), month.getMonth(), Math.min(day.getDate(), daysInMonth(month)))
}

/** The current time, used to decide what today is and to place the line in the week view. */
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!active) return
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function CalendarView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const openApp = useViewStore((s) => s.openApp)
  const update = useViewStore((s) => s.update)
  const { view, date, eventId } = useMiniApp('calendar')
  const settings = useSettingsStore((s) => s.settings?.calendar)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const now = useNow(open)
  const today = useMemo(() => startOfDay(now), [now])

  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const selected = useMemo(() => parseDayKey(date), [date])
  const cursor = useMemo(() => firstOfMonth(selected), [selected])
  const [miniCursor, setMiniCursor] = useState(cursor)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [popover, setPopover] = useState<Popover | null>(null)
  /** The event whose details are open, which the store names, and where they are placed. */
  const [shown, setShown] = useState<{ eventId: string; anchor: Anchor } | null>(null)
  const weekScroll = useRef(7 * HOUR_PX)
  const rootRef = useRef<HTMLDivElement>(null)

  const calendars = useMemo<CalendarAccount[]>(
    () => status?.calendars.filter((c) => settings?.readCalendarIds.includes(c.id)) ?? [],
    [status, settings]
  )
  const colors = useMemo(() => calendarColors(calendars), [calendars])
  const writeCalendar = status?.calendars.find((c) => c.id === settings?.writeCalendarId) ?? null
  const ready = Boolean(settings?.enabled) && status?.signIn === 'signedIn' && calendars.length > 0
  const range = useMemo(() => visibleRange(view, cursor, selected), [view, cursor, selected])
  // The range the events were listed for, which tells whether an event missing from them is outside the range.
  const [eventsRange, setEventsRange] = useState<typeof range | null>(null)
  const visibleEvents = useMemo(() => events.filter((e) => !hidden.has(e.calendarId)), [events, hidden])

  // The mini month moves with the day the calendar is placed on, and its own arrows move it apart.
  useEffect(() => setMiniCursor(firstOfMonth(parseDayKey(date))), [date])

  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    window.api
      .calendarStatus()
      .then((result) => active && setStatus(result))
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, revision])

  useEffect(() => {
    if (!open || !ready) return
    let active = true
    window.api
      .calendarEvents({ start: range.from.toISOString(), end: range.until.toISOString() })
      .then((list) => {
        if (!active) return
        setEvents(list)
        setEventsRange(range)
        setError('')
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, ready, range, revision])

  // An event the calendar was asked to show that the listed range does not hold is looked for around
  // the day the calendar is placed on. When found, the calendar moves to its day; when not, its details close.
  useEffect(() => {
    if (!open || !ready || !eventId || eventsRange !== range || events.some((e) => e.id === eventId)) return
    let active = true
    window.api
      .calendarEvents({ start: addDays(selected, -LOOKUP_DAYS).toISOString(), end: addDays(selected, LOOKUP_DAYS + 1).toISOString() })
      .then((list) => {
        if (!active) return
        const found = list.find((e) => e.id === eventId)
        update('calendar', found ? { date: dayKey(new Date(found.start)) } : { eventId: null })
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, ready, eventId, events, eventsRange, range, selected, update])

  // Without a readable calendar there is no event to show.
  useEffect(() => {
    if (status && !ready && eventId) update('calendar', { eventId: null })
  }, [status, ready, eventId, update])

  // Details opened from outside the screen have no chip that was pressed. They are placed beside the
  // event's first chip, or over the middle of the view when no chip of it is drawn, as in a full month cell.
  useLayoutEffect(() => {
    if (!eventId) {
      if (shown) setShown(null)
      return
    }
    if (shown?.eventId === eventId || !events.some((e) => e.id === eventId)) return
    const root = rootRef.current
    if (!root) return
    const chip = [...root.querySelectorAll<HTMLElement>('[data-event-id]')].find((el) => el.dataset.eventId === eventId)
    if (chip) {
      chip.scrollIntoView({ block: 'nearest' })
      setShown({ eventId, anchor: anchorOf(chip) })
      return
    }
    const body = root.querySelector<HTMLElement>('.cal-view')
    if (!body) return
    const rect = body.getBoundingClientRect()
    setShown({ eventId, anchor: anchorOf(body, new DOMRect(rect.left + rect.width / 2, rect.top + rect.height / 4, 0, 0)) })
  }, [eventId, shown, events])

  const closeCards = (): void => {
    setPopover(null)
    update('calendar', { eventId: null })
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (keyForApp(event) !== 'Escape' || event.defaultPrevented) return
      if (popover || eventId) closeCards()
      else closeApp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // closeCards follows from update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, popover, eventId, closeApp])

  useEffect(() => {
    if (!popover && !eventId) return
    const onDown = (event: MouseEvent): void => {
      if (!(event.target as Element).closest('.cal-pop')) closeCards()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // closeCards follows from update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popover, eventId])

  if (!open) return <></>

  const goTo = (day: Date): void => {
    setPopover(null)
    update('calendar', { date: dayKey(day), eventId: null })
  }
  const step = (n: number): void => goTo(view === 'week' ? addDays(selected, 7 * n) : shiftMonths(selected, n))
  const openEvent = (event: CalendarEvent, el: HTMLElement): void => {
    setPopover(null)
    setShown({ eventId: event.id, anchor: anchorOf(el) })
    update('calendar', { eventId: event.id })
  }
  const openDay = (day: string, el: HTMLElement): void => {
    setPopover({ type: 'day', day, anchor: anchorOf(el) })
    update('calendar', { eventId: null })
  }
  const openEditor = (draft: Draft, anchor: Anchor): void => {
    setPopover({ type: 'editor', draft, anchor })
    update('calendar', { eventId: null })
  }

  const submit = async (change: CalendarChange): Promise<void> => {
    try {
      const result = await window.api.calendarChange(change)
      if (!result.saved) {
        toast({ kind: 'info', title: t('calendar.saved.cancelled'), body: t('calendar.saved.cancelledDetail') })
        return
      }
      const title = {
        create: t('calendar.saved.create'),
        update: t('calendar.saved.update'),
        delete: t('calendar.saved.delete')
      }[result.operation]
      toast({ kind: 'ok', title, body: `${result.event.title} · ${result.sync}` })
      closeCards()
      setRevision((v) => v + 1)
    } catch (err) {
      toast({ kind: 'error', title: t('calendar.saved.failed'), body: displayError(err) })
    }
  }

  const title = (): string => {
    if (view !== 'week') return fmtMonth(locale, cursor)
    const from = mondayOf(selected)
    const until = addDays(from, 6)
    return sameMonth(from, until)
      ? fmtMonth(locale, from)
      : t('calendar.screen.monthRange', { from: fmtMonth(locale, from), until: fmtMonth(locale, until) })
  }

  const details = shown?.eventId === eventId ? shown : null
  const popoverEvent = details ? events.find((e) => e.id === details.eventId) : undefined
  const popoverAnchor = details?.anchor
  // A failure to list the events replaces the view too, since the events drawn would be those of a
  // range that is no longer on screen.
  const body = !ready || error ? (
    <Notice
      settings={settings}
      status={status}
      error={error}
      onSettings={() => openApp({ app: 'settings', page: 'connections' })}
      onRetry={() => setRevision((v) => v + 1)}
      onRequestAccess={() =>
        window.api
          .calendarRequestAccess()
          .then(setStatus)
          .catch((err: unknown) => setError(displayError(err)))
      }
    />
  ) : view === 'month' ? (
    <MonthView
      cursor={cursor}
      events={visibleEvents}
      today={today}
      colors={colors}
      onOpenEvent={openEvent}
      onOpenDay={openDay}
      onCreate={(day, el) => openEditor(newDraft(day), anchorOf(el))}
    />
  ) : view === 'week' ? (
    <WeekView
      selected={selected}
      events={visibleEvents}
      today={today}
      now={now}
      colors={colors}
      scrollTop={weekScroll}
      onOpenEvent={openEvent}
      onOpenDay={openDay}
      onCreateAllDay={(day, el) => openEditor(newDraft(day, { allDay: true }), anchorOf(el))}
      onCreateAt={(day, hour, el) => {
        const rect = el.getBoundingClientRect()
        const pad = (n: number): string => String(n).padStart(2, '0')
        openEditor(
          newDraft(day, { startTime: `${pad(hour)}:00`, endTime: hour === 23 ? '23:59' : `${pad(hour + 1)}:00` }),
          anchorOf(el, new DOMRect(rect.left, rect.top + hour * HOUR_PX, rect.width, HOUR_PX))
        )
      }}
    />
  ) : (
    <ScheduleView cursor={cursor} events={visibleEvents} today={today} colors={colors} onOpenEvent={openEvent} onOpenDay={openDay} />
  )

  return (
    <section className="builtin-focus glass cal-focus" aria-label="CALENDAR">
      <header>
        <h2>CALENDAR</h2>
        <button onClick={closeApp}>
          {t('common.backToConversation')} <X size={16} />
        </button>
      </header>
      <div className="cal-root" ref={rootRef}>
        <div className="cal-toolbar">
          <button className="cal-today" onClick={() => goTo(today)}>
            {t('calendar.screen.today')}
          </button>
          <button className="cal-arrow" aria-label={t('calendar.screen.previous')} onClick={() => step(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button className="cal-arrow" aria-label={t('calendar.screen.next')} onClick={() => step(1)}>
            <ChevronRight size={18} />
          </button>
          <h3 className="cal-title">{title()}</h3>
          <div className="cal-views" role="group" aria-label={t('calendar.screen.views')}>
            {VIEWS.map(([key, label]) => (
              <button
                key={key}
                aria-pressed={view === key}
                onClick={() => {
                  setPopover(null)
                  update('calendar', { view: key, eventId: null })
                }}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div className="cal-body">
          <Sidebar
            miniCursor={miniCursor}
            selected={selected}
            today={today}
            calendars={calendars}
            colors={colors}
            hidden={hidden}
            onMini={(n) => setMiniCursor(addMonths(miniCursor, n))}
            onSelectDay={goTo}
            onToggle={(id) =>
              setHidden((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
            onCreate={(el) => ready && openEditor(newDraft(dayKey(selected)), anchorOf(el))}
          />
          <div className="cal-view">{body}</div>
        </div>
        {popoverEvent && popoverAnchor && (
          <Card anchor={popoverAnchor} kind="event">
            <EventCard
              event={popoverEvent}
              account={status?.calendars.find((c) => c.id === popoverEvent.calendarId)}
              color={colorOf(colors, popoverEvent.calendarId)}
              onEdit={() => openEditor(draftFromEvent(popoverEvent), popoverAnchor)}
              onDelete={() => void submit({ operation: 'delete', eventId: popoverEvent.id })}
              onClose={closeCards}
            />
          </Card>
        )}
        {popover?.type === 'day' && (
          <Card anchor={popover.anchor} kind="day">
            <DayCard
              day={popover.day}
              events={visibleEvents}
              today={today}
              colors={colors}
              onOpenEvent={openEvent}
              onCreate={(day) => openEditor(newDraft(day), popover.anchor)}
              onClose={() => setPopover(null)}
            />
          </Card>
        )}
        {popover?.type === 'editor' && (
          <Card anchor={popover.anchor} kind="editor">
            <EditorCard
              key={popover.draft.eventId ?? popover.draft.startDate}
              initial={popover.draft}
              calendarLabel={editorCalendarLabel(popover.draft, events, status, writeCalendar)}
              onSubmit={(draft) => {
                const change = changeFromDraft(draft)
                if (change) void submit(change)
              }}
              onClose={() => setPopover(null)}
            />
          </Card>
        )}
      </div>
    </section>
  )
}

/** An edit is saved to the calendar the event came from, while a new event goes to the calendar chosen in the settings. */
function editorCalendarLabel(
  draft: Draft,
  events: CalendarEvent[],
  status: CalendarStatus | null,
  writeCalendar: CalendarAccount | null
): string | null {
  const calendarId = draft.eventId ? events.find((e) => e.id === draft.eventId)?.calendarId : writeCalendar?.id
  const account = status?.calendars.find((c) => c.id === calendarId)
  return account?.title ?? null
}
