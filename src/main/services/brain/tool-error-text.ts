import { promptLanguage, type ConversationLocale } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import { ToolError, resolvePromptTexts } from '@shared/tool-registry'
import { errorMessageIn } from '../i18n'

/**
 * A reason as the clause the texts for the model put it in, as in `…: {reason}。`: without the period that
 * closes it as a sentence of its own, which would otherwise be doubled.
 */
const asClause = (text: string): string => text.trimEnd().replace(/[。．.]+$/u, '')

/**
 * The reason a tool failed, as plain text the model reads inside a tool result, in the conversation
 * language of the tool registry, whatever the language of the interface. An error that carries a message
 * key is worded in that language and loses the key, which would mean nothing to the model, and a message
 * that a ToolError packed into both prompt languages is unpacked into the one being written. Any other
 * message can carry text from outside, so it is never read as a packed pair.
 */
export const reasonText = (err: unknown, locale: ConversationLocale): string =>
  err instanceof ToolError ? resolvePromptTexts(err.message, promptLanguage(locale)) : errorMessageIn(locale, err)

/** The same reason as a clause, for a text that words the failure around it. */
export const detail = (err: unknown, locale: ConversationLocale): string => asClause(reasonText(err, locale))

/** The reasons a schema rejected the input, as one sentence the model reads. */
export const issueText = (issues: readonly { message: string }[], locale: ConversationLocale): string => {
  const language = promptLanguage(locale)
  return issues.map((issue) => asClause(resolvePromptTexts(errorMessageIn(locale, issue.message), language))).join(language === 'ja' ? '、' : ', ')
}

/** The failure of a tool whose input its schema rejected, which sends the model back to the schema. */
export function badInput(issues: readonly { message: string }[], locale: ConversationLocale): ToolError {
  const reasons = issueText(issues, locale)
  return new ToolError({
    ja: `入力が不正: ${reasons}。スキーマに合わせて呼び直すこと。`,
    en: `Invalid input: ${reasons}. Call again with input that matches the schema.`
  })
}

/**
 * The error a card shows, which is the error's own message with its key still in it: the screen words
 * it in the language of the interface, which need not be the language the model is told the failure in.
 * Two errors carry no such message. A time limit, the tool's or the fetch's own, ends a fetch with the
 * platform's TimeoutError, whose message is English; and a ToolError holds the model's two languages,
 * of which the screen has none, while its reason goes to the model anyway.
 */
export const cardError = (err: unknown): string => {
  if (err instanceof Error && err.name === 'TimeoutError') return errorText('panels.errors.timedOut')
  if (err instanceof ToolError) return errorText('panels.errors.reasonToAssistant')
  return err instanceof Error ? err.message : String(err)
}
