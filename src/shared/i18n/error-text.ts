import { MESSAGES, formatMessage, type MessageKey, type UiLocale } from '.'
import { ERROR_MARKER as MARKER, errorKey, type ErrorArguments } from './error-key'
import type { Message } from './message'

/**
 * The text of an error that is meant for the user. Electron carries only an error's message from the
 * main process to the renderer, so the message has to hold everything: the English sentence, which
 * is what the log keeps, followed by the key of the message and its values, from which the renderer
 * writes the sentence again in the language of the interface.
 */

type Values = Record<string, string | number>
function find(key: string): Message | undefined {
  let node: unknown = MESSAGES
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part]
  return node && typeof node === 'object' && 'en-US' in node ? (node as Message) : undefined
}

const mapStrings = (values: Values, change: (value: string) => string): Values =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, typeof value === 'string' ? change(value) : value]))

/**
 * The message of an `Error` or of a zod issue: `throw new Error(errorText('errorsMail.notConnected', { account }))`.
 * A value may be the message of another error, which the sentence then carries without its marker, so the
 * first marker in the message is this one; the marker keeps the value whole for the reader.
 */
export function errorText<Key extends MessageKey>(key: Key, ...values: ErrorArguments<Key>): string {
  const given = values[0] as Values | undefined
  const sentence = formatMessage(find(key)!, 'en-US', given && mapStrings(given, (value) => value.replace(new RegExp(MARKER, 'g'), '')))
  return `${sentence} ${errorKey(key, ...values)}`
}

/**
 * The sentence of an error in the given language, or null for an error that was not written for the user,
 * such as one from a library. The marker can sit anywhere, because other code wraps messages, and the first
 * one is read. A value that is the message of another error is written in the same language.
 */
export function readErrorText(message: string, locale: UiLocale): string | null {
  const match = new RegExp(MARKER).exec(message)
  const found = match && find(match[1])
  if (!match || !found) return null
  const values = match[2] ? (JSON.parse(match[2]) as Values) : undefined
  return formatMessage(found, locale, values && mapStrings(values, (value) => readErrorText(value, locale) ?? value))
}
