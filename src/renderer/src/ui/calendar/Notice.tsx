import type { CalendarStatus } from '@shared/calendar'
import { useT } from '@/i18n'

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
  // A sign-in this build cannot read is replaced by a new one.
  if (status.signIn !== 'signedIn')
    return (
      <div className="cal-notice">
        <p>{t(status.signIn === 'unreadable' ? 'calendar.access.unreadable' : 'calendar.access.signedOut')}</p>
        <button className={button} onClick={onRequestAccess}>
          {t('calendar.notice.signIn')}
        </button>
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
