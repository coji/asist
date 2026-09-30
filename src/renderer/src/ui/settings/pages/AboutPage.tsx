import { useEffect, useState } from 'react'
import { APP_LOG_RETENTION_DAYS } from '@shared/app-log'
import { osMessageKey } from '@shared/i18n/os-message'
import type { AppUpdateState } from '@shared/app-update'
import { ASIST_LICENSE, creditsOf, type Credit, type CreditGroup } from '@shared/credits'
import { Btn, Chip, Group, Page, Row } from '../primitives'
import { useT } from '@/i18n'
import { platformCapabilities } from '@/platform'
import { displayError } from '@/display-error'
import type { Translate } from '@shared/i18n'

/** The about page: the version of the app, its log, and every model and data source it uses, with its license. */
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
        <Update t={t} />
        <Row label={t('settingsAbout.license')}>
          <a className="st-link" href={ASIST_LICENSE.url} target="_blank" rel="noreferrer">
            {ASIST_LICENSE.name}
          </a>
        </Row>
        <Row label={t('settingsAbout.notices.label')} hint={t('settingsAbout.notices.hint')}>
          <Btn onClick={() => void window.api.licensesOpen()}>{t('settingsAbout.notices.open')}</Btn>
        </Row>
      </Group>
      <Group title={t('settingsAbout.appLog.title')} description={t('settingsAbout.appLog.description', { days: APP_LOG_RETENTION_DAYS })}>
        <Row label={t('settingsAbout.appLog.folder')} hint={t(osMessageKey('settingsAbout.appLog.folderHint', platformCapabilities().os))}>
          <Btn onClick={() => void window.api.logsOpenFolder()}>{t(osMessageKey('settingsAbout.appLog.open', platformCapabilities().os))}</Btn>
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

/** Where the automatic update stands. A build that does not come from a release has no row. */
function Update({ t }: { t: Translate }): React.JSX.Element | null {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  useEffect(() => {
    const unsubscribe = window.api.onAppUpdateChanged(setState)
    void window.api.appUpdateState().then(setState)
    return unsubscribe
  }, [])
  if (!state || state.phase === 'off') return null
  const install = (): void => {
    setInstallError(null)
    window.api.appUpdateInstall().catch((error: unknown) => setInstallError(displayError(error)))
  }
  switch (state.phase) {
    case 'checking':
      return (
        <Row label={t('settingsAbout.update.label')}>
          <Chip tone="dim">{t('settingsAbout.update.checking')}</Chip>
        </Row>
      )
    case 'current':
      return (
        <Row label={t('settingsAbout.update.label')}>
          <Chip tone="ok">{t('settingsAbout.update.current')}</Chip>
        </Row>
      )
    case 'downloading':
      return (
        <Row label={t('settingsAbout.update.label')}>
          <Chip tone="cyan">{t('settingsAbout.update.downloading', { version: state.version, percent: state.percent })}</Chip>
        </Row>
      )
    case 'ready':
      return (
        <Row label={t('settingsAbout.update.label')} hint={installError ?? t('settingsAbout.update.ready', { version: state.version })}>
          <Btn tone="primary" onClick={install}>
            {t('settingsAbout.update.restart')}
          </Btn>
        </Row>
      )
    case 'failed':
      return (
        <Row label={t('settingsAbout.update.label')} hint={state.message}>
          <Chip tone="warn">{t('settingsAbout.update.failed')}</Chip>
        </Row>
      )
  }
}

function Credits({ group, t }: { group: CreditGroup; t: Translate }): React.JSX.Element {
  return (
    <Group title={t(`settingsAbout.${group}.title`)} description={t(`settingsAbout.${group}.description`)}>
      {creditsOf(group, platformCapabilities().localSpeech.backend !== null).map((credit) => (
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
