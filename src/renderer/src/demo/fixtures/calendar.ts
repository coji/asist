import type { CalendarEvent, CalendarStatus } from '@shared/calendar'

/**
 * The calendar of the demo. It builds events around today so that bands, overlaps and the "他 N 件"
 * ("N more") link are all visible. The dates follow the day the demo runs on, so the month, week and
 * list views all have events around today.
 */

export const DEMO_CALENDAR_STATUS: CalendarStatus = {
  signIn: 'signedIn',
  calendars: [
    { id: 'demo-work', title: '仕事', writable: true },
    { id: 'demo-home', title: '自宅', writable: true },
    { id: 'demo-holiday', title: '日本の祝日', writable: false }
  ],
  account: 'demo@example.com'
}

let seq = 0
export function demoEvent(
  calendarId: string,
  title: string,
  start: Date,
  end: Date,
  patch: Partial<CalendarEvent> = {}
): CalendarEvent {
  return {
    id: `demo-${++seq}`,
    calendarId,
    calendarTitle: DEMO_CALENDAR_STATUS.calendars.find((c) => c.id === calendarId)?.title ?? '',
    title,
    start: start.getTime(),
    end: end.getTime(),
    allDay: false,
    location: '',
    notes: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    revision: 'demo',
    recurring: false,
    hasAttendees: false,
    writable: calendarId !== 'demo-holiday',
    ...patch
  }
}

export function buildDemoCalendarEvents(): CalendarEvent[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = (n: number): Date => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n)
  const at = (d: Date, h: number, m = 0): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m)
  const list: CalendarEvent[] = []
  for (let d = day(-45); d <= day(60); d = day(Math.round((d.getTime() - today.getTime()) / 86_400_000) + 1)) {
    if (d.getDay() === 1) list.push(demoEvent('demo-work', '定例', at(d, 10), at(d, 10, 30), { recurring: true, hasAttendees: true, location: 'Zoom' }))
    if (d.getDay() === 3) list.push(demoEvent('demo-home', 'ジム', at(d, 19), at(d, 20), { recurring: true }))
  }
  list.push(
    demoEvent('demo-work', '予約画面 レビュー', at(today, 11), at(today, 12), { hasAttendees: true, location: 'Zoom', notes: '空き枠の一覧と確認の画面を見ながら導線を決める。' }),
    demoEvent('demo-work', '採用面談の候補日を返す', at(today, 11, 30), at(today, 12)),
    demoEvent('demo-work', 'ランチ 田中さん', at(today, 13), at(today, 14), { location: '神保町' }),
    demoEvent('demo-home', '買い物', at(today, 17, 30), at(today, 18), { notes: '牛乳、卵、コーヒー豆' }),
    demoEvent('demo-home', '箱根', day(-3), day(-1), { allDay: true }),
    demoEvent('demo-home', '歯医者', at(day(2), 10, 30), at(day(2), 11, 30), { location: 'さくら歯科' }),
    demoEvent('demo-work', '締め切り: 提案書', day(3), day(4), { allDay: true }),
    demoEvent('demo-holiday', '休日', day(6), day(7), { allDay: true }),
    demoEvent('demo-work', 'リリース判定', at(day(9), 10), at(day(9), 11), { hasAttendees: true }),
    demoEvent('demo-work', 'ランチMTG', at(day(9), 13), at(day(9), 14)),
    demoEvent('demo-work', 'A社 打合せ', at(day(9), 15), at(day(9), 16), { location: '六本木' }),
    demoEvent('demo-work', '歓迎会', at(day(9), 18), at(day(9), 20), { location: '恵比寿' }),
    demoEvent('demo-work', 'リリース作業', at(day(10), 22), at(day(11), 2)),
    demoEvent('demo-home', '帰省', day(11), day(15), { allDay: true, location: '仙台' })
  )
  return list
}

/**
 * The short list for the calendar card (today's events), as opposed to the calendar screen. Around the
 * time the demo runs it holds at least one event that has ended, one in progress, one still to come and
 * one all-day event.
 */
const HOUR = 3_600_000
const nowMs = Date.now()
const todayMs = new Date(new Date(nowMs).setHours(0, 0, 0, 0)).getTime()
export const DEMO_CALENDAR_CARD = {
  range: 'today',
  fromMs: todayMs,
  untilMs: todayMs + 24 * HOUR,
  events: [
    { title: '定例', start: nowMs - 2 * HOUR, end: nowMs - 1.5 * HOUR, allDay: false, location: 'Zoom', ongoing: false },
    { title: '締め切り: 提案書', start: todayMs, end: todayMs + 24 * HOUR, allDay: true },
    { title: '予約画面 レビュー', start: nowMs - 20 * 60_000, end: nowMs + 40 * 60_000, allDay: false, location: 'Zoom' },
    { title: 'ランチ 田中さん', start: nowMs + HOUR, end: nowMs + 2 * HOUR, allDay: false, location: '神保町' },
    { title: '歯医者', start: nowMs + 3 * HOUR, end: nowMs + 4 * HOUR, allDay: false, location: 'さくら歯科' },
    { title: '買い物', start: nowMs + 5 * HOUR, end: nowMs + 5.5 * HOUR, allDay: false }
  ]
}
