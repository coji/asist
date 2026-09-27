import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'
import { languageOf, regionCurrency } from '@shared/conversation-locale'
import { conversationLocale, region } from './conversation-locale'
import { weatherPanelProps } from './weather'
import { withTimeoutSignal } from '@shared/abort'
import { includesNextWeek, resolveCalendarRange, summarizeCalendarEvents, type CalendarRange } from '@shared/calendar'
import { addDays } from '@shared/calendar-layout'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'
import { calendarKind, searchCalendar } from './calendar'
import { getMailService } from './mail'
import { allowedPath, readFileItem } from './file-preview'
import { fileUrl } from '../file-protocol'
import type { FileItem } from '@shared/files'
import { allowedFileRoots } from './agent'
import { userAgent } from './user-agent'
import { fetchFailure } from './fetch-failure'
import { t } from './i18n'
import type { MessageKey } from '@shared/i18n'
import type { CalendarBackend } from '@shared/platform'

/**
 * The data fetchers of the built-in panels, which run in the main process and build, from external APIs
 * and local data, the props the renderer's Body receives. A failure is thrown, and the caller turns it
 * into the panel's error state.
 */

type Props = Record<string, unknown>
/** props is what the card renders. data is what goes back to the LLM, and props is sent as it is when data is omitted. */
type Fetched = { props: Props; source?: string; data?: unknown }
type Fetcher = (props: Props, signal: AbortSignal) => Promise<Fetched>

const request = async (url: string, signal: AbortSignal): Promise<Response> => {
  const res = await fetch(url, { signal, headers: { 'user-agent': userAgent() } }).catch((error: unknown) => {
    throw fetchFailure(url, error)
  })
  if (!res.ok) throw new Error(errorText('panels.errors.fetchFailed', { host: new URL(url).hostname, status: res.status }))
  return res
}

const json = async <T>(url: string, signal: AbortSignal): Promise<T> => (await (await request(url, signal)).json()) as T

interface GeoResult {
  name: string
  latitude: number
  longitude: number
  timezone: string
  country?: string
  admin1?: string
}

/**
 * Open-Meteo's geocoding only resolves English or local names, so a Japanese place name is translated
 * first. A Map, because the place name comes from the model and an object would also answer
 * "constructor" or "toString" with a member of its prototype.
 */
const JP_PLACES = new Map(
  Object.entries({
    東京: 'Tokyo', 大阪: 'Osaka', 京都: 'Kyoto', 名古屋: 'Nagoya', 札幌: 'Sapporo',
    福岡: 'Fukuoka', 仙台: 'Sendai', 広島: 'Hiroshima', 横浜: 'Yokohama', 神戸: 'Kobe',
    那覇: 'Naha', 沖縄: 'Naha', 金沢: 'Kanazawa', 新潟: 'Niigata', 静岡: 'Shizuoka',
    岡山: 'Okayama', 熊本: 'Kumamoto', 鹿児島: 'Kagoshima', 長野: 'Nagano', 松本: 'Matsumoto',
    ニューヨーク: 'New York', ロサンゼルス: 'Los Angeles', サンフランシスコ: 'San Francisco',
    ロンドン: 'London', パリ: 'Paris', ベルリン: 'Berlin', ローマ: 'Rome',
    シンガポール: 'Singapore', ソウル: 'Seoul', 北京: 'Beijing', 上海: 'Shanghai',
    台北: 'Taipei', 香港: 'Hong Kong', バンコク: 'Bangkok', シドニー: 'Sydney',
    ドバイ: 'Dubai', ホノルル: 'Honolulu', バンクーバー: 'Vancouver'
  })
)

async function geocodeOnce(name: string, signal: AbortSignal): Promise<GeoResult | null> {
  const data = await json<{ results?: GeoResult[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=${languageOf(conversationLocale())}`,
    signal
  )
  return data.results?.[0] ?? null
}

async function geocode(place: string, signal: AbortSignal): Promise<GeoResult> {
  const name = place.trim()
  // The suffix is dropped only after the name as given misses the table, or "京都" would be looked up as "京".
  const bare = name.replace(/(都|府|県|市)$/, '')
  const result = await geocodeOnce(JP_PLACES.get(name) ?? JP_PLACES.get(bare) ?? bare, signal)
  if (result) return result
  throw new Error(errorText('panels.errors.placeNotFound', { place }))
}

const weather: Fetcher = weatherPanelProps

const clock: Fetcher = async (props, signal) => {
  const city = String(props.city ?? '').trim()
  if (!city) throw new Error(errorText('panels.errors.cityMissing'))
  const geo = await geocode(city, signal)
  return {
    props: { city: geo.name, timezone: geo.timezone, country: geo.country ?? '' },
    source: geo.timezone
  }
}

/**
 * The props a card is keyed and fetched with, once the main process has filled in what only it knows:
 * an exchange rate asked for without the currency it is quoted in takes the region's. show_ tools make
 * the key of the card from these, so asking again with that currency named lands on the same card. A
 * rate of a currency against itself is always 1, so when the region's currency is the base, the rate
 * is quoted against the other of the two most traded currencies. A region outside the list of the
 * settings has no currency to take, and the card says so rather than quoting against a country the user
 * never chose.
 */
export function completePanelProps(type: string, props: Props): Props {
  if (type !== 'fx' || props.quote != null) return props
  const home = region()
  const currency = regionCurrency(home)
  if (!currency) throw new Error(errorText('panels.errors.currencyUnknown', { region: home }))
  const base = String(props.base).toUpperCase()
  return { ...props, quote: currency !== base ? currency : base === 'USD' ? 'EUR' : 'USD' }
}

const fx: Fetcher = async (props, signal) => {
  const base = String(props.base).toUpperCase()
  const quote = String(props.quote).toUpperCase()
  const data = await json<{ result: string; rates: Record<string, number>; time_last_update_utc: string }>(
    `https://open.er-api.com/v6/latest/${base}`,
    signal
  )
  if (data.result !== 'success' || !data.rates[quote]) throw new Error(errorText('panels.errors.rateUnavailable', { base, quote }))
  return {
    props: {
      base,
      quote,
      rate: data.rates[quote],
      amount: props.amount ?? null,
      asOf: data.time_last_update_utc
    },
    source: 'open.er-api.com'
  }
}

const news: Fetcher = async (props, signal) => {
  const topic = String(props.topic ?? NEWS_TOP_TOPIC).trim()
  // hl is the language of the edition, gl the country whose news it is, and ceid names both again.
  const language = languageOf(conversationLocale())
  const country = region()
  const edition = `hl=${language}&gl=${country}&ceid=${country}:${language}`
  const url =
    topic === NEWS_TOP_TOPIC
      ? `https://news.google.com/rss?${edition}`
      : `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&${edition}`
  const xml = await (await request(url, signal)).text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => {
    const block = m[1]
    const pick = (tag: string): string => {
      // Google News writes the publisher as <source url="…">, so an element may carry attributes.
      const raw = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
      return raw
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        // Last, or the text "&lt;" that the feed escapes as "&amp;lt;" would be read as "<".
        .replace(/&amp;/g, '&')
        .trim()
    }
    return { title: pick('title'), url: pick('link'), date: pick('pubDate'), source: pick('source') }
  })
  if (items.length === 0) throw new Error(errorText('panels.errors.newsMissing', { topic }))
  return { props: { topic, items }, source: 'Google News' }
}

/** The name of the calendar a card's events come from. */
const CALENDAR_CARD_SOURCE = {
  eventkit: 'calendar.card.source.eventkit',
  google: 'calendar.card.source.google'
} as const satisfies Record<CalendarBackend, MessageKey>

const calendar: Fetcher = async (props, signal) => {
  const now = new Date()
  const window = resolveCalendarRange(
    {
      range: typeof props.range === 'string' ? (props.range as CalendarRange) : undefined,
      from: typeof props.from === 'string' ? props.from : undefined,
      to: typeof props.to === 'string' ? props.to : undefined
    },
    now
  )
  const query = typeof props.query === 'string' && props.query.trim() ? props.query.trim() : undefined
  // Asked for "this week" on a weekend, the search reaches into next week in one call, while the card
  // still shows only the events inside this week.
  const searchUntilMs = includesNextWeek(now, window.range) ? addDays(new Date(window.untilMs), 7).getTime() : window.untilMs
  const result = await searchCalendar(
    { start: new Date(window.fromMs).toISOString(), end: new Date(searchUntilMs).toISOString(), ...(query ? { query } : {}) },
    signal
  )
  const events = result.events.filter((event) => event.start < window.untilMs)
  return {
    props: {
      range: window.range,
      fromMs: window.fromMs,
      untilMs: window.untilMs,
      ...(query ? { query } : {}),
      events: events.map((event) => ({ ...event, ongoing: event.start < window.fromMs }))
    },
    source: t(CALENDAR_CARD_SOURCE[calendarKind()]),
    data: summarizeCalendarEvents(conversationLocale(), result.events, now, window)
  }
}

/** How many messages the card shows, unread ones first and newest first within each group. */
const MAIL_CARD_LIMIT = 12

const mail: Fetcher = async (props) => {
  const service = getMailService()
  const status = service.status()
  if (!status.enabled || status.accounts.length === 0) throw new Error(errorText('panels.errors.mailOff'))
  const unreadOnly = props.unreadOnly === true
  const view = typeof props.view === 'string' ? props.view : 'inbox'
  const query = typeof props.query === 'string' ? props.query.trim() : ''
  const { messages, total } = service.list({ view, query, unreadOnly, limit: 200 })
  const sorted = [...messages].sort((a, b) => Number(b.unread) - Number(a.unread) || b.date - a.date).slice(0, MAIL_CARD_LIMIT)
  return {
    props: {
      unreadOnly,
      view,
      query,
      total,
      unread: status.unread,
      accounts: status.accounts.map((account) => ({ id: account.id, label: account.label, unread: account.unread, state: account.state })),
      messages: sorted
    },
    source: `IMAP · ${status.accounts.map((account) => account.label).join(' / ')}`
  }
}

/** The body limit for a single-message card. The rest is not shown even when the card is enlarged; the mail screen has it. */
const MAIL_MESSAGE_TEXT_MAX = 6_000

const mailMessage: Fetcher = async (props) => {
  const service = getMailService()
  const { message, text } = await service.read(String(props.id ?? ''))
  const label = service.status().accounts.find((account) => account.id === message.accountId)?.label ?? message.accountId
  return {
    props: { id: message.id, message, accountLabel: label, text: text.length > MAIL_MESSAGE_TEXT_MAX ? `${text.slice(0, MAIL_MESSAGE_TEXT_MAX)}\n${t('mailCards.message.textClipped')}` : text },
    source: `IMAP · ${label}`
  }
}

const files: Fetcher = async (props) => {
  const paths = Array.isArray(props.paths) ? props.paths.map(String) : []
  if (paths.length === 0) throw new Error(errorText('panels.errors.noPaths'))
  const roots = allowedFileRoots()
  const items: FileItem[] = paths.map((target) => {
    const allowed = allowedPath(target, roots)
    return allowed !== null
      ? readFileItem(allowed, fileUrl)
      : { path: target, name: path.basename(target), kind: 'binary', sizeBytes: 0, error: t('files.errors.outsideRoots') }
  })
  if (items.every((item) => item.error)) {
    throw new Error(errorText('panels.errors.filesUnreadable', { files: items.map((item) => `${item.name}: ${item.error}`).join(' / ') }))
  }
  return { props: { ...props, paths, items }, source: items.length === 1 ? items[0].kind : t('files.source', { count: items.length }) }
}

const FETCHERS: Record<string, Fetcher> = {
  calendar,
  mail,
  'mail-message': mailMessage,
  files,
  weather,
  clock,
  fx,
  news
}

/** Fetches a panel's data. A panel type with no fetcher passes its props straight through. */
export async function fetchPanel(
  type: string,
  props: Props,
  signal?: AbortSignal
): Promise<Fetched> {
  const fetcher = FETCHERS[type]
  if (!fetcher) return { props }
  return fetcher(completePanelProps(type, props), withTimeoutSignal(signal, 12_000))
}
