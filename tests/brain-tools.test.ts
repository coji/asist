import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationLocale } from '@shared/conversation-locale'
import type { JobDiff, TurnEvent } from '@shared/ipc'
import type { ToolContext, ToolOptions } from '../src/main/services/brain/tools'
import { PANEL_CATALOG } from '@shared/panel-catalog'
import { smallestLimitedFile } from './helpers/files'
import { DEMO_WEATHER_TOKYO } from '@/demo/fixtures/weather'
import { taskSummary } from '@shared/tasks'
import { FETCHER_TIMEOUT_MS, LOCAL_TIMEOUT_MS, resolvePromptTexts } from '@shared/tool-registry'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({
  windows: false,
  settings: { agentMode: 'readonly' as const, agentEngine: 'claude' as const, region: 'JP', uiLocale: 'ja-JP', conversationLocale: 'ja-JP' as string },
  memory: {
    search: vi.fn(() => []),
    promptDocumentBodies: vi.fn((): string[] => [])
  },
  agent: {
    findActive: vi.fn(() => undefined),
    allowedFileRoots: vi.fn((): string[] => []),
    workspaceRoot: vi.fn(() => '/work/asist-jobs'),
    start: vi.fn(() => ({ id: 'j1', title: 'job', cwd: '/tmp/ws' })),
    userJob: vi.fn(() => undefined),
    userJobs: vi.fn(() => []),
    getLog: vi.fn(() => []),
    cancel: vi.fn(),
    continueJob: vi.fn(),
    isGitRepo: vi.fn(() => false),
    startIsolated: vi.fn(() => ({ id: 'w1', title: 'fix', cwd: '/ws/wt', worktree: { repo: '/repo', branch: 'asist/x', base: 'abc' } })),
    merge: vi.fn(() => ({ id: 'w1', mergeState: 'merged', worktree: { repo: '/repo' } })),
    diff: vi.fn((): JobDiff => ({ commit: 'reviewed', base: 'merge-base', into: 'hotfix', stat: 'README.md | 2 +-', patch: '', submodules: [], leftOut: [], blocked: null })),
    discard: vi.fn(() => ({ id: 'w1', mergeState: 'discarded' })),
    discardPreview: vi.fn(() => ({ repo: '/repo', dir: '/ws/wt', branch: 'asist/x', stat: 'README.md | 2 +-', submodules: [] as string[], leftOut: [] as string[] }))
  },
  requestConfirm: vi.fn(async () => true),
  requireCli: vi.fn(async () => ({ path: '/opt/homebrew/bin/claude', env: {} })),
  fetchPanel: vi.fn(),
  timers: { create: vi.fn() },
  projects: {
    resolve: vi.fn(() => [] as Array<{ entry: { name: string; path: string; lastUsedAt: number }; score: number }>),
    register: vi.fn((name: string, path: string) => ({ name, path })),
    recent: vi.fn(() => [])
  },
  localData: { addNote: vi.fn(), listNotes: vi.fn() },
  tasks: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
}))

vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/memory', () => mocks.memory)
vi.mock('../src/main/services/agent', () => mocks.agent)
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: mocks.requireCli }))
vi.mock('../src/main/services/confirm', () => ({ requestConfirm: mocks.requestConfirm, askingFrom: (_asker: unknown, run: () => unknown) => run() }))
vi.mock('../src/main/services/panel-fetchers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/panel-fetchers')>()),
  fetchPanel: mocks.fetchPanel
}))
vi.mock('../src/main/services/timers', () => mocks.timers)
vi.mock('../src/main/services/user-local-data', () => ({ getLocalDataService: () => mocks.localData }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => mocks.tasks }))
vi.mock('../src/main/services/project-index', () => mocks.projects)

/**
 * The tools module, with every call given the conversation language a turn would read from the settings
 * at the moment of the call.
 */
async function load() {
  const module = await import('../src/main/services/brain/tools')
  const locale = (): ConversationLocale => mocks.settings.conversationLocale as ConversationLocale
  return {
    ...module,
    tools: () => module.tools(locale()),
    toolRegistry: (of: ConversationLocale = locale()) => module.toolRegistry(of),
    toolGuide: (options?: ToolOptions) => module.toolGuide(locale(), options),
    executeClientTool: (name: string, input: Record<string, unknown>, ctx: ToolContext, onAsk?: () => boolean) =>
      module.executeClientTool(name, input, ctx, locale(), onAsk)
  }
}

function makeCtx(): { ctx: { turnId: number; signal: AbortSignal; emit: (e: TurnEvent) => void }; events: TurnEvent[] } {
  const events: TurnEvent[] = []
  return { ctx: { turnId: 1, signal: new AbortController().signal, emit: (e) => events.push(e) }, events }
}

describe('brain tools registry', () => {
  // The first import of the tools transforms its whole module graph, and the imports after vi.resetModules
  // reuse that work. It took 387 ms alone but 5254 ms while `npm run demo:fit` kept three headless
  // Chromes busy (10-core Mac, 2026-09-24), which timed out whichever test came first. Importing once here moves
  // that cost into a hook with a timeout of its own.
  beforeAll(async () => {
    await load()
  }, 30_000)

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.windows = false
    mocks.memory.promptDocumentBodies.mockReturnValue([])
  })

  it('offers the calendar to the model on Windows as on a Mac, as a card, as a change and as a mini app', async () => {
    const calendarTools = async (): Promise<{ names: string[]; apps: unknown }> => {
      const { tools } = await load()
      const specs = tools()
      const openApp = specs.find((spec) => spec.name === 'open_app')!
      return {
        names: specs.map((spec) => spec.name).filter((name) => name.includes('calendar')),
        apps: (openApp.inputSchema as { properties: { app: { enum: string[] } } }).properties.app.enum.includes('calendar')
      }
    }
    const mac = await calendarTools()
    expect(mac).toEqual({ names: ['show_calendar', 'change_calendar'], apps: true })
    vi.resetModules()
    mocks.windows = true
    expect(await calendarTools()).toEqual(mac)
  })

  it('sends the catalog show_ tools and the separately registered ones under unique names, without web search, which the provider owns', async () => {
    const { tools, toolRegistry } = await load()
    const names = tools().map((t) => t.name)
    const shows = PANEL_CATALOG.filter((e) => e.tool).map((e) => `show_${e.type.replace(/-/g, '_')}`)
    for (const name of shows) expect(names).toContain(name)
    for (const name of ['run_agent_task', 'get_agent_job', 'continue_agent_job', 'merge_agent_job', 'discard_agent_job', 'cancel_agent_job', 'resolve_project', 'register_project', 'recall', 'list_tasks', 'add_task', 'update_task', 'remove_task']) {
      expect(names).toContain(name)
    }
    expect(names).not.toContain('web_search')
    expect(new Set(names).size).toBe(names.length)
    expect(toolRegistry().definitions.map((d) => d.name)).toEqual(names)
  })

  it('builds the tool guide from the registry and folds the show_ tools into a single line', async () => {
    const { toolGuide } = await load()
    const guide = toolGuide()
    expect(guide.startsWith('# ツールの使い分け\n- show_系(パネル): ')).toBe(true)
    for (const name of ['show_files', 'run_agent_task', 'continue_agent_job', 'merge_agent_job', 'resolve_project', 'recall', 'add_task', 'update_task', 'web 検索(組み込み)']) {
      expect(guide).toContain(`- ${name}: `)
    }
    expect(guide).not.toContain('- show_weather')
  })

  it('runs read-only tools in parallel and writing tools serially, with 8 seconds for remote fetches and 2 seconds for local work', async () => {
    const { toolRegistry } = await load()
    const registry = toolRegistry()
    const flags = (name: string) => {
      const def = registry.find(name)!
      return { parallel: def.parallel, timeoutMs: def.timeoutMs }
    }
    expect(flags('show_weather')).toEqual({ parallel: true, timeoutMs: FETCHER_TIMEOUT_MS })
    expect(flags('get_agent_job')).toEqual({ parallel: true, timeoutMs: LOCAL_TIMEOUT_MS })
    expect(flags('recall')).toEqual({ parallel: true, timeoutMs: LOCAL_TIMEOUT_MS })
    expect(flags('run_agent_task').parallel).toBe(false)
    // The job tools wait for the user to answer the confirmation window, which a local time limit would cut off.
    for (const name of ['run_agent_task', 'continue_agent_job', 'merge_agent_job']) {
      expect(flags(name).timeoutMs).toBeGreaterThanOrEqual(60_000)
    }
    expect(flags('show_timer')).toEqual({ parallel: false, timeoutMs: LOCAL_TIMEOUT_MS })
    expect(flags('list_tasks').parallel).toBe(true)
    expect(flags('add_task').parallel).toBe(false)
    expect(flags('update_task').parallel).toBe(false)
    expect(flags('add_note').parallel).toBe(false)
    expect(flags('search_notes').parallel).toBe(true)
    expect(flags('cancel_agent_job').parallel).toBe(false)
  })

  it('never tells the model to write a field that the tool fills in by itself when it is left out', async () => {
    const { tools } = await load()
    const defaulted: string[] = []
    const required: string[] = []
    for (const spec of tools()) {
      const schema = spec.inputSchema as { properties?: Record<string, object>; required?: string[] }
      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        if (!('default' in property)) continue
        defaulted.push(`${spec.name}.${field}`)
        if (schema.required?.includes(field)) required.push(`${spec.name}.${field}`)
      }
    }
    expect(defaulted.length).toBeGreaterThan(0)
    expect(required).toEqual([])
  })

  it('tells the model to write no field a tool does not name, in every object of every tool', async () => {
    const { tools } = await load()
    const open: string[] = []
    const visit = (schema: unknown, where: string): void => {
      if (!schema || typeof schema !== 'object') return
      const node = schema as Record<string, unknown>
      if (node.type === 'object' && node.properties && node.additionalProperties !== false) open.push(where)
      for (const [field, value] of Object.entries(node.properties ?? {})) visit(value, `${where}.${field}`)
      if (node.items) visit(node.items, `${where}[]`)
      for (const branch of ['anyOf', 'oneOf', 'allOf'] as const) {
        for (const [index, value] of ((node[branch] ?? []) as unknown[]).entries()) visit(value, `${where}|${index}`)
      }
    }
    for (const spec of tools()) visit(spec.inputSchema, spec.name)
    expect(open).toEqual([])
  })

  it('hands the fetcher what the model wrote as it is, even text from outside that looks like a packed pair', async () => {
    mocks.fetchPanel.mockResolvedValueOnce({ props: {}, source: 'Google News' })
    const { executeClientTool } = await load()
    const topic = 'bilingual: 請求書'
    const result = await executeClientTool('show_news', { topic }, makeCtx().ctx)
    expect(result.isError).toBe(false)
    expect(mocks.fetchPanel).toHaveBeenLastCalledWith('news', { topic }, expect.any(AbortSignal))
  })

  it('quotes show_fx against the currency of the region when none is named, on the card of that pair', async () => {
    mocks.settings.region = 'BR'
    try {
      const { executeClientTool } = await load()
      const keys: string[] = []
      for (const input of [{ base: 'USD' }, { base: 'USD', quote: 'BRL' }]) {
        mocks.fetchPanel.mockResolvedValueOnce({ props: {}, source: 'open.er-api.com' })
        const { ctx, events } = makeCtx()
        await executeClientTool('show_fx', input, ctx)
        expect(mocks.fetchPanel).toHaveBeenLastCalledWith('fx', { base: 'USD', quote: 'BRL' }, expect.any(AbortSignal))
        const created = events.find((e) => e.type === 'panel' && e.event.op === 'create')
        keys.push(created?.type === 'panel' ? created.event.key : '')
      }
      expect(keys[1]).toBe(keys[0])
    } finally {
      mocks.settings.region = 'JP'
    }
  })

  it('tells the model, and puts up no card, when a region outside the list has no currency to quote against', async () => {
    mocks.settings.region = 'XK'
    try {
      const { executeClientTool } = await load()
      const { ctx, events } = makeCtx()
      const result = await executeClientTool('show_fx', { base: 'USD' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain(ja('panels.errors.currencyUnknown', { region: 'XK' }))
      expect(events).toEqual([])
      expect(mocks.fetchPanel).not.toHaveBeenCalled()
    } finally {
      mocks.settings.region = 'JP'
    }
  })

  it('turns invalid panel input into a failed tool result instead of failing the turn', async () => {
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_timer', { seconds: 'abc' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('入力が不正')
    expect(events).toEqual([])
    expect(mocks.timers.create).not.toHaveBeenCalled()
  })

  it('puts the panel into the error state on a failed fetch and returns the failure and how to fix it', async () => {
    mocks.fetchPanel.mockRejectedValueOnce(new Error('open-meteo: HTTP 503'))
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_clock', { city: '大阪' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('HTTP 503')
    const patch = events.find((e) => e.type === 'panel' && e.event.op === 'patch')
    expect(patch).toMatchObject({ event: { state: 'error', error: 'open-meteo: HTTP 503' } })
  })

  it('words a card whose fetch ran past the time limit for the screen, and tells the model the tool timed out', async () => {
    const { executeClientTool } = await load()
    // Node's fetch rejects with the reason of the signal it was handed.
    mocks.fetchPanel.mockImplementationOnce(
      (_type: string, _props: Record<string, unknown>, signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { ctx, events } = makeCtx()
      const task = executeClientTool('show_news', { topic: 'AI' }, ctx)
      await vi.advanceTimersByTimeAsync(FETCHER_TIMEOUT_MS)
      const result = await task
      await task.completion
      expect(result.isError).toBe(true)
      const patch = events.find((e) => e.type === 'panel' && e.event.op === 'patch')
      const shown = patch?.type === 'panel' && patch.event.op === 'patch' ? patch.event.error : undefined
      expect(readErrorText(shown ?? '', 'en-US')).toBe(readErrorText(errorText('panels.errors.timedOut'), 'en-US'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the card the error with its key, for the screen to word, and tells the model in the language of the conversation', async () => {
    const failure = errorText('panels.errors.placeNotFound', { place: 'Atlantis' })
    mocks.fetchPanel.mockRejectedValueOnce(new Error(failure))
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_clock', { city: 'Atlantis' }, ctx)
    const patch = events.find((e) => e.type === 'panel' && e.event.op === 'patch')
    const shown = patch?.type === 'panel' && patch.event.op === 'patch' ? patch.event.error : undefined
    expect(readErrorText(shown ?? '', 'en-US')).toBe(readErrorText(failure, 'en-US'))
    expect(result.content).toContain(ja('panels.errors.placeNotFound', { place: 'Atlantis' }))
  })

  it('refuses a data card whose input is invalid with a failure the model reads, and puts up no card', async () => {
    const { putUpCard } = await import('../src/main/services/brain/cards')
    const { ToolError } = await import('@shared/tool-registry')
    const { ctx, events } = makeCtx()
    await expect(putUpCard('mail-message', { id: '' }, ctx, ctx.signal, 'en')).rejects.toBeInstanceOf(ToolError)
    expect(events).toEqual([])
  })

  it('returns the fetched data as JSON and puts the panel into the ready state', async () => {
    mocks.fetchPanel.mockResolvedValueOnce({ props: { location: '大阪', temp: 28 }, source: 'open-meteo' })
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_clock', { city: '大阪' }, ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({ shown: true, panel: 'clock', data: { location: '大阪', temp: 28 } })
    expect(events.at(-1)).toMatchObject({ event: { op: 'patch', state: 'ready', source: 'open-meteo' } })
  })

  it('returns the data the fetcher prepared for the model rather than the props of the card', async () => {
    const props = { range: 'week', events: [{ title: 'テスト', start: 1789434000000, end: 1789437600000, allDay: false }] }
    const data = { today: '2026-09-20(日) 15:58', title: 'この一週間', range: '2026-09-14(月) 〜 2026-09-20(日)', count: 1, events: [{ title: 'テスト', date: '2026-09-15(火)', time: '10:00–11:00' }] }
    mocks.fetchPanel.mockResolvedValueOnce({ props, source: 'Calendar.app', data })
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_calendar', { range: 'week' }, ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({ shown: true, panel: 'calendar', data })
    expect(events.at(-1)).toMatchObject({ event: { op: 'patch', state: 'ready', props } })
  })

  it('keeps the files the card left out in what the model reads of a result too long to send whole', async () => {
    // A job's artifacts, as long as a job's folder makes their paths, with the one the card leaves out last.
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-show-files-')))
    const work = path.join(base, 'Library', 'Application Support', 'ASIST', 'jobs', '2026-10-02-sales-analysis-7f3a', 'work')
    mkdirSync(work, { recursive: true })
    const file = (name: string, text: string, sizeBytes = text.length): string => {
      const target = path.join(work, name)
      writeFileSync(target, text)
      truncateSync(target, sizeBytes)
      return target
    }
    const { name: left, limit } = smallestLimitedFile()
    const paths = [
      file('report.md', '# 売上の分析\n'.repeat(4000)),
      file('summary.csv', 'month,sales\n'.repeat(800)),
      file('chart.png', '', 90_000),
      file('notes.md', 'メモ\n'.repeat(1000)),
      file('slides.pptx', '', 3_000_000),
      file(left, '', limit + 1)
    ]
    mocks.agent.allowedFileRoots.mockReturnValue([work])
    const actual = await vi.importActual<typeof import('../src/main/services/panel-fetchers')>('../src/main/services/panel-fetchers')
    mocks.fetchPanel.mockImplementationOnce(actual.fetchPanel)
    try {
      const { executeClientTool } = await load()
      const result = await executeClientTool('show_files', { paths }, makeCtx().ctx)
      expect(result.truncated).toBe(true)
      const { data } = result.value as { data: { notShown?: Array<{ files: string[] }> } }
      expect(data.notShown?.flatMap((group) => group.files)).toEqual([left])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('fetches nothing and leaves the card untouched while the weather location is unresolved', async () => {
    const { executeClientTool } = await load()
    for (const location of ['東京', '府中市']) {
      const { ctx, events } = makeCtx()
      const result = await executeClientTool('show_weather', { location }, ctx)
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content).status).toBe(location === '東京' ? 'location_not_found' : 'location_ambiguous')
      expect(events).toEqual([])
    }
    expect(mocks.fetchPanel).not.toHaveBeenCalled()
  })

  it('asks the model to settle a place the geocoding does not know with the user, as it does for one the table of Japan does not know', async () => {
    mocks.settings.region = 'DE'
    try {
      // What the geocoding throws for a name it does not know (weather-open-meteo.test.ts).
      const { WeatherIssueError } = await import('../src/main/services/weather/issue')
      const hint = { ja: 'どこの天気かユーザーに確かめる', en: 'Ask the user where' }
      mocks.fetchPanel.mockRejectedValueOnce(new WeatherIssueError({ status: 'location_not_found', requestedLocation: 'Atlantis', hint }))
      const { executeClientTool } = await load()
      const { ctx, events } = makeCtx()
      const result = await executeClientTool('show_weather', { location: 'Atlantis' }, ctx)
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content)).toEqual({ status: 'location_not_found', requestedLocation: 'Atlantis', hint: hint.ja })
      expect(events).toEqual([])
    } finally {
      mocks.settings.region = 'JP'
    }
  })

  it('answers the model with the days of the fetched weather named by weekday, and creates the card from the weather as fetched under the resolved area and date', async () => {
    const weather = DEMO_WEATHER_TOKYO
    mocks.fetchPanel.mockResolvedValueOnce({ props: { location: '東京都', date: 'tomorrow', weather } })
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_weather', { location: '東京都', date: 'tomorrow', replacesLocation: '広島県' }, ctx)
    const { data } = JSON.parse(result.content) as { data: { targetDate: string; daily: Array<{ date: string }> } }
    expect(data.targetDate).toBe('2026-09-16(水)')
    // A whole day of forecasts comes back uncut, all seven days of the week included.
    expect(data.daily.map((day) => day.date)).toEqual([
      '2026-09-16(水)',
      '2026-09-17(木)',
      '2026-09-18(金)',
      '2026-09-19(土)',
      '2026-09-20(日)',
      '2026-09-21(月)',
      '2026-09-22(火)'
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: { op: 'create', key: 'weather:13101:2026-09-16', replacesKey: 'weather:34100:2026-09-16', props: { weather }, state: 'ready' } })
  })

  it('leaves the existing card in place when the weather fetch fails', async () => {
    mocks.fetchPanel.mockRejectedValueOnce(new Error('気象庁の取得に失敗'))
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('show_weather', { location: '東京都' }, ctx)
    expect(result.isError).toBe(true)
    expect(events).toEqual([])
  })

  it('tells the model why the weather could not be fetched, in the language of the conversation', async () => {
    mocks.fetchPanel.mockRejectedValueOnce(new Error(errorText('cardsWeather.errors.unavailable')))
    const { executeClientTool } = await load()
    const result = await executeClientTool('show_weather', { location: '東京都' }, makeCtx().ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain(ja('cardsWeather.errors.unavailable'))
  })

  it('returns the hits of recall with their dates, the strongest match first, and fails on an empty query', async () => {
    mocks.memory.search.mockReturnValueOnce([{ via: 'lexical', exact: true, record: { id: 'm1', file: 'pages/中野.md', line: 3, kind: 'section', page: '中野', heading: '要約', aliases: [], text: '最寄り駅は中野', date: '2026-09-01', order: 0 } }] as never)
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const result = await executeClientTool('recall', { query: '最寄り駅' }, ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      hits: [{ id: 'm1', page: '中野', heading: '要約', kind: 'section', text: '最寄り駅は中野', date: '2026-09-01' }],
      count: 1
    })
    expect(mocks.memory.search).toHaveBeenCalledWith('最寄り駅', { limit: 5 }, expect.any(AbortSignal))
    const empty = await executeClientTool('recall', { query: ' ' }, ctx)
    expect(empty.isError).toBe(true)
  })

  it.each(['recall', 'resolve_project'])('passes the abort of the conversation to the search in %s and releases the wait', async (name) => {
    const { executeClientTool } = await load()
    const controller = new AbortController()
    const { ctx } = makeCtx()
    ctx.signal = controller.signal
    let received: AbortSignal | undefined
    mocks.memory.search.mockImplementationOnce((...args: unknown[]) => new Promise((_, reject) => {
      received = args[2] as AbortSignal
      received.addEventListener('abort', () => reject(received!.reason), { once: true })
    }) as never)
    const run = executeClientTool(name, { query: '猫', name: '不明な場所' }, ctx)
    await vi.waitFor(() => expect(received).toBeDefined())
    controller.abort()
    expect((await run).isError).toBe(true)
    await run.completion
    expect(received!.aborted).toBe(true)
  })

  it('answers resolve_project with candidates from the index, then with a path found in memory, and otherwise asks to register one', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    mocks.projects.resolve.mockReturnValueOnce([
      { entry: { name: 'asist', path: '/repo/asist', lastUsedAt: 0 }, score: 1 },
      { entry: { name: 'asist-docs', path: '/repo/asist-docs', lastUsedAt: 0 }, score: 0.9 }
    ])
    const two = JSON.parse((await executeClientTool('resolve_project', { name: 'アシスト' }, ctx)).content)
    expect(two.candidates.map((c: { path: string }) => c.path)).toEqual(['/repo/asist', '/repo/asist-docs'])
    expect(two.note).toContain('二択')
    mocks.memory.search.mockReturnValueOnce([
      { via: 'lexical', exact: false, record: { id: 'e1', file: 'pages/LP.md', line: 2, kind: 'section', page: 'LP', heading: '要約', aliases: [], text: '例のLPは /Users/me/work/lp にある', date: '2026-09-01', order: 0 } }
    ] as never)
    const fromMemory = JSON.parse((await executeClientTool('resolve_project', { name: '例のLP' }, ctx)).content)
    expect(fromMemory.candidates).toEqual([{ name: '例のLPは /Users/me/work/lp にある', path: '/Users/me/work/lp', lastUsed: '2026-09-01' }])
    const none = JSON.parse((await executeClientTool('resolve_project', { name: '宇宙' }, ctx)).content)
    expect(none.candidates).toEqual([])
    expect(none.note).toContain('register_project')
  })

  it('answers resolve_project with a path written in me.md or user.md, which the index of the memory leaves out, on a line that names the place', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    mocks.memory.promptDocumentBodies.mockReturnValue(['## 仕事\n- 例のLPは /Users/me/work/lp にある\n- ASIST のリポジトリ: /Users/me/src/asist\n\n## 好み\n辛さは控えめ。'])
    const paths = async (name: string): Promise<string[]> =>
      JSON.parse((await executeClientTool('resolve_project', { name }, ctx)).content).candidates.map((c: { path: string }) => c.path)
    expect(await paths('例のLP')).toEqual(['/Users/me/work/lp'])
    expect(await paths('asist')).toEqual(['/Users/me/src/asist'])
    expect(await paths('宇宙')).toEqual([])
    expect(JSON.parse((await executeClientTool('resolve_project', { name: '例のLP' }, ctx)).content).candidates)
      .toEqual([{ name: '- 例のLPは /Users/me/work/lp にある', path: '/Users/me/work/lp', lastUsed: '' }])
  })

  it('takes from a memory only a path that starts a word, not the slash of a date or of a URL', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const memoryWith = (text: string): void => {
      mocks.memory.search.mockReturnValueOnce([
        { via: 'lexical', exact: false, record: { id: 'e1', file: 'pages/LP.md', line: 2, kind: 'section', page: 'LP', heading: '要約', aliases: [], text, date: '2026-09-01', order: 0 } }
      ] as never)
    }
    memoryWith('例のLPの締切は 9/20、資料は https://example.com/lp にある')
    expect(JSON.parse((await executeClientTool('resolve_project', { name: '例のLP' }, ctx)).content).candidates).toEqual([])
    memoryWith('9/20 に作った例のLPは/Users/me/work/lp にある')
    expect(JSON.parse((await executeClientTool('resolve_project', { name: '例のLP' }, ctx)).content).candidates.map((c: { path: string }) => c.path))
      .toEqual(['/Users/me/work/lp'])
  })

  it('takes from a memory a Windows path that begins after a space, a quote or a bracket, and no drive letter inside a word', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const pathsIn = async (text: string): Promise<string[]> => {
      mocks.memory.search.mockReturnValueOnce([
        { via: 'lexical', exact: false, record: { id: 'e1', file: 'pages/LP.md', line: 2, kind: 'section', page: 'LP', heading: '要約', aliases: [], text, date: '2026-09-01', order: 0 } }
      ] as never)
      return JSON.parse((await executeClientTool('resolve_project', { name: '例のLP' }, ctx)).content).candidates.map((c: { path: string }) => c.path)
    }
    expect(await pathsIn('9/20 に作った例のLPは C:\\Users\\me\\work\\lp にある')).toEqual(['C:\\Users\\me\\work\\lp'])
    expect(await pathsIn('例のLP(D:/work/lp)')).toEqual(['D:/work/lp'])
    expect(await pathsIn('例のLPは「\\\\nas\\team\\lp」にある')).toEqual(['\\\\nas\\team\\lp'])
    expect(await pathsIn('例のLPは案A:/B テストで決める')).toEqual([])
    expect(await pathsIn('例のLPの改行は \\\\n で書く')).toEqual([])
  })

  it('continues a job in the session of the original one after the user approves it, and returns a failed result when it cannot', async () => {
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    mocks.agent.userJob.mockReturnValueOnce({ id: 'j1', title: '調査', status: 'running', engine: 'claude', readonly: true, cwd: '/w/j1' } as never)
    mocks.agent.continueJob.mockReturnValueOnce({ id: 'j2', title: '調査(続き)' } as never)
    const ok = await executeClientTool('continue_agent_job', { jobId: 'j1', prompt: '観点を足して' }, ctx)
    expect(ok.isError).toBe(false)
    expect(JSON.parse(ok.content)).toEqual({ started: true, jobId: 'j2', title: '調査(続き)', parentId: 'j1' })
    expect(mocks.agent.continueJob).toHaveBeenCalledWith('j1', '観点を足して', expect.any(AbortSignal))
    const request = mocks.requestConfirm.mock.calls[0][0] as { detail: string }
    for (const line of ['観点を足して', ja('jobs.confirm.place', { place: '/w/j1' }), ja('jobs.confirm.readOnly'), ja('jobs.confirm.stopsRunning')]) {
      expect(request.detail).toContain(line)
    }
    expect(events[0]).toMatchObject({ type: 'panel', event: { key: 'job:j2' } })
    mocks.agent.userJob.mockReturnValueOnce({ id: 'j1', title: '調査', status: 'done', engine: 'claude', readonly: true, cwd: '/w/j1' } as never)
    mocks.agent.continueJob.mockImplementationOnce(() => {
      throw new Error('再開できるセッションが残っていません')
    })
    const failed = await executeClientTool('continue_agent_job', { jobId: 'j1', prompt: 'x' }, ctx)
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('run_agent_task')
  })

  it.each(['run_agent_task', 'continue_agent_job'])('refuses %s whose CLI cannot be started before any confirmation opens', async (name) => {
    mocks.requireCli.mockRejectedValueOnce(new Error(errorText('jobs.start.cliMissing', { engine: 'claude' })))
    if (name === 'continue_agent_job') {
      mocks.agent.userJob.mockReturnValueOnce({ id: 'j1', title: '調査', status: 'done', engine: 'claude', readonly: true, cwd: '/w/j1' } as never)
    }
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool(name, { jobId: 'j1', prompt: '調べて' }, ctx)
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(mocks.requireCli).toHaveBeenCalledWith('claude')
    expect(mocks.agent.start).not.toHaveBeenCalled()
    expect(mocks.agent.continueJob).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('does not continue a job the user declines in the confirmation window', async () => {
    mocks.requestConfirm.mockResolvedValueOnce(false)
    mocks.agent.userJob.mockReturnValueOnce({ id: 'j1', title: '調査', status: 'running', engine: 'claude', readonly: false, cwd: '/w/j1' } as never)
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('continue_agent_job', { jobId: 'j1', prompt: '全部消して' }, ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ started: false, declined: true })
    expect(mocks.agent.continueJob).not.toHaveBeenCalled()
    expect(mocks.agent.cancel).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('puts up the tasks card from list_tasks only when asked, and returns the tasks either way', async () => {
    mocks.tasks.list.mockResolvedValue([
      { id: 't1', title: '牛乳を買う', notes: '', status: 'todo', due: null, order: 0, createdAt: 0, updatedAt: 0, completedAt: null }
    ])
    const { executeClientTool } = await load()
    const quiet = makeCtx()
    const listed = await executeClientTool('list_tasks', {}, quiet.ctx)
    expect(JSON.parse(listed.content)).toMatchObject({ count: 1 })
    expect(quiet.events).toEqual([])
    const shown = makeCtx()
    await executeClientTool('list_tasks', { card: true }, shown.ctx)
    expect(shown.events.map((e) => e.type === 'panel' && e.event.op === 'create' && e.event.type)).toEqual(['todo'])
  })

  it('returns a failed result for the details of a job that does not exist', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const result = await executeClientTool('get_agent_job', { jobId: 'nope' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('nope')
    expect(result.content).toContain('show_agent_job')
  })

  it('shows the card of one job when show_agent_job has a jobId and the list card when it has none', async () => {
    const { executeClientTool } = await load()
    const job = { id: 'j9', title: '調査', status: 'done', startedAt: 1, summary: '終わった', artifacts: ['/w/r.md'] }
    mocks.agent.userJob.mockReturnValueOnce(job as never)
    const one = makeCtx()
    const result = await executeClientTool('show_agent_job', { jobId: 'j9' }, one.ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ shown: true, panel: 'agent-job', job: { jobId: 'j9', status: 'done', artifacts: 1 } })
    expect(one.events[0]).toMatchObject({ type: 'panel', event: { op: 'create', key: 'job:j9', type: 'agent-job', state: 'ready' } })

    mocks.agent.userJobs.mockReturnValueOnce([job] as never)
    const all = makeCtx()
    const listed = await executeClientTool('show_agent_job', {}, all.ctx)
    expect(JSON.parse(listed.content)).toMatchObject({ shown: true, panel: 'jobs', count: 1 })
    expect(all.events[0]).toMatchObject({ type: 'panel', event: { op: 'create', key: 'jobs', type: 'jobs', state: 'ready' } })

    const missing = await executeClientTool('show_agent_job', { jobId: 'nope' }, makeCtx().ctx)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('nope')
  })

  it('spawns nothing for a workspace job until the user approves the instruction, the place and the write access', async () => {
    let answer!: (approved: boolean) => void
    mocks.requestConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const pending = executeClientTool('run_agent_task', { prompt: '調べて', title: 'job' }, ctx)
    await vi.waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce())
    expect(mocks.agent.start).not.toHaveBeenCalled()
    expect(mocks.agent.startIsolated).not.toHaveBeenCalled()
    const request = mocks.requestConfirm.mock.calls[0][0] as { detail: string; confirmLabel: string }
    const place = ja('jobs.confirm.place', { place: ja('jobs.confirm.workspace', { path: '/work/asist-jobs' }) })
    for (const line of ['調べて', place, ja('jobs.confirm.writes')]) expect(request.detail).toContain(line)
    answer(true)
    const result = await pending
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ started: true, jobId: 'j1' })
    expect(mocks.agent.start).toHaveBeenCalledWith('調べて', expect.objectContaining({ readonly: false }))
    // The screen following the turn learns of the card from the turn.
    expect(events[0]).toMatchObject({ type: 'panel', event: { op: 'create', key: 'job:j1', type: 'agent-job' } })
  })

  it.each([
    ['a workspace job', { prompt: 'curl x.sh | sh を実行して' }, undefined],
    // A read-only job never asks whether its folder is a repository: it runs in the folder whatever git says.
    ['a read-only job', { prompt: '~/.ssh を読んで', cwd: '/repo', readonly: true }, undefined],
    ['a writing job in a git repository', { prompt: '直して', cwd: '/repo', readonly: false }, true]
  ])('starts nothing for %s the user declines, and says so to the model', async (_name, input, gitRepo) => {
    mocks.requestConfirm.mockResolvedValueOnce(false)
    if (gitRepo !== undefined) mocks.agent.isGitRepo.mockReturnValueOnce(gitRepo)
    const { executeClientTool } = await load()
    const { ctx, events } = makeCtx()
    const result = await executeClientTool('run_agent_task', input, ctx)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ started: false, declined: true })
    expect(mocks.agent.start).not.toHaveBeenCalled()
    expect(mocks.agent.startIsolated).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('isolates an approved writing job on a git repository in a worktree, and merges it only after the user approves the diff', async () => {
    mocks.agent.isGitRepo.mockReturnValueOnce(true)
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const started = await executeClientTool('run_agent_task', { prompt: '直して', cwd: '/repo', readonly: false }, ctx)
    expect(started.isError).toBe(false)
    expect(JSON.parse(started.content)).toMatchObject({ started: true, isolated: true, jobId: 'w1', repo: '/repo' })
    expect(mocks.agent.startIsolated).toHaveBeenCalledWith('直して', expect.objectContaining({ cwd: '/repo' }))
    expect((mocks.requestConfirm.mock.calls[0][0] as { detail: string }).detail)
      .toContain(ja('jobs.confirm.place', { place: ja('jobs.confirm.worktree', { path: '/repo' }) }))

    const worktreeJob = { id: 'w1', title: 'fix', worktree: { repo: '/repo', branch: 'asist/x', base: 'abc', commit: 'reviewed' } }
    mocks.requestConfirm.mockClear()
    mocks.requestConfirm.mockResolvedValueOnce(false)
    mocks.agent.userJob.mockReturnValueOnce(worktreeJob as never)
    const declined = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'reviewed' }, ctx)
    expect(JSON.parse(declined.content)).toMatchObject({ merged: false, declined: true, jobId: 'w1' })
    expect(mocks.agent.merge).not.toHaveBeenCalled()
    const request = mocks.requestConfirm.mock.calls[0][0] as { detail: string }
    for (const line of ['README.md | 2 +-', ja('jobs.confirm.mergeInto', { into: 'hotfix', repo: '/repo' })]) expect(request.detail).toContain(line)

    mocks.agent.userJob.mockReturnValueOnce(worktreeJob as never)
    const merged = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'reviewed' }, ctx)
    expect(JSON.parse(merged.content)).toEqual({ merged: true, jobId: 'w1', repo: '/repo' })
    expect(mocks.agent.merge).toHaveBeenCalledWith('w1', expect.objectContaining({ commit: 'reviewed', base: 'merge-base', into: 'hotfix' }))
    mocks.agent.userJob.mockReturnValueOnce(worktreeJob as never)
    mocks.agent.merge.mockReturnValueOnce({ id: 'w1', mergeState: 'conflict' } as never)
    const conflict = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'reviewed' }, ctx)
    expect(conflict.isError).toBe(true)
    expect(conflict.content).toContain('continue_agent_job')
  })

  it('throws a worktree job\'s changes away only after the user approves, and keeps them when the user cancels', async () => {
    const worktreeJob = { id: 'w1', title: 'fix', status: 'done', mergeState: 'pending', worktree: { repo: '/repo', branch: 'asist/x', base: 'abc', commit: 'reviewed' } }
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    mocks.requestConfirm.mockResolvedValueOnce(false)
    mocks.agent.userJob.mockReturnValueOnce(worktreeJob as never)
    const declined = await executeClientTool('discard_agent_job', { jobId: 'w1' }, ctx)
    expect(JSON.parse(declined.content)).toMatchObject({ discarded: false, declined: true, jobId: 'w1' })
    expect(mocks.agent.discard).not.toHaveBeenCalled()
    const request = mocks.requestConfirm.mock.calls[0][0] as { detail: string; destructive: boolean }
    expect(request.destructive).toBe(true)
    const lines = [ja('jobs.confirm.job', { title: 'fix' }), ja('jobs.confirm.place', { place: '/ws/wt' }), ja('jobs.confirm.branch', { branch: 'asist/x', repo: '/repo' }), 'README.md | 2 +-']
    for (const line of lines) expect(request.detail).toContain(line)

    mocks.agent.userJob.mockReturnValueOnce(worktreeJob as never)
    const discarded = await executeClientTool('discard_agent_job', { jobId: 'w1' }, ctx)
    expect(JSON.parse(discarded.content)).toEqual({ discarded: true, jobId: 'w1' })
    expect(mocks.requestConfirm).toHaveBeenCalledTimes(2)
    expect(mocks.agent.discard).toHaveBeenCalledWith('w1')
  })

  it('warns before a discard that the work inside the job\'s submodules is deleted with its worktree', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', status: 'done', mergeState: 'pending', worktree: { repo: '/repo', dir: '/ws/wt', branch: 'asist/x', base: 'abc', commit: 'reviewed', submodules: ['vendor/sub'] } } as never)
    mocks.agent.discardPreview.mockReturnValueOnce({ repo: '/repo', dir: '/ws/wt', branch: 'asist/x', stat: 'vendor/sub | 2 +-', submodules: ['vendor/sub'], leftOut: [] })
    mocks.requestConfirm.mockResolvedValueOnce(false)
    const { executeClientTool } = await load()
    await executeClientTool('discard_agent_job', { jobId: 'w1' }, makeCtx().ctx)
    const request = mocks.requestConfirm.mock.calls[0][0] as { detail: string; destructive: boolean }
    expect(request.destructive).toBe(true)
    expect(request.detail).toContain(ja('jobs.discard.submoduleWork', { paths: 'vendor/sub' }))
    expect(mocks.agent.discard).not.toHaveBeenCalled()
  })

  it('gives the status, the summary and the log of a job whose diff cannot be read, and says why', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', status: 'done', summary: '直した', mergeState: 'pending', worktree: { repo: '/repo', dir: '/ws/wt', branch: 'asist/x', base: 'abc', commit: 'reviewed' } } as never)
    mocks.agent.getLog.mockReturnValueOnce([{ t: 1, event: { kind: 'system', text: 'ログの一行' } }] as never)
    mocks.agent.diff.mockImplementationOnce(() => {
      throw new Error(errorText('jobs.merging.noCommonHistory'))
    })
    const { executeClientTool } = await load()
    const result = await executeClientTool('get_agent_job', { jobId: 'w1' }, makeCtx().ctx)
    expect(result.isError).toBe(false)
    const detail = JSON.parse(result.content)
    expect(detail).toMatchObject({ jobId: 'w1', status: 'done', summary: '直した', mergeState: 'pending', reviewUnavailable: ja('jobs.merging.noCommonHistory') })
    expect(detail.review).toBeUndefined()
    expect(detail.logTail.join('\n')).toContain('ログの一行')
  })

  it('tells the model in its language why a job waiting to be merged cannot be merged by ASIST', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', status: 'done', mergeState: 'pending', worktree: { repo: '/repo', dir: '/ws/wt', branch: 'asist/x', base: 'abc', commit: 'reviewed' } } as never)
    mocks.agent.diff.mockReturnValueOnce({ commit: 'reviewed', base: 'merge-base', into: null, stat: 'README.md | 2 +-', patch: '', submodules: [], leftOut: [], blocked: errorText('jobs.merging.detached') })
    const { executeClientTool } = await load()
    const result = await executeClientTool('get_agent_job', { jobId: 'w1' }, makeCtx().ctx)
    expect(JSON.parse(result.content).review).toMatchObject({ into: null, blocked: ja('jobs.merging.detached') })
  })

  it('does not ask about discarding a job the agent service would refuse, such as one already merged, and tells the model why', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', status: 'done', mergeState: 'merged' } as never)
    mocks.agent.discardPreview.mockImplementationOnce(() => {
      throw new Error(errorText('jobs.discard.noChanges', { id: 'w1' }))
    })
    const { executeClientTool } = await load()
    const result = await executeClientTool('discard_agent_job', { jobId: 'w1' }, makeCtx().ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain(ja('jobs.discard.noChanges', { id: 'w1' }))
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expect(mocks.agent.discard).not.toHaveBeenCalled()
  })

  it('does not ask about a merge whose commit is not the one waiting, and merges nothing', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', worktree: { repo: '/repo', branch: 'asist/x', base: 'abc' } } as never)
    const { executeClientTool } = await load()
    const result = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'older' }, makeCtx().ctx)
    expect(result.isError).toBe(true)
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expect(mocks.agent.merge).not.toHaveBeenCalled()
  })

  it('refuses to merge a job that touched submodules before asking the user about it', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', worktree: { repo: '/repo', dir: '/ws/wt', branch: 'asist/x', base: 'abc', commit: 'reviewed' } } as never)
    const blocked = errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch: 'asist/x', dir: '/ws/wt' })
    mocks.agent.diff.mockReturnValueOnce({ commit: 'reviewed', base: 'merge-base', into: 'main', stat: 'vendor/sub | 2 +-', patch: '', submodules: ['vendor/sub'], leftOut: [], blocked })
    const { executeClientTool } = await load()
    const result = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'reviewed' }, makeCtx().ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain(ja('jobs.merging.submodules', { paths: 'vendor/sub', branch: 'asist/x', dir: '/ws/wt' }))
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expect(mocks.agent.merge).not.toHaveBeenCalled()
  })

  it('refuses to merge a job with nothing to merge before asking the user about it', async () => {
    mocks.agent.userJob.mockReturnValueOnce({ id: 'w1', title: 'fix', worktree: { repo: '/repo', branch: 'asist/x', base: 'abc', commit: 'reviewed' } } as never)
    mocks.agent.diff.mockReturnValueOnce({ commit: 'reviewed', base: 'merge-base', into: 'main', stat: '', patch: '', submodules: [], leftOut: [], blocked: errorText('jobs.merging.noChanges', { id: 'w1' }) })
    const { executeClientTool } = await load()
    const result = await executeClientTool('merge_agent_job', { jobId: 'w1', commit: 'reviewed' }, makeCtx().ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain(ja('jobs.merging.noChanges', { id: 'w1' }))
    expect(result.content).not.toContain('。。')
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expect(mocks.agent.merge).not.toHaveBeenCalled()
  })

  it('starts an approved read-only job on an existing repository and keeps its permission, without asking git about the folder', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const result = await executeClientTool('run_agent_task', { prompt: '調べて', cwd: '/repo', readonly: true }, ctx)
    expect(result.isError).toBe(false)
    expect(mocks.agent.isGitRepo).not.toHaveBeenCalled()
    expect((mocks.requestConfirm.mock.calls[0][0] as { detail: string }).detail).toContain(ja('jobs.confirm.readOnly'))
    expect(mocks.agent.start).toHaveBeenCalledWith('調べて', expect.objectContaining({ cwd: '/repo', readonly: true }))
    expect(mocks.agent.startIsolated).not.toHaveBeenCalled()
  })

  it('starts an approved writing job outside a git repository in place, without asking a second time', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const result = await executeClientTool('run_agent_task', { prompt: '直して', cwd: '/Users/me/Documents', readonly: false }, ctx)
    expect(JSON.parse(result.content)).toMatchObject({ started: true, jobId: 'j1' })
    expect(mocks.requestConfirm).toHaveBeenCalledOnce()
    expect(mocks.agent.start).toHaveBeenCalledWith('直して', expect.objectContaining({ cwd: '/Users/me/Documents', readonly: false }))
    expect(mocks.agent.startIsolated).not.toHaveBeenCalled()
  })

  it('returns a failed result for a tool name that is not registered', async () => {
    const { executeClientTool } = await load()
    const { ctx } = makeCtx()
    const result = await executeClientTool('show_nothing', {}, ctx)
    expect(result.isError).toBe(true)
  })
})

describe('the tool list in the language of the conversation', () => {
  const JAPANESE = /[぀-ヿ一-鿿]/

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.settings.conversationLocale = 'ja-JP'
  })

  /** Every description in a tool spec: the tool's own and every one nested anywhere in its input schema. */
  function descriptions(spec: { name: string; description: string; inputSchema: unknown }): string[] {
    const found = [spec.description]
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'description' && typeof value === 'string') found.push(value)
        else walk(value)
      }
    }
    walk(spec.inputSchema)
    return found
  }

  /**
   * What a schema decides, with every text that was written in both languages blanked out. A string
   * that resolves to something other than itself is such a text; everything else is a rule.
   */
  function rules(node: unknown): unknown {
    if (typeof node === 'string') return resolvePromptTexts(node, 'ja') === node ? node : '<both languages>'
    if (Array.isArray(node)) return node.map(rules)
    if (!node || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, rules(value)]))
  }

  const listFor = async (locale: string) => {
    mocks.settings.conversationLocale = locale
    const { tools, toolGuide } = await load()
    return { specs: tools(), guide: toolGuide() }
  }

  it.each(['en-US', 'hi-IN'])('writes every name, description and usage of the list in English for %s', async (locale) => {
    const { specs, guide } = await listFor(locale)
    const japanese = specs.flatMap((spec) =>
      [spec.name, ...descriptions(spec)].filter((text) => JAPANESE.test(text)).map((text) => `${spec.name}: ${text}`)
    )
    expect(japanese).toEqual([])
    expect(guide).not.toMatch(JAPANESE)
  })

  it('leaves no description empty in either language, so no tool loses its documentation', async () => {
    const japanese = await listFor('ja-JP')
    const english = await listFor('en-US')
    for (const { specs } of [japanese, english]) {
      expect(specs.flatMap((spec) => descriptions(spec).filter((text) => !text.trim()))).toEqual([])
    }
    // The Japanese list is the one the model has always been given, so it still reads as Japanese.
    expect(japanese.specs.every((spec) => JAPANESE.test(spec.description))).toBe(true)
  })

  it('keeps one schema per tool, so what makes a call valid never depends on the language', async () => {
    const { toolRegistry } = await load()
    const japanese = toolRegistry('ja-JP').definitions
    const english = toolRegistry('hi-IN').definitions
    expect(english.map((def) => def.name)).toEqual(japanese.map((def) => def.name))
    for (const [index, def] of english.entries()) {
      expect(rules(def.inputSchema)).toEqual(rules(japanese[index].inputSchema))
    }
  })

  it('rejects and accepts the same panel input in both languages, and says so in that language', async () => {
    mocks.settings.conversationLocale = 'ja-JP'
    const ja = await load()
    const badJa = await ja.executeClientTool('show_timer', { seconds: 'abc' }, makeCtx().ctx)
    const goodJa = await ja.executeClientTool('show_map', { place: '東京駅' }, makeCtx().ctx)
    vi.resetModules()
    mocks.settings.conversationLocale = 'en-US'
    const en = await load()
    const badEn = await en.executeClientTool('show_timer', { seconds: 'abc' }, makeCtx().ctx)
    const goodEn = await en.executeClientTool('show_map', { place: '東京駅' }, makeCtx().ctx)
    expect([badJa.isError, badEn.isError]).toEqual([true, true])
    expect([goodJa.isError, goodEn.isError]).toEqual([false, false])
    expect(badJa.content).toMatch(JAPANESE)
    expect(badEn.content).not.toMatch(JAPANESE)
  })

  it.each(['ja-JP', 'en-US'])('describes the task statuses in %s with the words list_tasks returns in statusLabel', async (locale) => {
    mocks.settings.conversationLocale = locale
    const { toolRegistry } = await load()
    const description = toolRegistry(locale).find('list_tasks')!.description[locale === 'ja-JP' ? 'ja' : 'en']
    const task = { id: 'a', title: 'x', notes: '', status: 'doing' as const, due: null, order: 0, createdAt: 0, updatedAt: 0, completedAt: null }
    expect(description).toContain(`doing=${taskSummary(task, locale === 'ja-JP' ? 'ja' : 'en').statusLabel}`)
  })

  it('hands the fetcher one plain city name when show_clock names none, in the language of the conversation', async () => {
    mocks.fetchPanel.mockResolvedValue({ props: {}, source: 'x' })
    mocks.settings.conversationLocale = 'ja-JP'
    const ja = await load()
    await ja.executeClientTool('show_clock', {}, makeCtx().ctx)
    expect(mocks.fetchPanel).toHaveBeenLastCalledWith('clock', { city: '東京' }, expect.any(AbortSignal))
    vi.resetModules()
    mocks.settings.conversationLocale = 'en-US'
    const en = await load()
    await en.executeClientTool('show_clock', {}, makeCtx().ctx)
    expect(mocks.fetchPanel).toHaveBeenLastCalledWith('clock', { city: 'Tokyo' }, expect.any(AbortSignal))
  })

  /**
   * A tool's description is not the only thing the model reads: so is what comes back. A word of
   * Japanese inside a result reads to the model as an instruction to answer in Japanese, so every
   * tool that can answer without a network call is run here, once as it succeeds and once as it
   * fails, and its result is searched.
   */
  it('words the result of every tool that answers offline in English, a failure included', async () => {
    mocks.settings.conversationLocale = 'en-US'
    mocks.tasks.list.mockResolvedValue([
      { id: 't1', title: 'Buy milk', notes: '', status: 'todo', due: '2026-09-21', order: 0, createdAt: 0, updatedAt: 0, completedAt: null }
    ])
    const { executeClientTool } = await load()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_tasks', {}],
      ['add_task', { title: '' }],
      ['update_task', { id: 'nope', status: 'done' }],
      ['remove_task', { id: 'nope' }],
      ['list_tasks', { card: true }],
      ['show_timer', { seconds: 0 }],
      ['get_agent_job', { jobId: 'nope' }],
      ['show_agent_job', { jobId: 'nope' }],
      ['resolve_project', { name: 'nope' }],
      ['no_such_tool', {}]
    ]
    const japanese: string[] = []
    for (const [name, input] of calls) {
      const result = await executeClientTool(name, input, makeCtx().ctx)
      if (JAPANESE.test(result.content)) japanese.push(`${name}: ${result.content}`)
    }
    // The weather of Japan comes from a table of Japanese municipalities, which a conversation in
    // another language still reaches whenever the region is Japan. The place names it returns are
    // data of Japan; what has to be English is the instruction that comes with them.
    for (const location of ['東京', '府中市']) {
      const result = await executeClientTool('show_weather', { location }, makeCtx().ctx)
      const hint = (JSON.parse(result.content) as { hint: string }).hint
      if (JAPANESE.test(hint)) japanese.push(`show_weather ${location}: ${hint}`)
    }
    mocks.requestConfirm.mockResolvedValueOnce(false)
    const declined = await executeClientTool('run_agent_task', { prompt: 'Tidy the README' }, makeCtx().ctx)
    if (JAPANESE.test(declined.content)) japanese.push(`run_agent_task declined: ${declined.content}`)
    expect(japanese).toEqual([])
  })

  it('follows a change of the language between turns instead of keeping the list it was first built with', async () => {
    const { tools, toolGuide } = await load()
    const first = JSON.stringify(tools())
    mocks.settings.conversationLocale = 'en-US'
    expect(JSON.stringify(tools())).not.toBe(first)
    expect(toolGuide()).not.toMatch(JAPANESE)
    mocks.settings.conversationLocale = 'ja-JP'
    expect(JSON.stringify(tools())).toBe(first)
  })
})

describe('the search cards of a turn', () => {
  it('puts up one card per search, with the Search Suggestions when the provider sends them', async () => {
    const { SearchCards } = await load()
    const { ctx, events } = makeCtx()
    const cards = new SearchCards(ctx)
    cards.publish('最新ニュース', [{ url: 'https://a.example', title: 'A', site: 'a.example' }], '<div class="container"></div>')
    cards.publish('明日の天気', [])
    expect(events).toEqual([
      expect.objectContaining({
        type: 'panel',
        event: expect.objectContaining({
          op: 'create',
          key: 'search:最新ニュース',
          props: { query: '最新ニュース', results: [{ url: 'https://a.example', title: 'A', site: 'a.example' }], suggestions: '<div class="container"></div>' }
        })
      })
    ])
  })

  it('marks the sources the answer cites on the card that lists them, moves them to the top, and leaves the other cards alone', async () => {
    const { SearchCards } = await load()
    const { ctx, events } = makeCtx()
    const cards = new SearchCards(ctx)
    cards.publish('最新ニュース', [
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: 'B' }
    ])
    cards.publish('明日の天気', [{ url: 'https://c.example', title: 'C' }])
    events.length = 0
    cards.cite([{ url: 'https://b.example', title: 'B', cited: true, snippet: '引用した文' }])
    expect(events).toEqual([
      {
        type: 'panel',
        turnId: 1,
        event: {
          op: 'patch',
          key: 'search:最新ニュース',
          props: {
            query: '最新ニュース',
            results: [
              { url: 'https://b.example', title: 'B', cited: true, snippet: '引用した文' },
              { url: 'https://a.example', title: 'A' }
            ]
          }
        }
      }
    ])
  })
})
