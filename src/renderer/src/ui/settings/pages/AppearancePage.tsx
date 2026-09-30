import type { CSSProperties } from 'react'
import { THEMES, type ThemeName } from '@shared/themes'
import type { SettingsContext } from '../context'
import { Group, Page, Row } from '../primitives'
import { HoloSwitch } from '@/components/ui/switch'
import { useT } from '@/i18n'

/** The appearance page: the theme of the whole interface, chosen from the pictures of the themes, and the processing times at the top. */
export function AppearancePage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const choose = (theme: ThemeName): void => {
    if (theme !== settings.theme) set({ theme })
  }
  return (
    <Page title={t('settingsAppearance.title')} lead={t('settingsAppearance.lead')}>
      <Group title={t('settingsAppearance.theme.title')} description={t('settingsAppearance.theme.description')}>
        <div className="st-themes" role="radiogroup" aria-label={t('settingsAppearance.theme.title')}>
          {THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              role="radio"
              className="st-theme"
              aria-checked={settings.theme === theme}
              onClick={() => choose(theme)}
            >
              {/* The picture comes from themes.css, which names the picture of every theme once. It is drawn by the
                  rule in settings.css, not here: a relative url() is resolved against the stylesheet of the
                  declaration that uses it, and in the packaged app an inline style resolved it beside index.html,
                  where no picture is. */}
              <span className="st-theme-picture" style={{ '--st-theme-picture': `var(--app-picture-${theme})` } as CSSProperties} aria-hidden />
              <span className="st-theme-name">{t(`settingsAppearance.themes.${theme}.name`)}</span>
              <span className="st-theme-note">{t(`settingsAppearance.themes.${theme}.description`)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t('settingsAppearance.hud.title')}>
        <Row label={t('settingsAppearance.hud.show')} hint={t('settingsAppearance.hud.hint')}>
          <HoloSwitch checked={settings.showHud} onCheckedChange={(v) => set({ showHud: v })} />
        </Row>
      </Group>
    </Page>
  )
}
