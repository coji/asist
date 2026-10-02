import { defaultPersona } from '@shared/persona'
import { useViewStore } from '@/state/view'
import type { SettingsContext } from '../context'
import { useFieldDraft } from '@/ui/field-draft'
import { Btn, Group, Link, NotSavedHint, Page, Row } from '../primitives'
import { useT } from '@/i18n'
import { personaStateKey } from '../persona-state'

/** The persona page, where the persona text is edited and saved once the field is left. */
export function PersonaPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const persona = useFieldDraft(settings.persona, { format: (text) => text, parse: (text) => text, save: (text) => set({ persona: text }) })
  // Resetting gives the persona of the language the conversation is held in now, not the one the app was installed in.
  const fresh = defaultPersona(settings.conversationLocale)

  return (
    <Page title={t('settingsPersona.title')} lead={t('settingsPersona.lead')}>
      <Group
        title={t('settingsPersona.text.title')}
        description={t('settingsPersona.text.description')}
        action={
          <Btn
            tone="quiet"
            disabled={persona.value === fresh}
            onClick={() => {
              // A text whose save failed stays in the field over the saved value, and the default may be that
              // very value, so saving it would not move the text aside.
              persona.discard()
              void set({ persona: fresh })
            }}
          >
            {t('settingsPersona.text.reset')}
          </Btn>
        }
      >
        <Row label={t(personaStateKey(persona.value))} hint={persona.failed ? <NotSavedHint /> : t('settingsPersona.text.hint')} wide>
          <textarea className="st-input" aria-label={t('settingsPersona.text.label')} placeholder={t('settingsPersona.text.placeholder')} {...persona.props} />
        </Row>
      </Group>

      <Group title={t('settingsPersona.me.title')} description={t('settingsPersona.me.description')}>
        <Row label={t('settingsPersona.me.row')} hint={t('settingsPersona.me.hint')}>
          <Link onClick={() => useViewStore.getState().openApp({ app: 'memory' })}>{t('settingsPersona.me.open')}</Link>
        </Row>
      </Group>
    </Page>
  )
}
