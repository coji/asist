import { execFile } from 'node:child_process'
import { z } from 'zod'
import { calendarEventSchema, calendarStatusSchema, type CalendarStatus } from '@shared/calendar'
import type { MessageKey } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { CalendarBackend, CalendarWrite } from './calendar-backend'
import { childEnv } from './child-env'
import { nativeHelperPath } from './resource-path'

/** The codes the calendar helper (resources/native/macos/asist-calendar.swift) fails with, and the message of each. */
const HELPER_ERRORS = {
  needsFullAccess: 'calendar.errors.needsFullAccess',
  noReadCalendars: 'calendar.errors.noReadCalendars',
  calendarNotFound: 'calendar.errors.calendarNotFound',
  eventNotFound: 'calendar.errors.eventNotFound',
  destinationUnwritable: 'calendar.errors.destinationUnwritable',
  locked: 'calendar.errors.locked',
  changedSinceConfirm: 'calendar.errors.changedSinceConfirm',
  badRequest: 'calendar.errors.helperBadRequest',
  eventKitFailed: 'calendar.errors.eventKitFailed'
} as const satisfies Record<string, MessageKey>
type HelperError = keyof typeof HELPER_ERRORS

const helperAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.enum(Object.keys(HELPER_ERRORS) as [HelperError, ...HelperError[]]) })
])

/** The data of the helper's answer, or the failure it reports, thrown as an error for the user. */
function helperResult(stdout: string): unknown {
  let answer: z.infer<typeof helperAnswerSchema>
  try {
    answer = helperAnswerSchema.parse(JSON.parse(stdout))
  } catch (cause) {
    throw new Error(errorText('calendar.errors.helperBadResponse'), { cause })
  }
  if (answer.ok) return answer.data
  throw new Error(errorText(HELPER_ERRORS[answer.error]))
}

/** One request to the helper, which runs once per request and answers on stdout. */
export type CalendarNative = (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

export const runCalendarNative: CalendarNative = (input, signal) => {
  const executable = nativeHelperPath('macos', 'asist-calendar')
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [],
      {
        timeout: input.operation === 'requestAccess' ? 120_000 : 15_000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: childEnv(),
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(errorText('calendar.errors.helperFailed')))
          return
        }
        try {
          resolve(helperResult(stdout))
        } catch (error) {
          reject(error)
        }
      }
    )
    child.stdin?.on('error', () => {
      /* execFile callback reports process failure. */
    })
    child.stdin?.end(JSON.stringify(input))
  })
}

/** What the helper is asked for a write. An update or a delete carries the revision the user approved. */
function writeRequest(change: CalendarWrite): Record<string, unknown> {
  if (change.operation === 'create') return { operation: 'create', event: change.event, calendarId: change.calendar.id }
  const { before } = change
  return {
    operation: change.operation,
    eventId: before.id,
    ...(change.operation === 'update' ? { event: change.event } : {}),
    calendarId: before.calendarId,
    revision: before.revision
  }
}

/**
 * The Mac's own calendars, which hold every account added to macOS. macOS syncs a saved change to Google
 * or iCloud later, so a save tells only that the Mac has it.
 */
export function eventKitBackend(native: CalendarNative): CalendarBackend {
  const events = z.array(calendarEventSchema)
  const status = async (operation: 'status' | 'requestAccess'): Promise<CalendarStatus> => ({
    ...calendarStatusSchema.omit({ account: true }).parse(await native({ operation })),
    account: null
  })
  return {
    status: () => status('status'),
    requestAccess: () => status('requestAccess'),
    events: async (calendarIds, start, end, signal) => events.parse(await native({ operation: 'search', calendarIds, start, end }, signal)),
    event: async (eventId, signal) => calendarEventSchema.parse(await native({ operation: 'get', eventId }, signal)),
    write: async (change) => calendarEventSchema.parse(await native(writeRequest(change))),
    syncNote: 'calendar.confirm.syncNote',
    savedTo: 'calendar.saved.toMac'
  }
}
