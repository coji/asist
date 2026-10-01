import { fillPrompt, promptText, type ConversationLocale, type PromptText } from './conversation-locale'
import { FIXED } from './memory-page'

/**
 * The bracketed markers the app writes in front of text the model reads, and the prefix a failed tool
 * result carries. Every place that emits one and every prompt that explains one reads it from here, so
 * a marker cannot be changed on one side and left stale on the other.
 */

export const CONVERSATION_MARKERS = {
  /** The memories the app searched for and attached to the user's utterance. */
  memory: { ja: '[記憶]', en: '[Memory]' },
  /** A notification from the app, such as a finished job, standing where a user utterance would. */
  systemNotice: { ja: '[システム通知]', en: '[System notice]' },
  /** Text the user typed rather than spoke, as a live engine receives it. */
  typedInput: { ja: '[文字入力]', en: '[Typed]' },
  /** The same, as a note attached to the utterance of a brain turn. */
  typedInputNote: { ja: '[注: 文字入力]', en: '[Note: typed]' },
  /** The mini app open on screen and what it shows, as a note attached to the utterance. */
  openApp: { ja: '[開いているミニアプリ]', en: '[Open app]' },
  /** The status of the agent jobs and the recent projects, as a note attached to the input when it changed. */
  jobStatus: { ja: '[ジョブの状況]', en: '[Jobs]' }
} as const satisfies Record<string, PromptText>

export type ConversationMarker = keyof typeof CONVERSATION_MARKERS

export const marker = (locale: ConversationLocale, name: ConversationMarker): string =>
  promptText(locale, CONVERSATION_MARKERS[name])

/** What an API whose tool results carry no error flag needs in front of the text, so a failure reads as one. */
const ERROR_PREFIX: PromptText = { ja: 'エラー:', en: 'Error:' }

export const errorPrefix = (locale: ConversationLocale): string => promptText(locale, ERROR_PREFIX)

/**
 * The heading a day's journal gets where it is injected into the conversation. It is the same wording
 * that stands in front of a journal entry where it is embedded for the search, so the model reads a
 * journal under the name the index knows it by.
 */
export const journalHeading = (locale: ConversationLocale, date: string): string =>
  `# ${fillPrompt(promptText(locale, FIXED.journalOf), { date })}`
