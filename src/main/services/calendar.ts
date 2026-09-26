import { app } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { MessageKey } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'
import { CalendarService } from './calendar-service'
import { requestConfirm } from './confirm'
import { t } from './i18n'
import { childEnv } from './child-env'

/** The codes the calendar helper (resources/native/asist-calendar.swift) fails with, and the message of each. */
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

export function runCalendarNative(
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (process.platform !== 'darwin')
    return Promise.reject(new Error(errorText('calendar.errors.macOnly')))
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'asist-calendar')
    : path.join(app.getAppPath(), 'resources/native/asist-calendar')
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

const service = new CalendarService({
  settings: () => getSettings().calendar,
  native: runCalendarNative,
  confirm: (detail, signal, destructive) =>
    requestConfirm(
      {
        title: t('calendar.confirm.title'),
        message: t('calendar.confirm.message'),
        detail,
        confirmLabel: t('calendar.confirm.action'),
        destructive
      },
      signal
    )
})
export const calendarStatus = (): ReturnType<CalendarService['status']> =>
  service.status()
export const requestCalendarAccess = (): ReturnType<
  CalendarService['status']
> => service.status(true)
export const searchCalendar = (
  input: unknown,
  signal?: AbortSignal
): ReturnType<CalendarService['search']> => service.search(input, signal)
export const listCalendar = (
  input: unknown,
  signal?: AbortSignal
): ReturnType<CalendarService['list']> => service.list(input, signal)
export const changeCalendar = (
  input: unknown,
  signal: AbortSignal
): ReturnType<CalendarService['change']> => service.change(input, signal)

