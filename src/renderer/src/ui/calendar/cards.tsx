import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { AlignLeft, CalendarDays, Clock, Lock, MapPin, Pencil, Repeat, Trash2, Users, X } from 'lucide-react'
import type { Translate } from '@shared/i18n'
import type { CalendarAccount, CalendarChange, CalendarEvent } from '@shared/calendar'
import { addDays, dayKey, daysBetween, eventsOn, lastInstant, parseDayKey } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { BarChip, TimedChip, type OpenEvent } from './EventChips'
import { dayClasses, fmtDateFull, fmtTime, fmtTimeRange, weekdayNames } from './format'
import { colorOf } from './palette'

/** Where a card is placed, in coordinates relative to the top left corner of the calendar view. */
export interface Anchor {
  left: number
  top: number
  width: number
  height: number
}

export function anchorOf(el: HTMLElement, rect: DOMRect = el.getBoundingClientRect()): Anchor {
  const root = el.closest('.cal-root')?.getBoundingClientRect()
  return {
    left: rect.left - (root?.left ?? 0),
    top: rect.top - (root?.top ?? 0),
    width: rect.width,
    height: rect.height
  }
}

/** Opens to the right of the element it belongs to, to its left when there is no room, and is pulled up or down to stay inside the frame. */
export function Card({
  anchor,
  kind,
  children
}: {
  anchor: Anchor
  kind: 'event' | 'day' | 'editor'
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const root = el?.parentElement
    if (!el || !root) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    let left = anchor.left + anchor.width + 8
    if (left + width > root.clientWidth - 8) left = anchor.left - width - 8
    if (left < 8) left = Math.max(8, Math.min(anchor.left, root.clientWidth - width - 8))
    let top = anchor.top
    if (top + height > root.clientHeight - 8) top = Math.max(8, root.clientHeight - height - 8)
    setPos({ left: Math.round(left), top: Math.round(top) })
  }, [anchor])
  return (
    <div
      ref={ref}
      className={`cal-pop is-${kind}`}
      role="dialog"
      style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.top, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <button aria-label={t('common.close')} onClick={onClose}>
      <X size={18} />
    </button>
  )
}

function whenText(t: Translate, locale: string, event: CalendarEvent): string {
  const start = new Date(event.start)
  const last = new Date(lastInstant(event))
  const sameDay = dayKey(start) === dayKey(last)
  if (event.allDay)
    return sameDay
      ? fmtDateFull(locale, start)
      : t('calendar.dateRange', { from: fmtDateFull(locale, start), until: fmtDateFull(locale, last) })
  return sameDay
    ? t('calendar.event.whenSameDay', {
        date: fmtDateFull(locale, start),
        time: fmtTimeRange(locale, event.start, event.end, (start, end) => t('calendar.timeRange', { start, end }))
      })
    : t('calendar.event.whenSpan', {
        from: fmtDateFull(locale, start),
        fromTime: fmtTime(locale, event.start),
        until: fmtDateFull(locale, event.end),
        untilTime: fmtTime(locale, event.end)
      })
}

export function EventCard({
  event,
  account,
  color,
  onEdit,
  onDelete,
  onClose
}: {
  event: CalendarEvent
  account?: CalendarAccount
  color: string
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const writable = account?.writable ?? event.writable
  const locked = !writable || event.recurring || event.hasAttendees
  const hint = !writable
    ? t('calendar.event.readOnlyHint')
    : locked
      ? t('calendar.event.lockedHint')
      : t('calendar.event.approvalHint')
  return (
    <>
      <div className="cal-pop-tools">
        <button aria-label={t('calendar.event.edit')} disabled={locked} onClick={onEdit}>
          <Pencil size={16} />
        </button>
        <button aria-label={t('common.delete')} disabled={locked} onClick={onDelete}>
          <Trash2 size={16} />
        </button>
        <CloseButton onClose={onClose} />
      </div>
      <div className="cal-pop-title">
        <i className="cal-pop-swatch" style={{ '--c': color } as CSSProperties} />
        <h4>{event.title}</h4>
      </div>
      <div className="cal-pop-when">{whenText(t, locale, event)}</div>
      {event.location && (
        <div className="cal-pop-row">
          <MapPin size={16} />
          <span>{event.location}</span>
        </div>
      )}
      {event.notes && (
        <div className="cal-pop-row">
          <AlignLeft size={16} />
          <span>{event.notes}</span>
        </div>
      )}
      <div className="cal-pop-row">
        <CalendarDays size={16} />
        <span>{account?.title ?? event.calendarTitle}</span>
      </div>
      {(event.recurring || event.hasAttendees || !writable) && (
        <div className="cal-pop-flags">
          {event.recurring && (
            <span>
              <Repeat size={11} />
              {t('calendar.event.recurring')}
            </span>
          )}
          {event.hasAttendees && (
            <span>
              <Users size={11} />
              {t('calendar.event.hasAttendees')}
            </span>
          )}
          {!writable && (
            <span>
              <Lock size={11} />
              {t('calendar.event.readOnly')}
            </span>
          )}
        </div>
      )}
      <p className="cal-pop-hint">{hint}</p>
    </>
  )
}

export function DayCard({
  day,
  events,
  today,
  colors,
  onOpenEvent,
  onCreate,
  onClose
}: {
  day: string
  events: CalendarEvent[]
  today: Date
  colors: Map<string, string>
  onOpenEvent: OpenEvent
  onCreate: (day: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const date = parseDayKey(day)
  const list = eventsOn(events, date)
  return (
    <>
      <div className="cal-pop-tools">
        <CloseButton onClose={onClose} />
      </div>
      <div className={`cal-pop-day${dayClasses(date, today)}`}>
        <span className="wd">{weekdayNames(locale, 'short')[date.getDay()]}</span>
        <button className="cal-pop-num" title={t('calendar.day.create')} onClick={() => onCreate(day)}>
          {date.getDate()}
        </button>
      </div>
      <div className="cal-pop-list">
        {list.length === 0 && <div className="cal-empty">{t('calendar.day.empty')}</div>}
        {list.map((event) =>
          event.allDay ? (
            <BarChip
              key={event.id}
              bar={{ event, c0: 0, c1: 0, contLeft: false, contRight: false, lane: 0 }}
              color={colorOf(colors, event.calendarId)}
              onOpen={onOpenEvent}
            />
          ) : (
            <TimedChip key={event.id} event={event} color={colorOf(colors, event.calendarId)} onOpen={onOpenEvent} />
          )
        )}
      </div>
    </>
  )
}

/**
 * The input of the create and edit card, held as the local-time strings of the date and time inputs.
 * `endDate` is the day the event ends on: for an all-day event its last day, and for an event with a
 * time the day of its end, so an event that crosses midnight or lasts several days keeps its length.
 */
export interface Draft {
  eventId?: string
  title: string
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  allDay: boolean
  location: string
  notes: string
  /**
   * The time zone an event with times is saved in: the event's own when it is edited, this computer's when
   * it is new. Its start and end are instants, so any zone holds them. An all-day event is saved in this
   * computer's zone instead, because its days are midnights in the zone the inputs are written in.
   */
  timeZone: string
}

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * A draft of a new event on that day from 10:00 to 11:00. An all-day event being edited keeps these
 * times too, and they apply once "all day" is turned off.
 */
export function newDraft(day: string, patch: Partial<Draft> = {}): Draft {
  return {
    title: '',
    startDate: day,
    startTime: '10:00',
    endDate: day,
    endTime: '11:00',
    allDay: false,
    location: '',
    notes: '',
    timeZone: localZone(),
    ...patch
  }
}

/** The value of an `input[type=time]`, which is always 24-hour `HH:mm` whatever the language is. */
function timeValue(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function draftFromEvent(event: CalendarEvent): Draft {
  const fields = {
    eventId: event.id,
    title: event.title,
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    timeZone: event.timeZone,
    endDate: dayKey(new Date(event.allDay ? lastInstant(event) : event.end))
  }
  return event.allDay
    ? newDraft(dayKey(new Date(event.start)), fields)
    : newDraft(dayKey(new Date(event.start)), { ...fields, startTime: timeValue(event.start), endTime: timeValue(event.end) })
}

const minuteOf = (time: string): number => {
  const [hh, mm] = time.split(':').map(Number)
  return hh * 60 + mm
}

/**
 * The draft with another start day or start time, whose end moves by as many days and minutes, so that
 * the event keeps its length as it does in Google Calendar's editor.
 */
export function moveStart(draft: Draft, start: Pick<Draft, 'startDate'> | Pick<Draft, 'startTime'>): Draft {
  const next = { ...draft, ...start }
  const days = daysBetween(parseDayKey(draft.startDate), parseDayKey(next.startDate))
  const minutes = minuteOf(next.startTime) - minuteOf(draft.startTime)
  const end = localDate(draft.endDate, draft.endTime)
  // An input that is cleared gives an empty value, from which no distance can be counted.
  if ([days, minutes, end.getTime()].some(Number.isNaN)) return next
  const moved = new Date(end.getFullYear(), end.getMonth(), end.getDate() + days, end.getHours(), end.getMinutes() + minutes)
  return { ...next, endDate: dayKey(moved), endTime: timeValue(moved.getTime()) }
}

/**
 * The draft with another end time. An event shorter than a day ends at the first time on the clock after
 * its start, as the end-time menu of Google Calendar's editor sets it, so an end time not after the start
 * time moves the end to the next day and 22:00 to 01:00 ends the next morning. A longer event keeps its
 * end day. Both are decided from the draft before the change, because a time input passes through
 * partial values such as 01:00 on the way to 13:00.
 */
export function setEndTime(draft: Draft, endTime: string): Draft {
  const start = localDate(draft.startDate, draft.startTime)
  const end = localDate(draft.endDate, draft.endTime)
  const dayAfterStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, start.getHours(), start.getMinutes())
  const withinADay = Number.isNaN(end.getTime()) ? draft.endDate === draft.startDate : end < dayAfterStart
  if (Number.isNaN(start.getTime()) || !endTime || !withinADay) return { ...draft, endTime }
  const endDate = endTime > draft.startTime ? draft.startDate : dayKey(addDays(parseDayKey(draft.startDate), 1))
  return { ...draft, endTime, endDate }
}

/** A local day and time, or an invalid Date when an input was cleared. */
function localDate(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

/** What saving the draft asks main to do, or null while the draft cannot be saved. */
export function changeFromDraft(draft: Draft): CalendarChange | null {
  const title = draft.title.trim()
  if (!title) return null
  const { start, end, timeZone } = draft.allDay
    ? { start: localDate(draft.startDate, '00:00'), end: addDays(localDate(draft.endDate, '00:00'), 1), timeZone: localZone() }
    : { start: localDate(draft.startDate, draft.startTime), end: localDate(draft.endDate, draft.endTime), timeZone: draft.timeZone }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  const event = {
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: draft.allDay,
    timeZone,
    location: draft.location.trim(),
    notes: draft.notes
  }
  return draft.eventId ? { operation: 'update', eventId: draft.eventId, event } : { operation: 'create', event }
}

export function EditorCard({
  initial,
  calendarLabel,
  onSubmit,
  onClose
}: {
  initial: Draft
  /** The calendar to save into; null means none is configured and nothing can be saved. */
  calendarLabel: string | null
  onSubmit: (draft: Draft) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(initial)
  const update = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))
  const invalid = changeFromDraft(draft) === null
  // An event with times shows its end day only when it ends on another day, as Google Calendar's editor
  // does, so that a one-day event stays on one line; its end time reaches the next day and from there
  // any day. An all-day event has no times, and its two days fit on the line, so its end day is always
  // there to be changed.
  const showEndDate = draft.allDay || draft.endDate !== draft.startDate
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!invalid && calendarLabel) onSubmit(draft)
  }
  return (
    <>
      <div className="cal-pop-tools">
        <CloseButton onClose={onClose} />
      </div>
      <form className="cal-create-form" onSubmit={submit}>
        <input
          className="cal-title-input"
          placeholder={t('calendar.editor.title')}
          autoComplete="off"
          autoFocus
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
        />
        <div className="cal-pop-row">
          <Clock size={16} />
          <span className="cal-fields">
            <span className="cal-when">
              <input
                className="cal-field"
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft((d) => moveStart(d, { startDate: e.target.value }))}
              />
              {!draft.allDay && (
                <input
                  className="cal-field"
                  type="time"
                  value={draft.startTime}
                  onChange={(e) => setDraft((d) => moveStart(d, { startTime: e.target.value }))}
                />
              )}
            </span>
            <span className="cal-dash">–</span>
            <span className="cal-when">
              {showEndDate && (
                <input className="cal-field" type="date" value={draft.endDate} onChange={(e) => update({ endDate: e.target.value })} />
              )}
              {!draft.allDay && (
                <input
                  className="cal-field"
                  type="time"
                  value={draft.endTime}
                  onChange={(e) => setDraft((d) => setEndTime(d, e.target.value))}
                />
              )}
            </span>
          </span>
        </div>
        <label className="cal-pop-row cal-allday">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => update({ allDay: e.target.checked })} />
          <span>{t('calendar.allDay')}</span>
        </label>
        <div className="cal-pop-row">
          <MapPin size={16} />
          <input
            className="cal-field is-wide"
            placeholder={t('calendar.editor.location')}
            value={draft.location}
            onChange={(e) => update({ location: e.target.value })}
          />
        </div>
        <div className="cal-pop-row">
          <CalendarDays size={16} />
          <span>{calendarLabel ?? t('calendar.editor.noWriteCalendar')}</span>
        </div>
        <div className="cal-pop-actions">
          <span className="cal-pop-hint">{t('calendar.editor.confirmHint')}</span>
          <button className="cal-primary" type="submit" disabled={invalid || !calendarLabel}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </>
  )
}

