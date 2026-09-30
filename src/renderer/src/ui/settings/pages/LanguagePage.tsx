import { CONVERSATION_LOCALES, REGIONS, ttsEngineSpeaks, type ConversationLocale } from '@shared/conversation-locale'
import { UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from '@shared/i18n'
import type { SettingsContext } from '../context'
import { Group, Page, Row } from '../primitives'
import { useT, useUiLocale } from '@/i18n'

/**
 * The three language settings side by side: the language of the screen, the language the conversation
 * is held in, and the region its weather, news and formats come from. They are three choices rather
 * than one, because someone living in Japan may talk in English and still want the weather of Japan.
 */
export function LanguagePage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const uiLocale = useUiLocale()
  const names = new Intl.DisplayNames([uiLocale], { type: 'region' })
  const regions = [...new Set([...REGIONS, settings.region])]
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLocale))

  const changeLocale = (locale: ConversationLocale): void => {
    // An engine that cannot read the new language aloud would leave the conversation silent, so it
    // moves to the OS's voice in the same save.
    const engine = ttsEngineSpeaks(locale, settings.ttsEngine) ? {} : { ttsEngine: 'system' as const }
    set({ conversationLocale: locale, ...engine })
  }

  return (
    <Page title={t('settings.pages.language')} lead={t('settingsLanguage.lead')}>
      <Group>
        <Row label={t('settingsLanguage.ui')} hint={t('settingsLanguage.uiHint')}>
          <select className="st-select" aria-label={t('settingsLanguage.ui')} value={settings.uiLocale} onChange={(e) => set({ uiLocale: e.target.value as UiLocale })}>
            {UI_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {UI_LOCALE_NAMES[locale]}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('settingsLanguage.conversation')} hint={t('settingsLanguage.conversationHint')}>
          <select
            className="st-select"
            aria-label={t('settingsLanguage.conversation')}
            value={settings.conversationLocale}
            onChange={(e) => changeLocale(e.target.value as ConversationLocale)}
          >
            {CONVERSATION_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {UI_LOCALE_NAMES[locale]}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('settingsLanguage.region')} hint={t('settingsLanguage.regionHint')}>
          <select className="st-select" aria-label={t('settingsLanguage.region')} value={settings.region} onChange={(e) => set({ region: e.target.value })}>
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </select>
        </Row>
      </Group>
    </Page>
  )
}
