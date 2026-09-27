import { resolveWeatherCard, WeatherIssueError } from '../weather'
import { weatherCardKeyOf, type WeatherData, type WeatherIssue } from '@shared/weather'
import { PANEL_CATALOG, panelAvailable, panelDescription, type PanelCatalogEntry } from '@shared/panel-catalog'
import type { PlatformCapabilities } from '@shared/platform'
import { MINI_APPS, miniAppAvailable } from '@shared/mini-apps'
import type { AgentJob, PanelEvent, TurnEvent } from '@shared/ipc'
import type { SearchSource, ToolSpec } from '@shared/conversation'
import {
  promptLanguage,
  type ConversationLocale,
  type PromptLanguage,
  type PromptText
} from '@shared/conversation-locale'
import {
  FETCHER_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  ToolError,
  createToolRegistry,
  executeTool,
  inputJsonSchema,
  renderToolGuide,
  resolvePromptTexts,
  type ToolDefinition,
  type ToolExecutionTask,
  type ToolGuideEntry,
  type ToolRegistry
} from '@shared/tool-registry'
import { askingFrom } from '../confirm'
import { conversationLocale } from '../conversation-locale'
import { t } from '../i18n'
import * as agentRunner from '../agent'
import { completePanelProps, fetchPanel } from '../panel-fetchers'
import { platformCapabilities } from '../platform'
import * as timers from '../timers'
import { calendarTools } from './calendar-tools'
import { taskTools } from './task-tools'
import { mailTools } from './mail-tools'
import { agentTool, jobTools, projectTools } from './job-tools'
import { memoryTools } from './memory-tools'
import { miniAppTools } from './mini-app-tools'
import { noteTools } from './note-tools'
import { badInput, cardError, detail } from './tool-error-text'

/**
 * The client tools the conversation model can call, held in a registry. One tool is one definition
 * carrying its name, description, input schema, run function, whether it may run in parallel, its time
 * limit and the maximum length of its result, and both the list sent to the API and the dispatch at
 * call time are built from that same array. The panel tools (show_*) are generated from the zod
 * schemas in the catalog. A run that fails throws ToolError with what failed and how to fix it, and
 * the registry turns that into a result marked isError.
 *
 * Every text here exists in both prompt languages. The registry is built for the conversation
 * language of the turn and kept per language, so changing the language in the settings changes the
 * next turn's tool list; nothing is frozen at import.
 */

export interface ToolContext {
  turnId: number
  signal: AbortSignal
  emit: (event: TurnEvent) => void
}

type Def = ToolDefinition<ToolContext>

const PANEL_RESULT_MAX = 3000
const DISPLAY_ONLY_RESULT_MAX = 1500

const LOCAL_WRITE_PANELS = new Set(['timer'])

/** The panels that get their own line in the tool guide; the other show_ tools are collapsed into a single line. */
const PANEL_USAGE: Record<string, PromptText> = {
  'agent-job': {
    ja: 'ジョブを画面で見せる。「ログ見せて」「さっきのジョブどうなった」は jobId を指定、「ジョブどうなってる」「昨夜どうだった」は jobId なしで一覧。何を見せるか(ログ・差分・成果物)はカードが段階から決めるので選ばなくてよい。中身を語るなら get_agent_job で確かめてから',
    en: 'Show a job on screen. When the user asks about one job, such as to see its log or how the last one went, give the jobId; when they ask how the jobs are going in general, leave it out and the list comes up. The card decides from the stage what to show — the log, the diff, the artifacts — so you do not pick. Check with get_agent_job before you talk about what is inside.'
  },
  files: {
    ja: 'ファイルやフォルダを画面で見せる。ジョブの成果物を報告するときは、成果物のパスを全部まとめて一枚で出してから要点を話す。「見せて」「開いて」「どこに保存した?」にも使う。中身の解釈はカードがやるので、種類で呼び分けなくてよい',
    en: 'Show files and folders on screen. When reporting what a job produced, put every artifact path into one card first and then talk about the main points. Use it as well when the user asks to see or open something, or where it was saved. The card reads the contents itself, so you do not call it differently for each kind of file.'
  }
}
const SHOW_USAGE: PromptText = {
  ja: '情報をパネル表示する。話題に対応するパネルがあれば積極的に使い、返ってきたデータに基づいて話す。一瞬で終わるのでつなぎ文は要らない',
  en: 'Put information on a card. Reach for the card that matches the subject whenever there is one, and speak from the data that comes back. It finishes instantly, so no filler sentence is needed.'
}
const WEB_SEARCH_USAGE: PromptText = {
  ja: '読んで要約すれば答えられる情報(ニュース、最新情報、事実確認)。呼ぶ前に「調べますね」のような短いつなぎを一文言う。2〜3回で足りなければ「裏でちゃんと調べますね」と言って run_agent_task へ昇格し、沈黙して粘らない',
  en: 'Anything you can answer by reading and summarizing: news, what is new, checking a fact. Say one short filler sentence first, such as that you will look it up. If two or three searches are not enough, say you will look into it properly in the background, hand the work to run_agent_task, and do not keep at it in silence.'
}

function panelTool(entry: PanelCatalogEntry, language: PromptLanguage, capabilities: PlatformCapabilities): Def {
  const type = entry.type
  const localWrite = LOCAL_WRITE_PANELS.has(type)
  return {
    name: `show_${type.replace(/-/g, '_')}`,
    description: panelDescription(entry, capabilities),
    ...(PANEL_USAGE[type] ? { usage: PANEL_USAGE[type] } : {}),
    inputSchema: inputJsonSchema(entry.schema),
    // Showing and fetching only read, while the timer writes locally and therefore runs serially.
    parallel: !localWrite,
    timeoutMs: entry.fetch ? FETCHER_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
    maxResultChars: entry.resultChars ?? (entry.fetch || localWrite ? PANEL_RESULT_MAX : DISPLAY_ONLY_RESULT_MAX),
    run: (input, ctx, signal) => runPanelTool(entry, input, ctx, signal, language)
  }
}

/** A place that names no weather card, which the model is to settle with the user rather than report as a failure. */
const issueResult = (issue: WeatherIssue, language: PromptLanguage): Record<string, unknown> => ({ ...issue, hint: issue.hint[language] })

async function runPanelTool(
  entry: PanelCatalogEntry,
  input: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
  language: PromptLanguage
): Promise<unknown> {
  const type = entry.type
  const parsed = entry.schema.safeParse(input)
  if (!parsed.success) throw badInput(parsed.error.issues, language)
  // A default the schema filled in may be a packed pair, so the fetcher and the card see one language.
  // Only a field the model left out can hold one; what it wrote may quote text from outside.
  const given = Object.fromEntries(
    Object.entries(parsed.data as Record<string, unknown>).map(([field, value]) => [
      field,
      field in input ? value : resolvePromptTexts(value, language)
    ])
  )
  // What the model is told when the card cannot be filled, in the language of the conversation; a card
  // that is already up shows the same error in the language of the interface.
  const failure = (err: unknown): ToolError => new ToolError(TEXTS.panelFailed(detail(err, language)))
  if (type === 'weather') {
    signal.throwIfAborted()
    const place = resolveWeatherCard(String(given.location))
    if ('status' in place) return issueResult(place, language)
    let result: Awaited<ReturnType<typeof fetchPanel>>
    try {
      result = await fetchPanel(type, given, signal)
    } catch (err) {
      if (err instanceof WeatherIssueError) return issueResult(err.issue, language)
      throw failure(err)
    }
    signal.throwIfAborted()
    const weather = result.props.weather as WeatherData
    const key = weatherCardKeyOf(place.cardId, weather.targetDate)
    const previous =
      typeof given.replacesLocation === 'string' ? resolveWeatherCard(given.replacesLocation) : null
    const replacesKey =
      previous && !('status' in previous)
        ? weatherCardKeyOf(previous.cardId, weather.targetDate)
        : undefined
    ctx.emit({ type: 'panel', turnId: ctx.turnId, event: {
      op: 'create', key, type, slot: entry.slot, props: result.props, state: 'ready', replacesKey
    } })
    return { shown: true, panel: type, data: weather }
  }
  let props: Record<string, unknown>
  try {
    props = completePanelProps(type, given)
  } catch (err) {
    throw failure(err)
  }
  const key = entry.key(props)
  const panelEvent = (event: PanelEvent): void =>
    ctx.emit({ type: 'panel', turnId: ctx.turnId, event })
  const failPanel = (err: unknown): void =>
    panelEvent({ op: 'patch', key, state: 'error', error: cardError(err) })

  if (type === 'agent-job') return showAgentJob(props, panelEvent)

  panelEvent({
    op: 'create',
    key,
    type,
    slot: entry.slot,
    props,
    state: entry.fetch || LOCAL_WRITE_PANELS.has(type) ? 'loading' : 'ready'
  })
  if (type === 'timer') {
    try {
      const timer = timers.create({
        id: key,
        seconds: Number(props.seconds),
        label: typeof props.label === 'string' ? props.label : undefined
      })
      props = { seconds: timer.seconds, label: timer.label }
      panelEvent({ op: 'patch', key, props, state: 'ready', source: t('cardsTime.timer.source') })
      return { shown: true, panel: type, started: true, timer }
    } catch (err) {
      failPanel(err)
      throw new ToolError(TEXTS.timerFailed(detail(err, language)))
    }
  }
  if (!entry.fetch) return { shown: true, panel: type, props }
  try {
    const result = await fetchPanel(type, props, signal)
    panelEvent({ op: 'patch', key, props: result.props, state: 'ready', source: result.source })
    return { shown: true, panel: type, data: result.data ?? result.props }
  } catch (err) {
    failPanel(err)
    throw failure(err)
  }
}

/**
 * Shows the card of one job when a jobId is given and the list card otherwise. The card is drawn from
 * the renderer's job store, so the props carry nothing but the id, and the status is returned for the
 * model to talk about.
 */
function showAgentJob(props: Record<string, unknown>, panelEvent: (event: PanelEvent) => void): unknown {
  const jobId = typeof props.jobId === 'string' && props.jobId.trim() ? props.jobId : null
  if (!jobId) {
    const jobs = agentRunner.userJobs().slice(0, 10).map(jobBrief)
    panelEvent({ op: 'create', key: 'jobs', type: 'jobs', slot: 'right', props: {}, state: 'ready' })
    return { shown: true, panel: 'jobs', jobs, count: jobs.length }
  }
  const job = agentRunner.userJob(jobId)
  if (!job) throw new ToolError(TEXTS.noSuchJobCard(jobId))
  panelEvent({ op: 'create', key: `job:${job.id}`, type: 'agent-job', slot: 'right', props: { jobId: job.id }, state: 'ready' })
  return { shown: true, panel: 'agent-job', job: jobBrief(job) }
}

const jobBrief = (j: AgentJob): Record<string, unknown> => ({
  jobId: j.id,
  title: j.title,
  status: j.status,
  mergeState: j.mergeState,
  startedAt: new Date(j.startedAt).toLocaleString(conversationLocale()),
  summary: j.summary?.slice(0, 120),
  artifacts: j.artifacts?.length ?? 0
})

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  timerFailed: (reason: string): PromptText => ({
    ja: `タイマー開始に失敗: ${reason}。秒数を見直して呼び直すこと。`,
    en: `The timer could not be started: ${reason}. Check the number of seconds and call again.`
  }),
  panelFailed: (reason: string): PromptText => ({
    ja: `パネルの処理に失敗: ${reason}。入力を見直して呼び直すか、失敗したことを伝えること。`,
    en: `The card failed: ${reason}. Check the input and call again, or tell the user it failed.`
  }),
  noSuchJobCard: (jobId: string): PromptText => ({
    ja: `ジョブ ${jobId} は無い。ジョブ現況か jobId なしの show_agent_job で一覧を確かめること。`,
    en: `There is no job ${jobId}. Check the list in the job status block, or with show_agent_job called without a jobId.`
  }),
  showGroup: { ja: 'show_系(パネル)', en: 'the show_ tools (cards)' },
  webSearch: { ja: 'web 検索(組み込み)', en: 'web search (the provider\'s own)' }
} as const

const registryCache = new Map<ConversationLocale, ToolRegistry<ToolContext>>()

/**
 * The registry of client tools for one conversation language, built on first use and kept per
 * language. Both the list sent to the model and the dispatch at call time read it.
 */
export function toolRegistry(locale: ConversationLocale = conversationLocale()): ToolRegistry<ToolContext> {
  const cached = registryCache.get(locale)
  if (cached) return cached
  const language = promptLanguage(locale)
  const capabilities = platformCapabilities()
  const registry = createToolRegistry<ToolContext>([
    ...PANEL_CATALOG.filter((e) => e.tool && panelAvailable(e.type, capabilities)).map((entry) => panelTool(entry, language, capabilities)),
    agentTool(locale),
    ...taskTools(language),
    ...noteTools(language),
    ...(capabilities.calendar !== null ? calendarTools(locale) : []),
    ...mailTools(language),
    ...jobTools(locale),
    ...projectTools(language),
    ...memoryTools(language),
    ...miniAppTools(language, MINI_APPS.filter((app) => miniAppAvailable(app, capabilities)))
  ])
  registryCache.set(locale, registry)
  return registry
}

/** What a provider offers, because not every provider has a built-in web search. */
export interface ToolOptions {
  webSearch: boolean
}
const ALL_TOOLS: ToolOptions = { webSearch: true }

/** The client tools handed to the model. Web search is not among them, because it is the provider's own. */
export const tools = (): ToolSpec[] => {
  const locale = conversationLocale()
  return toolRegistry(locale).toolSpecs(promptLanguage(locale))
}

const guideCache = new Map<string, string>()

/**
 * The tool guide section of the system prompt, generated from the registry. The show_ tools collapse
 * into one line, and web search is listed only where it is available.
 */
export function toolGuide({ webSearch: withSearch }: ToolOptions = ALL_TOOLS): string {
  const locale = conversationLocale()
  const language = promptLanguage(locale)
  const cacheKey = `${locale}:${withSearch}`
  const cached = guideCache.get(cacheKey)
  if (cached) return cached
  const entries: ToolGuideEntry[] = [{ name: TEXTS.showGroup[language], usage: SHOW_USAGE }]
  for (const def of toolRegistry(locale).definitions) {
    if (def.usage) entries.push({ name: def.name, usage: def.usage })
  }
  if (withSearch) entries.push({ name: TEXTS.webSearch[language], usage: WEB_SEARCH_USAGE })
  const guide = renderToolGuide(entries, language)
  guideCache.set(cacheKey, guide)
  return guide
}

/**
 * Runs a client tool. A failure or a timeout comes back as a result marked isError rather than as an
 * exception. A confirmation the tool opens calls `onAsk` (see askingFrom), and its approval tells the
 * execution that the operation has started.
 */
export function executeClientTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  onAsk: () => boolean = () => false
): ToolExecutionTask {
  const locale = conversationLocale()
  // The approval comes from the user long after this returns, so the task is there by then.
  let task: ToolExecutionTask | undefined
  task = askingFrom({ onAsk, onApprove: () => task?.operationStarted() }, () =>
    executeTool(toolRegistry(locale), name, input, ctx, ctx.signal, promptLanguage(locale))
  )
  return task
}

type SearchResult = { title: string; url: string; site?: string; cited?: boolean; snippet?: string }

const toResult = (source: SearchSource): SearchResult => ({
  title: source.title,
  url: source.url,
  ...(source.site ? { site: source.site } : {}),
  ...(source.cited ? { cited: true } : {}),
  ...(source.snippet ? { snippet: source.snippet } : {})
})

/** The search cards of one turn, so that citations arriving after the answer can be written onto them. */
export class SearchCards {
  private readonly cards = new Map<string, SearchResult[]>()

  constructor(private readonly ctx: ToolContext) {}

  publish(query: string, sources: readonly SearchSource[], suggestions?: string): void {
    const results = sources.slice(0, 6).map(toResult)
    if (results.length === 0) return
    this.cards.set(query, results)
    this.ctx.emit({
      type: 'panel',
      turnId: this.ctx.turnId,
      event: {
        op: 'create',
        key: `search:${query}`,
        type: 'search-results',
        slot: 'right',
        props: { query, results, ...(suggestions ? { suggestions } : {}) },
        state: 'ready',
        source: 'web_search'
      }
    })
  }

  /** Marks the cited sources on every card that lists them, and moves them to the top. */
  cite(sources: readonly SearchSource[]): void {
    const cited = new Map(sources.map((source) => [source.url, source]))
    for (const [query, results] of this.cards) {
      if (!results.some((result) => cited.has(result.url))) continue
      const marked = results.map((result) => {
        const source = cited.get(result.url)
        return source ? { ...result, cited: true, ...(source.snippet ? { snippet: source.snippet } : {}) } : result
      })
      const ordered = [...marked.filter((result) => result.cited), ...marked.filter((result) => !result.cited)]
      this.cards.set(query, ordered)
      this.ctx.emit({ type: 'panel', turnId: this.ctx.turnId, event: { op: 'patch', key: `search:${query}`, props: { query, results: ordered } } })
    }
  }
}
