import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mitt from 'mitt'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmEvent } from '@shared/confirm'
import type { AgentJob, TurnEvent, TurnPlaybackAckStatus } from '@shared/ipc'
import type { ConversationMessage, ConversationPart, ConversationResult, NativeOutput, SearchEvent, StopReason } from '@shared/conversation'
import { marker } from '@shared/conversation-markers'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { lastRoundNote } from '@shared/tool-round'
import { interruptedBeforeReply, interruptedWhileSpeaking, resumeAfterDisconnectNote } from '@shared/turn-recovery'
import { InterjectPlaybackAcks } from '@/interject-playback'
import { DEMO_WEATHER_TOKYO } from '@/demo/fixtures/weather'

const LAST_ROUND_NOTE = lastRoundNote('ja-JP')
const INTERRUPTED_BEFORE_REPLY = interruptedBeforeReply('ja-JP')
const INTERRUPTED_WHILE_SPEAKING = interruptedWhileSpeaking('ja-JP')
const RESUME_AFTER_DISCONNECT_NOTE = resumeAfterDisconnectNote('ja-JP')

/**
 * These tests run a whole brain turn against a fake conversation stream in place of the llm service and a fake TTS,
 * so that resuming after a disconnect, the history after an interruption, the round limit and the conversation log
 * are exercised together.
 */

type Handler = (...args: unknown[]) => void

interface RoundEmitter {
  /** Streams the chunks as deltas and closes the text block. */
  text: (...chunks: string[]) => void
  /** Streams a delta without closing the block, as for a sentence cut off midway. */
  textDelta: (chunk: string) => void
  toolUse: (id: string, name: string, input: Record<string, unknown>) => void
  /** Reports the progress of a web search that runs on the provider's side, inside the same response. */
  search: (event: SearchEvent) => void
  /** Rejects once the caller aborts the turn, and never resolves otherwise. */
  untilAborted: () => Promise<never>
}

/**
 * A round that returns `usage: null` finished without the provider's usage, as a Cerebras stream cut after its finish
 * reason does. `native` is the provider's own output the response carries beside its parts.
 */
type RoundScript = (round: RoundEmitter) => Promise<{ stop?: StopReason; usage?: null; native?: NativeOutput }>

const USAGE = { input: 100, cacheRead: 900, cacheCreation: 0, output: 20 }

class FakeStream {
  private readonly handlers = new Map<string, Handler[]>()
  private readonly parts: ConversationPart[] = []
  private openText = ''
  constructor(
    private readonly script: RoundScript,
    private readonly signal: AbortSignal | undefined
  ) {}

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  snapshot(): ConversationMessage | null {
    const parts = [...this.parts]
    if (this.openText) parts.push({ type: 'text', text: this.openText })
    return parts.length > 0 ? { role: 'assistant', parts } : null
  }

  async final(): Promise<ConversationResult> {
    const emitter: RoundEmitter = {
      text: (...chunks) => {
        for (const chunk of chunks) this.fire('text', chunk)
        this.parts.push({ type: 'text', text: chunks.join('') })
      },
      textDelta: (chunk) => {
        this.openText += chunk
        this.fire('text', chunk)
      },
      toolUse: (id, name, input) => {
        const call = { type: 'tool_call' as const, id, name, input }
        this.parts.push(call)
        this.fire('toolCall', call)
      },
      search: (event) => this.fire('search', event),
      untilAborted: () =>
        new Promise<never>((_, reject) => {
          const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
          if (this.signal?.aborted) abort()
          else this.signal?.addEventListener('abort', abort, { once: true })
        })
    }
    const partial = await this.script(emitter)
    return {
      message: { role: 'assistant', parts: [...this.parts], ...(partial.native ? { native: partial.native } : {}) },
      stop: partial.stop ?? 'end',
      usage: partial.usage === null ? null : USAGE
    }
  }
}

const mocks = vi.hoisted(() => ({
  userData: '',
  rounds: [] as RoundScript[],
  requests: [] as Array<{ messages: ConversationMessage[]; system: Array<{ text: string }>; tools: unknown }>,
  /** The language each sentence was handed to the voice in. */
  voiceLocales: [] as string[],
  fetchPanel: vi.fn(),
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US',
  key: 'test-key' as string | undefined,
  ttsEngine: 'voicevox',
  /** Holds every synthesis until the turn is aborted, as a slow speech engine does. */
  holdSynthesis: false,
  /** The agent jobs as the agent service keeps them. */
  jobs: new Map<string, AgentJob>(),
  contextBlock: (): string | null => null,
  workClip: async (): Promise<unknown> => null
}))

vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/store', () => ({
  dataPath: (...parts: string[]) => path.join(mocks.userData, ...parts)
}))
vi.mock('../src/main/services/llm', () => ({
  providerKey: () => mocks.key,
  completeText: vi.fn(async (): Promise<{ text: string; stop: StopReason }> => ({ text: '', stop: 'end' })),
  streamConversation: (request: { messages: ConversationMessage[]; system: Array<{ text: string }>; tools: unknown; signal?: AbortSignal }) => {
    mocks.requests.push({ messages: structuredClone(request.messages), system: request.system, tools: request.tools })
    const script = mocks.rounds.shift()
    if (!script) throw new Error('no scripted round left')
    return new FakeStream(script, request.signal)
  }
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({
    uiLocale: 'ja-JP',
    conversationLocale: mocks.conversationLocale,
    region: 'JP',
    persona: '',
    ttsEngine: mocks.ttsEngine,
    conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
    bridgeModel: { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
    conversationLogRetentionDays: 30,
    agentMode: 'readonly',
    agentEngine: 'claude'
  })
}))
// The approval gate shows its sheet in the window that is there.
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => ({ isDestroyed: () => false, isVisible: () => true }), getAllWindows: () => [] }
}))
vi.mock('../src/main/services/tts', () => ({
  nextRequest: (waiting: readonly string[]) => ({ text: waiting[0], count: 1 }),
  synthesizeSentence: async (_text: string, locale: string, signal?: AbortSignal) => {
    mocks.voiceLocales.push(locale)
    if (mocks.holdSynthesis) {
      await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
    return { kind: 'whole', audio: null, phonemes: null }
  }
}))
vi.mock('../src/main/services/agent', () => ({
  events: mitt(),
  contextBlock: () => mocks.contextBlock(),
  findActive: () => undefined,
  start: vi.fn(),
  get: (id: string) => mocks.jobs.get(id),
  userJob: vi.fn(),
  list: () => [],
  getLog: () => [],
  cancel: vi.fn(),
  continueJob: vi.fn(),
  isGitRepo: () => false,
  workspaceRoot: () => '/work/asist-jobs',
  startIsolated: vi.fn(),
  merge: vi.fn(),
  discard: vi.fn()
}))
vi.mock('../src/main/services/aizuchi', () => ({ randomClip: () => mocks.workClip() }))
vi.mock('../src/main/services/memory', () => ({
  promptBlock: () => null,
  list: () => [{ id: 'm1', file: 'pages/中野.md', line: 3, kind: 'section', page: '中野', heading: '要約', aliases: [], text: '最寄り駅は中野', date: '2026-09-01', order: 0 }],
  search: vi.fn(() => [])
}))
vi.mock('../src/main/services/panel-fetchers', () => ({ fetchPanel: mocks.fetchPanel }))
vi.mock('../src/main/services/user-local-data', () => ({ getLocalDataService: () => ({}) }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => ({}) }))
vi.mock('../src/main/services/timers', () => ({ create: vi.fn() }))

type Brain = typeof import('../src/main/services/brain')

async function loadBrain(): Promise<{ brain: Brain; events: TurnEvent[] }> {
  const brain = await import('../src/main/services/brain')
  const events: TurnEvent[] = []
  brain.events.on('event', (event) => events.push(event))
  return { brain, events }
}

/** The history derived from the conversation log, which is the messages sent with the next request. */
async function historyMessages(): Promise<ConversationMessage[]> {
  const { history } = await import('../src/main/services/brain/session')
  return history.toMessages()
}

const textOf = (message: ConversationMessage): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
const said = (text: string): ConversationMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] })

function runToDone(brain: Brain, text: string): Promise<number> {
  return new Promise((resolve) => {
    brain.events.on('event', (event) => {
      if (event.type === 'done' && event.turnId === turnId) resolve(turnId)
    })
    const turnId = brain.startTurn(text)
  })
}

const FINISHED_JOB = { id: 'j1', title: '調査', status: 'done', summary: '完了した' } as AgentJob

/** A job that has finished, as the agent service keeps it and announces it. */
async function finishJob(job: AgentJob = FINISHED_JOB): Promise<void> {
  mocks.jobs.set(job.id, job)
  const agent = await import('../src/main/services/agent')
  agent.events.emit('event', { type: 'update', job })
}

/** The renderer's side of the playback acknowledgement, fed with brain's events the way conversation.ts feeds it. */
function acknowledgeLikeTheRenderer(brain: Brain, acknowledgePlayback: (turnId: number, status: TurnPlaybackAckStatus) => void): void {
  const acks = new InterjectPlaybackAcks(async (turnId, status) => { acknowledgePlayback(turnId, status) })
  brain.events.on('event', (e) => {
    if (e.type === 'started' && e.origin === 'interject') acks.track(e.turnId)
    if (e.type === 'segment' && acks.markSegmentQueued(e.segment)) acks.markSegmentStarted(e.segment)
    if (e.type === 'done') acks.finishTurn(e.turnId)
  })
}

const readLog = (): Array<Record<string, unknown>> => {
  const dir = path.join(mocks.userData, 'conversations')
  const [file] = fs.readdirSync(dir)
  return fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const lastUserParts = (request: { messages: ConversationMessage[] }): ConversationPart[] => request.messages.at(-1)!.parts

/** The tool calls with no result in the message right after them, which the API refuses with a 400. */
function unansweredCalls(messages: ConversationMessage[]): string[] {
  return messages.flatMap((message, i) => {
    if (message.role !== 'assistant') return []
    const next = messages[i + 1]
    return message.parts.flatMap((part) =>
      part.type === 'tool_call' && !(next?.role === 'user' && next.parts.some((p) => p.type === 'tool_result' && p.callId === part.id)) ? [part.id] : []
    )
  })
}

/** The assistant messages that carry nothing, which the Messages API refuses anywhere but at the end with a 400. */
const withoutContent = (messages: ConversationMessage[]): ConversationMessage[] =>
  messages.filter((message) => message.role === 'assistant' && message.parts.length === 0)

const spokenIn = (events: TurnEvent[]): string[] => events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))
const shownIn = (events: TurnEvent[]): string => events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')

const weatherPanel = { props: { location: '東京都', date: 'tomorrow', weather: DEMO_WEATHER_TOKYO }, source: 'test' }

describe('brain turn', () => {
  // The first import of the brain transforms its whole module graph, and the imports after vi.resetModules
  // reuse that work. It took 399 ms alone but 5762 ms while `npm run demo:fit` kept three headless
  // Chromes busy (10-core Mac, 2026-09-24), which timed out whichever test came first. Importing once here moves
  // that cost into a hook with a timeout of its own.
  beforeAll(async () => {
    await import('../src/main/services/brain')
  }, 30_000)

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // clearAllMocks keeps implementations, so fetchPanel is reset explicitly: an implementation that only settles on
    // abort would otherwise block the next test.
    mocks.fetchPanel.mockReset()
    mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-brain-'))
    mocks.rounds = []
    mocks.requests = []
    mocks.voiceLocales = []
    mocks.conversationLocale = 'ja-JP'
    mocks.key = 'test-key'
    mocks.ttsEngine = 'voicevox'
    mocks.holdSynthesis = false
    mocks.jobs = new Map()
    mocks.contextBlock = () => null
    mocks.workClip = async () => null
  })

  it('speaks the reply of a normal turn, keeps it in the history and the conversation log, and reports usage in metrics', async () => {
    mocks.rounds.push(async (round) => {
      round.text('明日は', '晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')

    expect(events.filter((e) => e.type === 'segment').map((e) => e.type === 'segment' && e.segment.text)).toEqual(['明日は晴天です。'])
    const messages = await historyMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const today = new Date()
    const weekday = '日月火水木金土'[today.getDay()]
    expect(textOf(messages[0])).toMatch(
      new RegExp(`^\\[${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}\\(${weekday}\\) \\d\\d:\\d\\d\\] 明日の天気は$`)
    )
    // The history keeps exactly the shape that was sent to the API.
    expect(messages[1]).toEqual(said('明日は晴天です。'))
    const usage = events.find((e) => e.type === 'metrics' && 'inputTokens' in e.timings)
    expect(usage).toMatchObject({ timings: { inputTokens: 100, cacheReadTokens: 900, contextTokens: 1000, rounds: 1, toolCalls: 0 } })
    expect(readLog().map((r) => [r.kind, r.text])).toEqual([
      ['user', '明日の天気は'],
      ['messages', undefined],
      ['assistant', '明日は晴天です。']
    ])
    expect(readLog()[1]).toMatchObject({ kind: 'messages', messages: [said('明日は晴天です。')] })
  })

  it('reports no token counts for a turn whose round finished without its usage, and keeps the history estimating its context', async () => {
    mocks.rounds.push(async (round) => {
      round.text('晴天です。')
      return { usage: null }
    })
    const { brain, events } = await loadBrain()
    const { history } = await import('../src/main/services/brain/session')
    await runToDone(brain, '明日の天気は')
    const metrics = events.find((e) => e.type === 'metrics' && 'toolCalls' in e.timings)
    expect(metrics).toMatchObject({ timings: { toolCalls: 0 } })
    expect(metrics && metrics.type === 'metrics' && 'inputTokens' in metrics.timings).toBe(false)
    // A measured context of no tokens would hold off compaction until the next measurement.
    expect(history.contextTokens).toBeGreaterThan(0)
  })

  it('resumes exactly once after a disconnect that happens mid-reply, carrying the confirmed text and the tool results', async () => {
    mocks.fetchPanel.mockResolvedValue({ props: { location: '東京都', weather: { targetDate: '2026-09-16', summary: '晴天' } }, source: 'open-meteo' })
    mocks.rounds.push(async (round) => {
      round.text('調べますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      round.textDelta('少々')
      throw new Error('fetch failed')
    })
    mocks.rounds.push(async (round) => {
      round.text('明日は晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')

    expect(mocks.requests).toHaveLength(2)
    const resumed = mocks.requests[1].messages.slice(-2)
    expect(resumed[0]).toEqual({
      role: 'assistant',
      parts: [
        { type: 'text', text: '調べますね。' },
        { type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } },
        { type: 'text', text: '少々' }
      ]
    })
    expect(resumed[1].role).toBe('user')
    expect(resumed[1].parts[0]).toMatchObject({ type: 'tool_result', callId: 't1', name: 'show_weather' })
    expect(resumed[1].parts.at(-1)).toMatchObject({ type: 'text', text: RESUME_AFTER_DISCONNECT_NOTE })
    // No apology is spoken; only the continuation is.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // The messages added for the resume stay in the history, and the continuation comes last.
    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(textOf(carried[1])).toContain('調べますね。')
    expect(textOf(carried[2])).toContain(RESUME_AFTER_DISCONNECT_NOTE)
    expect(carried.at(-1)).toEqual(said('明日は晴天です。'))
    expect(events.find((e) => e.type === 'metrics' && 'resumed' in e.timings)).toMatchObject({ timings: { resumed: true, rounds: 1 } })
  })

  it('does not resume a second disconnect and reports it as an API failure', async () => {
    mocks.rounds.push(async (round) => {
      round.text('一回目。')
      throw new Error('fetch failed')
    })
    mocks.rounds.push(async (round) => {
      round.text('二回目。')
      throw new Error('fetch failed')
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'x')
    expect(mocks.requests).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    // The first reply was already sent as part of the resume, so only the second one, which was never sent, is kept
    // together with the failure marker.
    const carried = await historyMessages()
    expect(textOf(carried[1])).toContain('一回目。')
    expect(carried.at(-1)).toEqual(said('二回目。(応答が途中で失敗した)'))
  })

  it.each(['non-transient', 'resumed'] as const)('stops tools that have not started on a %s failure and closes the turn after the running one finishes', async (failure) => {
    let finishFetch!: () => void
    let fetchSignal: AbortSignal | undefined
    mocks.fetchPanel.mockImplementation((_type, _props, signal: AbortSignal) => {
      fetchSignal = signal
      return new Promise((resolve) => {
        finishFetch = () => resolve({ props: { location: '東京都', weather: { targetDate: '2026-09-16', summary: '晴天' } }, source: 'test' })
      })
    })
    if (failure === 'resumed') {
      mocks.rounds.push(async (round) => {
        round.text('調べます。')
        throw new Error('fetch failed')
      })
    }
    mocks.rounds.push(async (round) => {
      round.toolUse('weather', 'show_weather', { location: '東京都' })
      round.toolUse('agent', 'run_agent_task', { prompt: '調査を始める' })
      await vi.waitFor(() => expect(fetchSignal).toBeDefined())
      throw failure === 'resumed' ? new Error('fetch failed') : Object.assign(new Error('bad request'), { status: 400 })
    })
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: '天気を調べて、調査も始めて' }, {}, 'user', false)!
    try {
      await vi.waitFor(() => expect(fetchSignal?.aborted).toBe(true))
      expect(events.some((event) => event.type === 'done')).toBe(false)
    } finally {
      finishFetch?.()
      await handle.completion
    }
    const agent = await import('../src/main/services/agent')
    expect(agent.start).not.toHaveBeenCalled()
    const doneIndex = events.findIndex((event) => event.type === 'done')
    expect(doneIndex).toBeGreaterThan(-1)
    expect(events.slice(doneIndex + 1)).toEqual([])
    expect(events.some((event) => event.type === 'panel' && event.event.op === 'patch' && event.event.state === 'ready')).toBe(false)
  })

  it('marks the text that was already spoken when the turn is interrupted mid-reply and keeps it in the history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('明日は晴天で、')
      return round.untilAborted()
    })
    const { brain, events } = await loadBrain()
    const done = new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
    })
    const turnId = brain.startTurn('明日の天気は')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'delta')).toBe(true))
    brain.abortTurn(turnId)
    await done

    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(carried[0])).toContain('明日の天気は')
    expect(carried[1]).toEqual(said(`明日は晴天で、${INTERRUPTED_WHILE_SPEAKING}`))
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: '明日は晴天で、', interrupted: 'while-speaking' })
  })

  it('keeps the user utterance and marks the assistant side when the interruption comes before any reply', async () => {
    mocks.rounds.push(async (round) => round.untilAborted())
    const { brain, events } = await loadBrain()
    const done = new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
    })
    const turnId = brain.startTurn('明日の天気は')
    await vi.waitFor(() => expect(mocks.requests).toHaveLength(1))
    brain.abortTurn(turnId)
    await done

    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(carried[0])).toContain('明日の天気は')
    expect(carried[1]).toEqual(said(INTERRUPTED_BEFORE_REPLY))
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: '', interrupted: 'before-reply' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it.each(['result', 'error'] as const)('moves on without waiting for the earlier memory search when the user rephrases, and keeps a late %s out of the history', async (late) => {
    const memory = await import('../src/main/services/memory')
    let finishSearch!: (hits: Awaited<ReturnType<typeof memory.search>>) => void
    let failSearch!: (error: Error) => void
    const heldSearch = new Promise<Awaited<ReturnType<typeof memory.search>>>((resolve, reject) => {
      finishSearch = resolve
      failSearch = reject
    })
    vi.mocked(memory.search).mockReturnValueOnce(heldSearch)
    mocks.rounds.push(async (round) => { round.text('明後日ですね。'); return {} })
    const { brain, events } = await loadBrain()
    const first = brain.beginTurn({ text: '明日の天気は' }, {}, 'user', false)!
    await vi.waitFor(() => expect(memory.search).toHaveBeenCalledOnce())
    const second = brain.beginTurn({ text: 'あ、明後日で' }, {}, 'user', false)!
    let complete = false
    void second.completion.then(() => { complete = true })
    try {
      await vi.waitFor(() => expect(complete).toBe(true), { timeout: 300 })
      expect(memory.search).toHaveBeenNthCalledWith(1, '明日の天気は', { limit: 8, mode: 'utterance' }, first.signal)
      expect(first.signal.aborted).toBe(true)
      expect(mocks.requests).toHaveLength(1)
      expect(JSON.stringify(mocks.requests[0])).toContain(INTERRUPTED_BEFORE_REPLY)
      expect(readLog().filter((r) => r.kind !== 'messages').map((r) => [r.kind, r.turnId, r.text])).toEqual([
        ['user', first.turnId, '明日の天気は'],
        ['assistant', first.turnId, ''],
        ['user', second.turnId, 'あ、明後日で'],
        ['assistant', second.turnId, '明後日ですね。']
      ])
      const before = readLog()
      if (late === 'result') finishSearch([{ record: memory.list()[0], score: 1, exact: true, via: 'lexical' }])
      else failSearch(new Error('old search failed'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(readLog()).toEqual(before)
      expect((await historyMessages()).map(textOf)).toEqual([
        expect.stringContaining('明日の天気は'), INTERRUPTED_BEFORE_REPLY,
        expect.stringContaining('あ、明後日で'), '明後日ですね。'
      ])
      expect(events.filter((e) => e.type === 'done').map((e) => e.turnId)).toEqual([first.turnId, second.turnId])
      expect(events.some((e) => e.type === 'error')).toBe(false)
    } finally {
      finishSearch([])
      await Promise.all([first.completion, second.completion])
    }
  })

  it('records the input and the failure of a turn that fails while preparing, and closes it with done', async () => {
    const { brain, events } = await loadBrain()
    const { history } = await import('../src/main/services/brain/session')
    vi.spyOn(history, 'needsCompaction').mockImplementationOnce(() => { throw new Error('preparation failed') })
    await runToDone(brain, '予定を教えて')
    expect(mocks.requests).toEqual([])
    expect(readLog()).toMatchObject([
      { kind: 'user', text: '予定を教えて' },
      { kind: 'assistant', text: '', failed: true }
    ])
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it.each(['user', 'notice'] as const)('lets a %s turn proceed over the limit without waiting for compaction, which folds only the turns up to its start', async (kind) => {
    const { brain, events } = await loadBrain()
    const { history, record, LIMIT_TOKENS } = await import('../src/main/services/brain/session')
    const { completeText } = await import('../src/main/services/llm')
    history.ensureLoaded()
    // The 30 most recent turns are kept, so more than that are recorded here.
    for (let i = 0; i < 50; i++) {
      record({ kind: 'user', turnId: 100 + i, text: `以前の質問${i}` })
      record({ kind: 'assistant', turnId: 100 + i, text: `以前の回答${i}` })
    }
    history.noteContextTokens(LIMIT_TOKENS + 1, history.revision)
    let finishSummary!: (text: string) => void
    const heldSummary = new Promise<{ text: string; stop: StopReason }>((resolve) => { finishSummary = (text) => resolve({ text, stop: 'end' }) })
    vi.mocked(completeText).mockReturnValueOnce(heldSummary)
    const input = kind === 'notice'
      ? { text: '作業が完了しました', notice: 'job-done' as const }
      : { text: '明日の天気は' }
    mocks.rounds.push(async (round) => { round.text('はい、進めます。'); return {} })
    const first = brain.beginTurn(input, {}, 'user', false)!
    try {
      // Compaction starts, but the turn sends its request with the current history instead of waiting for the summary.
      await vi.waitFor(() => expect(events.some((e) => e.type === 'done' && e.turnId === first.turnId)).toBe(true), { timeout: 1000 })
      expect(completeText).toHaveBeenCalledOnce()
      expect(mocks.requests).toHaveLength(1)
      expect(mocks.requests[0].messages.length).toBe(101)
      expect(history.summary).toBe('')
    } finally {
      finishSummary('以前の会話の引き継ぎ')
      await Promise.all([first.completion, history.compact('quiet')])
    }
    // The 30 turns that were most recent at the start (20 to 49) and the turns recorded afterwards stay as they are,
    // while turns 0 to 19 become the summary.
    expect(history.summary).toBe('以前の会話の引き継ぎ')
    const log = vi.mocked(completeText).mock.calls[0][3]
    expect(log).toContain('ユーザー: 以前の質問19')
    expect(log).not.toContain('以前の質問20')
    const contents = (await historyMessages()).map(textOf)
    expect(contents).toHaveLength(62)
    expect(contents[0]).toContain('以前の質問20')
    expect(contents.slice(-2)).toEqual([expect.stringContaining(input.text), 'はい、進めます。'])
    const checkpoint = readLog().findLast((r) => r.kind === 'checkpoint')!
    expect(checkpoint.summary).toBe('以前の会話の引き継ぎ')
    expect((checkpoint.records as Array<{ kind: string; turnId: number }>).slice(-3).map((r) => [r.kind, r.turnId])).toEqual([
      [kind, first.turnId], ['messages', first.turnId], ['assistant', first.turnId]
    ])
    // The next turn carries the summary in system and rebuilds the history from what stayed.
    mocks.rounds.push(async (round) => { round.text('了解です。'); return {} })
    await runToDone(brain, '続けて')
    expect(mocks.requests[1].messages.length).toBe(63)
    expect(mocks.requests[1].system.some((block) => block.text.includes('以前の会話の引き継ぎ'))).toBe(true)
  })

  it('answers a turn at the hard limit at once, saying the history is being summarized, and never waits for the summary, even after one fails', async () => {
    const { brain, events } = await loadBrain()
    const { history, record, HARD_LIMIT_TOKENS } = await import('../src/main/services/brain/session')
    const { completeText } = await import('../src/main/services/llm')
    history.ensureLoaded()
    for (let i = 0; i < 50; i++) {
      record({ kind: 'user', turnId: 100 + i, text: `以前の質問${i}` })
      record({ kind: 'assistant', turnId: 100 + i, text: `以前の回答${i}` })
    }
    history.noteContextTokens(HARD_LIMIT_TOKENS + 1_000_000, history.revision)
    let failSummary!: (error: Error) => void
    vi.mocked(completeText).mockReturnValueOnce(new Promise((_, reject) => { failSummary = reject }))
    const said = (turnId: number): string => events.flatMap((e) => (e.type === 'segment' && e.turnId === turnId ? [e.segment.text] : [])).join('')
    const sentence = createTranslator('ja-JP')('spoken.historyFull')

    // The summary is still being written while both of these turns are answered.
    expect(said(await runToDone(brain, '明日の天気は'))).toBe(sentence)
    expect(said(await runToDone(brain, 'まだですか'))).toBe(sentence)
    expect(completeText).toHaveBeenCalledOnce()
    failSummary(new Error('overloaded'))
    await history.compact('quiet')
    // After the failure the next turn starts another summary and is answered without waiting for it either.
    const callsBefore = vi.mocked(completeText).mock.calls.length
    vi.mocked(completeText).mockReturnValueOnce(new Promise(() => {}))
    const third = await runToDone(brain, 'もう一度')
    expect(said(third)).toBe(sentence)
    expect(vi.mocked(completeText).mock.calls.length).toBe(callsBefore + 1)
    expect(mocks.requests).toEqual([])

    // It is the app's reply, shown once as the reply line and not as a failure.
    const ofThird = events.filter((e) => e.turnId === third)
    expect(ofThird.filter((e) => e.type === 'error')).toEqual([])
    expect(ofThird.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toBe(sentence)
    expect(ofThird.at(-1)).toMatchObject({ type: 'done', fullText: sentence })
    // The history holds what was said, so a later model does not read the request as left undone.
    expect(readLog().findLast((r) => r.kind === 'assistant')).toMatchObject({ turnId: third, text: sentence })
    expect(readLog().findLast((r) => r.kind === 'assistant')).not.toHaveProperty('failed')
    expect(textOf(history.toMessages().at(-1)!)).toBe(sentence)
  })

  it('holds a job report at the hard limit, starting no summary and using up no attempt, until a summary succeeds, and then reports the job as it is by then, once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { completeText } = await import('../src/main/services/llm')
    try {
      const { brain, events } = await loadBrain()
      const { conversationLog, history, HARD_LIMIT_TOKENS } = await import('../src/main/services/brain/session')
      const { compactionJob } = await import('../src/main/services/maintenance')
      // The log is on disk and no turn has read it yet, as right after the app starts.
      for (let i = 0; i < 50; i++) {
        conversationLog.append({ kind: 'user', turnId: 100 + i, text: `以前の質問${i}` })
        conversationLog.append({ kind: 'assistant', turnId: 100 + i, text: `以前の回答${i}` })
      }
      history.noteContextTokens(HARD_LIMIT_TOKENS + 1, history.revision)
      // The network is down, so every summary fails at once.
      let online = false
      vi.mocked(completeText).mockImplementation(async () => {
        if (!online) throw new Error('fetch failed')
        return { text: '以前の会話の引き継ぎ', stop: 'end' }
      })
      mocks.rounds.push(async (round) => { round.text('調査が終わりました。'); return {} })
      const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
      acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
      initJobReporting()
      const waitingForMerge = { ...FINISHED_JOB, worktree: { dir: '/w', repo: '/r', branch: 'b', base: 'c' }, mergeState: 'pending' } as AgentJob
      await finishJob(waitingForMerge)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(completeText).not.toHaveBeenCalled()
      // The user throws the changes away from the job panel while the report waits.
      const discarded = { ...waitingForMerge, mergeState: 'discarded' } as AgentJob
      mocks.jobs.set('j1', discarded)
      // The idle compaction fails more times than a report has attempts.
      for (let i = 0; i < 6; i++) {
        await compactionJob.run()
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(mocks.requests).toEqual([])
      online = true
      await compactionJob.run()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mocks.requests).toHaveLength(1)
      const { reportNotice } = await import('../src/main/services/brain/job-reporting')
      expect(textOf(mocks.requests[0].messages.at(-1)!)).toBe(reportNotice(discarded).text)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.requests).toHaveLength(1)
      expect(events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))).toEqual(['調査が終わりました。'])
    } finally {
      vi.mocked(completeText).mockImplementation(async () => ({ text: '', stop: 'end' }))
      vi.useRealTimers()
    }
  })

  /** A history at the hard limit, recorded the way the conversation records it. */
  async function historyAtHardLimit(): Promise<void> {
    const { history, record, HARD_LIMIT_TOKENS } = await import('../src/main/services/brain/session')
    history.ensureLoaded()
    for (let i = 0; i < 50; i++) {
      record({ kind: 'user', turnId: 100 + i, text: `以前の質問${i}` })
      record({ kind: 'assistant', turnId: 100 + i, text: `以前の回答${i}` })
    }
    history.noteContextTokens(HARD_LIMIT_TOKENS + 1, history.revision)
  }

  it('hands a report held at the hard limit to a voice engine that took the conversation over meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const { brain } = await loadBrain()
      await historyAtHardLimit()
      const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
      acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
      initJobReporting()
      await finishJob()
      await vi.advanceTimersByTimeAsync(60_000)
      const { setConversationOwner } = await import('../src/main/services/brain/session')
      const notify = vi.fn(async () => {})
      setConversationOwner({ notify, say: async () => {} })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(notify).toHaveBeenCalledOnce()
      expect(mocks.requests).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a job report while the conversation log cannot be read, and delivers it once the log reads again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const { brain } = await loadBrain()
      const { logFileName } = await import('../src/main/services/brain/conversation-log')
      // A directory in the day file's place fails the read with EISDIR, as a permission error would.
      const dayFile = path.join(mocks.userData, 'conversations', logFileName(new Date()))
      fs.mkdirSync(dayFile, { recursive: true })
      const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
      acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
      initJobReporting()
      mocks.rounds.push(async (round) => { round.text('調査が終わりました。'); return {} })
      await finishJob()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(mocks.requests).toEqual([])
      fs.rmdirSync(dayFile)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.requests).toHaveLength(1)
      const { reportNotice } = await import('../src/main/services/brain/job-reporting')
      expect(textOf(mocks.requests[0].messages.at(-1)!)).toBe(reportNotice(FINISHED_JOB).text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports nothing for a job that is gone by the time the history has room', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const { brain } = await loadBrain()
      await historyAtHardLimit()
      const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
      acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
      initJobReporting()
      mocks.rounds.push(async (round) => { round.text('調査が終わりました。'); return {} })
      await finishJob()
      await vi.advanceTimersByTimeAsync(60_000)
      mocks.jobs.delete('j1')
      const { completeText } = await import('../src/main/services/llm')
      vi.mocked(completeText).mockResolvedValueOnce({ text: '以前の会話の引き継ぎ', stop: 'end' })
      const { compactionJob } = await import('../src/main/services/maintenance')
      await compactionJob.run()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.requests).toEqual([])
      expect(readLog().filter((r) => r.kind === 'notice')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells in the report whether the changes of a job were taken in, thrown away, or are still waiting, and asks only while they wait', async () => {
    await loadBrain()
    const { reportNotice } = await import('../src/main/services/brain/job-reporting')
    const worktree = { dir: '/w', repo: '/r', branch: 'b', base: 'c' }
    const notices = (['pending', 'merged', 'discarded'] as const).map((mergeState) => reportNotice({ ...FINISHED_JOB, worktree, mergeState } as AgentJob).text)
    expect(new Set([...notices, reportNotice(FINISHED_JOB).text]).size).toBe(4)
    expect(notices.map((text) => text.includes('merge_agent_job'))).toEqual([true, false, false])
  })

  it('tells the model which worktree holds the commits of a job that touched a submodule, and offers only the discard', async () => {
    await loadBrain()
    const { reportNotice } = await import('../src/main/services/brain/job-reporting')
    const worktree = { dir: '/w/job-1', repo: '/r', branch: 'asist/b', base: 'c', submodules: ['vendor/sub'] }
    const text = reportNotice({ ...FINISHED_JOB, worktree, mergeState: 'pending' } as AgentJob).text
    for (const value of ['vendor/sub', 'asist/b', '/w/job-1', 'discard_agent_job']) expect(text).toContain(value)
    expect(text).not.toContain('merge_agent_job')
  })

  it('reports a finished job once when its turn takes longer to start speaking than the wait for playback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      mocks.rounds.push(async (round) => {
        // A slow model, or a tool that runs long before the first sentence.
        await new Promise((resolve) => setTimeout(resolve, 4 * 60_000))
        round.text('調査が終わりました。')
        return {}
      })
      for (let i = 0; i < 4; i++) mocks.rounds.push(async (round) => { round.text('調査が終わりました。'); return {} })
      const { brain } = await loadBrain()
      const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
      acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
      initJobReporting()
      await finishJob()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(mocks.requests).toHaveLength(1)
      expect(readLog().filter((r) => r.kind === 'notice')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns tool results in the order of the calls, marks a failure with isError, and logs each tool name and result length', async () => {
    mocks.fetchPanel.mockRejectedValueOnce(new Error('HTTP 503'))
    mocks.rounds.push(async (round) => {
      round.text('見てみますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      round.toolUse('t2', 'recall', { query: '中野' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => {
      round.text('天気は取れませんでした。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '天気と記憶')

    const results = lastUserParts(mocks.requests[1]) as Array<Extract<ConversationPart, { type: 'tool_result' }>>
    expect(results.map((r) => [r.callId, r.name])).toEqual([['t1', 'show_weather'], ['t2', 'recall']])
    expect(results[0]).toMatchObject({ isError: true })
    expect(results[0].content).toContain('HTTP 503')
    expect(results[1].isError).toBeUndefined()
    expect(JSON.parse(results[1].content)).toMatchObject({ count: 0 })
    expect(events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && `${e.name}:${e.status}`)).toEqual(
      expect.arrayContaining(['show_weather:start', 'show_weather:error', 'recall:start', 'recall:done'])
    )
    const toolRecords = readLog().filter((r) => r.kind === 'tool')
    expect(toolRecords.map((r) => r.name).sort()).toEqual(['recall', 'show_weather'])
    expect(toolRecords.find((r) => r.name === 'show_weather')).toMatchObject({ isError: true, input: '{"location":"東京都"}' })
    expect(toolRecords.find((r) => r.name === 'recall')!.resultLength).toBeGreaterThan(10)
    expect(events.find((e) => e.type === 'metrics' && 'toolCalls' in e.timings)).toMatchObject({ timings: { toolCalls: 2, rounds: 2 } })
  })

  it('keeps the tool call and its result from the previous turn in the next request and only appends to the history', async () => {
    mocks.fetchPanel.mockResolvedValueOnce(weatherPanel)
    mocks.rounds.push(async (round) => {
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => {
      round.text('晴天です。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    await runToDone(brain, '東京の天気')
    await runToDone(brain, 'ありがとう')
    const messages = mocks.requests[2].messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(messages[1].parts).toEqual([{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } }])
    // The whole result comes back, its last day included.
    expect(JSON.stringify(messages[2].parts)).toContain('2026-09-22(火)')
    expect(messages[3]).toEqual(said('晴天です。'))
    // The messages sent in the previous turn become the prefix of the next request unchanged.
    expect(messages.slice(0, 4)).toEqual([...mocks.requests[1].messages.slice(0, 3), said('晴天です。')])
  })

  it('appends an injected memory to the last user message, keeps it on the user record and in the history, and does not inject it again while it is still in the raw window', async () => {
    const { search } = await import('../src/main/services/memory')
    const hit = { via: 'lexical', exact: true, record: { id: 'm1', file: 'pages/中野.md', line: 3, kind: 'section', page: '中野', heading: '要約', aliases: [], text: '最寄り駅', date: '2026-09-01', order: 0 } }
    ;(search as unknown as ReturnType<typeof vi.fn>).mockReturnValue([hit])
    mocks.rounds.push(async (round) => {
      round.text('中野ですね。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('十分くらいです。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '最寄り駅どこだっけ')
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain('最寄り駅どこだっけ')
    expect(sent.endsWith('\n\n[記憶]\n# 中野\n\n## 要約\n最寄り駅')).toBe(true)
    // The note and the memory id stay on the user record of the conversation log and do not mix into the text.
    const logged = readLog().find((r) => r.kind === 'user')
    expect(logged).toMatchObject({ text: '最寄り駅どこだっけ', memoryIds: ['m1'] })
    expect(String(logged?.notes)).toBe('[記憶]\n# 中野\n\n## 要約\n最寄り駅')
    // In the history the note follows the text as well, so it matches what the model read.
    expect(textOf((await historyMessages())[0])).toContain('最寄り駅どこだっけ\n\n[記憶]\n# 中野\n\n## 要約\n最寄り駅')

    await runToDone(brain, '駅まで歩いて何分')
    expect(textOf(mocks.requests[1].messages.at(-1)!)).not.toContain('[記憶]')
    // The note of the previous turn is still sent as part of the history.
    expect(JSON.stringify(mocks.requests[1].messages[0])).toContain('# 中野')
    const injected = events
      .filter((e): e is Extract<TurnEvent, { type: 'metrics' }> => e.type === 'metrics' && 'injectedMemories' in e.timings)
      .map((e) => e.timings.injectedMemories)
    expect(injected).toEqual([1, 0])
  })

  it('appends the typed-input note to the last user message and keeps it in the same shape, so the prefix does not change', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('テスト', { typed: true })
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain('[注: 文字入力]')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('stamps and annotates the utterance in the conversation language, and says nothing about a backchannel where none plays', async () => {
    mocks.conversationLocale = 'en-US'
    mocks.rounds.push(async (round) => {
      round.text('Sure.')
      return {}
    })
    const { brain } = await loadBrain()
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      // The renderer sends no aizuchi outside Japanese, but it does send the bridge it has already played.
      brain.startTurn('what is the weather', { typed: true, bridge: 'The weather, right.' })
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toMatch(/^\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] what is the weather/)
    expect(sent).toContain(marker('en-US', 'typedInputNote'))
    expect(sent).toContain('the short line "The weather, right."')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('attaches the open mini app to the utterance with the id of what it shows, and keeps it in the history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    const { reportOpenMiniApp } = await import('../src/main/services/mini-app-view')
    reportOpenMiniApp({ app: 'mail', box: 'inbox', accountId: null, query: '', pane: { kind: 'message', id: 'acct:INBOX:42' } })
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('これに返信して')
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain(marker('ja-JP', 'openApp'))
    expect(sent).toContain('acct:INBOX:42')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('says nothing about the screen while only the conversation is open', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    const { reportOpenMiniApp } = await import('../src/main/services/mini-app-view')
    reportOpenMiniApp(null)
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('こんにちは')
    })
    expect(textOf(mocks.requests[0].messages.at(-1)!)).not.toContain(marker('ja-JP', 'openApp'))
  })

  it('reports the cache miss reason as first on the initial turn and as hit on the next one, which only appended history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('一。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('二。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'a')
    await runToDone(brain, 'b')
    const reasons = events
      .filter((e) => e.type === 'metrics' && 'cacheMissReason' in e.timings)
      .map((e) => (e.type === 'metrics' ? e.timings.cacheMissReason : null))
    expect(reasons).toEqual(['first', 'hit'])
  })

  it('adds the note to finish on the next round one round before the limit, and stops with a fixed sentence at the limit', async () => {
    for (let i = 0; i < 6; i++) {
      mocks.rounds.push(async (round) => {
        round.toolUse(`t${i}`, 'recall', { query: '中野' })
        return { stop: 'tool_calls' }
      })
    }
    const { brain, events } = await loadBrain()
    await runToDone(brain, '延々と')

    expect(mocks.requests).toHaveLength(6)
    expect(lastUserParts(mocks.requests[5]).at(-1)).toMatchObject({ type: 'text', text: LAST_ROUND_NOTE })
    expect(lastUserParts(mocks.requests[4]).every((part) => part.type === 'tool_result')).toBe(true)
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: createTranslator('ja-JP')('spoken.turnStopped') })
  })

  /**
   * The sentence is spoken aloud, so it follows the language of the conversation. The interface stays
   * Japanese here, which is what tells a lookup in the wrong dictionary from a right one.
   */
  it('speaks the sentence that ends a turn at the round limit in the language of the conversation', async () => {
    mocks.conversationLocale = 'en-US'
    for (let i = 0; i < 6; i++) {
      mocks.rounds.push(async (round) => {
        round.toolUse(`t${i}`, 'recall', { query: '中野' })
        return { stop: 'tool_calls' }
      })
    }
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'on and on')
    const spoken = createTranslator('en-US')('spoken.turnStopped')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: spoken })
    // What was said is what was sent to the speaker, not only to the screen.
    const segments = events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))
    expect(segments).toContain(spoken)
  })

  it('records an interjected sentence as the assistant in the conversation log', async () => {
    mocks.rounds.push(async (round) => {
      round.text('終わりましたよ。')
      return {}
    })
    const { brain } = await loadBrain()
    // A job completion report starts from an agent event, a path this test cannot drive directly.
    const { interject } = await import('../src/main/services/brain/interject')
    await interject('タイマーが終わりました。')
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: 'タイマーが終わりました。' })
  })

  it('says and records nothing of an interjection that a user turn replaced before it began', async () => {
    mocks.rounds.push(async (round) => { round.text('晴れです。'); return {} })
    const { brain, events } = await loadBrain()
    const { interject } = await import('../src/main/services/brain/interject')
    const interjection = interject('タイマーが終わりました。')
    const turnId = brain.startTurn('明日の天気は')
    await interjection
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done' && e.turnId === turnId)).toBe(true))
    expect(events.filter((e) => e.type === 'started').map((e) => e.type === 'started' && e.origin)).toEqual(['user'])
    expect(readLog().some((r) => r.text === 'タイマーが終わりました。')).toBe(false)
  })

  it('answers the tool call a response finished before the output limit, then asks for the rest, in the request and in the history', async () => {
    mocks.fetchPanel.mockResolvedValue(weatherPanel)
    mocks.rounds.push(async (round) => {
      round.text('調べますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      round.text('東京は')
      return { stop: 'max_tokens' }
    })
    mocks.rounds.push(async (round) => {
      round.text('晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await brain.beginTurn({ text: '東京の天気' }, {}, 'user', false)!.completion
    expect(mocks.requests).toHaveLength(2)
    expect(unansweredCalls(mocks.requests[1].messages)).toEqual([])
    expect(lastUserParts(mocks.requests[1])[0]).toMatchObject({ type: 'tool_result', callId: 't1' })
    // Every later turn sends the same history, so a call stored without its result would fail each of them.
    expect(unansweredCalls(await historyMessages())).toEqual([])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('asks for the rest without sending back a reply whose only part was a tool call the output limit cut off', async () => {
    // The adapter drops a tool call the limit cut off, so nothing of the response is left.
    mocks.rounds.push(async () => ({ stop: 'max_tokens' }))
    mocks.rounds.push(async (round) => { round.text('メモに書きました。'); return {} })
    const { brain } = await loadBrain()
    await runToDone(brain, '長いメモを書いて')
    expect(mocks.requests).toHaveLength(2)
    expect(withoutContent(mocks.requests[1].messages)).toEqual([])
    expect(withoutContent(await historyMessages())).toEqual([])
  })

  it('never sends back the lone reasoning item of a response the output limit cut off before any text, after its tool call was dropped', async () => {
    // OpenAI keeps the reasoning item in the provider's output even when the call after it was cut off and
    // dropped, and a reasoning item with nothing after it is refused when it is sent back.
    const reasoningOnly: NativeOutput = { provider: 'openai', model: 'gpt-5.5', payload: [{ type: 'reasoning', id: 'rs_cut', encrypted_content: 'enc' }] }
    mocks.rounds.push(async () => ({ stop: 'max_tokens', native: reasoningOnly }))
    mocks.rounds.push(async (round) => { round.text('メモに書きました。'); return {} })
    mocks.rounds.push(async (round) => { round.text('はい。'); return {} })
    const { brain } = await loadBrain()
    await runToDone(brain, '長いメモを書いて')
    await runToDone(brain, 'ありがとう')
    expect(mocks.requests).toHaveLength(3)
    for (const request of mocks.requests) {
      expect(withoutContent(request.messages)).toEqual([])
      expect(JSON.stringify(request.messages)).not.toContain('rs_cut')
    }
    expect(JSON.stringify(await historyMessages())).not.toContain('rs_cut')
    expect(readLog().some((r) => JSON.stringify(r).includes('rs_cut'))).toBe(false)
  })

  it('asks the model once to go on after a reply that came back with nothing in it, and keeps no assistant message without content', async () => {
    mocks.rounds.push(async () => ({}))
    mocks.rounds.push(async (round) => { round.text('明日は晴れです。'); return {} })
    mocks.rounds.push(async (round) => { round.text('どういたしまして。'); return {} })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')
    await runToDone(brain, 'ありがとう')
    expect(mocks.requests).toHaveLength(3)
    for (const request of mocks.requests) expect(withoutContent(request.messages)).toEqual([])
    expect(withoutContent(await historyMessages())).toEqual([])
    expect(spokenIn(events)).toEqual(['明日は晴れです。', 'どういたしまして。'])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('ends the turn with a prepared sentence when the reply comes back empty a second time and the turn has neither said nor done anything', async () => {
    mocks.rounds.push(async () => ({}))
    mocks.rounds.push(async () => ({}))
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')
    expect(mocks.requests).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    const carried = await historyMessages()
    expect(withoutContent(carried)).toEqual([])
    expect(carried.at(-1)?.role).toBe('assistant')
  })

  it('ends the turn as it is when a response comes back empty after an earlier round already said the answer', async () => {
    mocks.fetchPanel.mockResolvedValue(weatherPanel)
    mocks.rounds.push(async (round) => {
      round.text('明日の東京は晴れです。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async () => ({}))
    mocks.rounds.push(async (round) => { round.text('明日の東京は晴れです。'); return {} })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')
    expect(mocks.requests).toHaveLength(2)
    expect(spokenIn(events)).toEqual(['明日の東京は晴れです。'])
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(withoutContent(await historyMessages())).toEqual([])
  })

  it('ends the turn quietly when the reply comes back empty twice after a tool ran, rather than invite the user to ask for it again', async () => {
    mocks.fetchPanel.mockResolvedValue(weatherPanel)
    mocks.rounds.push(async (round) => {
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async () => ({}))
    mocks.rounds.push(async () => ({}))
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気を出して')
    expect(mocks.requests).toHaveLength(3)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const carried = await historyMessages()
    expect(withoutContent(carried)).toEqual([])
    expect(carried.at(-1)?.role).toBe('assistant')
  })

  it('appends no request for a reply that would never be sent, when the last round allowed comes back empty', async () => {
    mocks.fetchPanel.mockResolvedValue(weatherPanel)
    for (let i = 0; i < 5; i++) {
      mocks.rounds.push(async (round) => {
        round.toolUse(`t${i}`, 'show_weather', { location: '東京都' })
        return { stop: 'tool_calls' }
      })
    }
    mocks.rounds.push(async () => ({}))
    const { brain, events } = await loadBrain()
    await runToDone(brain, '天気')
    expect(mocks.requests).toHaveLength(6)
    // Every message the turn kept was sent in one of its requests.
    const kept = readLog().flatMap((r) => (r.kind === 'messages' ? (r.messages as ConversationMessage[]) : []))
    const lastSent = mocks.requests.at(-1)!.messages
    expect(lastSent.slice(-kept.length)).toEqual(kept)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('sends a pause response back as it is, even with no text, so the search it holds goes on rather than starting again', async () => {
    // Anthropic pauses a long server-side search and continues it from the paused blocks sent back.
    const paused: NativeOutput = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      payload: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'tokyo marathon' } }]
    }
    mocks.rounds.push(async (round) => {
      round.search({ phase: 'start' })
      return { stop: 'pause', native: paused }
    })
    mocks.rounds.push(async (round) => { round.text('東京マラソンは3月に移りました。'); return {} })
    mocks.rounds.push(async (round) => { round.text('はい。'); return {} })
    const { brain } = await loadBrain()
    await runToDone(brain, '東京マラソンのニュースは')
    await runToDone(brain, 'ありがとう')
    expect(mocks.requests).toHaveLength(3)
    expect(JSON.stringify(mocks.requests[1].messages)).toContain('srvtoolu_1')
    // The answer that followed may refer to the search, so the next turn sends the paused blocks too.
    expect(JSON.stringify(mocks.requests[2].messages)).toContain('srvtoolu_1')
  })

  it.each([
    ['a dropped stream', 'en-US', 'The weather tomorrow will be su', 'nny and warm.'],
    ['the output limit', 'ja-JP', '明日の天気は晴', 'れで暖かいです。']
  ] as const)('reads a sentence that %s cut in the middle of a word as one sentence, without a space in it', async (cut, locale, before, after) => {
    mocks.conversationLocale = locale
    mocks.rounds.push(async (round) => {
      if (cut === 'a dropped stream') {
        round.textDelta(before)
        throw new Error('fetch failed')
      }
      round.text(before)
      return { stop: 'max_tokens' }
    })
    mocks.rounds.push(async (round) => { round.text(after); return {} })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'weather')
    expect(spokenIn(events)).toEqual([`${before}${after}`])
    expect(shownIn(events)).toBe(`${before}${after}`)
  })

  it('never replays a tool call without its result after a restart, even when a line of the log could not be written', async () => {
    mocks.fetchPanel.mockResolvedValue(weatherPanel)
    mocks.rounds.push(async (round) => {
      round.text('見てみますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('明日は晴れです。'); return {} })
    // The disk fills up as the results of the tool are appended, which the log reports and passes over.
    const append = fs.appendFileSync
    vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
      if (typeof data === 'string' && data.includes('"tool_result"')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return append(file, data, options)
    })
    const { brain } = await loadBrain()
    try {
      await runToDone(brain, '明日の天気は')
    } finally {
      vi.mocked(fs.appendFileSync).mockRestore()
    }
    // The app starts again, and a fresh history replays the same log.
    vi.resetModules()
    const { history } = await import('../src/main/services/brain/session')
    history.ensureLoaded()
    const replayed = history.toMessages()
    expect(unansweredCalls(replayed)).toEqual([])
    // The call and its results are gone together, and the rest of the turn stays.
    expect(replayed.map(textOf)).toEqual([expect.stringContaining('明日の天気は'), '明日は晴れです。'])
  })

  it('speaks the sentence said before a slow tool while the tool runs in a language that writes words apart, and keeps it apart from the answer', async () => {
    mocks.conversationLocale = 'en-US'
    let finishFetch!: () => void
    mocks.fetchPanel.mockImplementation(() => new Promise((resolve) => { finishFetch = () => resolve(weatherPanel) }))
    mocks.rounds.push(async (round) => {
      round.text('Let me look that up.')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('It will be sunny tomorrow.'); return {} })
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: 'What is the weather tomorrow?' }, {}, 'user', false)!
    try {
      await vi.waitFor(() => expect(finishFetch).toBeDefined())
      await vi.waitFor(() => expect(spokenIn(events)).toEqual(['Let me look that up.']))
    } finally {
      finishFetch?.()
      await handle.completion
    }
    expect(spokenIn(events)).toEqual(['Let me look that up.', 'It will be sunny tomorrow.'])
    // The screen and the log read the two rounds as two sentences too.
    expect(shownIn(events)).toBe('Let me look that up. It will be sunny tomorrow.')
    expect(events.at(-1)).toMatchObject({ type: 'done', fullText: shownIn(events) })
    expect(readLog().findLast((r) => r.kind === 'assistant')).toMatchObject({ text: shownIn(events) })
  })

  it('speaks the sentence said before a web search while the search runs in a language that writes words apart', async () => {
    mocks.conversationLocale = 'en-US'
    let finishSearch!: () => void
    const searching = new Promise<void>((resolve) => { finishSearch = resolve })
    // The search runs on the provider's side inside the same response, as with Anthropic, OpenAI and Gemini.
    mocks.rounds.push(async (round) => {
      round.text('Let me check the latest news on that.')
      round.search({ phase: 'start' })
      await searching
      round.search({ phase: 'done', query: 'tokyo marathon', sources: [] })
      round.text('The Tokyo Marathon was moved to March.')
      return {}
    })
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: 'Any news about the Tokyo Marathon?' }, {}, 'user', false)!
    try {
      await vi.waitFor(() => expect(spokenIn(events)).toEqual(['Let me check the latest news on that.']))
    } finally {
      finishSearch()
      await handle.completion
    }
    expect(spokenIn(events)).toEqual(['Let me check the latest news on that.', 'The Tokyo Marathon was moved to March.'])
    expect(events.at(-1)).toMatchObject({ type: 'done', fullText: 'Let me check the latest news on that. The Tokyo Marathon was moved to March.' })
  })

  it('closes a turn that has no key for its model with a failed reply in the log, so the utterance counts as answered', async () => {
    mocks.key = undefined
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: '予定を教えて' }, {}, 'user', false)!
    await handle.completion
    expect(mocks.requests).toEqual([])
    expect(events.filter((e) => e.turnId === handle.turnId).map((e) => e.type)).toEqual(['started', 'error', 'done'])
    expect(readLog()).toMatchObject([
      { kind: 'user', turnId: handle.turnId, text: '予定を教えて' },
      { kind: 'assistant', turnId: handle.turnId, failed: true }
    ])
  })

  it('ends the turn with an error and done, and answers the utterance in the log, when building the request fails after the utterance arrived', async () => {
    // The job history is read on first use, and a file the app cannot read makes that throw.
    mocks.contextBlock = () => { throw new Error('jobs.json: unsupported version 3') }
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: '予定を教えて' }, {}, 'user', false)!
    await handle.completion
    expect(mocks.requests).toEqual([])
    expect(events.filter((e) => e.turnId === handle.turnId).map((e) => e.type)).toEqual(['started', 'error', 'done'])
    expect(readLog().map((r) => [r.kind, r.turnId])).toEqual([['user', handle.turnId], ['assistant', handle.turnId]])
  })

  it('reports a finished job once, not once per attempt, when reading aloud is off and no segment plays', async () => {
    for (let i = 0; i < 5; i++) mocks.rounds.push(async (round) => { round.text('調査が終わりました。'); return {} })
    mocks.ttsEngine = 'none'
    const { brain } = await loadBrain()
    const { initJobReporting, acknowledgePlayback } = await import('../src/main/services/brain/job-reporting')
    acknowledgeLikeTheRenderer(brain, acknowledgePlayback)
    initJobReporting()
    await finishJob()
    await vi.waitFor(() => expect(readLog().some((r) => r.kind === 'messages')).toBe(true))
    // A report counted as not delivered goes out again at once, so a second request would have started by now.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(mocks.requests).toHaveLength(1)
    expect(readLog().filter((r) => r.kind === 'notice')).toHaveLength(1)
  })

  it('keeps one copy of a record written before the history was first read, after the records already in the log', async () => {
    const { logFileName } = await import('../src/main/services/brain/conversation-log')
    const dir = path.join(mocks.userData, 'conversations')
    fs.mkdirSync(dir, { recursive: true })
    const t = Date.now() - 60_000
    fs.writeFileSync(
      path.join(dir, logFileName(new Date())),
      [{ t, kind: 'user', turnId: 1, text: '昨日の話' }, { t: t + 1, kind: 'assistant', turnId: 1, text: 'はい。' }].map((r) => JSON.stringify(r)).join('\n') + '\n'
    )
    const { history, record } = await import('../src/main/services/brain/session')
    // Under Gemini Live the notice of a finished job is recorded by job reporting, before any turn read the history.
    record({ kind: 'notice', turnId: 7, notice: 'job-done', text: '[システム通知] ジョブが完了した。' })
    history.ensureLoaded()
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('昨日の話'), 'はい。', '[システム通知] ジョブが完了した。'])
  })

  /**
   * The job status changes every minute while a job runs. Every provider caches the messages behind
   * the system prompt, so the status has to ride on the input for the previous turn to stay cached.
   */
  it('sends the job status with the input only when it changed, leaving the system prompt and the earlier messages as they were', async () => {
    for (const reply of ['まだです。', 'もう少しです。', 'はい。', '終わりました。']) mocks.rounds.push(async (round) => { round.text(reply); return {} })
    const statuses = ['# jobs\n- [j1] running 1 min', '# jobs\n- [j1] running 2 min', '# jobs\n- [j1] running 2 min', null]
    const { brain } = await loadBrain()
    for (const [i, status] of statuses.entries()) {
      mocks.contextBlock = () => status
      await runToDone(brain, `質問${i}`)
    }
    const [first, second, third, fourth] = mocks.requests
    const jobs = marker('ja-JP', 'jobStatus')
    expect(second.system).toEqual(first.system)
    expect(second.messages.slice(0, 2)).toEqual([...first.messages, said('まだです。')])
    expect(textOf(first.messages.at(-1)!)).toContain(`${jobs}\n# jobs\n- [j1] running 1 min`)
    expect(textOf(second.messages.at(-1)!)).toContain(`${jobs}\n# jobs\n- [j1] running 2 min`)
    // The same status is already in the history, so it does not come again.
    expect(textOf(third.messages.at(-1)!)).not.toContain(jobs)
    // Once there is nothing to report, the model is told so instead of going on reading the running job as current.
    expect(textOf(fourth.messages.at(-1)!)).toContain(jobs)
    expect(textOf(fourth.messages.at(-1)!)).not.toContain('[j1]')
  })

  it('speaks the sentence for a failed API call in the language of the conversation, not of the screen', async () => {
    mocks.conversationLocale = 'en-US'
    mocks.rounds.push(async () => { throw Object.assign(new Error('bad request'), { status: 400 }) })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'what is the weather')
    const spoken = events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))
    expect(spoken).toEqual([createTranslator('en-US')('conversation.reply.failed')])
  })

  it('keeps the conversation language it started with for the tools, their errors, the spoken sentences and the voice when the setting changes during the turn', async () => {
    const timedOut = errorText('panels.errors.timedOut')
    mocks.fetchPanel.mockRejectedValueOnce(new Error(timedOut))
    mocks.rounds.push(async (round) => {
      round.text('見てみますね。')
      mocks.conversationLocale = 'en-US'
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async () => { throw Object.assign(new Error('bad request'), { status: 400 }) })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '天気は')

    expect(mocks.requests[1].tools).toEqual(mocks.requests[0].tools)
    const [result] = lastUserParts(mocks.requests[1]) as Array<Extract<ConversationPart, { type: 'tool_result' }>>
    expect(result.content).toContain(readErrorText(timedOut, 'ja-JP'))
    expect(result.content).not.toContain(readErrorText(timedOut, 'en-US'))
    const spoken = events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))
    expect(spoken.at(-1)).toBe(createTranslator('ja-JP')('conversation.reply.failed'))
    expect(new Set(mocks.voiceLocales)).toEqual(new Set(['ja-JP']))
  })

  it('marks the reply as interrupted when the user barges in while its last sentences are still being synthesized', async () => {
    mocks.holdSynthesis = true
    mocks.rounds.push(async (round) => { round.text('明日は晴れです。', '傘はいりません。'); return {} })
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: '明日の天気は' }, {}, 'user', false)!
    // The stream has ended and the turn waits for the synthesis of its sentences.
    await vi.waitFor(() => expect(readLog().some((r) => r.kind === 'messages')).toBe(true))
    brain.abortTurn(handle.turnId)
    await handle.completion
    expect(events.some((e) => e.type === 'segment')).toBe(false)
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', interrupted: 'while-speaking' })
    // The reply itself was already sent, so the history adds the marker after it.
    expect((await historyMessages()).slice(-2)).toEqual([said('明日は晴れです。傘はいりません。'), said(INTERRUPTED_WHILE_SPEAKING)])
  })

  it('finishes the turn without an unhandled rejection when the clip for a slow tool cannot be read', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      mocks.workClip = () => Promise.reject(new Error('clip bank unreadable'))
      let finishFetch!: () => void
      mocks.fetchPanel.mockImplementation(() => new Promise((resolve) => { finishFetch = () => resolve(weatherPanel) }))
      mocks.rounds.push(async (round) => {
        round.toolUse('t1', 'show_weather', { location: '東京都' })
        return { stop: 'tool_calls' }
      })
      mocks.rounds.push(async (round) => { round.text('晴天です。'); return {} })
      const { brain, events } = await loadBrain()
      const handle = brain.beginTurn({ text: '東京の天気' }, {}, 'user', false)!
      await vi.waitFor(() => expect(finishFetch).toBeDefined())
      // A tool that runs past two and a half seconds asks for the filler.
      await vi.advanceTimersByTimeAsync(3000)
      finishFetch()
      await handle.completion
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: 'done', fullText: '晴天です。' })
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it.each([
    ['ja-JP', 'en-US', true],
    ['en-US', 'ja-JP', false]
  ] as const)('covers a slow tool with the work clip only when the language the turn started in (%s) has backchannels, whatever it is switched to (%s)', async (start, switched, plays) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      mocks.conversationLocale = start
      mocks.workClip = async () => ({ text: 'えーっと', category: 'work', weight: 1, audio: 'AAAA' })
      let finishFetch!: () => void
      mocks.fetchPanel.mockImplementation(() => new Promise((resolve) => { finishFetch = () => resolve(weatherPanel) }))
      mocks.rounds.push(async (round) => {
        mocks.conversationLocale = switched
        round.toolUse('t1', 'show_weather', { location: '東京都' })
        return { stop: 'tool_calls' }
      })
      mocks.rounds.push(async (round) => { round.text('晴天です。'); return {} })
      const { brain, events } = await loadBrain()
      const handle = brain.beginTurn({ text: '東京の天気' }, {}, 'user', false)!
      await vi.waitFor(() => expect(finishFetch).toBeDefined())
      await vi.advanceTimersByTimeAsync(3000)
      finishFetch()
      await handle.completion
      await new Promise((resolve) => setImmediate(resolve))
      expect(events.some((e) => e.type === 'segment' && e.segment.text === 'えーっと')).toBe(plays)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a turn the user started open while its confirmation waits through the next words, and takes those up once the approved job has started', async () => {
    mocks.rounds.push(async (round) => {
      round.text('確認画面で承認してください。')
      round.toolUse('t1', 'run_agent_task', { prompt: '調べて', title: '調べもの' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('始めました。終わったら声をかけます。'); return {} })
    const { brain } = await loadBrain()
    const { confirmEvents, resolveConfirm } = await import('../src/main/services/confirm')
    const agent = await import('../src/main/services/agent')
    vi.mocked(agent.start).mockReturnValueOnce({ id: 'j1', title: '調べもの', cwd: '/work/asist-jobs/j1' } as never)
    const confirmations: ConfirmEvent[] = []
    confirmEvents.on('event', (event) => confirmations.push(event))
    const begin = (text: string) => brain.beginTurn({ text }, {}, 'user', false)!

    const asking = begin('調べておいて')
    await vi.waitFor(() => expect(confirmations).toHaveLength(1))
    const opened = confirmations[0] as Extract<ConfirmEvent, { type: 'open' }>
    expect(opened.request.holdsConversation).toBe(true)
    // The user answers out loud: the renderer aborts the turn it was playing and starts the next one.
    brain.abortTurn(asking.turnId)
    const answer = begin('はい')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(confirmations).toHaveLength(1)
    expect(asking.signal.aborted).toBe(false)
    expect(agent.start).not.toHaveBeenCalled()

    resolveConfirm(opened.request.id, true)
    await Promise.all([asking.completion, answer.completion])
    expect(agent.start).toHaveBeenCalledOnce()
    // The asking turn stops once the job has started, and the words said meanwhile are answered from its result.
    expect(asking.signal.aborted).toBe(true)
    expect(mocks.requests).toHaveLength(2)
    const sent = mocks.requests[1].messages
    expect(unansweredCalls(sent)).toEqual([])
    const result = sent.flatMap((message) => message.parts).find((part) => part.type === 'tool_result' && part.callId === 't1')
    expect(JSON.parse((result as Extract<ConversationPart, { type: 'tool_result' }>).content)).toMatchObject({ started: true, jobId: 'j1' })
    expect(textOf(sent.at(-1)!)).toContain('はい')
  })

  it('replies with what came of the answer when a barge-in with no words came while the confirmation waited', async () => {
    mocks.rounds.push(async (round) => {
      round.text('確認画面で承認してください。')
      round.toolUse('t1', 'run_agent_task', { prompt: '調べて', title: '調べもの' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('始めました。'); return {} })
    const { brain, events } = await loadBrain()
    const { confirmEvents, resolveConfirm } = await import('../src/main/services/confirm')
    const agent = await import('../src/main/services/agent')
    vi.mocked(agent.start).mockReturnValueOnce({ id: 'j1', title: '調べもの', cwd: '/work/asist-jobs/j1' } as never)
    const confirmations: ConfirmEvent[] = []
    confirmEvents.on('event', (event) => confirmations.push(event))
    const asking = brain.beginTurn({ text: '調べておいて' }, {}, 'user', false)!
    await vi.waitFor(() => expect(confirmations).toHaveLength(1))
    // The renderer aborts the turn it was playing on a barge-in, and no words follow it.
    brain.abortTurn(asking.turnId)
    resolveConfirm((confirmations[0] as Extract<ConfirmEvent, { type: 'open' }>).request.id, true)
    await asking.completion
    expect(asking.signal.aborted).toBe(false)
    expect(mocks.requests).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'done', turnId: asking.turnId, fullText: expect.stringContaining('始めました。') })
  })

  it('keeps every utterance said while a confirmation waits, in order, and answers the last one', async () => {
    mocks.rounds.push(async (round) => {
      round.text('確認画面で承認してください。')
      round.toolUse('t1', 'run_agent_task', { prompt: '調べて', title: '調べもの' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('明後日の天気ですね。'); return {} })
    const { brain } = await loadBrain()
    const { confirmEvents, resolveConfirm } = await import('../src/main/services/confirm')
    const agent = await import('../src/main/services/agent')
    vi.mocked(agent.start).mockReturnValueOnce({ id: 'j1', title: '調べもの', cwd: '/work/asist-jobs/j1' } as never)
    const confirmations: ConfirmEvent[] = []
    confirmEvents.on('event', (event) => confirmations.push(event))

    const asking = brain.beginTurn({ text: '調べておいて' }, {}, 'user', false)!
    await vi.waitFor(() => expect(confirmations).toHaveLength(1))
    // The user says two things while the sheet is open; the renderer aborts its active turn before each.
    brain.abortTurn(asking.turnId)
    const first = brain.beginTurn({ text: '明日の天気も' }, {}, 'user', false)!
    brain.abortTurn(first.turnId)
    const second = brain.beginTurn({ text: 'あ、明後日で' }, {}, 'user', false)!

    resolveConfirm((confirmations[0] as Extract<ConfirmEvent, { type: 'open' }>).request.id, true)
    await Promise.all([asking.completion, first.completion, second.completion])
    expect(mocks.requests).toHaveLength(2)
    const sent = mocks.requests[1].messages.slice(-3)
    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(textOf(sent[0])).toContain('明日の天気も')
    expect(sent[1]).toEqual(said(INTERRUPTED_BEFORE_REPLY))
    expect(textOf(sent[2])).toContain('あ、明後日で')
    expect(readLog().filter((r) => r.kind === 'user' || r.kind === 'assistant').map((r) => [r.kind, r.turnId, r.text, r.interrupted])).toEqual([
      ['user', asking.turnId, '調べておいて', undefined],
      ['assistant', asking.turnId, '確認画面で承認してください。', 'while-speaking'],
      ['user', first.turnId, '明日の天気も', undefined],
      ['assistant', first.turnId, '', 'before-reply'],
      ['user', second.turnId, 'あ、明後日で', undefined],
      ['assistant', second.turnId, '明後日の天気ですね。', undefined]
    ])
  })

  it('reports a continuation approved in the last seconds of the time limit as started, not as timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      mocks.rounds.push(async (round) => {
        round.toolUse('t1', 'continue_agent_job', { jobId: 'j1', prompt: '続けて' })
        return { stop: 'tool_calls' }
      })
      mocks.rounds.push(async (round) => { round.text('続きを始めました。'); return {} })
      const { brain } = await loadBrain()
      const { confirmEvents, resolveConfirm } = await import('../src/main/services/confirm')
      const agent = await import('../src/main/services/agent')
      vi.mocked(agent.userJob).mockReturnValue({ id: 'j1', title: '調べもの', engine: 'claude', readonly: true, cwd: '/work/asist-jobs/j1', status: 'running' } as never)
      // The running job is stopped before the continuation starts, which takes a few seconds.
      let continued!: () => void
      vi.mocked(agent.continueJob).mockImplementationOnce(() => new Promise((resolve) => {
        continued = () => resolve({ id: 'j2', title: '調べもの(続き)' } as never)
      }))
      const confirmations: ConfirmEvent[] = []
      confirmEvents.on('event', (event) => confirmations.push(event))
      const turn = brain.beginTurn({ text: 'さっきの続きをやって' }, {}, 'user', false)!
      await vi.waitFor(() => expect(confirmations).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(299_000)
      resolveConfirm((confirmations[0] as Extract<ConfirmEvent, { type: 'open' }>).request.id, true)
      await vi.advanceTimersByTimeAsync(3_000)
      continued()
      await turn.completion
      const result = mocks.requests[1].messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'tool_result' && part.callId === 't1') as Extract<ConversationPart, { type: 'tool_result' }>
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(result.content)).toMatchObject({ started: true, jobId: 'j2' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold the conversation for a confirmation that something a tool started asks for after the tool\'s round', async () => {
    mocks.rounds.push(async (round) => {
      round.toolUse('t1', 'run_agent_task', { prompt: '調べて' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => { round.text('始めました。'); return {} })
    mocks.rounds.push(async (round) => { round.text('はい。'); return {} })
    const { brain } = await loadBrain()
    const { confirmEvents, requestConfirm, resolveConfirm } = await import('../src/main/services/confirm')
    const agent = await import('../src/main/services/agent')
    const confirmations: ConfirmEvent[] = []
    confirmEvents.on('event', (event) => confirmations.push(event))
    let jobEnds!: () => void
    let answer!: Promise<boolean>
    // The job's process lives on after the tool, and what it runs later keeps the tool's asynchronous context.
    vi.mocked(agent.start).mockImplementationOnce(() => {
      answer = new Promise<void>((resolve) => { jobEnds = resolve }).then(() =>
        requestConfirm({ title: 't', message: 'm', detail: 'd', confirmLabel: 'ok', destructive: false }, new AbortController().signal)
      )
      return { id: 'j1', title: 'job', cwd: '/work/asist-jobs/j1' } as never
    })
    const started = brain.beginTurn({ text: '調べておいて' }, {}, 'user', false)!
    await vi.waitFor(() => expect(confirmations).toHaveLength(1))
    resolveConfirm((confirmations[0] as Extract<ConfirmEvent, { type: 'open' }>).request.id, true)
    await started.completion

    jobEnds()
    await vi.waitFor(() => expect(confirmations.filter((event) => event.type === 'open')).toHaveLength(2))
    expect(confirmations.at(-1)).toMatchObject({ type: 'open', request: { holdsConversation: false } })
    const next = brain.beginTurn({ text: 'ありがとう' }, {}, 'user', false)!
    await next.completion
    expect(mocks.requests).toHaveLength(3)
    resolveConfirm((confirmations.at(-1) as Extract<ConfirmEvent, { type: 'open' }>).request.id, false)
    await expect(answer).resolves.toBe(false)
  })
})
