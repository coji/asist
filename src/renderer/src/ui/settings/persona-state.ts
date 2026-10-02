import type { MessageKey } from '@shared/i18n'
import type { AppSettings } from '@shared/ipc'

/** How the persona page names a persona as it is saved, or as leaving the field would save it. */
export function personaStateKey(persona: AppSettings['persona']): Extract<MessageKey, `settingsPersona.state.${string}`> {
  if (persona === null) return 'settingsPersona.state.default'
  return persona.trim() ? 'settingsPersona.state.edited' : 'settingsPersona.state.empty'
}
