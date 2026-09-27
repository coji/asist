import type { CalendarEvent, CalendarEventInput, CalendarStatus } from '@shared/calendar'

/**
 * Where CalendarService reads and writes events. The service owns the rules every calendar shares (the
 * chosen calendars, the confirmation before a write, the checks that make a write safe), and a backend
 * only talks to its calendar: EventKit through the native helper, or Google through its API.
 */

/** A write the user approved, with the event as it was read before the confirmation. */
export type CalendarWrite =
  | { operation: 'create'; calendar: CalendarStatus['calendars'][number]; event: CalendarEventInput }
  | { operation: 'update'; before: CalendarEvent; event: CalendarEventInput }
  | { operation: 'delete'; before: CalendarEvent }

export interface CalendarBackend {
  status(signal?: AbortSignal): Promise<CalendarStatus>
  /** Asks for access: EventKit asks macOS, and Google signs in through the browser unless it already has. */
  requestAccess(): Promise<CalendarStatus>
  /** Every event of the calendars that overlaps the range, and possibly some just before it, which the service trims. */
  events(calendarIds: string[], start: string, end: string, signal?: AbortSignal): Promise<CalendarEvent[]>
  event(eventId: string, signal?: AbortSignal): Promise<CalendarEvent>
  /**
   * Saves an approved change and returns the event as saved, or as it was for a delete. It throws
   * CalendarWriteRejected only when the calendar answered that it saved nothing; any other failure leaves
   * the result unknown.
   */
  write(change: CalendarWrite): Promise<CalendarEvent>
  /** A note in the confirmation about where the change goes after it is saved, if the calendar needs one. */
  syncNote: 'calendar.confirm.syncNote' | null
  /** What a saved change reports about where it was saved. */
  savedTo: 'calendar.saved.toMac' | 'calendar.saved.toGoogle'
}

/** A write the calendar refused before saving anything, so its reason can be shown instead of an unknown result. */
export class CalendarWriteRejected extends Error {}
