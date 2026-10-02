import type { MessageKey, MessageValues } from '.'

/**
 * The marker that carries the key of a message and its values inside an error's message, at its start or after a
 * sentence. Its values are matched one JSON string at a time, because a value can be the message of another
 * error, marker and all, and a pattern that ends the values at the first or the last `}]` cuts such a value in two.
 */
export const ERROR_MARKER = String.raw`(?:^|\s)\[asist:([\w.]+)(?: (\{(?:[^"{}]|"(?:[^"\\]|\\.)*")*\}))?\]`

export type ErrorArguments<Key extends MessageKey> = keyof MessageValues<Key> extends never ? [] : [values: MessageValues<Key>]

/**
 * The message of an error thrown where the dictionary is not loaded, such as the preview iframe: the key and its
 * values alone, which the screen writes in the language of the interface as it writes errorText's. This module
 * imports the dictionary's types only, because the dictionary in eleven languages is 1.6 MB of script that took
 * V8 about 18 ms to compile and run once (Node 22, Apple M5, 2026-10-02). Everywhere else errorText is thrown,
 * so that the log keeps an English sentence as well.
 */
export function errorKey<Key extends MessageKey>(key: Key, ...values: ErrorArguments<Key>): string {
  const given = values[0] as Record<string, string | number> | undefined
  return `[asist:${key}${given ? ` ${JSON.stringify(given)}` : ''}]`
}
