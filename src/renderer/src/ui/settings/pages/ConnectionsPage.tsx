import { connectionsTitle, type SettingsContext } from '../context'
import { CalendarSettings } from '../CalendarSettings'
import { MailSettings } from '../MailSettings'
import { Page } from '../primitives'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'

/** The calendar where this machine has one, and mail. A machine without a calendar sees a page about mail alone. */
export function ConnectionsPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  const { calendar } = platformCapabilities()
  return (
    <Page
      title={connectionsTitle(t, calendar)}
      lead={t(calendar === null ? 'settingsIntegrations.lead.withoutCalendar' : 'settingsIntegrations.lead.withCalendar')}
    >
      {calendar !== null && <CalendarSettings settings={ctx.settings} />}
      <MailSettings ctx={ctx} />
    </Page>
  )
}
