import { defaultRegion } from '@shared/conversation-locale'
import { UI_LOCALES } from '@shared/i18n'
import type {
  AppSettings,
  AppStatus,
  JobEvent,
  PanelEvent,
  RendererApi,
  TimerEvent,
  TurnEvent
} from '@shared/ipc'
import { noteIdOf, noteMatches, normalizeNoteMarkdown, type NoteSummary } from '@shared/notes'
import {
  applyTaskPatch,
  buildTask,
  parseOrThrow,
  placeTask,
  reindex,
  taskInputSchema,
  taskMoveSchema,
  taskPatchSchema,
  type Task
} from '@shared/tasks'
import type { CalendarChange, CalendarChangeResult, CalendarEvent } from '@shared/calendar'
import { overlaps } from '@shared/calendar-layout'
import { defaultPersona } from '@shared/persona'
import { demoUsageDays } from './fixtures/usage'
import { DEFAULT_DOCK_ORDER } from '@shared/dock'
import {
  DEFAULT_MAIL_SETTINGS,
  mailChangeSchema,
  mailListQuerySchema,
  parseAddress,
  parseMailInput,
  parseMessageId,
  replySubject,
  mailDraftInputSchema,
  mailReplySendSchema,
  type MailAddress,
  type MailChangeResult,
  type MailDraft,
  type MailMessage
} from '@shared/mail'
import type { ConfirmEvent } from '@shared/confirm'
import { buildDemoCalendarEvents, DEMO_CALENDAR_STATUS, demoEvent } from './fixtures/calendar'
import { CARD_GROUPS } from './fixtures/cards'
import { DEMO_JOB, DEMO_JOB_LOG, DEMO_JOBS } from './fixtures/jobs'
import { DEMO_NOTES, demoNoteSummary, type DemoNote } from './fixtures/notes'
import { DEMO_TASKS } from './fixtures/tasks'
import { DEMO_MAIL_ACCOUNTS, DEMO_MAIL_BODIES, DEMO_MAIL_MESSAGES, demoMailStatus, demoReplyOf } from './fixtures/mail'
import { commitDrafts, createDemoDraft, demoDraft, demoDrafts, emitMail, mailListeners } from './mail-state'
import { DEMO_MEMORY, demoDocuments, demoPageTemplate } from './fixtures/memory'
import { parseMemoryPageInput, validateDocument, documentOf } from '@shared/memory-page'
import { errorText } from '@shared/i18n/error-text'
import { translate, uiLocale } from '@/i18n'
import { demoPanelProps, respondTo } from './sayings'
import { DEFAULT_THEME, THEMES } from '@shared/themes'
import { mergeSettings } from '@shared/settings'
import { recommendQwenTts } from '@shared/tts-models'
import { demoCapabilities, demoOs } from './platform'

/**
 * Demo mode: the mock used where window.api (preload) does not exist, that is, in a plain browser. Only
 * behavior lives here; the data comes from fixtures/ and sayings.ts. Voice input is not available, but
 * the whole flow runs from typed input.
 */

const turnListeners = new Set<(e: TurnEvent) => void>()
const jobListeners = new Set<(e: JobEvent) => void>()
const timerListeners = new Set<(e: TimerEvent) => void>()
const noteListeners = new Set<(notes: NoteSummary[]) => void>()
const demoTimers = new Map<string, Extract<TimerEvent, { type: 'updated' }>['timer']>()
const taskListeners = new Set<(tasks: Task[]) => void>()
let demoTasks: Task[] = DEMO_TASKS.map((task) => ({ ...task }))
let demoNotes: DemoNote[] = DEMO_NOTES.map((note) => ({ ...note }))
const demoMemory: Record<string, string> = { ...DEMO_MEMORY }
let turnSeq = 1

/** `?lang=en-US` opens the demo in that interface language, which is how the other dictionaries are checked. */
const requestedLocale = new URLSearchParams(location.search).get('lang')

const demoLocale = UI_LOCALES.find((locale) => locale === requestedLocale) ?? 'ja-JP'

/** `?theme=pop` opens the demo in that theme. index.tsx refuses a name that is not a theme. */
const requestedTheme = new URLSearchParams(location.search).get('theme')

const capabilities = demoCapabilities(demoOs(location.search))

/** `?hotkey=failed` turns the global hotkey on and has the OS refuse it, as when another application holds the keys. */
const hotkeyRefused = new URLSearchParams(location.search).get('hotkey') === 'failed'

const settings: AppSettings = {
  onboardingVersion: 1,
  safetyNoticeVersion: 1,
  uiLocale: demoLocale,
  theme: THEMES.find((theme) => theme === requestedTheme) ?? DEFAULT_THEME,
  // The conversation stays Japanese, which the sample data is written in; the region follows the interface so
  // that dates and numbers read as they do for someone who uses that language.
  conversationLocale: 'ja-JP',
  region: defaultRegion(demoLocale),
  conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
  bridgeModel: { provider: 'anthropic', id: 'claude-haiku-4-5' },
  voiceEngine: 'cascade',
  gptLive: { model: 'gpt-live-1', voice: 'marin' },
  geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' },
  liveIdleSeconds: 90,
  persona: defaultPersona('ja-JP'),
  conversationLogRetentionDays: 90,
  ttsEngine: 'system',
  voicevoxSpeaker: 1,
  aivisSpeaker: null,
  qwenTtsVoice: 'ono_anna',
  bargeIn: true,
  aizuchi: true,
  aizuchiRate: 0.85,
  hangoverMs: 350,
  partialIntervalMs: 600,
  agentCwd: '/Users/demo',
  agentEngine: 'codex',
  agentMode: 'readonly',
  fileRoots: ['/Users/demo/Desktop', '/Users/demo/Downloads'],
  calendar: { enabled: true, readCalendarIds: ['demo-work', 'demo-home', 'demo-holiday'], writeCalendarId: 'demo-work' },
  mail: { ...DEFAULT_MAIL_SETTINGS, enabled: true, accounts: DEMO_MAIL_ACCOUNTS, defaultAccountId: 'demo-work' },
  micAutoStart: false,
  localAsrEnabled: false,
  nativeMic: false,
  noiseSuppression: false,
  vapEnabled: false,
  memoryEmbeddingEnabled: false,
  asrModel: 'auto',
  globalHotkey: hotkeyRefused,
  dockOrder: [...DEFAULT_DOCK_ORDER],
  listeningAizuchi: false
}

let demoEvents: CalendarEvent[] | null = null
const demoCalendarEvents = (): CalendarEvent[] => (demoEvents ??= buildDemoCalendarEvents())

const confirmListeners = new Set<(e: ConfirmEvent) => void>()
const confirmPending = new Map<string, (approved: boolean) => void>()
let confirmSeq = 0
/** Stands in for the approval gate of the main process: it opens the same dialog and waits for the answer. */
function demoConfirm(title: string, message: string, detail: string, confirmLabel: string, destructive: boolean): Promise<boolean> {
  const id = `confirm-${++confirmSeq}`
  return new Promise((resolve) => {
    confirmPending.set(id, (approved) => {
      confirmPending.delete(id)
      confirmListeners.forEach((listener) => listener({ type: 'close', id }))
      resolve(approved)
    })
    confirmListeners.forEach((listener) => listener({ type: 'open', request: { id, title, message, detail, confirmLabel, destructive, holdsConversation: false } }))
  })
}

async function demoCalendarChange(change: CalendarChange): Promise<CalendarChangeResult> {
  const format = new Intl.DateTimeFormat(uiLocale(), { dateStyle: 'full', timeStyle: 'short' })
  const detail = [
    translate(`calendar.confirm.${change.operation}`, { calendar: 'デモ / 仕事' }),
    change.operation === 'delete' ? '' : `${translate('calendar.confirm.after')}\n${change.event.title}\n${format.format(Date.parse(change.event.start))} → ${format.format(Date.parse(change.event.end))}`,
    translate('calendar.confirm.syncNote')
  ]
    .filter(Boolean)
    .join('\n\n')
  if (!(await demoConfirm(translate('calendar.confirm.title'), translate('calendar.confirm.message'), detail, translate('calendar.confirm.action'), change.operation === 'delete'))) return { cancelled: true, saved: false }
  const list = demoCalendarEvents()
  if (change.operation === 'delete') {
    const index = list.findIndex((e) => e.id === change.eventId)
    const [event] = list.splice(index, 1)
    return { saved: true, operation: 'delete', event, sync: translate('calendar.saved.toMac') }
  }
  const fields = { ...change.event, start: Date.parse(change.event.start), end: Date.parse(change.event.end) }
  if (change.operation === 'update') {
    const index = list.findIndex((e) => e.id === change.eventId)
    list[index] = { ...list[index], ...fields }
    return { saved: true, operation: 'update', event: list[index], sync: translate('calendar.saved.toMac') }
  }
  const event = demoEvent(settings.calendar.writeCalendarId ?? 'demo-work', fields.title, new Date(fields.start), new Date(fields.end), fields)
  list.push(event)
  return { saved: true, operation: 'create', event, sync: translate('calendar.saved.toMac') }
}

let demoMail: MailMessage[] = DEMO_MAIL_MESSAGES.map((message) => ({ ...message }))
/** Stands in for the mail cache of the main process: every change broadcasts a changed and a status event. */
const commitMail = (next: MailMessage[], accountId: string): void => {
  demoMail = next
  emitMail({ type: 'changed', accountId })
  emitMail({ type: 'status', status: demoMailStatus(demoMail) })
}
const demoMailMessage = (id: string): MailMessage => {
  const message = demoMail.find((candidate) => candidate.id === id)
  if (!message) throw new Error(errorText('mail.errors.message.notFound'))
  return message
}
/** Puts a sent message into the Sent folder and marks the message answered, `answered`, when it is still there. */
function demoSend(accountId: string, to: MailAddress[], cc: MailAddress[], subject: string, body: string, answered: string | null): MailChangeResult {
  const account = DEMO_MAIL_ACCOUNTS.find((a) => a.id === accountId) ?? DEMO_MAIL_ACCOUNTS[0]
  const original = answered === null ? null : (demoMail.find((m) => m.id === answered) ?? null)
  const uid = Math.max(0, ...demoMail.map((m) => m.uid)) + 1
  const sent: MailMessage = {
    id: `${account.id}:sent:${uid}`,
    accountId: account.id,
    folder: 'sent',
    uid,
    messageId: `<${uid}@demo.example>`,
    threadId: original?.threadId ?? `m:<${uid}@demo.example>`,
    subject,
    from: { name: account.name, address: account.email },
    to,
    cc,
    replyTo: [],
    date: Date.now(),
    snippet: body.slice(0, 200),
    unread: false,
    starred: false,
    answered: false,
    attachments: [],
    size: body.length,
    labels: [],
    bodyFetched: true
  }
  DEMO_MAIL_BODIES.set(sent.id, body)
  commitMail([...demoMail.map((m) => (original && m.id === original.id ? { ...m, answered: true } : m)), sent], account.id)
  const operation = answered === null ? 'send' : 'reply'
  return { saved: true, operation, id: sent.messageId, summary: translate(operation === 'reply' ? 'mail.result.reply' : 'mail.result.send', { recipients: to.map((a) => a.address).join(', ') }) }
}

async function demoMailChange(value: Parameters<RendererApi['mailChange']>[0]): Promise<MailChangeResult> {
  const input = parseMailInput(mailChangeSchema, value)
  if (input.operation === 'send') {
    return demoSend(input.accountId ?? 'demo-work', input.to.map(parseAddress), input.cc.map(parseAddress), input.subject, input.body, null)
  }
  if (input.operation === 'reply') throw new Error('a reply from the screen is settled with mailReplySettle and sent with mailReplySend')
  if (input.operation === 'markRead') {
    const ids = new Set(input.ids)
    const targets = demoMail.filter((m) => ids.has(m.id))
    commitMail(demoMail.map((m) => (ids.has(m.id) ? { ...m, unread: !input.read } : m)), targets[0]?.accountId ?? '')
    return { saved: true, operation: input.operation, id: input.ids[0], summary: translate(input.read ? 'mail.result.markReadCount' : 'mail.result.markUnreadCount', { count: targets.length }) }
  }
  const message = demoMailMessage(input.id)
  if (input.operation === 'trash') {
    const account = DEMO_MAIL_ACCOUNTS.find((a) => a.id === message.accountId) ?? DEMO_MAIL_ACCOUNTS[0]
    const detail = translate('mail.confirm.trash', {
      label: account.label,
      subject: message.subject || translate('mail.noSubject'),
      name: message.from.name || message.from.address,
      date: new Intl.DateTimeFormat(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(message.date),
      folder: account.folders.trash ?? ''
    })
    if (!(await demoConfirm(translate('mail.confirm.title'), translate('mail.confirm.message'), detail, translate('mail.confirm.action.trash'), true))) return { cancelled: true, saved: false }
  }
  if (input.operation === 'archive' || input.operation === 'trash') {
    commitMail(demoMail.filter((m) => m.id !== message.id), message.accountId)
    return { saved: true, operation: input.operation, id: message.id, summary: translate(`mail.result.${input.operation}`, { subject: message.subject }) }
  }
  commitMail(demoMail.map((m) => (m.id === message.id ? { ...m, starred: input.starred } : m)), message.accountId)
  return { saved: true, operation: input.operation, id: message.id, summary: translate(input.starred ? 'mail.result.star' : 'mail.result.unstar', { subject: message.subject }) }
}

const emit = (e: TurnEvent): void => turnListeners.forEach((l) => l(e))
/** Stands in for the save of the main process: every change broadcasts the whole task list. */
const commitTasks = (next: Task[]): void => {
  demoTasks = next
  taskListeners.forEach((listener) => listener(demoTasks.map((task) => ({ ...task }))))
}
const demoTask = (id: string): Task => {
  const task = demoTasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(errorText('tasks.errors.notFound'))
  return { ...task }
}
const demoNoteList = (): NoteSummary[] => [...demoNotes].sort((a, b) => b.updatedAt - a.updatedAt).map(demoNoteSummary)
const emitNotes = (): void => noteListeners.forEach((listener) => listener(demoNoteList()))
const demoNote = (id: string): DemoNote => {
  const note = demoNotes.find((candidate) => candidate.id === id)
  if (!note) throw new Error(errorText('notes.errors.notFound'))
  return note
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The timer card reads the timers registered in the main process, so the demo registers one before showing it. */
export function createDemoTimer(id: string, props: Record<string, unknown>): void {
  if (demoTimers.has(id)) return
  const seconds = Number(props.seconds)
  if (!Number.isInteger(seconds) || seconds <= 0) return
  const createdAt = Date.now()
  const timer = {
    id,
    label: typeof props.label === 'string' && props.label.trim() ? props.label.trim() : translate('cardsTime.timer.defaultLabel'),
    seconds,
    createdAt,
    endsAt: createdAt + seconds * 1000,
    status: 'active' as const
  }
  demoTimers.set(id, timer)
  setTimeout(() => {
    const current = demoTimers.get(id)
    if (!current || current.status !== 'active') return
    const finished = { ...current, status: 'finished' as const, finishedAt: Date.now() }
    demoTimers.set(id, finished)
    timerListeners.forEach((listener) => listener({ type: 'updated', timer: finished }))
  }, seconds * 1000)
}

/** Streams the running job and its log lines to both the agent-job card and the agent screen. */
export async function emitDemoJob(): Promise<void> {
  for (const job of DEMO_JOBS) jobListeners.forEach((l) => l({ type: 'update', job: { ...job } }))
  for (const event of DEMO_JOB_LOG) {
    jobListeners.forEach((l) => l({ type: 'log', id: DEMO_JOB.id, line: { t: Date.now(), event } }))
    await sleep(150)
  }
}

/** Typing "/g1" through "/g4" shows every card type in turn, from the same samples the card list (/cards) uses. */
async function galleryTurn(turnId: number, command: string): Promise<boolean> {
  const group = CARD_GROUPS.find((g) => g.command === command)
  if (!group) return false
  for (const item of group.cards) {
    const key = `${item.type}:demo`
    if (item.type === 'timer') createDemoTimer(key, item.props)
    const event: PanelEvent = {
      op: 'create',
      key,
      type: item.type,
      slot: 'right',
      props: item.props,
      state: 'ready',
      source: item.source
    }
    emit({ type: 'panel', turnId, event })
    await sleep(120)
  }
  if (group.cards.some((c) => c.type === 'agent-job')) await emitDemoJob()
  emit({ type: 'done', turnId, fullText: 'ギャラリー表示' })
  return true
}

async function scriptedTurn(turnId: number, text: string): Promise<void> {
  if (await galleryTurn(turnId, text.trim())) return
  await sleep(250)
  emit({ type: 'metrics', turnId, timings: { ttftMs: 240 } })
  const response = respondTo(text)
  for (const event of response.cards) {
    if (event.op === 'create' && event.type === 'timer') createDemoTimer(event.key, event.props)
    emit({ type: 'panel', turnId, event })
  }
  if (response.cards.some((event) => event.op === 'create' && event.type === 'agent-job')) await emitDemoJob()
  for (const sentence of response.reply.split(/(?<=[。!?])/)) {
    if (!sentence) continue
    for (const ch of sentence) {
      emit({ type: 'delta', turnId, text: ch })
      await sleep(28)
    }
    emit({
      type: 'segment',
      turnId,
      segment: { turnId, index: 0, text: sentence, audio: null, phonemes: null }
    })
  }
  emit({ type: 'metrics', turnId, timings: { ttsMs: 120, e2eMs: 610 } })
  emit({ type: 'done', turnId, fullText: response.reply })
}

/**
 * The utterances the demo sends one after another at startup. The entry point (index.tsx) takes them
 * from the definition of the screen being opened and from the URL's say=. They exist so that the look of
 * a card can be captured reproducibly in a browser or in headless Chrome.
 */
let scriptedSayings: string[] = []
export function scriptSayings(sayings: string[]): void {
  scriptedSayings = sayings
}
let scriptedStarted = false
function startScriptedSayings(): void {
  if (scriptedStarted || scriptedSayings.length === 0) return
  scriptedStarted = true
  void (async () => {
    const { sendTypedMessage } = await import('@/conversation')
    await sleep(500)
    for (const text of scriptedSayings) {
      await sendTypedMessage(text)
      await sleep(4000)
    }
  })()
}

export const mockApi: RendererApi = {
  getStatus: async (): Promise<AppStatus> => ({
    llm: true,
    conversationModel: settings.conversationModel,
    llmKeys: { anthropic: 'verified', openai: 'missing', google: 'missing', cerebras: 'saved' },
    tts: false,
    ttsEngine: 'system',
    ttsLabel: 'DEMO',
    asr: false,
    agent: false,
    agentEngine: 'codex',
    voiceEngine: settings.voiceEngine,
    live: 'off'
  }),
  onStatusChanged: () => () => {},
  requestMicPermission: async () => false,
  micNativeStart: async () => ({ ok: false, sampleRate: 48_000, reason: 'demo' }),
  micNativeStop: async () => {},
  onMicNativeFrame: () => () => {},
  onMicNativeStatus: () => () => {},
  vapStart: async () => false,
  vapPush: async () => {},
  onVapState: () => () => {},
  vapStatus: async () => ({ runtimeInstalled: false, modelsInstalled: false, running: false }),
  vapPrepare: async () => ({ ok: false, message: 'demo' }),
  vapPrepareCancel: async () => false,
  embeddingStatus: async () => ({
    runtimeInstalled: false,
    modelInstalled: false,
    running: false,
    enabled: false,
    converting: false,
    embedded: 0,
    total: 0,
    model: 'demo'
  }),
  embeddingPrepare: async () => ({ ok: false, message: 'demo' }),
  embeddingPrepareCancel: async () => false,
  transcribe: async () => '',
  transcribeCancel: async () => false,
  transcribePartial: async () => '',
  turnStart: async (text) => {
    const turnId = turnSeq++
    void scriptedTurn(turnId, text)
    return turnId
  },
  turnAbort: async () => {},
  onTurnEvent: (cb) => {
    turnListeners.add(cb)
    startScriptedSayings()
    return () => turnListeners.delete(cb)
  },
  interject: async () => {},
  turnPlaybackAck: async () => {},
  liveStart: async () => ({ ok: false, reason: 'デモでは live エンジンを使えません' }),
  liveStop: async () => {},
  livePush: async () => {},
  liveActivity: async () => {},
  liveText: async () => {},
  onLiveAudio: () => () => {},
  onLiveEvent: () => () => {},
  // Where the real app has the main process fetch a card's data, the demo fills it from the fixtures.
  panelFetch: async (type, props) => demoPanelProps(type, props),
  onPanelEvent: () => () => {},
  timerList: async () => [...demoTimers.values()].map((timer) => ({ ...timer })),
  timerCancel: async (id) => {
    const removed = demoTimers.delete(id)
    if (removed) timerListeners.forEach((listener) => listener({ type: 'removed', id }))
    return removed
  },
  onTimerEvent: (callback) => {
    timerListeners.add(callback)
    return () => timerListeners.delete(callback)
  },
  aizuchiBank: async () => [],
  bridgePlan: async () => ({ bridge: '' }),
  bridgeSynthesize: async (text) => ({ text, audio: null }),
  aizuchiClassify: async () => ({ cls: 'understand', prob: 1, complete: 1 }),
  aizuchiClassifierStatus: async () => ({ runtimeInstalled: false, modelInstalled: false, running: false }),
  aizuchiClassifierPrepare: async () => ({ ok: false, message: 'demo' }),
  aizuchiClassifierPrepareCancel: async () => false,
  metricsLog: async () => {},
  memoryDocuments: async () => demoDocuments(demoMemory),
  memoryDocumentRead: async (file) => demoMemory[file] ?? null,
  memoryDocumentWrite: async (file, markdown, base) => {
    if (demoMemory[file] === undefined) throw new Error(errorText('memory.errors.removedSinceOpened'))
    if (demoMemory[file] !== base) throw new Error(errorText('memory.errors.changedSinceOpened'))
    const errors = validateDocument(file, markdown, translate)
    if (errors.length > 0) throw new Error(errors.join(' / '))
    demoMemory[file] = markdown
    return documentOf(file, markdown)
  },
  memoryDocumentCreate: async (input) => {
    const { name } = parseMemoryPageInput(input)
    const file = `pages/${name}.md`
    if (demoMemory[file]) throw new Error(errorText('memory.errors.pageExists', { name }))
    demoMemory[file] = demoPageTemplate(name)
    return documentOf(file, demoMemory[file])
  },
  memoryDocumentDelete: async (file) => {
    delete demoMemory[file]
  },
  memoryOverview: async () => ({
    dir: '~/Library/Application Support/asist/memory',
    units: 0,
    pages: Object.keys(demoMemory).filter((file) => file.startsWith('pages/')).length,
    curatedThrough: null,
    pendingJobId: null,
    lastFailure: null,
    unavailableReason: null
  }),
  memoryCurate: async () => null,
  tasksList: async () => demoTasks.map((task) => ({ ...task })),
  taskCreate: async (input) => {
    const task = buildTask(demoTasks, parseOrThrow(taskInputSchema, input), crypto.randomUUID(), Date.now())
    commitTasks([...demoTasks, task])
    return { ...task }
  },
  taskUpdate: async (id, patch) => {
    commitTasks(applyTaskPatch(demoTasks, id, parseOrThrow(taskPatchSchema, patch), Date.now()))
    return demoTask(id)
  },
  taskMove: async (move) => {
    const parsed = parseOrThrow(taskMoveSchema, move)
    commitTasks(placeTask(demoTasks, parsed.id, parsed.status, parsed.index, Date.now()))
    return demoTask(parsed.id)
  },
  taskRemove: async (id) => {
    const task = demoTask(id)
    commitTasks(reindex(demoTasks.filter((candidate) => candidate.id !== id)))
    return task
  },
  tasksClearDone: async () => {
    const done = demoTasks.filter((task) => task.status === 'done').length
    commitTasks(demoTasks.filter((task) => task.status !== 'done'))
    return done
  },
  onTasksChanged: (callback) => {
    taskListeners.add(callback)
    return () => taskListeners.delete(callback)
  },
  notesList: async () => demoNoteList(),
  notesSearch: async (query) =>
    [...demoNotes].sort((a, b) => b.updatedAt - a.updatedAt).filter((note) => noteMatches({ ...demoNoteSummary(note), markdown: note.markdown }, query)).map(demoNoteSummary),
  noteRead: async (id) => demoNote(id).markdown,
  noteCreate: async (markdown) => {
    const note = { id: noteIdOf(new Date(), Math.random().toString(16).slice(2, 6).padEnd(4, '0')), markdown: normalizeNoteMarkdown(markdown), updatedAt: Date.now() }
    demoNotes = [note, ...demoNotes]
    emitNotes()
    return demoNoteSummary(note)
  },
  noteWrite: async (id, markdown) => {
    const note = { ...demoNote(id), markdown: normalizeNoteMarkdown(markdown), updatedAt: Date.now() }
    demoNotes = demoNotes.map((candidate) => (candidate.id === id ? note : candidate))
    emitNotes()
    return demoNoteSummary(note)
  },
  noteRemove: async (id) => {
    demoNote(id)
    demoNotes = demoNotes.filter((candidate) => candidate.id !== id)
    emitNotes()
  },
  onNotesChanged: (callback) => {
    noteListeners.add(callback)
    return () => noteListeners.delete(callback)
  },
  notify: async () => {},
  reportMiniAppView: async () => {},
  onHotkeyMic: () => () => {},
  getSetupStatus: async () => ({
    services: await mockApi.getStatus(),
    asr:
      capabilities.speechRuntime.kind === null
        ? null
        : {
            selectedModel: 'auto',
            resolvedModel: 'qwen3-asr-1.7b-mlx',
            recommendedModel: 'qwen3-asr-1.7b-mlx',
            label: 'Qwen3-ASR 1.7B 8-bit MLX',
            totalMemoryGb: capabilities.speechRuntime.memoryGb,
            runtimeInstalled: false,
            modelInstalled: false,
            ready: false
          },
    qwenTts: {
      label: 'Qwen3-TTS 0.6B 8-bit MLX',
      recommended: recommendQwenTts(capabilities.speechRuntime),
      runtimeInstalled: false,
      modelInstalled: false,
      ready: false
    }
  }),
  completeSetup: async (request) => {
    Object.assign(settings, {
      onboardingVersion: 1,
      localAsrEnabled: request.voiceMode === 'local',
      micAutoStart: request.voiceMode === 'text' ? false : request.micAutoStart
    })
    return settings
  },
  prepareAsrModel: async () => ({ ok: false, message: 'デモモードでは使えません' }),
  cancelAsrPreparation: async () => false,
  prepareTtsModel: async () => ({ ok: false, message: 'デモモードでは使えません' }),
  cancelTtsPreparation: async () => false,
  onSetupProgress: () => () => {},
  jobCancel: async () => {},
  jobMerge: async () => {},
  jobDiscard: async () => {},
  jobDiscardPreview: async () => ({ repo: '/Users/demo/repo', dir: '/Users/demo/repo/.asist-worktrees/asist-readme', branch: 'asist/readme-note', stat: '', submodules: [] }),
  jobDiff: async () => ({
    commit: 'abc',
    base: 'a0c',
    into: 'main',
    stat: ' README.md | 3 +++\n 1 file changed, 3 insertions(+)',
    patch: '+## 注意\n+\n+設定ファイルの形式は変わることがあります。',
    submodules: []
  }),
  jobList: async () => DEMO_JOBS.map((job) => ({ ...job })),
  jobLog: async (id) => (id === DEMO_JOB.id ? DEMO_JOB_LOG.map((event, i) => ({ t: Date.now() - (DEMO_JOB_LOG.length - i) * 1000, event })) : []),
  onJobEvent: (cb) => {
    jobListeners.add(cb)
    return () => jobListeners.delete(cb)
  },
  calendarStatus: async () => DEMO_CALENDAR_STATUS,
  calendarRequestAccess: async () => DEMO_CALENDAR_STATUS,
  calendarEvents: async ({ start, end }) =>
    demoCalendarEvents().filter((e) => overlaps(e, Date.parse(start), Date.parse(end))),
  calendarChange: async (change) => demoCalendarChange(change),
  calendarOpenGuide: async () => {
    throw new Error('手順書はmacOSアプリで開いてください')
  },
  ttsVerify: async () => mockApi.getStatus(),
  micOpenPrivacy: async () => {},
  logsOpenFolder: async () => {},
  folderChoose: async () => '/Users/demo/Projects',
  calendarOpenPrivacy: async () => {
    throw new Error('アクセス許可はmacOSアプリで設定してください')
  },
  mailStatus: async () => demoMailStatus(demoMail),
  mailProbe: async () => ({ folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' }, gmail: false, mailboxes: ['INBOX', 'Sent', 'Archive', 'Trash'] }),
  mailAccountAdd: async () => {
    throw new Error('デモモードではアカウントを追加できません')
  },
  mailAccountUpdate: async (id) => {
    const account = DEMO_MAIL_ACCOUNTS.find((candidate) => candidate.id === id)
    if (!account) throw new Error(errorText('mail.errors.account.notFound'))
    return account
  },
  mailAccountRemove: async () => {
    throw new Error('デモモードではアカウントを消せません')
  },
  mailList: async (value) => {
    const query = parseMailInput(mailListQuerySchema, value)
    const needle = query.query.toLowerCase()
    // The order of main's cache, in which `before` names the last message of the page before.
    const order = (a: Pick<MailMessage, 'date' | 'uid' | 'id'>, b: Pick<MailMessage, 'date' | 'uid' | 'id'>): number =>
      b.date - a.date || b.uid - a.uid || b.id.localeCompare(a.id)
    const hits = demoMail
      .filter((m) =>
        query.view === 'starred' ? m.starred : m.folder === query.view
      )
      .filter((m) => !query.accountId || m.accountId === query.accountId)
      .filter((m) => !query.unreadOnly || m.unread)
      .filter(
        (m) =>
          !needle ||
          [m.subject, m.from.name, m.from.address, m.snippet, DEMO_MAIL_BODIES.get(m.id) ?? ''].some((text) => text.toLowerCase().includes(needle))
      )
      .sort(order)
    const { before } = query
    const page = hits.filter((m) => before === null || order(m, before) > 0).slice(0, query.limit)
    return { messages: page.map((m) => ({ ...m })), total: hits.length, unread: hits.filter((m) => m.unread).length }
  },
  mailThread: async (accountId, threadId) =>
    demoMail.filter((m) => m.accountId === accountId && m.threadId === threadId).sort((a, b) => a.date - b.date).map((m) => ({ ...m })),
  mailRead: async (id) => ({ message: { ...demoMailMessage(id) }, text: DEMO_MAIL_BODIES.get(id) ?? '' }),
  mailChange: async (change) => demoMailChange(change),
  mailReplySettle: async (id, replyAll) => demoReplyOf(demoMailMessage(id), replyAll),
  mailReplySend: async (value) => {
    const { reply, body } = parseMailInput(mailReplySendSchema, value)
    return demoSend(parseMessageId(reply.id).accountId, reply.to, reply.cc, replySubject(reply.subject), body, reply.id)
  },
  mailSyncNow: async () => {
    emitMail({ type: 'status', status: demoMailStatus(demoMail) })
  },
  mailOpenGuide: async () => {
    throw new Error('手順書はmacOSアプリで開いてください')
  },
  onMailEvent: (callback) => {
    mailListeners.add(callback)
    return () => mailListeners.delete(callback)
  },
  mailDraftList: async () => demoDrafts().map((draft) => ({ ...draft })),
  mailDraftCreate: async (value) => {
    const input = parseMailInput(mailDraftInputSchema, value)
    return createDemoDraft({ accountId: input.accountId ?? 'demo-work', to: input.to, cc: input.cc, subject: input.subject, body: input.body, reply: null, origin: 'screen' })
  },
  mailDraftUpdate: async (id, patch) => {
    const before = demoDraft(id)
    // As in main, a reply draft keeps its settled recipients and subject and takes only a new body.
    const allowed = before.reply ? { body: patch.body } : patch
    const next = { ...before, ...Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined)), updatedAt: Date.now() } as MailDraft
    commitDrafts(demoDrafts().map((draft) => (draft.id === id ? next : draft)))
    return { ...next }
  },
  mailDraftRemove: async (id) => {
    demoDraft(id)
    commitDrafts(demoDrafts().filter((draft) => draft.id !== id))
  },
  mailDraftSend: async (id) => {
    const draft = demoDraft(id)
    const result = draft.reply
      ? demoSend(draft.accountId, draft.reply.to, draft.reply.cc, replySubject(draft.reply.subject), draft.body, draft.reply.id)
      : await demoMailChange({ operation: 'send', accountId: draft.accountId, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body })
    if (result.saved) commitDrafts(demoDrafts().filter((candidate) => candidate.id !== id))
    return result
  },
  onConfirmEvent: (callback) => {
    confirmListeners.add(callback)
    return () => confirmListeners.delete(callback)
  },
  confirmPending: async () => [],
  confirmResolve: async (id, approved) => {
    confirmPending.get(id)?.(approved)
  },
  getSettings: async () => settings,
  saveSettings: async (patch) => Object.assign(settings, mergeSettings(settings, patch)),
  saveApiKey: async () => mockApi.getStatus(),
  listSpeakers: async () => [],
  ttsTest: async () => ({ turnId: 0, index: 0, text: 'テスト', audio: null, phonemes: null }),
  revealPath: async () => {},
  openExternal: async (url) => {
    window.open(url, '_blank')
  },
  appVersion: async () => '1.0.0',
  getPlatformCapabilities: async () => capabilities,
  hotkeyStatus: async () => (!settings.globalHotkey ? 'off' : hotkeyRefused ? 'failed' : 'registered'),
  licensesOpen: async () => {},
  apiUsage: async () => demoUsageDays()
}
