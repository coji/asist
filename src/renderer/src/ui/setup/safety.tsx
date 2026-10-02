import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { docsUrl } from '@shared/docs-links'
import { safetyNoticePending } from '@shared/settings'
import type { UiLocale } from '@shared/i18n'
import { useSettingsStore } from '@/state/stores'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { Btn } from '../settings/primitives'
import { SetupError } from './error'

/**
 * The risks of using ASIST, shown once before it is used: as a step of the first-run setup, or in a
 * dialog of its own for someone who finished the setup before the notice existed. Ticking the box is
 * the acknowledgement, and settings.json keeps it.
 */

const POINTS = ['answers', 'approval', 'billing', 'data'] as const

export function SafetyStep({
  uiLocale,
  acknowledged,
  onAcknowledged
}: {
  uiLocale: UiLocale
  acknowledged: boolean
  onAcknowledged: (acknowledged: boolean) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="su-stack">
      <ol className="su-risks">
        {POINTS.map((id) => (
          <li key={id}>
            <h3>{t(`setup.safety.points.${id}.title`)}</h3>
            <p>{t(`setup.safety.points.${id}.body`)}</p>
          </li>
        ))}
      </ol>
      <div className="su-risks-foot">
        <label className="su-check su-ack">
          <input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledged(event.target.checked)} />
          {t('setup.safety.acknowledge')}
        </label>
        <button type="button" className="su-link" onClick={() => void window.api.openExternal(docsUrl('safety', uiLocale))}>
          {t('setup.safety.docsLink')}
          <ExternalLink size={12} aria-hidden />
        </button>
      </div>
    </div>
  )
}

/**
 * The notice for someone whose setup is already finished but who has not acknowledged the risks. It
 * covers the app until the box is ticked and saved, and then calls onAcknowledged.
 */
export function SafetyNotice({ onAcknowledged }: { onAcknowledged: () => void }): React.JSX.Element | null {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const saveSettings = useSettingsStore((state) => state.save)
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  if (!settings || !safetyNoticePending(settings)) return null

  const acknowledge = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await saveSettings({ safetyNoticeVersion: 1 })
      onAcknowledged()
    } catch (err) {
      setError(displayError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="su-backdrop">
      <section className="glass su-dialog is-notice" role="dialog" aria-modal="true" aria-labelledby="su-notice-title">
        <header className="su-head">
          <h1 id="su-notice-title">{t('setup.steps.safety.title')}</h1>
          <p>{t('setup.steps.safety.lead')}</p>
        </header>
        <div className="su-body">
          <SafetyStep uiLocale={settings.uiLocale} acknowledged={checked} onAcknowledged={setChecked} />
          {error && <SetupError message={error} />}
        </div>
        <footer className="su-foot">
          <p className="su-next" aria-live="polite">
            {checked ? '' : t('setup.guide.safety.tick')}
          </p>
          <Btn tone="primary" disabled={!checked || saving} onClick={() => void acknowledge()}>
            {saving ? t('common.saving') : t('setup.safety.continue')}
          </Btn>
        </footer>
      </section>
    </div>
  )
}
