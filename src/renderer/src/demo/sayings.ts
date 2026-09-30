import type { PanelEvent } from '@shared/ipc'
import { catalogByType } from '@shared/panel-catalog'
import { weatherCardKey } from '@shared/weather'
import { matchPanels } from './matcher'
import { DEMO_CALENDAR_CARD } from './fixtures/calendar'
import { resolveCalendarRange, type CalendarRangeInput } from '@shared/calendar'
import { demoFx } from './fixtures/finance'
import { DEMO_JOB } from './fixtures/jobs'
import { DEMO_FILES_DIR, DEMO_IMAGE_PATHS, DEMO_MIXED_PATHS, demoFileItems } from './fixtures/files'
import { DEMO_PDF_PATHS } from './fixtures/files-pdf'
import { DEMO_CODE_PATH, DEMO_HTML_PATH, DEMO_JSON_PATH, DEMO_NOTEBOOK_PATH } from './fixtures/files-code'
import { DEMO_ARCHIVE_PATH, DEMO_AUDIO_PATH, DEMO_VIDEO_PATH } from './fixtures/files-media'
import { DEMO_DOCX_PATH, DEMO_PPTX_PATH, DEMO_XLSX_PATH } from './fixtures/files-office'
import { DEMO_MAIL_BODIES, DEMO_MAIL_CARD, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGE_CARD } from './fixtures/mail'
import { createDemoDraft } from './mail-state'
import { DEMO_NEWS, DEMO_SEARCH } from './fixtures/reading'
import { DEMO_TIMER, demoClock } from './fixtures/time'
import { DEMO_WEATHER_MIYAGI, DEMO_WEATHER_MUNICH, DEMO_WEATHER_TOKYO, demoWeatherFor } from './fixtures/weather'
import { translate } from '@/i18n'

/**
 * The replies to utterances typed into the demo. They build cards in the same shape the real main
 * process returns, together with the text that is spoken. The utterance is interpreted by the demo's own
 * rules (matcher.ts) and the data comes from the fixtures. Making a new card type reachable from the
 * demo means adding one branch to respondTo.
 */
export interface DemoResponse {
  cards: PanelEvent[]
  reply: string
}

const card = (type: string, props: Record<string, unknown>, key?: string, source?: string): PanelEvent => ({
  op: 'create',
  key: key ?? catalogByType.get(type)!.key(props),
  type,
  slot: catalogByType.get(type)?.slot ?? 'right',
  props,
  state: 'ready',
  source
})

/** Stands in for the fetchers of the main process: both panelFetch and the conversation take a card's props from here. */
export function demoPanelProps(type: string, props: Record<string, unknown>): { props: Record<string, unknown>; source?: string } {
  switch (type) {
    case 'fx':
      return {
        props: demoFx(String(props.base ?? 'USD'), String(props.quote ?? 'JPY'), typeof props.amount === 'number' ? props.amount : null),
        source: 'open.er-api.com'
      }
    case 'clock': {
      const clock = demoClock(String(props.city ?? 'ニューヨーク'))
      return { props: clock, source: clock.timezone }
    }
    case 'news':
      return { props: { ...DEMO_NEWS, topic: String(props.topic ?? DEMO_NEWS.topic) }, source: 'Google News' }
    case 'files': {
      const paths = Array.isArray(props.paths) ? props.paths.map(String) : []
      const items = demoFileItems(paths)
      return { props: { ...props, paths, items }, source: items.length === 1 ? items[0].kind : `${items.length}件` }
    }
    case 'calendar':
      return { props: demoCalendarCard(props), source: translate('calendar.card.source') }
    case 'mail': {
      const unreadOnly = props.unreadOnly === true
      const query = String(props.query ?? '').trim().toLowerCase()
      const messages = DEMO_MAIL_CARD.messages
        .filter((m) => !unreadOnly || m.unread)
        .filter((m) => !query || [m.subject, m.from.name, m.snippet, DEMO_MAIL_BODIES.get(m.id) ?? ''].some((text) => text.toLowerCase().includes(query)))
      return { props: { ...DEMO_MAIL_CARD, unreadOnly, view: 'inbox', query, total: messages.length, messages }, source: 'IMAP · 仕事 / 個人' }
    }
    case 'mail-message':
      return { props: DEMO_MAIL_MESSAGE_CARD, source: 'IMAP · 仕事' }
    default:
      return { props, source: 'DEMO' }
  }
}

const fetched = (type: string, props: Record<string, unknown>, key?: string): PanelEvent => {
  const result = demoPanelProps(type, props)
  return card(type, result.props, key, result.source)
}

/** The calendar card of the demo. The window is resolved by the same rules as in the app, and the events reuse today's fixed data. */
function demoCalendarCard(props: Record<string, unknown>): Record<string, unknown> {
  const window = resolveCalendarRange(props as CalendarRangeInput, new Date())
  // For a range that does not include today, today's events are shifted whole onto the first day of the range.
  const shift = window.fromMs <= Date.now() && Date.now() < window.untilMs ? 0 : window.fromMs - DEMO_CALENDAR_CARD.fromMs
  const events = DEMO_CALENDAR_CARD.events.map((event) => ({ ...event, start: event.start + shift, end: event.end + shift }))
  return { ...DEMO_CALENDAR_CARD, events, range: window.range, fromMs: window.fromMs, untilMs: window.untilMs }
}

/** Turns an utterance such as "あさっての予定" ("the day after tomorrow's schedule") or "昨日の予定" ("yesterday's schedule") into a range of that single day. */
function demoDayRange(text: string): { from: string; to: string } | null {
  const offset = /あさって|明後日/.test(text) ? 2 : /明日/.test(text) ? 1 : /昨日/.test(text) ? -1 : null
  if (offset === null || !/予定/.test(text)) return null
  const day = new Date()
  day.setDate(day.getDate() + offset)
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return { from: date, to: date }
}

export function respondTo(text: string): DemoResponse {
  if (/天気/.test(text)) {
    const weather = demoWeatherFor(text)
    return {
      cards: [
        card('weather', { location: weather.location.requested, date: weather.date, weather }, weatherCardKey(weather.location, weather.date))
      ],
      reply:
        weather === DEMO_WEATHER_TOKYO
          ? '明日の東京は一日雨模様ですね。降水確率は80パーセント、最高24度、最低21度と今日より肌寒くなりそうです。傘は必須ですね。'
          : weather === DEMO_WEATHER_MIYAGI
            ? '仙台は今日はよく晴れていますね。いまは29度で、日中は32度まで上がりました。夜も晴れたまま26度くらいまで下がる見込みです。'
            : weather === DEMO_WEATHER_MUNICH
              ? 'ミュンヘンは今15度、曇りで風は時速11キロです。夜は弱い雨に変わって13度まで下がる見込みですよ。'
              : '長野県、長野の観測ですね。今は雨で気温23度、湿度も95パーセントとかなり高めです。この後は曇りに変わっていく見込みですよ。'
    }
  }
  const matches = matchPanels(text)
  if (/タイマー/.test(text)) {
    const minutes = text.match(/(\d+)\s*分/)?.[1]
    const seconds = text.match(/(\d+)\s*秒/)?.[1]
    const total = minutes || seconds ? Number(minutes ?? 0) * 60 + Number(seconds ?? 0) : DEMO_TIMER.seconds
    const label = minutes || seconds ? `${minutes ? `${minutes}分` : ''}${seconds ? `${seconds}秒` : ''}タイマー` : DEMO_TIMER.label
    return {
      cards: [card('timer', { seconds: total, label }, `timer:demo-${Date.now()}`)],
      reply: `${label}を開始しました。`
    }
  }
  const dayRange = demoDayRange(text)
  if (dayRange) return { cards: [fetched('calendar', dayRange)], reply: 'その日の予定を出しました。' }
  const calendarMatch = matches.find((m) => m.type === 'calendar')
  if (calendarMatch) {
    return {
      cards: [fetched('calendar', calendarMatch.props)],
      reply: calendarMatch.props.range === 'week' ? '今週の予定を出しました。' : '今日は6件の予定があります。次はランチですね。'
    }
  }
  if (/メール.*(送って|送信して|返信して)|(送って|送信して|返信して).*メール/.test(text)) {
    // In the real app the change_mail tool creates the draft and opens the card, so the demo creates a draft of the same shape.
    const seed = DEMO_MAIL_DRAFTS[0]
    const draft = createDemoDraft({ accountId: seed.accountId, to: seed.to, cc: seed.cc, subject: seed.subject, body: seed.body, reply: null, origin: 'agent' })
    return { cards: [card('mail-draft', { draftId: draft.id })], reply: '田中さん宛に季節のご挨拶の下書きを出しました。見て、送信を押してください。' }
  }
  if (/メール.*(読んで|開いて|内容|何て)/.test(text)) {
    return { cards: [fetched('mail-message', { id: DEMO_MAIL_MESSAGE_CARD.id })], reply: '田中さんから、来週の打合せの候補日です。火曜 14時か水曜 10時のどちらかで、と聞いています。' }
  }
  const searchMatch = text.match(/(.+?)のメール(を)?(探して|検索して|ある\?|ある？)/)
  if (searchMatch) {
    const query = searchMatch[1].replace(/^(から|の)/, '')
    return { cards: [fetched('mail', { query })], reply: `「${query}」で探しました。` }
  }
  const mailMatch = matches.find((m) => m.type === 'mail')
  if (mailMatch) {
    const unreadOnly = mailMatch.props.unreadOnly === true
    return {
      cards: [fetched('mail', mailMatch.props)],
      reply: unreadOnly ? '未読は3件です。田中さんから来週の打合せの候補日が届いています。' : '受信箱を出しました。未読は3件で、急ぎそうなのは田中さんの打合せの候補日ですね。'
    }
  }
  if (/todo|やること|タスク/i.test(text)) {
    return { cards: [card('todo', {})], reply: 'やることの一覧です。' }
  }
  if (/メモ/.test(text)) {
    return { cards: [card('notes', {})], reply: 'メモの一覧です。' }
  }
  const newsMatch = matches.find((m) => m.type === 'news')
  if (newsMatch) {
    return { cards: [fetched('news', newsMatch.props)], reply: '最新のニュースを6件出しました。' }
  }
  if (/検索|調べて/.test(text)) {
    return { cards: [card('search-results', DEMO_SEARCH, undefined, 'web_search')], reply: '検索結果を5件出しました。' }
  }
  const fxMatch = matches.find((m) => m.type === 'fx')
  if (fxMatch || /為替|ドル|ユーロ|ポンド|レート/.test(text)) {
    const amount = text.match(/(\d[\d,]*)\s*(ドル|ユーロ|ポンド)/)?.[1]
    const props = { ...(fxMatch?.props ?? { base: 'USD', quote: 'JPY' }), amount: amount ? Number(amount.replace(/,/g, '')) : 1000 }
    return { cards: [fetched('fx', props)], reply: '1ドルは162円35銭です。' }
  }
  const routeMatch = text.match(/(.+?)から(.+?)まで.*(?:行き方|経路|道)/)
  if (routeMatch) {
    const [, origin, place] = routeMatch
    const travel = /電車|バス/.test(text) ? 'transit' : /自転車/.test(text) ? 'bicycling' : /車/.test(text) ? 'driving' : 'walking'
    return { cards: [card('map', { place, mode: 'directions', origin, travel })], reply: `${origin}から${place}までの経路を出しました。` }
  }
  const nearbyMatch = text.match(/(.+?)を探して/)
  if (nearbyMatch) {
    return { cards: [card('map', { place: nearbyMatch[1].replace(/の/g, ' '), mode: 'search' })], reply: `${nearbyMatch[1]}を地図で探しました。` }
  }
  const placeMatch = text.match(/(.+?)の地図/)
  if (placeMatch) {
    return { cards: [card('map', { place: placeMatch[1], mode: 'place' })], reply: `${placeMatch[1]}の地図を出しました。` }
  }
  const clockMatch = matches.find((m) => m.type === 'clock')
  if (clockMatch || /何時|時刻|時計/.test(text)) {
    const props = clockMatch?.props ?? { city: 'ニューヨーク' }
    return { cards: [fetched('clock', props)], reply: `${String(props.city)}の現在時刻です。` }
  }
  if (/html|ウェブページ/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_HTML_PATH], title: '競合サービスの比較' })], reply: 'HTML のレポートを開きました。グラフはページの中のスクリプトが描いています。' }
  }
  if (/word|ワード|docx/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_DOCX_PATH] })], reply: '調査レポートの Word を開きました。' }
  }
  if (/excel|エクセル|xlsx/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_XLSX_PATH] })], reply: '料金の Excel を開きました。シートは2枚あります。' }
  }
  if (/スライド|パワポ|pptx|powerpoint/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_PPTX_PATH] })], reply: '報告のスライドを開きました。3枚あります。' }
  }
  if (/グラフ|画像|チャート/.test(text)) {
    return { cards: [fetched('files', { paths: DEMO_IMAGE_PATHS, title: '調査のグラフ' })], reply: 'グラフを3枚出しました。' }
  }
  if (/フォルダ/.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_FILES_DIR] })], reply: '調査の作業フォルダです。' }
  }
  if (/成果物|ファイル.*(全部|一覧)/.test(text)) {
    return { cards: [fetched('files', { paths: DEMO_MIXED_PATHS, title: '競合サービスの調査' })], reply: '成果物を一枚にまとめました。読めないものが1つあります。' }
  }
  if (/PDF|資料/i.test(text)) {
    return { cards: [fetched('files', { paths: DEMO_PDF_PATHS, title: '競合の比較資料' })], reply: 'PDF を開きました。3 ページあります。' }
  }
  if (/コード|スクリプト/.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_CODE_PATH] })], reply: '料金を取りに行くスクリプトです。' }
  }
  if (/json/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_JSON_PATH] })], reply: '調査の結果の JSON です。' }
  }
  if (/ノートブック|notebook/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_NOTEBOOK_PATH] })], reply: '料金の分析のノートブックです。最後のセルはエラーで止まっています。' }
  }
  if (/動画|ビデオ|ムービー/.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_VIDEO_PATH], title: 'ヒアリングの録画' })], reply: 'ヒアリングの録画を出しました。3秒の短いものです。' }
  }
  if (/音声|録音|聞かせて/.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_AUDIO_PATH], title: 'ヒアリングの録音' })], reply: 'ヒアリングの録音を出しました。再生ボタンで聞けます。' }
  }
  if (/zip|書庫|アーカイブ/i.test(text)) {
    return { cards: [fetched('files', { paths: [DEMO_ARCHIVE_PATH], title: '配布資料' })], reply: '配布資料の zip の中身を一覧にしました。' }
  }
  if (/レポート|報告書|見せて|開いて/.test(text)) {
    return { cards: [fetched('files', { paths: [`${DEMO_FILES_DIR}/report.md`], title: '調査レポート' })], reply: '調査レポートを開きました。差が大きいのは同時接続数の上限です。' }
  }
  if (/ジョブ.*(どう|一覧|全部)|どうなって/.test(text)) {
    return { cards: [card('jobs', {})], reply: '判断待ちが2件、実行中が1件です。README の追記は取り込み待ちになっています。' }
  }
  if (/英訳|ジョブ|エージェント|agent/i.test(text)) {
    return { cards: [card('agent-job', { jobId: DEMO_JOB.id })], reply: 'READMEの英訳を裏で始めました。終わったら報告しますね。' }
  }
  return {
    cards: [],
    reply: 'デモモードで動作中です。Electronアプリとして起動すると、音声とツールがすべて使えます。'
  }
}
