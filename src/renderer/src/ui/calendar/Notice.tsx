import type { MessageKey } from '@shared/i18n'
import type { CalendarStatus } from '@shared/calendar'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'

/** `fullAccess` is left out: the notice that carries a hint is drawn only while access is missing. */
const ACCESS_HINT = {
  notDetermined: 'calendar.access.notDetermined',
  denied: 'calendar.access.denied',
  restricted: 'calendar.access.restricted',
  writeOnly: 'calendar.access.writeOnly',
  unreadable: 'calendar.access.unreadable'
} as const satisfies Record<Exclude<CalendarStatus['authorization'], 'fullAccess'>, MessageKey>

/**
 * What the calendar shows in place of its events: a failure to read the calendar, which comes first
 * because it can happen at any step, then what is missing before any event can be shown.
 */
export function Notice({
  settings,
  status,
  error,
  onSettings,
  onRetry,
  onRequestAccess
}: {
  settings: { enabled: boolean; readCalendarIds: string[] } | undefined
  status: CalendarStatus | null
  error: string
  onSettings: () => void
  onRetry: () => void
  onRequestAccess: () => void
}): React.JSX.Element {
  const t = useT()
  const button = 'cal-btn'
  if (error)
    return (
      <div className="cal-notice" role="alert">
        <p>{error}</p>
        <button className={button} onClick={onRetry}>
          {t('common.retry')}
        </button>
      </div>
    )
  if (!settings?.enabled)
    return (
      <div className="cal-notice">
        <p>{t('calendar.notice.disabled')}</p>
        <button className={button} onClick={onSettings}>
          {t('calendar.notice.openSettings')}
        </button>
      </div>
    )
  if (!status) return <div className="cal-notice">{t('calendar.notice.checking')}</div>
  // Google is signed in or not, or holds a sign-in this build cannot read, which a new sign-in replaces.
  if (status.authorization !== 'fullAccess' && platformCapabilities().calendar === 'google')
    return (
      <div className="cal-notice">
        <p>{t(status.authorization === 'unreadable' ? 'calendar.access.unreadable' : 'calendar.access.googleSignedOut')}</p>
        <button className={button} onClick={onRequestAccess}>
          {t('calendar.notice.signIn')}
        </button>
      </div>
    )
  if (status.authorization !== 'fullAccess')
    return (
      <div className="cal-notice">
        <p>{t(ACCESS_HINT[status.authorization])}</p>
        {status.authorization === 'notDetermined' ? (
          <button className={button} onClick={onRequestAccess}>
            {t('calendar.notice.requestAccess')}
          </button>
        ) : (
          <button className={button} onClick={() => void window.api.calendarOpenPrivacy()}>
            {t('calendar.notice.openPrivacy')}
          </button>
        )}
      </div>
    )
  return (
    <div className="cal-notice">
      <p>{t('calendar.notice.noCalendars')}</p>
      <button className={button} onClick={onSettings}>
        {t('calendar.notice.openSettings')}
      </button>
    </div>
  )
}
