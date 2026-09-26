import { fillPrompt, promptLanguage, type ConversationLocale, type PromptLanguage, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import {
  CALENDAR_VIEWS,
  MAIL_BOXES,
  SETTINGS_PAGES,
  TASK_VIEWS,
  localDate,
  placeMiniApp,
  sameMiniAppView,
  type MiniApp,
  type MiniAppTarget,
  type MiniAppView
} from '@shared/mini-apps'
import { LOCAL_TIMEOUT_MS, ToolError, bilingual, type ToolDefinition } from '@shared/tool-registry'
import { nextOpenMiniApp, openMiniApp } from '../mini-app-view'
import type { ToolContext } from './tools'

/**
 * The tools that open and close ASIST's mini apps and tell which one is open, and the note that says
 * so on every user utterance. The note and get_open_app give only the ids of what is shown; the model
 * reads the content with the tools of each mini app, so a mail's text never enters the context unasked.
 */

type Def = ToolDefinition<ToolContext>

/** The fields of open_app that each mini app takes; any other field is a mistake the model is told about. */
const TARGET_FIELDS: Record<MiniApp, readonly string[]> = {
  notes: ['noteId'],
  tasks: ['view', 'taskId'],
  mail: ['box', 'messageId', 'draftId'],
  calendar: ['view', 'date', 'eventId'],
  jobs: ['jobId'],
  memory: ['file'],
  settings: ['page']
}

const VIEWS: Partial<Record<MiniApp, readonly string[]>> = { tasks: TASK_VIEWS, calendar: CALENDAR_VIEWS }

/** Turns the input of open_app into a target among the mini apps this machine has, or throws a ToolError that says what to fix. */
export function parseTarget(input: Record<string, unknown>, apps: readonly MiniApp[]): MiniAppTarget {
  const app = input.app
  if (typeof app !== 'string' || !(apps as readonly string[]).includes(app)) throw new ToolError(TEXTS.unknownApp(apps))
  const miniApp = app as MiniApp
  const allowed = TARGET_FIELDS[miniApp]
  const target: Record<string, string> = {}
  for (const [field, value] of Object.entries(input)) {
    if (field === 'app' || value === undefined || value === null || value === '') continue
    if (!allowed.includes(field)) throw new ToolError(TEXTS.fieldNotForApp(field, miniApp, allowed))
    if (typeof value !== 'string') throw new ToolError(TEXTS.fieldNotForApp(field, miniApp, allowed))
    target[field] = value
  }
  const views = VIEWS[miniApp]
  if (target.view !== undefined && views && !views.includes(target.view)) throw new ToolError(TEXTS.badValue('view', views))
  if (target.box !== undefined && !(MAIL_BOXES as readonly string[]).includes(target.box)) throw new ToolError(TEXTS.badValue('box', MAIL_BOXES))
  if (target.page !== undefined && !(SETTINGS_PAGES as readonly string[]).includes(target.page)) throw new ToolError(TEXTS.badValue('page', SETTINGS_PAGES))
  if (target.date !== undefined && !localDate.safeParse(target.date).success) throw new ToolError(TEXTS.badDate)
  if (target.messageId !== undefined && target.draftId !== undefined) throw new ToolError(TEXTS.messageOrDraft)
  return { app: miniApp, ...target } as MiniAppTarget
}

/** One sentence on what the open mini app shows, with the ids the tools take. */
export function describeOpenApp(view: MiniAppView, language: PromptLanguage): string {
  const say = (text: PromptText, values: Record<string, string> = {}): string => fillPrompt(text[language], values)
  switch (view.app) {
    case 'notes':
      if (view.noteId) return say(view.editing ? STATE.noteEditing : STATE.noteShown, { id: view.noteId })
      return say(view.editing ? STATE.noteNew : STATE.notesEmpty)
    case 'tasks':
      return say(view.taskId ? STATE.taskSelected : STATE.tasks, { view: view.view, id: view.taskId ?? '' })
    case 'mail': {
      const where = say(STATE.mailBox, { box: view.box })
        + (view.accountId ? say(STATE.mailAccount, { account: view.accountId }) : '')
        + (view.query ? say(STATE.mailQuery, { query: view.query }) : '')
      const pane = view.pane
      if (!pane) return where + say(STATE.mailList)
      if (pane.kind === 'message') return where + say(STATE.mailMessage, { id: pane.id })
      if (pane.kind === 'draft') return where + say(STATE.mailDraft, { id: pane.id })
      return where + say(STATE.mailCompose)
    }
    case 'calendar':
      return say(STATE.calendar, { view: view.view, date: view.date })
        + (view.eventId ? say(STATE.calendarEvent, { id: view.eventId }) : '')
    case 'jobs':
      return say(view.jobId ? STATE.job : STATE.jobsEmpty, { id: view.jobId ?? '' })
    case 'memory':
      return say(view.file ? STATE.memoryFile : STATE.memoryEmpty, { file: view.file ?? '' })
    case 'settings':
      return say(STATE.settings, { page: view.page })
  }
}

/**
 * How long open_app and close_app wait for the screen. A mini app holding a draft that is not saved asks
 * the user before it is left, and their answer is waited for as long as the approval of a job is.
 */
const ANSWER_TIMEOUT_MS = 300_000

/**
 * Asks the renderer to open a mini app, or to close the open one for null, and resolves with what the
 * screen shows afterwards, which the renderer reports whether it made the change or the user kept a draft.
 */
function request(ctx: ToolContext, open: MiniAppTarget | null, signal: AbortSignal): Promise<MiniAppView | null> {
  const shown = nextOpenMiniApp(signal)
  ctx.emit({ type: 'app', turnId: ctx.turnId, open })
  return shown
}

const keptText = (view: MiniAppView | null, language: PromptLanguage): string =>
  view ? describeOpenApp(view, language) : STATE.nothingOpen[language]

/** The note attached to a user utterance while a mini app is open, or null when only the conversation is on screen. */
export function openAppNote(locale: ConversationLocale, view: MiniAppView | null = openMiniApp()): string | null {
  if (!view) return null
  return `${marker(locale, 'openApp')} ${describeOpenApp(view, promptLanguage(locale))}`
}

/** What each mini app is, with the tools that read it, as the description of open_app lists them. */
const APP_SUMMARY: Record<MiniApp, PromptText> = {
  notes: { ja: 'notes=メモ(read_note / search_notes)', en: 'notes = notes (read_note / search_notes)' },
  tasks: { ja: 'tasks=タスク(list_tasks)', en: 'tasks = tasks (list_tasks)' },
  mail: { ja: 'mail=メール(list_mail / read_mail)', en: 'mail = mail (list_mail / read_mail)' },
  calendar: { ja: 'calendar=カレンダー(show_calendar / change_calendar)', en: 'calendar = calendar (show_calendar / change_calendar)' },
  jobs: { ja: 'jobs=Agent のジョブ(get_agent_job)', en: 'jobs = the agent jobs (get_agent_job)' },
  memory: { ja: 'memory=記憶(recall)', en: 'memory = the memory (recall)' },
  settings: { ja: 'settings=設定', en: 'settings = the settings' }
}

/** The tools for the mini apps this machine has; a mini app it lacks is neither named nor accepted. */
export function miniAppTools(language: PromptLanguage, apps: readonly MiniApp[]): Def[] {
  const text = (field: PromptText): string => bilingual(field)
  const has = (app: MiniApp): boolean => apps.includes(app)
  const calendar = has('calendar')
  const summary: PromptText = {
    ja: `${apps.map((app) => APP_SUMMARY[app].ja).join('、')}。`,
    en: `${apps.map((app) => APP_SUMMARY[app].en).join(', ')}.`
  }
  return [
    {
      name: 'open_app',
      description: {
        ja: [
          'ASIST のミニアプリを画面に開く。ミニアプリは Dock から開く画面で、一度に一つだけ開く。開いている間、会話は右に出る。',
          summary.ja,
          '場所を指す欄は、そのミニアプリのものだけを使う。id は各ツールの結果か、発話に付いた「開いているミニアプリ」の注から取り、推測しない。省いた欄は、そのミニアプリがふだん見せるものになる。',
          '結果は { opened }。開いたことを一言で伝える。保存していない下書きのあるミニアプリは、離れる前に本人に確かめる。本人が下書きを残すと opened は null になり、kept に画面が今見せているものが入る。そのときは開かなかったことを伝え、頼まれない限り開き直さない。'
        ].join('\n'),
        en: [
          "Opens one of ASIST's mini apps on screen. The mini apps are the screens opened from the Dock, one at a time; while one is open, the conversation moves to the right.",
          summary.en,
          'Use only the fields that belong to the mini app you open. Take ids from the results of those tools or from the open-app note on the utterance, and never guess one. A field left out shows what the mini app shows by itself.',
          'The result is { opened }. Say in a few words that it is open. A mini app holding a draft that is not saved asks the user before it is left; when they keep the draft, opened is null and kept says what the screen still shows. Then say that it did not open, and do not try again unless asked.'
        ].join('\n')
      },
      usage: calendar
        ? {
            ja: '「メモ開いて」「カレンダーで来週を見せて」「このメールを開いて」「設定の API キーのところ」のように、ミニアプリを開いてと言われたとき。会話の横でちらっと見せるだけなら show_ のカード',
            en: 'When the user asks to open a mini app: their notes, next week in the calendar, this mail, the API key part of the settings. To show something briefly beside the conversation, use a show_ card instead.'
          }
        : {
            ja: '「メモ開いて」「タスクを一覧で見せて」「このメールを開いて」「設定の API キーのところ」のように、ミニアプリを開いてと言われたとき。会話の横でちらっと見せるだけなら show_ のカード',
            en: 'When the user asks to open a mini app: their notes, the tasks as a list, this mail, the API key part of the settings. To show something briefly beside the conversation, use a show_ card instead.'
          },
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: [...apps] },
          noteId: { type: 'string', description: text({ ja: 'notes: 開くメモの id', en: 'notes: the id of the note to open' }) },
          taskId: { type: 'string', description: text({ ja: 'tasks: 選ぶタスクの id', en: 'tasks: the id of the task to select' }) },
          view: calendar
            ? {
                type: 'string',
                enum: [...new Set([...TASK_VIEWS, ...CALENDAR_VIEWS])],
                description: text({ ja: 'tasks: board か list。calendar: month、week、list', en: 'tasks: board or list. calendar: month, week or list.' })
              }
            : { type: 'string', enum: [...TASK_VIEWS], description: text({ ja: 'tasks: board か list', en: 'tasks: board or list.' }) },
          box: { type: 'string', enum: [...MAIL_BOXES], description: text({ ja: 'mail: 開く箱', en: 'mail: the box to open' }) },
          messageId: { type: 'string', description: text({ ja: 'mail: 読むメールの id', en: 'mail: the id of the message to read' }) },
          draftId: { type: 'string', description: text({ ja: 'mail: 開く下書きの id', en: 'mail: the id of the draft to open' }) },
          ...(calendar
            ? {
                date: { type: 'string', description: text({ ja: 'calendar: 合わせる日(YYYY-MM-DD)', en: 'calendar: the day to go to (YYYY-MM-DD)' }) },
                eventId: { type: 'string', description: text({ ja: 'calendar: 詳細を開く予定の id', en: 'calendar: the id of the event whose details to open' }) }
              }
            : {}),
          jobId: { type: 'string', description: text({ ja: 'jobs: 表示するジョブの id', en: 'jobs: the id of the job to show' }) },
          file: { type: 'string', description: text({ ja: 'memory: 記憶のフォルダからの相対パス', en: 'memory: the path relative to the memory folder' }) },
          page: { type: 'string', enum: [...SETTINGS_PAGES], description: text({ ja: 'settings: 開くページ', en: 'settings: the page to open' }) }
        },
        required: ['app'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: ANSWER_TIMEOUT_MS,
      maxResultChars: 500,
      run: async (input, ctx, signal) => {
        const target = parseTarget(input, apps)
        const expected = placeMiniApp(openMiniApp(), target)
        const shown = await request(ctx, target, signal)
        return sameMiniAppView(shown, expected) ? { opened: target.app } : { opened: null, kept: keptText(shown, language) }
      }
    },
    {
      name: 'close_app',
      description: {
        ja: '開いているミニアプリを閉じ、会話だけの画面に戻す。結果は { closed }。保存していない下書きがあると本人に確かめ、本人が下書きを残すと closed は false になり、kept に画面が今見せているものが入る。そのときは閉じなかったことを伝える。',
        en: 'Closes the open mini app and goes back to the conversation alone. The result is { closed }. A mini app holding a draft that is not saved asks the user first; when they keep the draft, closed is false and kept says what the screen still shows, so say that it stayed open.'
      },
      usage: {
        ja: '「閉じて」「会話に戻って」と言われたとき',
        en: 'When the user asks you to close it or to go back to the conversation.'
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      parallel: false,
      timeoutMs: ANSWER_TIMEOUT_MS,
      maxResultChars: 500,
      run: async (_input, ctx, signal) => {
        const shown = await request(ctx, null, signal)
        return shown === null ? { closed: true } : { closed: false, kept: keptText(shown, language) }
      }
    },
    {
      name: 'get_open_app',
      description: {
        ja: 'いま画面に開いているミニアプリと、そこで表示しているものの id を返す。何も開いていなければ { open: null }。中身は各ミニアプリのツールで読む。',
        en: 'Returns the mini app open on screen now and the ids of what it shows, or { open: null } when none is. Read the content with the tools of that mini app.'
      },
      usage: {
        ja: '発話に「開いているミニアプリ」の注が無いのに、「これ」「いま見てるの」が画面の何を指すか知りたいとき',
        en: 'When the utterance carries no open-app note and you need to know what "this" or "what I am looking at" refers to on screen.'
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 1_000,
      run: () => {
        const view = openMiniApp()
        return view ? { open: view, description: describeOpenApp(view, language) } : { open: null }
      }
    }
  ]
}

/** What the note and get_open_app say about the open mini app, in both prompt languages. */
const STATE = {
  noteShown: { ja: 'メモ(notes)を開いていて、メモ {id} を表示している。', en: 'Notes is open, showing note {id}.' },
  noteEditing: { ja: 'メモ(notes)を開いていて、メモ {id} を編集している。', en: 'Notes is open, editing note {id}.' },
  noteNew: { ja: 'メモ(notes)を開いていて、新しいメモを書いている。', en: 'Notes is open, with a new note being written.' },
  notesEmpty: { ja: 'メモ(notes)を開いている。表示しているメモはない。', en: 'Notes is open, showing no note.' },
  tasks: { ja: 'タスク(tasks)を {view} 表示で開いている。選んでいるタスクはない。', en: 'Tasks is open in the {view} view, with no task selected.' },
  taskSelected: { ja: 'タスク(tasks)を {view} 表示で開いていて、タスク {id} を選んでいる。', en: 'Tasks is open in the {view} view, with task {id} selected.' },
  mailBox: { ja: 'メール(mail)の {box} を開いていて', en: 'Mail is open on {box}' },
  mailAccount: { ja: '(アカウント {account})', en: ' (account {account})' },
  mailQuery: { ja: '、「{query}」で絞り込み', en: ', filtered by "{query}"' },
  mailList: { ja: '、一覧を見ている。', en: ', showing the list.' },
  mailMessage: { ja: '、メール {id} を読んでいる。', en: ', reading message {id}.' },
  mailDraft: { ja: '、下書き {id} を編集している。', en: ', editing draft {id}.' },
  mailCompose: { ja: '、新しいメールを書いている。', en: ', writing a new message.' },
  calendar: { ja: 'カレンダー(calendar)を {view} 表示で {date} に合わせて開いている。', en: 'Calendar is open in the {view} view on {date}.' },
  calendarEvent: { ja: '予定 {id} の詳細を開いている。', en: ' The details of event {id} are open.' },
  job: { ja: 'Agent のジョブ(jobs)を開いていて、ジョブ {id} を表示している。', en: 'Jobs is open, showing job {id}.' },
  jobsEmpty: { ja: 'Agent のジョブ(jobs)を開いている。ジョブはまだない。', en: 'Jobs is open, with no job yet.' },
  memoryFile: { ja: '記憶(memory)を開いていて、{file} を表示している。', en: 'Memory is open, showing {file}.' },
  memoryEmpty: { ja: '記憶(memory)を開いている。表示している文書はない。', en: 'Memory is open, showing no document.' },
  settings: { ja: '設定(settings)の {page} のページを開いている。', en: 'Settings is open on the {page} page.' },
  nothingOpen: { ja: 'ミニアプリは開いていない。', en: 'No mini app is open.' }
} as const satisfies Record<string, PromptText>

/** What the tools say to the model when an input is wrong, in both prompt languages. */
const TEXTS = {
  unknownApp: (apps: readonly MiniApp[]): PromptText => ({
    ja: `app は ${apps.join('、')} のどれか。`,
    en: `app is one of ${apps.join(', ')}.`
  }),
  fieldNotForApp: (field: string, app: string, allowed: readonly string[]): PromptText => ({
    ja: `${field} は ${app} では使えない。${app} で使える欄: ${allowed.join('、') || 'なし'}。`,
    en: `${field} does not apply to ${app}. The fields ${app} takes: ${allowed.join(', ') || 'none'}.`
  }),
  badValue: (field: string, values: readonly string[]): PromptText => ({
    ja: `${field} は ${values.join('、')} のどれか。`,
    en: `${field} is one of ${values.join(', ')}.`
  }),
  badDate: { ja: 'date は実在する日を YYYY-MM-DD で書く。', en: 'Write date as a day that exists, in the form YYYY-MM-DD.' },
  messageOrDraft: { ja: 'messageId と draftId はどちらか一つだけ。', en: 'Give messageId or draftId, not both.' }
} as const

