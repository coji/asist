import { safeStorage, shell } from 'electron'
import type { CalendarStatus } from '@shared/calendar'
import { CALENDAR_BACKEND_VARIABLE, type CalendarBackend as CalendarKind } from '@shared/platform'
import { errorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'
import { CalendarService } from './calendar-service'
import type { CalendarBackend } from './calendar-backend'
import { eventKitBackend, runCalendarNative } from './calendar-eventkit'
import { requestConfirm } from './confirm'
import { createEncryptedSecretStore } from './encrypted-secrets'
import { GoogleCalendarBackend } from './google-calendar'
import { GoogleAuth, type GoogleTokenId } from './google-oauth'
import { googleOAuthClient } from './google-oauth-client'
import { googleSignInPage } from './google-sign-in-page'
import { t } from './i18n'
import { platformCapabilities } from './platform'
import { dataPath } from './store'

let backend: CalendarBackend | null = null
let google: GoogleCalendarBackend | null = null

/** The Google backend with its sign-in, whose refresh token lives encrypted in userData/google-calendar.json. */
function googleBackend(): GoogleCalendarBackend {
  if (google) return google
  const client = googleOAuthClient()
  // The capabilities have already stopped the launch when Google was asked for without its client.
  if (!client) throw new Error(errorText('app.startup.googleClientMissing', { variable: CALENDAR_BACKEND_VARIABLE }))
  const tokens = createEncryptedSecretStore<GoogleTokenId>({
    filePath: dataPath('google-calendar.json'),
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
    errors: {
      encryptionUnavailable: () => errorText('calendar.errors.tokenEncryptionUnavailable'),
      secretUnreadable: () => errorText('calendar.errors.tokenUnreadable'),
      fileUnreadable: (file, reason) => errorText('calendar.errors.tokenFileUnreadable', { file, reason }),
      fileBroken: (file) => errorText('calendar.errors.tokenFileBroken', { file })
    }
  })
  const auth = new GoogleAuth({ client, tokens, fetch, openBrowser: (url) => shell.openExternal(url), page: googleSignInPage })
  return (google = new GoogleCalendarBackend({ auth, fetch }))
}

/** Which calendar this machine uses, as the capabilities decided at startup. */
export function calendarKind(): CalendarKind {
  const kind = platformCapabilities().calendar
  if (kind === null) throw new Error(errorText('calendar.errors.macOnly'))
  return kind
}

function calendarBackend(): CalendarBackend {
  return (backend ??= calendarKind() === 'google' ? googleBackend() : eventKitBackend(runCalendarNative))
}

let service: CalendarService | null = null
function calendarService(): CalendarService {
  return (service ??= new CalendarService({
    settings: () => getSettings().calendar,
    backend: calendarBackend(),
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
  }))
}

export const calendarStatus = (): ReturnType<CalendarService['status']> => calendarService().status()
export const requestCalendarAccess = (): ReturnType<CalendarService['status']> => calendarService().status(true)
export const searchCalendar = (input: unknown, signal?: AbortSignal): ReturnType<CalendarService['search']> =>
  calendarService().search(input, signal)
export const listCalendar = (input: unknown, signal?: AbortSignal): ReturnType<CalendarService['list']> =>
  calendarService().list(input, signal)
export const changeCalendar = (input: unknown, signal: AbortSignal): ReturnType<CalendarService['change']> =>
  calendarService().change(input, signal)

/** Signs out of Google. Only the Google calendar has a sign-in of ASIST's own. */
export function signOutCalendar(): Promise<CalendarStatus> {
  if (platformCapabilities().calendar !== 'google') throw new Error(errorText('calendar.errors.googleOnly'))
  return googleBackend().signOut()
}
