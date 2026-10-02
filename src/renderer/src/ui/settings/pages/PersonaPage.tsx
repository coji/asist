import { defaultPersona, personaText } from '@shared/persona'
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
  const shown = personaText(settings)
  // A text equal to the default the field shows, the one of the conversation language, is saved as the default,
  // which goes on following the language. The default of the other language is saved as the user's text, since
  // saving it as the default would replace it in the field with the default of the conversation language.
  const fromField = (text: string): string | null => (text === defaultPersona(settings.conversationLocale) ? null : text)
  const persona = useFieldDraft(shown, { format: (text) => text, parse: (text) => text, save: (text) => set({ persona: fromField(text) }) })
  // A field that still shows the saved persona saves nothing when it is left, so a text of the user's stays theirs
  // even where it reads as the default.
  const stored = persona.value === shown ? settings.persona : fromField(persona.value)

  return (
    <Page title={t('settingsPersona.title')} lead={t('settingsPersona.lead')}>
      <Group
        title={t('settingsPersona.text.title')}
        description={t('settingsPersona.text.description')}
        action={
          <Btn
            tone="quiet"
            disabled={stored === null}
            onClick={() => {
              // A text whose save failed stays in the field over the saved value, and the default may be that
              // very value, so saving it would not move the text aside.
              persona.discard()
              void set({ persona: null })
            }}
          >
            {t('settingsPersona.text.reset')}
          </Btn>
        }
      >
        <Row label={t(personaStateKey(stored))} hint={persona.failed ? <NotSavedHint /> : t('settingsPersona.text.hint')} wide>
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
