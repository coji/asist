import { type Message, type PluralForms, type UiLocale } from './message'
import { app } from './messages/app'
import { boot } from './messages/boot'
import { calendar } from './messages/calendar'
import { cardsFinance } from './messages/cards-finance'
import { cardsInfo } from './messages/cards-info'
import { cardsTime } from './messages/cards-time'
import { cardsWeather } from './messages/cards-weather'
import { common } from './messages/common'
import { confirm } from './messages/confirm'
import { conversation } from './messages/conversation'
import { files } from './messages/files'
import { hud } from './messages/hud'
import { jobs } from './messages/jobs'
import { llmModels } from './messages/llm-models'
import { mail } from './messages/mail'
import { mailCards } from './messages/mail-cards'
import { memory } from './messages/memory'
import { navigation } from './messages/navigation'
import { notes } from './messages/notes'
import { panels } from './messages/panels'
import { settings } from './messages/settings'
import { settingsAbout } from './messages/settings-about'
import { settingsLanguage } from './messages/settings-language'
import { settingsOverview } from './messages/settings-overview'
import { settingsUsage } from './messages/settings-usage'
import { settingsAgent } from './messages/settings-agent'
import { settingsCalendar } from './messages/settings-calendar'
import { settingsAppearance } from './messages/settings-appearance'
import { settingsConversation } from './messages/settings-conversation'
import { settingsIntegrations } from './messages/settings-integrations'
import { settingsMail } from './messages/settings-mail'
import { settingsMemory } from './messages/settings-memory'
import { settingsModels } from './messages/settings-models'
import { settingsPersona } from './messages/settings-persona'
import { settingsVoice } from './messages/settings-voice'
import { setup } from './messages/setup'
import { speechRecognition } from './messages/speech-recognition'
import { spoken } from './messages/spoken'
import { tasks } from './messages/tasks'
import { voice } from './messages/voice'
import { voiceEngines } from './messages/voice-engines'

export { UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from './message'

/** Each group by the type of its own file. Spelled out because the compiler cannot write the inferred type of the whole dictionary into a declaration. */
export interface MessageGroups {
  readonly app: typeof app
  readonly boot: typeof boot
  readonly calendar: typeof calendar
  readonly cardsFinance: typeof cardsFinance
  readonly cardsInfo: typeof cardsInfo
  readonly cardsTime: typeof cardsTime
  readonly cardsWeather: typeof cardsWeather
  readonly common: typeof common
  readonly confirm: typeof confirm
  readonly conversation: typeof conversation
  readonly files: typeof files
  readonly hud: typeof hud
  readonly jobs: typeof jobs
  readonly llmModels: typeof llmModels
  readonly mail: typeof mail
  readonly mailCards: typeof mailCards
  readonly memory: typeof memory
  readonly navigation: typeof navigation
  readonly notes: typeof notes
  readonly panels: typeof panels
  readonly settings: typeof settings
  readonly settingsAbout: typeof settingsAbout
  readonly settingsLanguage: typeof settingsLanguage
  readonly settingsOverview: typeof settingsOverview
  readonly settingsUsage: typeof settingsUsage
  readonly settingsAgent: typeof settingsAgent
  readonly settingsCalendar: typeof settingsCalendar
  readonly settingsAppearance: typeof settingsAppearance
  readonly settingsConversation: typeof settingsConversation
  readonly settingsIntegrations: typeof settingsIntegrations
  readonly settingsMail: typeof settingsMail
  readonly settingsMemory: typeof settingsMemory
  readonly settingsModels: typeof settingsModels
  readonly settingsPersona: typeof settingsPersona
  readonly settingsVoice: typeof settingsVoice
  readonly setup: typeof setup
  readonly speechRecognition: typeof speechRecognition
  readonly spoken: typeof spoken
  readonly tasks: typeof tasks
  readonly voice: typeof voice
  readonly voiceEngines: typeof voiceEngines
}

/**
 * The strings of the user interface, one file per screen under messages/. A key is the path to a
 * message, and the `{name}` placeholders of its Japanese text are the values it takes, so a wrong
 * key or a missing value is a type error.
 */
export const MESSAGES: MessageGroups = {
  app,
  boot,
  calendar,
  cardsFinance,
  cardsInfo,
  cardsTime,
  cardsWeather,
  common,
  confirm,
  conversation,
  files,
  hud,
  jobs,
  llmModels,
  mail,
  mailCards,
  memory,
  navigation,
  notes,
  panels,
  settings,
  settingsAbout,
  settingsLanguage,
  settingsOverview,
  settingsUsage,
  settingsAgent,
  settingsCalendar,
  settingsAppearance,
  settingsConversation,
  settingsIntegrations,
  settingsMail,
  settingsMemory,
  settingsModels,
  settingsPersona,
  settingsVoice,
  setup,
  speechRecognition,
  spoken,
  tasks,
  voice,
  voiceEngines
}

type Paths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends Message ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>
}[keyof T & string]

export type MessageKey = Paths<MessageGroups>

type At<T, Key extends string> = Key extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T ? At<T[Head], Rest> : never
  : Key extends keyof T ? T[Key] : never

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never
type SourcePlaceholders<M> = M extends Message
  ? M['ja-JP'] extends string ? Placeholders<M['ja-JP']> : M['ja-JP'] extends PluralForms ? Placeholders<M['ja-JP']['other']> | 'count' : never
  : never

type ValueNames<Key extends MessageKey> = SourcePlaceholders<At<MessageGroups, Key>>

/** The values a message takes. A message with plural forms always takes `count`. */
export type MessageValues<Key extends MessageKey> = Record<ValueNames<Key>, string | number>

type Arguments<Key extends MessageKey> = [ValueNames<Key>] extends [never] ? [] : [values: MessageValues<Key>]

export type Translate = <Key extends MessageKey>(key: Key, ...values: Arguments<Key>) => string

function find(key: string): Message {
  let node: unknown = MESSAGES
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part]
  return node as Message
}

/** Picks the plural form by `count` under the locale's rules and fills the placeholders in. */
export function formatMessage(message: Message, locale: UiLocale, values?: Record<string, string | number>): string {
  const form = message[locale]
  const text = typeof form === 'string' ? form : form[new Intl.PluralRules(locale).select(Number(values?.count))] ?? form.other
  return values ? text.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name])) : text
}

export function createTranslator(locale: UiLocale): Translate {
  return (key: string, values?: Record<string, string | number>): string => formatMessage(find(key), locale, values)
}
