import { createTranslator, type Translate, type UiLocale } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'

/**
 * The interface language for the text the main process writes itself: menus, notifications, confirmation
 * windows, and the progress and results of preparations. Errors are not written here; they carry a key
 * (shared/i18n/error-text.ts) and the renderer writes them.
 */

const translators = new Map<UiLocale, Translate>()

/**
 * The dictionary in one language. Text that belongs to the conversation rather than to the screen, such
 * as a fixed line the assistant says aloud or a word a tool result carries to the model, is looked up in
 * the conversation language a turn read when it started: someone can read the screen in one language and
 * talk in another, and a reply is in one language from start to end.
 */
export function translatorIn(locale: UiLocale): Translate {
  let translator = translators.get(locale)
  if (!translator) {
    translator = createTranslator(locale)
    translators.set(locale, translator)
  }
  return translator
}

/** Reads the language on every call, so a change of the setting shows in the next text. */
export const t: Translate = (key, ...values) => translatorIn(getSettings().uiLocale)(key, ...values)

/** An error as text in the given language. An error that was not written for the user is returned as it is. */
export function errorMessageIn(locale: UiLocale, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return readErrorText(text, locale) ?? text
}

/**
 * An error as text in the interface language, for a result the screen shows as plain text instead of as an
 * error, such as `{ ok: false, message }`.
 */
export const errorMessage = (error: unknown): string => errorMessageIn(getSettings().uiLocale, error)
