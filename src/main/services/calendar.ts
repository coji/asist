import { safeStorage, shell } from 'electron'
import type { CalendarStatus } from '@shared/calendar'
import { errorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'
import { CalendarService } from './calendar-service'
import { requestConfirm } from './confirm'
import { createEncryptedSecretStore } from './encrypted-secrets'
import { GoogleCalendar } from './google-calendar'
import { GoogleAuth, type GoogleTokenId } from './google-oauth'
import { googleOAuthClient } from './google-oauth-client'
import { googleSignInPage } from './google-sign-in-page'
import { t } from './i18n'
import { dataPath } from './store'

let google: GoogleCalendar | null = null

/**
 * Google Calendar with its sign-in, whose refresh token lives encrypted in userData/google-calendar.json.
 * A build without the OAuth client fails here, when the calendar is first used, rather than at launch.
 */
function googleCalendar(): GoogleCalendar {
  if (google) return google
  const client = googleOAuthClient()
  if (!client) throw new Error(errorText('calendar.errors.googleClientMissing'))
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
  return (google = new GoogleCalendar({ auth, fetch }))
}

let service: CalendarService | null = null
function calendarService(): CalendarService {
  return (service ??= new CalendarService({
    settings: () => getSettings().calendar,
    calendar: googleCalendar(),
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
export const signOutCalendar = (): Promise<CalendarStatus> => googleCalendar().signOut()
