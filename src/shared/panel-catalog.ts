import { weatherInputSchema } from './weather'
import { mapCardKey, mapInputSchema } from './map-embed'
import { z } from 'zod'
import { CALENDAR_RANGES } from './calendar'
import type { PromptText } from './conversation-locale'
import { bilingual } from './tool-registry'
import type { PanelSlot } from './ipc'
import type { CalendarBackend, PlatformCapabilities } from './platform'

/**
 * The catalog of the built-in panels, shared by main and the renderer.
 * - main generates the LLM tool definitions, named show_<type>, from it and validates a fetcher's
 *   props against it.
 * - The renderer takes the slot and the time to live from it.
 * The React components and the rule-based matching live in the renderer's own registry.
 */

export interface PanelCatalogEntry {
  type: string
  /**
   * The tool's description, written for the LLM in both prompt languages. No screen shows it. A card whose
   * source depends on the machine, such as the calendar, words it from the capabilities.
   */
  description: PromptText | ((capabilities: PlatformCapabilities) => PromptText)
  slot: PanelSlot
  /**
   * The zod schema of the props, one per panel whatever the language: it decides what is valid, and
   * the wording of a field sits inside it as a packed pair the tool list unpacks.
   */
  schema: z.ZodType
  /** Whether the panel is exposed to the LLM as a show_<type> tool. */
  tool: boolean
  /** Whether the main process has a fetcher for it. Without one the props pass through unchanged. */
  fetch: boolean
  key: (props: Record<string, unknown>) => string
  /**
   * How many milliseconds after the last data update the panel goes stale. A static panel, or one the
   * user drives, omits it and never goes stale.
   */
  ttl?: number
  /**
   * The limit in characters on the result returned to the LLM. Omitting it uses the default for the
   * show_ tools, in brain/tools.ts.
   */
  resultChars?: number
}

const s = (v: unknown): string => String(v ?? '').trim()

/**
 * The topic the news card falls back to, which is the day's top headlines. No word names it, because a
 * word would have to be one of the eleven languages and the model would then see it in the tool list;
 * the empty topic means the same thing in all of them, the fetcher asks for the front page, and the
 * card gives it a heading of its own.
 */
export const NEWS_TOP_TOPIC = ''

/** What the calendar card reads, as the model is told, for each calendar a machine can have. */
const CALENDAR_SOURCE: Record<CalendarBackend, PromptText> = {
  eventkit: { ja: 'macOSのカレンダー', en: 'the macOS calendars' },
  google: { ja: 'Google カレンダー', en: 'the calendars in Google Calendar' }
}

/** The calendar card is offered only where panelAvailable finds a calendar. */
function calendarSource(calendar: CalendarBackend | null): PromptText {
  if (calendar === null) throw new Error('the calendar card is described on a machine without a calendar')
  return CALENDAR_SOURCE[calendar]
}

/** The description of a card's tool on this machine. */
export const panelDescription = (entry: PanelCatalogEntry, capabilities: PlatformCapabilities): PromptText =>
  typeof entry.description === 'function' ? entry.description(capabilities) : entry.description

export const PANEL_CATALOG: PanelCatalogEntry[] = [
  {
    type: 'weather',
    description: {
      ja: '場所の天気を取得して表示する。設定の地域が日本なら気象庁から日本国内の天気を、それ以外なら Open-Meteo から世界の天気を取る。日本の場所は正式な都道府県または市区町村を、日本以外は都市名(同名があれば国名も)を必ず指定する。都道府県は代表地点を使うので原則確認不要。同名の候補が返った場合だけユーザーへ確認する。現在値は予報区の代表観測所の値であり、観測所名を伝える。観測と予報、対象日、地点を区別して説明する。返却データだけを根拠に話し、取得していない日との比較や未取得の観測値は述べない。',
      en: 'Fetches the weather for a place and shows it. With the region set to Japan it covers Japan alone, from the Japan Meteorological Agency; with any other region it covers the world, from Open-Meteo. Always name the place in full: a prefecture or municipality in Japan, a city elsewhere, with its country when several share the name. When more than one place has that name, candidates come back instead, and only then ask the user which one they mean. Keep the observation, the forecast, the day and the place apart when you explain it. Speak only from the data that came back: do not compare with a day you did not fetch, and do not state a measurement you did not receive.'
    },
    slot: 'right',
    tool: true,
    fetch: true,
    ttl: 15 * 60_000,
    schema: weatherInputSchema,
    key: (p) => `weather:${s(p.location)}:${s(p.date) || 'today'}`
  },
  {
    type: 'clock',
    description: {
      ja: '世界時計パネル。都市名を指定するとその都市の現在時刻を表示する。',
      en: 'A world clock card. Naming a city shows the time there now.'
    },
    slot: 'right',
    tool: true,
    fetch: true,
    schema: z.object({
      // The city filled in when none is named is a place name, so it is a packed pair like a
      // description: the tool resolves it after parsing, and the fetcher is handed one plain name.
      city: z
        .string()
        .default(bilingual({ ja: '東京', en: 'Tokyo' }))
        .describe(bilingual({ ja: '都市名。例: ニューヨーク, ロンドン', en: 'The city, for example New York or London.' }))
    }),
    key: (p) => `clock:${s(p.city)}`
  },
  {
    type: 'timer',
    description: {
      ja: 'カウントダウンタイマーを開始してパネル表示する。',
      en: 'Starts a countdown timer and shows it on a card.'
    },
    slot: 'right',
    tool: true,
    fetch: false,
    schema: z.object({
      seconds: z
        .number()
        .int()
        .positive()
        .describe(bilingual({ ja: 'タイマー秒数', en: 'How many seconds to count down.' })),
      label: z
        .string()
        .optional()
        .describe(bilingual({ ja: 'タイマーの名前', en: 'A name for the timer.' }))
    }),
    // Every call creates a new timer, and a key built from the time alone would collide between two
    // calls made in the same millisecond.
    key: () => `timer:${globalThis.crypto.randomUUID()}`
  },
  {
    type: 'fx',
    description: {
      ja: '為替レートパネル。通貨ペアの現在レートを表示する。',
      en: 'A foreign exchange card. It shows the current rate of a currency pair.'
    },
    slot: 'left',
    tool: true,
    fetch: true,
    ttl: 5 * 60_000,
    schema: z.object({
      base: z
        .string()
        .default('USD')
        .describe(bilingual({ ja: '基準通貨。例: USD', en: 'The currency being converted from, such as USD.' })),
      // Left out, the fetcher takes the currency of the region, which only the main process knows.
      quote: z
        .string()
        .optional()
        .describe(
          bilingual({
            ja: '相手通貨。例: JPY。省略すると設定の地域の通貨',
            en: 'The currency it is priced in, such as EUR. Left out, it is the currency of the region in the settings.'
          })
        ),
      amount: z
        .number()
        .optional()
        .describe(
          bilingual({ ja: '換算したい金額(基準通貨建て)', en: 'An amount to convert, given in the base currency.' })
        )
    }),
    key: (p) => `fx:${s(p.base).toUpperCase()}:${s(p.quote).toUpperCase()}`
  },
  {
    type: 'search-results',
    description: {
      ja: 'Web検索結果パネル(web_search実行時に自動表示)。',
      en: 'The web search results card, shown by itself whenever web_search runs.'
    },
    slot: 'right',
    tool: false,
    fetch: false,
    schema: z.object({
      query: z.string(),
      results: z
        .array(z.object({ title: z.string(), url: z.string(), site: z.string().optional(), cited: z.boolean().optional(), snippet: z.string().optional() }))
        .default([]),
      // Google's Search Suggestions, HTML shown unchanged because the Gemini API terms require it.
      suggestions: z.string().optional()
    }),
    key: (p) => `search:${s(p.query)}`
  },
  {
    type: 'agent-job',
    description: {
      ja: 'エージェントジョブのカード。jobId を指定するとそのジョブ(段階に応じて、実行中はいまのステップとログ、取り込み待ちは差分と取り込み、完了は要約と成果物)、省略すると全ジョブの一覧を出す。run_agent_task の起動時と、判断待ち・完了になったときは自動で出る。',
      en: 'The card of an agent job. With a jobId it shows that one job, and what it shows follows the stage: the step it is on and its log while it runs, the diff and the merge while its changes wait to be merged, the summary and the artifacts once it has finished. Without a jobId it lists every job. It appears by itself when run_agent_task starts a job and when a job comes to wait for a decision or finishes.'
    },
    slot: 'right',
    tool: true,
    fetch: false,
    schema: z.object({
      jobId: z
        .string()
        .optional()
        .describe(
          bilingual({
            ja: 'ジョブID(ジョブ現況の [id])。省略で一覧',
            en: 'The job id, from [id] in the job status block. Leave it out for the list.'
          })
        )
    }),
    key: (p) => (p.jobId ? `job:${s(p.jobId)}` : 'jobs')
  },
  {
    type: 'jobs',
    description: {
      ja: 'エージェントジョブの一覧カード(show_agent_job を jobId なしで呼ぶと出る)。',
      en: 'The card listing the agent jobs, which show_agent_job puts up when it is called without a jobId.'
    },
    slot: 'right',
    tool: false,
    fetch: false,
    schema: z.object({}),
    key: () => 'jobs'
  },
  {
    type: 'news',
    description: {
      ja: 'ニュースパネル。トピックの最新ニュース見出しを表示する。',
      en: 'A news card. It shows the latest headlines on a topic.'
    },
    slot: 'right',
    tool: true,
    fetch: true,
    ttl: 15 * 60_000,
    schema: z.object({
      topic: z
        .string()
        .default(NEWS_TOP_TOPIC)
        .describe(
          bilingual({
            ja: 'トピック。例: AI, 経済, スポーツ。省略するとその日の主要ニュース',
            en: "The topic, such as AI, the economy or sport. Leave it out for the day's top headlines."
          })
        )
    }),
    key: (p) => `news:${s(p.topic)}`
  },
  {
    type: 'map',
    description: {
      ja: '地図パネル。Googleマップをカードに表示する。場所を示す、周辺の店や施設を探す、2地点の経路を出す、の3通りがある。地図は画面に出るだけで、住所・営業時間・所要時間・距離などのデータは返らない。返っていない情報を地図から読み取ったように話さない。',
      en: 'A map card showing Google Maps. It does three things: point at a place, look for shops and facilities around one, and draw the route between two places. The map is only drawn on screen: no address, opening hours, travel time or distance comes back. Do not talk as if you had read such things off the map.'
    },
    slot: 'right',
    tool: true,
    fetch: false,
    schema: mapInputSchema,
    key: mapCardKey
  },
  {
    type: 'todo',
    description: {
      ja: 'やること(タスク)のカード。未完了のタスクを状態と期限つきで見せる。list_tasks に card を付けると出る。',
      en: 'The tasks card. It shows the unfinished tasks with their status and their due date. list_tasks puts it up when called with card.'
    },
    slot: 'right',
    tool: false,
    fetch: false,
    schema: z.object({}),
    key: () => 'todo'
  },
  {
    type: 'notes',
    description: {
      ja: 'メモのカード。最近のメモを更新の新しい順に見せる。add_note と、card を付けた search_notes が出す。',
      en: 'The notes card. It shows the latest notes, the most recently changed first. add_note puts it up, and so does search_notes called with card.'
    },
    slot: 'right',
    tool: false,
    fetch: false,
    schema: z.object({}),
    key: () => 'notes'
  },
  {
    type: 'files',
    description: {
      ja: 'ファイルやフォルダをカードで見せる。markdown、テキスト、csv、json、コード、画像(複数なら並べる)、PDF、Word、PowerPoint、Excel、動画、音声、ipynb、zip、フォルダの中身をアプリの中で読める。ジョブの成果物を見せるとき、「見せて」「開いて」と言われたときに使う。パスはジョブの artifacts、フォルダなら cwd、ユーザーが指した場所(デスクトップ、ダウンロード、書類)から。',
      en: 'Shows files and folders on a card. Markdown, text, csv, json, code, images (several are laid out side by side), PDF, Word, PowerPoint, Excel, video, audio, ipynb, zip and the contents of a folder can all be read inside the app. Use it to show what a job produced, and whenever the user asks to see or open something. Take the paths from a job\'s artifacts, from its cwd for a folder, or from the place the user pointed at, such as the desktop, the downloads folder or the documents folder.'
    },
    slot: 'right',
    tool: true,
    fetch: true,
    schema: z.object({
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          bilingual({
            ja: '見せるファイルかフォルダの絶対パス(複数可)',
            en: 'The absolute paths of the files or folders to show; there may be several.'
          })
        ),
      title: z
        .string()
        .optional()
        .describe(bilingual({ ja: 'カードの短い見出し。例: 調査レポート', en: 'A short heading for the card, such as "Research report".' }))
    }),
    key: (p) => `files:${(Array.isArray(p.paths) ? p.paths : []).map(s).join('|')}`
  },
  {
    type: 'calendar',
    description: ({ calendar }) => ({
      ja: `カレンダーのカード。設定で選択した${calendarSource(calendar).ja}の予定を、今日・今週・来週(range)か、from/to(端末のローカル日付 YYYY-MM-DD、to を含む、366日まで)の範囲で見せる。query は件名・場所の部分一致。「今日の予定は?」「来週空いてる?」「10月の予定」「スミカとの打ち合わせいつ?」やブリーフィングで使う。結果の today・range・events[].date/time は端末のローカル日時の文字列なので、そのまま読んで答える(日付を計算しない)。週は暦どおり月曜〜日曜で、週末には nextWeek に来週分も付く。events[].id と start/end(オフセット付きISO)は change_calendar にそのまま渡せる。返答では range の日付を一度言う。`,
      en: `The calendar card. It shows the events of ${calendarSource(calendar).en} chosen in the settings, either for today, this week or next week (range), or over from/to, which are local calendar days written YYYY-MM-DD, with to included and at most 366 days. query matches part of a title or a location. Use it whenever the user asks about their schedule — what is on today, whether next week is free, what a given month holds, when the meeting with someone is — and in a briefing. today, range and events[].date/time in the result are already written in this machine's local time, so read them out as they are and never work a date out yourself. A week runs Monday to Sunday as the calendar does, and at the weekend next week's events come along in nextWeek. events[].id and start/end, an ISO timestamp with its offset, can be handed to change_calendar unchanged. Say the dates of the range once in your answer.`
    }),
    slot: 'right',
    tool: true,
    fetch: true,
    ttl: 5 * 60_000,
    resultChars: 12_000,
    schema: z.object({
      range: z
        .enum(CALENDAR_RANGES)
        .optional()
        .describe(
          bilingual({
            ja: 'today / week / next-week。from/to を使うときは省く。両方省くと today',
            en: 'today / week / next-week. Leave it out when using from/to. With neither, it is today.'
          })
        ),
      // A pattern of digits lets 2026-09-31 through, and Date rolls it into October.
      from: z.iso
        .date()
        .optional()
        .describe(
          bilingual({
            ja: '開始日(端末のローカル日付 YYYY-MM-DD)。to と一緒に指定',
            en: 'The first day, as a local calendar day YYYY-MM-DD. Give it together with to.'
          })
        ),
      to: z.iso
        .date()
        .optional()
        .describe(
          bilingual({ ja: '終了日(含む)。from と一緒に指定', en: 'The last day, included. Give it together with from.' })
        ),
      query: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe(
          bilingual({
            ja: '件名・場所の部分一致。省略で絞らない',
            en: 'Matches part of a title or a location. Left out, nothing is filtered.'
          })
        )
    }),
    key: (p) => `calendar:${p.from && p.to ? `${s(p.from)}..${s(p.to)}` : s(p.range) || 'today'}${s(p.query) ? `:${s(p.query)}` : ''}`
  },
  {
    type: 'mail',
    description: {
      ja: 'メールの一覧カード。取り込み済みのメールを未読を先に、新しい順に見せる。list_mail に card を付けると出る。',
      en: 'The mail list card. It shows the messages already fetched, unread first and newest first. list_mail puts it up when called with card.'
    },
    slot: 'right',
    tool: false,
    fetch: true,
    ttl: 5 * 60_000,
    schema: z.object({
      unreadOnly: z.boolean().default(false).describe(bilingual({ ja: '未読だけにする', en: 'Show only the unread ones.' })),
      view: z
        .enum(['inbox', 'starred', 'sent', 'archive'])
        .default('inbox')
        .describe(bilingual({ ja: '箱。省略で受信箱', en: 'Which box. Left out, the inbox.' })),
      query: z
        .string()
        .trim()
        .max(200)
        .default('')
        .describe(
          bilingual({
            ja: '件名・差出人・本文の部分一致。省略で絞らない',
            en: 'Matches part of a subject, a sender or a body. Left out, nothing is filtered.'
          })
        )
    }),
    key: (p) => (s(p.query) || (p.view && p.view !== 'inbox') ? `mail:${s(p.view) || 'inbox'}:${s(p.query)}` : 'mail')
  },
  {
    type: 'mail-message',
    description: {
      ja: 'メール一通のカード。差出人・宛先・日時・添付と本文を見せる。read_mail に card を付けると出る。読んでも既読にはならない。',
      en: 'The card of one message. It shows the sender, the recipients, the date, the attachments and the body. read_mail puts it up when called with card. Showing it does not mark it read.'
    },
    slot: 'right',
    tool: false,
    fetch: true,
    ttl: 5 * 60_000,
    schema: z.object({
      id: z.string().min(1).describe(bilingual({ ja: 'list_mail の id', en: 'The id from list_mail.' }))
    }),
    key: (p) => `mail-message:${s(p.id)}`
  },
  {
    type: 'mail-draft',
    description: {
      ja: 'メールの下書きカード。change_mail の send / reply が作り、ユーザーがカードで直して送る。',
      en: "The mail draft card. change_mail's send and reply create it, and the user edits it there and sends it."
    },
    slot: 'right',
    tool: false,
    fetch: false,
    schema: z.object({ draftId: z.string() }),
    key: (p) => `mail-draft:${s(p.draftId)}`
  }
]

export const catalogByType = new Map(PANEL_CATALOG.map((e) => [e.type, e]))

/** Whether this machine can show a card of the type: the calendar card needs a calendar to read. */
export const panelAvailable = (type: string, capabilities: Pick<PlatformCapabilities, 'calendar'>): boolean =>
  type !== 'calendar' || capabilities.calendar !== null
