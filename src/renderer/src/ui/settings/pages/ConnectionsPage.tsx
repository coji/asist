import type { SettingsContext } from '../context'
import { CalendarSettings } from '../CalendarSettings'
import { MailSettings } from '../MailSettings'
import { Page } from '../primitives'
import { useT } from '@/i18n'

/** The calendar and mail page: the Google account the calendar reads, and the mail accounts. */
export function ConnectionsPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  return (
    <Page title={t('settings.pages.connections')} lead={t('settingsIntegrations.lead')}>
      <CalendarSettings settings={ctx.settings} />
      <MailSettings ctx={ctx} />
    </Page>
  )
}
