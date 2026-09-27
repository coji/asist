import { useEffect, useState } from 'react'
import { ASIST_LICENSE, creditsOf, type Credit, type CreditGroup } from '@shared/credits'
import { Btn, Chip, Group, Page, Row } from '../primitives'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import type { Translate } from '@shared/i18n'

/** The about page: the version of the app and every model and data source it uses, with its license. */
export function AboutPage(): React.JSX.Element {
  const t = useT()
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])
  return (
    <Page title={t('settingsAbout.title')} lead={t('settingsAbout.lead')}>
      <Group title="ASIST">
        <Row label={t('settingsAbout.version')}>
          <span className="st-value">{version}</span>
        </Row>
        <Row label={t('settingsAbout.license')}>
          <a className="st-link" href={ASIST_LICENSE.url} target="_blank" rel="noreferrer">
            {ASIST_LICENSE.name}
          </a>
        </Row>
        <Row label={t('settingsAbout.notices.label')} hint={t('settingsAbout.notices.hint')}>
          <Btn onClick={() => void window.api.licensesOpen()}>{t('settingsAbout.notices.open')}</Btn>
        </Row>
      </Group>
      <Credits group="local" t={t} />
      <Credits group="api" t={t} />
      <Credits group="data" t={t} />
      <Credits group="bundled" t={t} />
      <Credits group="software" t={t} />
    </Page>
  )
}

function Credits({ group, t }: { group: CreditGroup; t: Translate }): React.JSX.Element {
  return (
    <Group title={t(`settingsAbout.${group}.title`)} description={t(`settingsAbout.${group}.description`)}>
      {creditsOf(group, platformCapabilities().speechRuntime.kind).map((credit) => (
        <Row key={credit.id} label={credit.name} hint={t(credit.use)}>
          <Chip tone="dim">{credit.license ?? t('settingsAbout.providerTerms')}</Chip>
          <Source credit={credit} />
        </Row>
      ))}
    </Group>
  )
}

/** The link the license or the terms ask to be shown. Where a notice is required, it is the text of the link. */
function Source({ credit }: { credit: Credit }): React.JSX.Element {
  return (
    <a className="st-link" href={credit.url} target="_blank" rel="noreferrer">
      {credit.notice ?? credit.provider}
    </a>
  )
}
