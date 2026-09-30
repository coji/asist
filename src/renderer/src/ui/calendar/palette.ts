import type { CalendarAccount } from '@shared/calendar'

/** The colors are theme tokens (themes.css), so each theme draws the same calendar in its own shade. */
const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--cal-event-${n})`)

/** Gives each visible calendar a color, following the order they come in. */
export function calendarColors(calendars: CalendarAccount[]): Map<string, string> {
  return new Map(calendars.map((c, i) => [c.id, PALETTE[i % PALETTE.length]]))
}

export const colorOf = (colors: Map<string, string>, calendarId: string): string =>
  colors.get(calendarId) ?? PALETTE[0]
