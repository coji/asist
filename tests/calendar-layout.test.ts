import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detailCalendarEvent, type CalendarEvent } from '../src/shared/calendar'
import { dateLabel } from '../src/shared/conversation-locale'
import {
  cellPlan,
  eventsOn,
  lanesForHeight,
  layoutBlocks,
  mondayOf,
  monthWeeks,
  visibleRange,
  weekLayout
} from '../src/shared/calendar-layout'

let seq = 0
function event(patch: Partial<CalendarEvent> & { start: Date; end: Date }): CalendarEvent {
  return {
    id: `e${++seq}`,
    calendarId: 'work',
    calendarTitle: '仕事',
    title: `予定${seq}`,
    allDay: false,
    location: '',
    notes: '',
    timeZone: 'Asia/Tokyo',
    revision: 'r',
    recurring: false,
    hasAttendees: false,
    writable: true,
    ...patch,
    start: patch.start.getTime(),
    end: patch.end.getTime()
  }
}
const day = (d: number, h = 0, m = 0): Date => new Date(2026, 8, d, h, m)
const monday = day(14)

describe('month view weeks', () => {
  it('lists Monday-start weeks from the week of the first day to the week of the last day', () => {
    const weeks = monthWeeks(new Date(2026, 8, 1))
    expect(weeks.map((w) => w.getDate())).toEqual([31, 7, 14, 21, 28])
    expect(weeks[0].getMonth()).toBe(7)
    expect(weeks.every((w) => w.getDay() === 1)).toBe(true)
  })

  it('covers exactly the visible week or month with the fetch range', () => {
    expect(visibleRange('month', new Date(2026, 8, 1), day(15))).toEqual({ from: new Date(2026, 7, 31), until: new Date(2026, 9, 5) })
    expect(visibleRange('week', new Date(2026, 8, 1), day(17))).toEqual({ from: monday, until: day(21) })
    expect(visibleRange('list', new Date(2026, 8, 1), day(17))).toEqual({ from: day(1), until: new Date(2026, 9, 1) })
  })
})

describe('week layout', () => {
  it('draws a multi-day all-day event as one bar and marks the side that continues past the week', () => {
    const trip = event({ allDay: true, start: day(12), end: day(16) })
    const layout = weekLayout(monday, [trip])
    expect(layout.bars).toHaveLength(1)
    expect(layout.bars[0]).toMatchObject({ c0: 0, c1: 1, contLeft: true, contRight: false, lane: 0 })
  })

  it('puts the longer bar in the upper lane and starts timed events below the bars of that day', () => {
    const long = event({ allDay: true, start: day(15), end: day(18) })
    const short = event({ allDay: true, start: day(15), end: day(16) })
    const meeting = event({ start: day(15, 10), end: day(15, 11) })
    const layout = weekLayout(monday, [short, meeting, long])
    const lanes = Object.fromEntries(layout.bars.map((b) => [b.event.id, b.lane]))
    expect(lanes[long.id]).toBe(0)
    expect(lanes[short.id]).toBe(1)
    expect(layout.days[1].firstFree).toBe(2)
    expect(layout.days[1].timed).toEqual([meeting])
    expect(layout.days[2].firstFree).toBe(1)
    expect(layout.laneCount).toBe(2)
  })

  it('collapses the events that do not fit into a remaining count that also covers hidden bars', () => {
    const bar = event({ allDay: true, start: day(15), end: day(16) })
    const timed = [10, 11, 13, 15].map((h) => event({ start: day(15, h), end: day(15, h + 1) }))
    const plan = cellPlan(weekLayout(monday, [bar, ...timed]).days[1], 3)
    expect(plan.shown).toEqual(timed.slice(0, 1))
    expect(plan.more).toBe(3)
    expect(plan.moreLane).toBe(2)
    const tight = cellPlan(weekLayout(monday, [bar, ...timed]).days[1], 1)
    expect(tight.shown).toEqual([])
    expect(tight.more).toBe(4)
    expect(tight.moreLane).toBeNull()
  })

  it('shows no remaining count on a day where every event fits', () => {
    const timed = [10, 12].map((h) => event({ start: day(15, h), end: day(15, h + 1) }))
    expect(cellPlan(weekLayout(monday, timed).days[1], 3)).toEqual({ shown: timed, more: 0, moreLane: null })
  })

  it('derives the number of lanes from the cell height', () => {
    expect(lanesForHeight(104)).toBe(3)
    expect(lanesForHeight(40)).toBe(1)
  })
})

describe('week view time grid', () => {
  it('splits overlapping events into side-by-side columns and leaves separated events at full width', () => {
    const a = event({ start: day(15, 11), end: day(15, 12) })
    const b = event({ start: day(15, 11, 30), end: day(15, 12) })
    const c = event({ start: day(15, 14), end: day(15, 15) })
    const blocks = layoutBlocks([c, b, a], day(15))
    const byId = Object.fromEntries(blocks.map((x) => [x.event.id, x]))
    expect(byId[a.id]).toMatchObject({ col: 0, cols: 2, startMin: 660, endMin: 720 })
    expect(byId[b.id]).toMatchObject({ col: 1, cols: 2 })
    expect(byId[c.id]).toMatchObject({ col: 0, cols: 1 })
  })

  it('clips an event that crosses midnight to the day being laid out', () => {
    const late = event({ start: day(15, 23), end: day(16, 1) })
    expect(layoutBlocks([late], day(15))[0]).toMatchObject({ startMin: 1380, endMin: 1440 })
    expect(layoutBlocks([late], day(16))[0]).toMatchObject({ startMin: 0, endMin: 60 })
  })
})

describe('events of a day', () => {
  it('lists all-day events first, then by start time, and leaves out an event that ends at midnight', () => {
    const allDay = event({ allDay: true, start: day(15), end: day(16) })
    const early = event({ start: day(15, 9), end: day(15, 9, 30) })
    const late = event({ start: day(15, 13), end: day(15, 14) })
    const yesterday = event({ start: day(14, 22), end: day(15, 0) })
    expect(eventsOn([late, yesterday, early, allDay], day(15))).toEqual([allDay, early, late])
  })

  it('puts an event without length at midnight on the day it starts in every view, as the model is told', () => {
    const reminder = event({ start: day(16), end: day(16) })
    // The list view and the day's popup.
    expect(eventsOn([reminder], day(16))).toEqual([reminder])
    expect(eventsOn([reminder], day(15))).toEqual([])
    // The month view's cells and the week view's columns.
    const { days } = weekLayout(monday, [reminder])
    expect(days.map((d) => d.timed.length)).toEqual([0, 0, 1, 0, 0, 0, 0])
    expect(layoutBlocks(days[2].timed, days[2].date)).toMatchObject([{ startMin: 0 }])
    expect(detailCalendarEvent('ja-JP', reminder).date).toBe(dateLabel('ja-JP', day(16)))
  })
})

describe('the days daylight saving time starts and ends', () => {
  // In New York, 2026-03-08 has 23 hours and 2026-11-01 has 25.
  let zone: string | undefined
  beforeEach(() => {
    zone = process.env.TZ
    process.env.TZ = 'America/New_York'
  })
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('keeps an event in the last hour of the day of 25 hours on that day', () => {
    const late = event({ start: new Date(2026, 10, 1, 23, 30), end: new Date(2026, 10, 1, 23, 50) })
    expect(eventsOn([late], new Date(2026, 10, 1))).toEqual([late])
    expect(weekLayout(mondayOf(new Date(2026, 10, 1)), [late]).days[6].timed).toEqual([late])
  })

  it('does not put an event of the day after the day of 23 hours on that day', () => {
    const early = event({ start: new Date(2026, 2, 9, 0, 30), end: new Date(2026, 2, 9, 0, 50) })
    expect(eventsOn([early], new Date(2026, 2, 8))).toEqual([])
    expect(weekLayout(mondayOf(new Date(2026, 2, 8)), [early]).days[6].timed).toEqual([])
  })

  it('draws an event at the time on the clock in the week view', () => {
    const ten = event({ start: new Date(2026, 10, 1, 10), end: new Date(2026, 10, 1, 11) })
    expect(layoutBlocks([ten], new Date(2026, 10, 1))[0]).toMatchObject({ startMin: 600, endMin: 660 })
    const late = event({ start: new Date(2026, 2, 8, 22), end: new Date(2026, 2, 9, 1) })
    expect(layoutBlocks([late], new Date(2026, 2, 8))[0]).toMatchObject({ startMin: 1320, endMin: 1440 })
  })
})
