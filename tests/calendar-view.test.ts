// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '../src/shared/i18n'
import { errorText } from '../src/shared/i18n/error-text'
import { calendarChangeSchema, isoWithOffset, type CalendarEvent } from '../src/shared/calendar'
import type { AppSettings } from '../src/shared/settings'
import { CalendarView } from '../src/renderer/src/ui/calendar/CalendarView'
import { EditorCard, changeFromDraft, draftFromEvent, moveStart, newDraft, setEndTime, type Draft } from '../src/renderer/src/ui/calendar/cards'
import { useSettingsStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'

const day = (d: number, h = 0, m = 0): number => new Date(2026, 8, d, h, m).getTime()
let seq = 0
const event = (patch: Partial<CalendarEvent>): CalendarEvent => ({
  id: `e${++seq}`,
  calendarId: 'work',
  calendarTitle: '仕事',
  title: `予定${seq}`,
  start: day(15, 10),
  end: day(15, 11),
  allDay: false,
  location: '',
  notes: '',
  timeZone: 'Asia/Tokyo',
  revision: 'r',
  recurring: false,
  hasAttendees: false,
  writable: true,
  ...patch
})
const trip = event({ title: '箱根', allDay: true, start: day(12), end: day(14), calendarId: 'home' })
const review = event({ title: '予約画面 レビュー', location: 'Zoom', hasAttendees: true })
const lunch = event({ title: 'ランチ', start: day(15, 13), end: day(15, 14) })
const events = [trip, review, lunch]

const calendarEvents = vi.fn()
const calendarChange = vi.fn()
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 15, 10, 24), toFake: ['Date'] })
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  calendarEvents.mockReset().mockResolvedValue(events)
  calendarChange.mockReset()
  window.api = {
    calendarStatus: async () => ({
      signIn: 'signedIn',
      calendars: [
        { id: 'work', title: '仕事', writable: true },
        { id: 'home', title: '自宅', writable: true },
        { id: 'other', title: '見ない', writable: true }
      ],
      account: 'me@example.com'
    }),
    calendarEvents,
    calendarChange
  } as unknown as typeof window.api
  useSettingsStore.setState({
    settings: { calendar: { enabled: true, readCalendarIds: ['work', 'home'], writeCalendarId: 'work' } } as AppSettings
  })
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'calendar' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function render(): Promise<void> {
  await act(async () => root.render(React.createElement(CalendarView, { open: true })))
  await act(async () => {})
}
const text = (selector: string): string[] =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '')
const t = createTranslator('ja-JP')

it('loads the events of the visible range, draws bars and a remaining count, and opens a detail card on click', async () => {
  await render()
  const range = calendarEvents.mock.calls[0][0]
  expect(new Date(range.start).getTime()).toBe(new Date(2026, 7, 31).getTime())
  expect(new Date(range.end).getTime()).toBe(new Date(2026, 9, 5).getTime())
  expect(text('.cal-side-item')).toEqual(['仕事', '自宅'])
  expect(text('.cal-ev.is-bar')).toEqual(['箱根'])
  expect(container.querySelector('.cal-daynum.is-today')?.textContent).toBe('15')
  const more = container.querySelector<HTMLButtonElement>('.cal-more')!
  expect(more.textContent).toBe(t('common.more', { count: 2 }))
  await act(async () => more.click())
  expect(text('.cal-pop .cal-ev')).toEqual(['10:00予約画面 レビュー', '13:00ランチ'])
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-pop .cal-ev')!.click())
  const card = container.querySelector('.cal-pop.is-event')!
  expect(card.textContent).toContain('2026年9月15日火曜日・10:00～11:00')
  expect(card.textContent).toContain('Zoom')
  expect(card.textContent).toContain(t('calendar.event.hasAttendees'))
  expect(card.querySelector<HTMLButtonElement>(`[aria-label="${t('common.delete')}"]`)?.disabled).toBe(true)
})

it('sends the new event to main for confirmation and reloads the range after it is saved', async () => {
  calendarChange.mockResolvedValue({ saved: true, operation: 'create', event: event({ title: '動作確認' }), sync: 'macOSに保存しました' })
  await render()
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-create')!.click())
  const form = container.querySelector<HTMLFormElement>('.cal-create-form')!
  const setValue = (input: HTMLInputElement, value: string): void => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await act(async () => setValue(form.querySelector('.cal-title-input')!, '動作確認'))
  await act(async () => form.requestSubmit())
  expect(calendarChange).toHaveBeenCalledWith({
    operation: 'create',
    event: {
      title: '動作確認',
      start: new Date(2026, 8, 15, 10, 0).toISOString(),
      end: new Date(2026, 8, 15, 11, 0).toISOString(),
      allDay: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      location: '',
      notes: ''
    }
  })
  expect(calendarEvents).toHaveBeenCalledTimes(2)
  expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: 'ok', title: t('calendar.saved.create') })
  expect(container.querySelector('.cal-pop')).toBeNull()
})

it('edits an event that crosses midnight with its end day shown, and saves it with its whole length', async () => {
  const overnight = event({ title: '夜間作業', start: day(15, 22), end: day(16, 2) })
  calendarEvents.mockResolvedValue([overnight])
  calendarChange.mockResolvedValue({ saved: true, operation: 'update', event: overnight, sync: 'macOSに保存しました' })
  await render()
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-ev.is-timed')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${t('calendar.event.edit')}"]`)!.click())
  const form = container.querySelector<HTMLFormElement>('.cal-create-form')!
  expect([...form.querySelectorAll<HTMLInputElement>('input[type=date]')].map((input) => input.value)).toEqual(['2026-09-15', '2026-09-16'])
  await act(async () => form.requestSubmit())
  expect(calendarChange).toHaveBeenCalledWith({
    operation: 'update',
    eventId: overnight.id,
    event: expect.objectContaining({ start: new Date(overnight.start).toISOString(), end: new Date(overnight.end).toISOString() })
  })
})

it('keeps the event being written on the Escape that cancels an IME conversion in its title, and closes it on the next Escape', async () => {
  await render()
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-create')!.click())
  const title = container.querySelector<HTMLInputElement>('.cal-create-form .cal-title-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'ていれい')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Chromium on macOS sends the Escape that cancels an IME conversion with isComposing set.
  await act(async () => void title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
  expect(container.querySelector<HTMLInputElement>('.cal-create-form .cal-title-input')?.value).toBe('ていれい')
  await act(async () => void title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('.cal-create-form')).toBeNull()
  expect(useViewStore.getState().open?.app).toBe('calendar')
})

it('shows why the events could not be listed while the calendar is ready, and lists them on retry', async () => {
  calendarEvents.mockRejectedValue(new Error(errorText('calendar.errors.noReadCalendars')))
  await render()
  expect(container.querySelector('.cal-notice[role=alert]')?.textContent).toContain(t('calendar.errors.noReadCalendars'))
  calendarEvents.mockResolvedValue(events)
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-notice button')!.click())
  await act(async () => {})
  expect(container.querySelector('.cal-notice')).toBeNull()
  expect(text('.cal-ev.is-bar')).toEqual(['箱根'])
})

describe('a repeating event, each of whose occurrences Google gives an id of its own', () => {
  const standup = (d: number): CalendarEvent => ({ ...event({ title: '朝会', recurring: true }), id: `me@example.com weekly_202609${d}T000000Z`, start: day(d, 9), end: day(d, 9, 30) })

  it('opens the details of the occurrence that was pressed', async () => {
    calendarEvents.mockResolvedValue([standup(15), standup(22)])
    await render()
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.cal-ev.is-timed')]
    await act(async () => chips[1].click())
    expect(container.querySelector('.cal-pop.is-event .cal-pop-when')?.textContent).toContain('2026年9月22日')
  })

  it('opens the occurrence asked for from outside the screen', async () => {
    calendarEvents.mockResolvedValue([standup(15), standup(22)])
    await render()
    await act(async () => useViewStore.getState().openApp({ app: 'calendar', view: 'month', date: '2026-09-22', eventId: standup(22).id }))
    await act(async () => {})
    expect(container.querySelector('.cal-pop.is-event .cal-pop-when')?.textContent).toContain('2026年9月22日')
  })
})

describe('the draft of the event editor', () => {
  it('saves a multi-day all-day event and an event with times over several days without changing their length', () => {
    const trip = event({ allDay: true, start: day(15), end: day(18) })
    const tour = event({ start: day(15, 10), end: day(17, 12) })
    for (const original of [trip, tour]) {
      const change = changeFromDraft(draftFromEvent(original))
      expect(change?.operation === 'update' && [Date.parse(change.event.start), Date.parse(change.event.end)]).toEqual([original.start, original.end])
    }
  })

  describe('in the editor', () => {
    const onSubmit = vi.fn()
    const open = async (draft: Draft): Promise<void> => {
      onSubmit.mockReset()
      await act(async () => root.render(React.createElement(EditorCard, { initial: draft, calendarLabel: '仕事', onSubmit, onClose: vi.fn() })))
    }
    const dates = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type=date]')]
    const times = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type=time]')]
    const type = async (input: HTMLInputElement, value: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const saved = async (): Promise<[number, number]> => {
      await act(async () => container.querySelector<HTMLFormElement>('.cal-create-form')!.requestSubmit())
      const change = changeFromDraft(onSubmit.mock.calls[0][0])
      if (change?.operation === 'delete' || !change) throw new Error('the draft was not saved')
      return [Date.parse(change.event.start), Date.parse(change.event.end)]
    }

    it('saves a new event from 22:00 to 01:00 as one that ends the next morning', async () => {
      // As the first hour of the week view creates it, with the end already at 01:00.
      await open(newDraft('2026-09-15', { title: '夜間作業', startTime: '00:00', endTime: '01:00' }))
      await type(times()[0], '22:00')
      expect(times()[1].value).toBe('23:00')
      await type(times()[1], '01:00')
      expect(dates().map((input) => input.value)).toEqual(['2026-09-15', '2026-09-16'])
      expect(await saved()).toEqual([day(15, 22), day(16, 1)])
    })

    it('keeps a one-day event with times on one line while its end time passes through an earlier hour', async () => {
      await open(newDraft('2026-09-15', { title: '打合せ' }))
      expect(dates()).toHaveLength(1)
      await type(times()[1], '01:00')
      await type(times()[1], '13:00')
      expect(dates()).toHaveLength(1)
      expect(await saved()).toEqual([day(15, 10), day(15, 13)])
    })

    it('extends a one-day all-day event to several days through its end day', async () => {
      await open(draftFromEvent(event({ title: '出張', allDay: true, start: day(15), end: day(16) })))
      await type(dates()[1], '2026-09-17')
      expect(await saved()).toEqual([day(15), day(18)])
    })

    it('extends a one-day event with times to several days once its end reaches the next day', async () => {
      await open(newDraft('2026-09-15', { title: '合宿' }))
      await type(times()[1], '09:00')
      await type(dates()[1], '2026-09-18')
      expect(await saved()).toEqual([day(15, 10), day(18, 9)])
    })
  })

  it('keeps the end day of an event a day or longer when only its end time changes', () => {
    const tour = draftFromEvent(event({ start: day(15, 10), end: day(17, 12) }))
    expect(setEndTime(tour, '09:00')).toMatchObject({ endDate: '2026-09-17', endTime: '09:00' })
  })

  it('moves the end along with the start day or the start time, so that the event keeps its length', () => {
    const trip = draftFromEvent(event({ allDay: true, start: day(15), end: day(18) }))
    expect(moveStart(trip, { startDate: '2026-09-29' })).toMatchObject({ startDate: '2026-09-29', endDate: '2026-10-01' })
    const late = newDraft('2026-09-15', { startTime: '00:00', endTime: '01:00' })
    expect(moveStart(late, { startTime: '23:30' })).toMatchObject({ endDate: '2026-09-16', endTime: '00:30' })
  })

  describe('on a computer in another time zone than the event', () => {
    let zone: string | undefined
    beforeEach(() => {
      zone = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
    })
    afterEach(() => {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    })

    it('saves an event with times turned into an all-day one on the days the editor shows', () => {
      const draft = { ...draftFromEvent(event({ start: day(15, 10), end: day(15, 11), timeZone: 'Asia/Tokyo' })), allDay: true }
      const change = calendarChangeSchema.parse(changeFromDraft(draft))
      if (change.operation === 'delete') throw new Error('the draft was not saved as an event')
      const dayOf = (iso: string): string => isoWithOffset(Date.parse(iso), change.event.timeZone).slice(0, 10)
      expect([dayOf(change.event.start), dayOf(change.event.end)]).toEqual(['2026-09-15', '2026-09-16'])
    })

    it('keeps the time zone of an event with times that stays one', () => {
      const change = changeFromDraft(draftFromEvent(event({ start: day(15, 10), end: day(15, 11), timeZone: 'Asia/Tokyo' })))
      expect(change?.operation === 'update' && change.event.timeZone).toBe('Asia/Tokyo')
    })
  })

  it('cannot be saved while a date or a time is cleared', () => {
    const draft = draftFromEvent(event({ title: '打合せ' }))
    expect(changeFromDraft(draft)).not.toBeNull()
    expect(changeFromDraft(moveStart(draft, { startDate: '' }))).toBeNull()
    expect(changeFromDraft({ ...draft, endTime: '' })).toBeNull()
  })
})

it('loads no events while the calendar integration is off and points to the settings screen', async () => {
  useSettingsStore.setState({
    settings: { calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null } } as AppSettings
  })
  await render()
  expect(calendarEvents).not.toHaveBeenCalled()
  expect(container.querySelector('.cal-notice')?.textContent).toContain(t('calendar.notice.disabled'))
  await act(async () => container.querySelector<HTMLButtonElement>('.cal-notice button')!.click())
  expect(useViewStore.getState().open?.app).toBe('settings')
})
