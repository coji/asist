import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import type { LiveEvent, TurnEvent } from '@shared/ipc'
import type { ToolExecution, ToolExecutionTask } from '@shared/tool-registry'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import { marker } from '@shared/conversation-markers'
import { buildMemoryInjection, type InjectableMemory } from '@shared/memory-injection'
import type { GeminiConnectParams, GeminiServerMessage, GeminiSession } from '../src/main/services/live/gemini-live'
import { jobStatusNote, stampUserMessage } from '../src/main/services/brain/prompt'

/** These tests drive the Gemini Live engine end to end against a fake session. */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nextTurnId: 200,
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US',
  /** The status of the agent jobs as the engine reads it when a session opens. */
  jobContext: null as string | null,
  /** What connecting waits for before the session arrives, as the socket opening does. */
  connected: Promise.resolve(),
  /** The recent history a session that opens blank is seeded with. */
  history: (): Array<{ role: 'user' | 'assistant'; content: string }> => [{ role: 'user', content: '前の話' }]
}))

vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: mocks.conversationLocale, uiLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/brain/session', () => ({
  record: mocks.record,
  turnScheduler: { allocateTurnId: () => mocks.nextTurnId++ }
}))

class FakeSession implements GeminiSession {
  /** Everything sent to the session, in the order it was sent. */
  readonly sent: Array<{ kind: 'realtime' | 'content' | 'toolResponse'; params: unknown }> = []
  closed = false
  constructor(readonly params: GeminiConnectParams) {}
  get realtime(): unknown[] {
    return this.sent.filter((entry) => entry.kind === 'realtime').map((entry) => entry.params)
  }
  get contents(): unknown[] {
    return this.sent.filter((entry) => entry.kind === 'content').map((entry) => entry.params)
  }
  get toolResponses(): unknown[] {
    return this.sent.filter((entry) => entry.kind === 'toolResponse').map((entry) => entry.params)
  }
  sendRealtimeInput(params: unknown): void {
    this.sent.push({ kind: 'realtime', params })
  }
  sendClientContent(params: unknown): void {
    this.sent.push({ kind: 'content', params })
  }
  sendToolResponse(params: { functionResponses: unknown[] }): void {
    this.sent.push({ kind: 'toolResponse', params })
  }
  close(): void {
    this.closed = true
  }
  message(message: GeminiServerMessage): void {
    this.params.callbacks.onmessage(message)
  }
}

type ExecuteTool = (name: string, input: Record<string, unknown>, ctx: { signal: AbortSignal }) => ToolExecutionTask

const result = (content: string): ToolExecution => ({ content, isError: false, durationMs: 1, resultLength: content.length, truncated: false })

const CAFE: InjectableMemory = { id: 'm-cafe', kind: 'section', page: '行きつけ', heading: 'いつもの店', text: '中野のカフェ', date: '' }
/** The note the engine sends and records for the memory above. */
const CAFE_NOTE = buildMemoryInjection([CAFE], { locale: 'ja-JP' })!.text

/** A tool call whose answer and work have both ended. */
const finished = (content: string): ToolExecutionTask => Object.assign(Promise.resolve(result(content)), { completion: Promise.resolve() })

async function setup(execute?: ExecuteTool): Promise<{
  engine: import('../src/main/services/live/gemini-live').GeminiLiveEngine
  sessions: FakeSession[]
  events: LiveEvent[]
  turnEvents: TurnEvent[]
  executeTool: ReturnType<typeof vi.fn>
  findMemories: ReturnType<typeof vi.fn>
  recordTool: ReturnType<typeof vi.fn>
}> {
  const { GeminiLiveEngine } = await import('../src/main/services/live/gemini-live')
  const sessions: FakeSession[] = []
  const events: LiveEvent[] = []
  const turnEvents: TurnEvent[] = []
  const executeTool = vi.fn(execute ?? ((name: string) => finished(`{"shown":true,"panel":"${name}"}`)))
  const recordTool = vi.fn()
  const findMemories = vi.fn(async (text: string): Promise<InjectableMemory[]> => (text.includes('いつもの') ? [CAFE] : []))
  const engine = new GeminiLiveEngine(LIVE_ENGINE_INFO['gemini-live'], {
    settings: () => ({ liveIdleSeconds: 30, geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' } }) as never,
    apiKey: () => 'key',
    connect: async (params) => {
      // The session exists from the call on, so that a test can deliver messages before connecting
      // resolves, as the SDK does with those that come with setupComplete.
      const session = new FakeSession(params)
      sessions.push(session)
      await mocks.connected
      return session
    },
    systemInstruction: () => 'SYSTEM',
    jobContext: () => mocks.jobContext,
    functionDeclarations: () => [{ name: 'show_weather', parametersJsonSchema: { type: 'object' }, behavior: 'NON_BLOCKING' }],
    executeTool: executeTool as never,
    // The show_ tools only read, as in the registry; every other name stands for a tool that writes.
    isParallel: (name) => name.startsWith('show_'),
    recordTool,
    findMemories,
    memoryBlock: () => '',
    recordNote: (turnId, text, memoryIds) => mocks.record({ kind: 'note', turnId, text, memoryIds }),
    recordUser: (turnId, text) => mocks.record({ kind: 'user', turnId, text }),
    history: () => mocks.history(),
    emitTurn: (event) => turnEvents.push(event)
  })
  engine.events.on('event', (event) => events.push(event))
  await engine.start()
  return { engine, sessions, events, turnEvents, executeTool, findMemories, recordTool }
}

/** A tool call that runs until the test ends it, as one waiting for approval does. `finish` ends its work as well. */
function held(): { task: ToolExecutionTask; answer: (content: string) => void; finish: () => void } {
  let answer!: (content: string) => void
  let finish!: () => void
  const response = new Promise<ToolExecution>((resolve) => (answer = (content) => resolve(result(content))))
  const completion = new Promise<void>((resolve) => (finish = resolve))
  return { task: Object.assign(response, { completion }), answer, finish }
}

/** Seconds of the model's voice as Gemini sends it, base64 PCM16 at 24 kHz. */
const voice = (seconds: number): string => Buffer.from(new Int16Array(24_000 * seconds).buffer).toString('base64')

/** How a notice sent at `at` begins: the stamp of that time, then the notice marker. */
const noticeAt = (at: Date): string => stampUserMessage('ja-JP', marker('ja-JP', 'systemNotice'), at)

/** The note a session was given as it opened: the last turn of the first content it was sent, which asks for no reply. */
function openingNote(session: FakeSession): string {
  const first = session.contents[0] as { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }
  expect(first.turnComplete).toBe(false)
  expect(first.turns.at(-1)!.role).toBe('user')
  return first.turns.at(-1)!.parts[0].text
}

const responseIds = (session: FakeSession): string[] =>
  session.toolResponses.map((response) => (response as { functionResponses: Array<{ id: string }> }).functionResponses[0].id)

async function open(engine: { activity: (a: boolean) => void }, sessions: FakeSession[]): Promise<FakeSession> {
  engine.activity(true)
  await vi.advanceTimersByTimeAsync(0)
  const session = sessions[sessions.length - 1]
  session.message({ setupComplete: {} })
  await vi.advanceTimersByTimeAsync(0)
  return session
}

describe('GeminiLiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.record.mockClear()
    mocks.nextTurnId = 200
    mocks.conversationLocale = 'ja-JP'
    mocks.jobContext = null
    mocks.connected = Promise.resolve()
    mocks.history = () => [{ role: 'user', content: '前の話' }]
  })
  afterEach(() => vi.useRealTimers())

  it('feeds the recent history into a new session as context and sends audio as 16 kHz PCM', async () => {
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    expect(session.params).toMatchObject({ model: 'gemini-3.8-live', voice: 'Kore', systemInstruction: 'SYSTEM', resumptionHandle: null })
    expect(session.contents[0]).toEqual({
      turns: [{ role: 'user', parts: [{ text: '前の話' }] }, { role: 'user', parts: [{ text: expect.stringContaining(noticeAt(new Date())) }] }],
      turnComplete: false
    })
    engine.pushAudio(new Float32Array(160))
    expect(session.realtime[0]).toMatchObject({ audio: { mimeType: 'audio/pcm;rate=16000' } })
    await engine.stop()
    expect(session.realtime.at(-1)).toEqual({ audioStreamEnd: true })
    expect(session.closed).toBe(true)
  })

  it('starts a turn for a function call, runs the tool, answers with WHEN_IDLE, and closes the turn on turnComplete', async () => {
    const { engine, sessions, turnEvents, executeTool } = await setup()
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'c1', name: 'show_weather', args: { location: '大阪' } }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenCalledWith('show_weather', { location: '大阪' }, expect.objectContaining({ turnId: 200 }))
    expect(session.toolResponses).toEqual([
      { functionResponses: [{ id: 'c1', name: 'show_weather', response: { result: '{"shown":true,"panel":"show_weather"}' }, scheduling: 'WHEN_IDLE' }] }
    ])
    expect(turnEvents.map((e) => e.type)).toEqual(['started', 'tool', 'tool'])
    expect(turnEvents[0]).toEqual({ type: 'started', turnId: 200, origin: 'live' })
    session.message({ serverContent: { outputTranscription: { text: '大阪は快晴です。' } } })
    session.message({ serverContent: { turnComplete: true } })
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 200, text: '大阪は快晴です。' })
    expect(turnEvents.at(-1)).toEqual({ type: 'done', turnId: 200, fullText: '大阪は快晴です。' })
    await engine.stop()
  })

  it('records the user transcript once it is finished and adds the related memory without asking for a reply', async () => {
    const { engine, sessions, events, findMemories } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの' } } })
    session.message({ serverContent: { inputTranscription: { text: '店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'user', turnId: 200, text: 'いつもの店を教えて' })
    expect(events.at(-1)).toMatchObject({ type: 'userTranscript', text: 'いつもの店を教えて', final: true })
    expect(findMemories).toHaveBeenCalledWith('いつもの店を教えて')
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: CAFE_NOTE }] }], turnComplete: false })
    // The note is recorded on the utterance's turn, which keeps its memories in the history brain reads.
    expect(mocks.record).toHaveBeenLastCalledWith({ kind: 'note', turnId: 200, text: CAFE_NOTE, memoryIds: ['m-cafe'] })
    await engine.stop()
  })

  it('shows a memory again to a session that opened blank, though an earlier session was shown it, and not to one that resumed', async () => {
    const { engine, sessions } = await setup()
    const notes = (session: FakeSession): number => session.contents.filter((content) => JSON.stringify(content).includes(CAFE.text)).length
    const first = await open(engine, sessions)
    first.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes(first)).toBe(1)
    // The session goes idle and closes before the provider gave a resumption handle.
    await vi.advanceTimersByTimeAsync(31_000)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBeNull()
    second.message({ serverContent: { inputTranscription: { text: 'いつもの店は何時まで', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes(second)).toBe(1)
    second.message({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    const third = await open(engine, sessions)
    expect(third.params.resumptionHandle).toBe('h2')
    third.message({ serverContent: { inputTranscription: { text: 'いつもの店の場所', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes(third)).toBe(0)
    await engine.stop()
  })

  it('shows a memory again after resuming from a handle issued before the note that showed it, and not one shown before the handle', async () => {
    const STATION: InjectableMemory = { id: 'm-station', kind: 'section', page: '行きつけ', heading: '最寄り駅', text: '中野駅の北口', date: '' }
    const { engine, sessions, findMemories } = await setup()
    findMemories.mockImplementation(async (text: string) => [...(text.includes('いつもの') ? [CAFE] : []), ...(text.includes('駅') ? [STATION] : [])])
    const shown = (session: FakeSession, memory: InjectableMemory): number =>
      session.contents.filter((content) => JSON.stringify(content).includes(memory.text)).length
    const first = await open(engine, sessions)
    first.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    first.message({ serverContent: { inputTranscription: { text: '駅からの道は', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(first, STATION)).toBe(1)
    // The model starts generating, which the provider offers no handle for, and the connection drops.
    first.message({ sessionResumptionUpdate: { resumable: false } })
    first.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBe('h1')
    second.message({ serverContent: { inputTranscription: { text: 'いつもの店から駅まで', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(second, STATION)).toBe(1)
    expect(shown(second, CAFE)).toBe(0)
    await engine.stop()
  })

  it('shows a memory again once the session has had more audio since it than its sliding window can be assumed to keep', async () => {
    const { engine, sessions } = await setup()
    const notes = (session: FakeSession): number => session.contents.filter((content) => JSON.stringify(content).includes(CAFE.text)).length
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店は混んでる', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes(session)).toBe(1)
    // Ten minutes of audio reach the session, which its context compression may have cut the note from.
    for (let i = 0; i < 60; i++) engine.pushAudio(new Float32Array(160_000))
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店は何時まで', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes(session)).toBe(2)
    await engine.stop()
  })

  it('shows no memory that a recall result already gave the session', async () => {
    const recalled: ToolExecution = { ...result('{"hits":[{"id":"m-cafe"}]}'), value: { hits: [{ id: 'm-cafe' }] } }
    const { engine, sessions } = await setup(() => Object.assign(Promise.resolve(recalled), { completion: Promise.resolve() }))
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'r', name: 'recall', args: { query: '店' } }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['r'])
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.contents.some((content) => JSON.stringify(content).includes(CAFE.text))).toBe(false)
    await engine.stop()
  })

  it('shows a memory once when the searches of two utterances end together', async () => {
    const { engine, sessions, findMemories } = await setup()
    const searches: Array<(memories: InjectableMemory[]) => void> = []
    findMemories.mockImplementation(() => new Promise((resolve) => searches.push(resolve)))
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店まで何分', finished: true } } })
    expect(searches).toHaveLength(2)
    for (const resolve of searches) resolve([CAFE])
    await vi.advanceTimersByTimeAsync(0)
    expect(session.contents.filter((content) => JSON.stringify(content).includes(CAFE.text))).toHaveLength(1)
    expect(mocks.record.mock.calls.filter((c) => c[0].kind === 'note')).toHaveLength(1)
    await engine.stop()
  })

  it('records no memory note when the session closed before the note was ready, since no model read it', async () => {
    const { engine, sessions, findMemories } = await setup()
    let ready!: (memories: InjectableMemory[]) => void
    findMemories.mockImplementationOnce(() => new Promise((resolve) => (ready = resolve)))
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await engine.stop()
    ready([CAFE])
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.record.mock.calls.map((c) => c[0].kind)).toEqual(['user'])
    expect(session.contents.some((content) => JSON.stringify(content).includes(CAFE.text))).toBe(false)
  })

  it('tells the renderer about an interruption, keeps what was spoken, and sends typed text and notices as text turns', async () => {
    const { engine, sessions, events } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { outputTranscription: { text: '長い説明を' } } })
    const mark = events.length
    session.message({ serverContent: { interrupted: true } })
    expect(events.filter((e) => e.type === 'interrupted')).toHaveLength(1)
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 200, text: '長い説明を' })
    // The final transcript comes before the interrupted event: if it arrived after the renderer had
    // closed the line, the same sentence would be shown twice.
    expect(events.slice(mark).map((e) => e.type)).toEqual(['assistantTranscript', 'interrupted'])
    const before = events.length
    await engine.sendText('こんにちは')
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'user', turnId: 201, text: 'こんにちは' })
    // The renderer already shows what was typed, so no transcript event repeats it.
    expect(events.slice(before).some((e) => e.type === 'userTranscript')).toBe(false)
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: '[文字入力] こんにちは' }] }], turnComplete: true })
    await engine.notify({ notice: 'job-done', text: '[システム通知] ジョブが完了した' })
    expect(session.contents.at(-1)).toEqual({
      turns: [{ role: 'user', parts: [{ text: stampUserMessage('ja-JP', '[システム通知] ジョブが完了した', new Date()) }] }],
      turnComplete: true
    })
    await engine.stop()
  })

  it('stamps a job report with the time it is sent, so a report long after the session opened is not read at the time it opened', async () => {
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(first.closed).toBe(true)
    const reportedAt = new Date(2026, 9, 2, 11, 30)
    vi.setSystemTime(reportedAt)
    const report = '[システム通知] ジョブ「調査」(jobId: j1)が完了した。'
    const notified = engine.notify({ notice: 'job-done', text: report })
    await vi.advanceTimersByTimeAsync(0)
    const resumed = sessions.at(-1)!
    expect(resumed.params.resumptionHandle).toBe('h1')
    resumed.message({ setupComplete: {} })
    await notified
    // The session is told the time as it opens, before the report.
    expect(resumed.contents).toEqual([
      { turns: [{ role: 'user', parts: [{ text: expect.stringContaining(noticeAt(reportedAt)) }] }], turnComplete: false },
      { turns: [{ role: 'user', parts: [{ text: stampUserMessage('ja-JP', report, reportedAt) }] }], turnComplete: true }
    ])
    await engine.stop()
  })

  it('gives a session that opens blank for a job report the report once, after a history that does not hold it, and records the reply on its turn', async () => {
    // The history is read from what was recorded, as the app derives it from the conversation log.
    mocks.history = () => [
      { role: 'user', content: '前の話' },
      ...mocks.record.mock.calls.map(([recorded]: [{ kind: string; text: string }]) => ({
        role: recorded.kind === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: recorded.text
      }))
    ]
    const { engine, sessions } = await setup()
    const report = '[システム通知] ジョブ「調査」(jobId: j1)が完了した。'
    const notified = engine.notify({ notice: 'job-done', text: report })
    await vi.advanceTimersByTimeAsync(0)
    const [session] = sessions
    expect(session.params.resumptionHandle).toBeNull()
    session.message({ setupComplete: {} })
    await notified
    const texts = session.contents.flatMap((content) => (content as { turns: Array<{ parts: Array<{ text: string }> }> }).turns.map((turn) => turn.parts[0].text))
    expect(texts.filter((text) => text.includes(report))).toEqual([stampUserMessage('ja-JP', report, new Date())])
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'notice', turnId: 200, notice: 'job-done', text: report })
    session.message({ serverContent: { outputTranscription: { text: '調査が終わりました。' } } })
    session.message({ serverContent: { turnComplete: true } })
    expect(mocks.record).toHaveBeenLastCalledWith({ kind: 'assistant', turnId: 200, text: '調査が終わりました。' })
    await engine.stop()
  })

  it('stamps a notice that comes minutes into an open session with the time it is sent, not the time the session opened', async () => {
    const openedAt = new Date(2026, 9, 2, 10, 0)
    vi.setSystemTime(openedAt)
    const call = held()
    const { engine, sessions } = await setup(() => call.task)
    const session = await open(engine, sessions)
    // A call waiting for approval keeps the session open past its idle time.
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(sessions).toEqual([session])
    expect(session.closed).toBe(false)
    const report = '[システム通知] ジョブ「調査」(jobId: j1)が完了した。'
    await engine.notify({ notice: 'job-done', text: report })
    const sentAt = new Date(openedAt.getTime() + 7 * 60_000)
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: stampUserMessage('ja-JP', report, sentAt) }] }], turnComplete: true })
    call.finish()
    await engine.stop()
  })

  it('marks typed text and a sentence to read out with the markers of the conversation language', async () => {
    mocks.conversationLocale = 'en-US'
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    await engine.sendText('hello')
    expect(session.contents.at(-1)).toEqual({
      turns: [{ role: 'user', parts: [{ text: `${marker('en-US', 'typedInput')} hello` }] }],
      turnComplete: true
    })
    await engine.say('Three minutes are up.')
    const spoken = (session.contents.at(-1) as { turns: Array<{ parts: Array<{ text: string }> }> }).turns[0].parts[0].text
    expect(spoken.startsWith(stampUserMessage('en-US', marker('en-US', 'systemNotice'), new Date()))).toBe(true)
    expect(spoken).toContain('Three minutes are up.')
    expect(spoken).not.toMatch(/[぀-ヿ一-鿿]/)
    await engine.stop()
  })

  it('passes a resumption handle when it reopens the session and feeds no history then, only the time', async () => {
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(first.closed).toBe(true)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBe('h1')
    expect(second.contents).toEqual([{ turns: [{ role: 'user', parts: [{ text: expect.stringContaining(noticeAt(new Date())) }] }], turnComplete: false }])
    await engine.stop()
  })

  it('tells each session the time it opens at, a resumed one included, since a resumed session keeps the instruction it first opened with', async () => {
    const openedAt = new Date(2026, 9, 2, 10, 0)
    vi.setSystemTime(openedAt)
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    expect(openingNote(first).startsWith(noticeAt(openedAt))).toBe(true)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    const resumedAt = new Date(2026, 9, 2, 11, 30)
    vi.setSystemTime(resumedAt)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBe('h1')
    expect(openingNote(second).startsWith(noticeAt(resumedAt))).toBe(true)
    await engine.stop()
  })

  it('tells a session the job status as it opens, and a resumed one only what changed since it last read the status', async () => {
    mocks.jobContext = 'JOBS: survey running 3 min'
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    const shown = jobStatusNote('ja-JP', 'JOBS: survey running 3 min', null)!
    expect(openingNote(first)).toContain(shown)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    // Nothing changed: the resumed session already read this status.
    const second = await open(engine, sessions)
    expect(openingNote(second)).not.toContain(shown)
    second.message({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    mocks.jobContext = 'JOBS: survey done 1 min ago'
    const third = await open(engine, sessions)
    const changed = jobStatusNote('ja-JP', 'JOBS: survey done 1 min ago', shown)!
    expect(openingNote(third)).toContain(changed)
    third.message({ sessionResumptionUpdate: { newHandle: 'h3', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    // The jobs are gone, which a session that read them is told once rather than left reading the old status.
    mocks.jobContext = null
    const fourth = await open(engine, sessions)
    expect(openingNote(fourth)).toContain(jobStatusNote('ja-JP', null, changed)!)
    await engine.stop()
  })

  it('tells a session that opens blank the whole job status, whatever an earlier session read', async () => {
    mocks.jobContext = 'JOBS: survey running 3 min'
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    // The session goes idle and closes before the provider gave a resumption handle.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(first.closed).toBe(true)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBeNull()
    expect(openingNote(second)).toContain(jobStatusNote('ja-JP', 'JOBS: survey running 3 min', null)!)
    await engine.stop()
  })

  it('tells a session that resumed with the status unchanged, and resumes again once the jobs are gone, that they are gone', async () => {
    mocks.jobContext = 'JOBS: survey running 3 min'
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    const shown = jobStatusNote('ja-JP', 'JOBS: survey running 3 min', null)!
    expect(openingNote(first)).toContain(shown)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    const second = await open(engine, sessions)
    expect(openingNote(second)).not.toContain(shown)
    second.message({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    mocks.jobContext = null
    const third = await open(engine, sessions)
    expect(openingNote(third)).toContain(jobStatusNote('ja-JP', null, shown)!)
    await engine.stop()
  })

  it('tells a session resumed from a handle the job status that handle carried, not what a later session that issued no handle read', async () => {
    mocks.jobContext = 'JOBS: survey running 3 min'
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    const running = jobStatusNote('ja-JP', 'JOBS: survey running 3 min', null)!
    mocks.jobContext = 'JOBS: survey done 1 min ago'
    const second = await open(engine, sessions)
    const done = jobStatusNote('ja-JP', 'JOBS: survey done 1 min ago', running)!
    expect(openingNote(second)).toContain(done)
    // The provider ends the session before it offers a handle, so the next one resumes from h1 again,
    // which never read that the job was done.
    second.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    const third = await open(engine, sessions)
    expect(third.params.resumptionHandle).toBe('h1')
    expect(openingNote(third)).toContain(done)
    await engine.stop()
  })

  it('ties a handle that comes with setupComplete, before connecting resolves, to the job status the new session reads', async () => {
    mocks.jobContext = 'JOBS: survey running 3 min'
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    const running = jobStatusNote('ja-JP', 'JOBS: survey running 3 min', null)!
    mocks.jobContext = 'JOBS: survey done 1 min ago'
    let connect!: () => void
    mocks.connected = new Promise((resolve) => (connect = resolve))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const second = sessions[1]
    second.message({ setupComplete: {} })
    second.message({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } })
    connect()
    await vi.advanceTimersByTimeAsync(0)
    const done = jobStatusNote('ja-JP', 'JOBS: survey done 1 min ago', running)!
    expect(openingNote(second)).toContain(done)
    second.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    const third = await open(engine, sessions)
    expect(third.params.resumptionHandle).toBe('h2')
    // h2 came from a session that read that the job was done, so a session resumed from it is not told again.
    expect(openingNote(third).startsWith(noticeAt(new Date()))).toBe(true)
    expect(openingNote(third)).not.toContain(done)
    await engine.stop()
  })

  it('gives a session its opening note before the audio of the speech that opened it', async () => {
    const { engine, sessions } = await setup()
    // The start of speech opens the session, and what is heard while it connects goes out once it is open.
    engine.activity(true)
    engine.pushAudio(new Float32Array(1600))
    await vi.advanceTimersByTimeAsync(0)
    const session = sessions[0]
    engine.pushAudio(new Float32Array(1600))
    session.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.sent.map((entry) => entry.kind)).toEqual(['content', 'realtime', 'realtime'])
    expect(session.sent[0].params).toEqual(session.contents[0])
    expect(openingNote(session).startsWith(noticeAt(new Date()))).toBe(true)
    await engine.stop()
  })

  it('keeps the conversation log in user then assistant order even when the input transcript arrives late', async () => {
    const { engine, sessions, events } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { outputTranscription: { text: '今日は雨だよ。' } } })
    session.message({ serverContent: { inputTranscription: { text: '今日の天気' } } })
    session.message({ serverContent: { turnComplete: true } })
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'user', turnId: 200, text: '今日の天気' },
      { kind: 'assistant', turnId: 200, text: '今日は雨だよ。' }
    ])
    expect(events.filter((e) => e.type === 'userTranscript').map((e) => e.type === 'userTranscript' && [e.turnId, e.final])).toEqual([[200, false], [200, true]])
    await engine.stop()
  })

  it('answers a timed-out write at once, and holds a write from a later message until the earlier one has stopped working', async () => {
    const first = held()
    const { engine, sessions, executeTool } = await setup((name) => (name === 'run_agent_task' ? first.task : finished('archived')))
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    first.answer('run_agent_task timed out')
    // A NON_BLOCKING call can arrive while an earlier write is still working.
    session.message({ toolCall: { functionCalls: [{ id: 'b', name: 'change_mail', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['a'])
    expect(executeTool).toHaveBeenCalledTimes(1)
    first.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenLastCalledWith('change_mail', {}, expect.anything())
    expect(responseIds(session)).toEqual(['a', 'b'])
    await engine.stop()
  })

  it('lets a later write run once a write that ignores its abort has had its time to stop, rather than holding every write for good', async () => {
    const { createToolRegistry, executeTool, STOP_GRACE_MS } = await import('@shared/tool-registry')
    const tool = (name: string, run: () => Promise<unknown>) => ({
      name,
      description: { ja: name, en: name },
      inputSchema: { type: 'object' as const, properties: {} },
      parallel: false,
      timeoutMs: 1000,
      maxResultChars: 500,
      run
    })
    const registry = createToolRegistry([tool('run_agent_task', () => new Promise(() => {})), tool('change_mail', async () => 'archived')])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { engine, sessions } = await setup((name, input, ctx) => executeTool(registry, name, input, undefined, ctx.signal, 'ja'))
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(1000)
    session.message({ toolCall: { functionCalls: [{ id: 'b', name: 'change_mail', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    expect(responseIds(session)).toEqual(['a', 'b'])
    errors.mockRestore()
    await engine.stop()
  })

  it('answers the model with an error and marks the tool failed when the tool throws before it returns its task', async () => {
    const { engine, sessions, turnEvents } = await setup(() => {
      throw new Error('settings unreadable')
    })
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.toolResponses).toEqual([
      { functionResponses: [{ id: 'a', name: 'run_agent_task', response: { error: 'settings unreadable' }, scheduling: 'WHEN_IDLE' }] }
    ])
    expect(turnEvents.filter((event) => event.type === 'tool').map((event) => event.type === 'tool' && event.status)).toEqual(['start', 'error'])
    await engine.stop()
  })

  it('does not run a call that Gemini cancels while it waits for its turn', async () => {
    const first = held()
    const { engine, sessions, executeTool } = await setup(() => first.task)
    const session = await open(engine, sessions)
    session.message({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'run_agent_task', args: {} },
          { id: 'b', name: 'change_mail', args: {} }
        ]
      }
    })
    session.message({ toolCallCancellation: { ids: ['b'] } })
    first.answer('started')
    first.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(responseIds(session)).toEqual(['a'])
    await engine.stop()
  })

  it('records a call Gemini cancels after its operation started, and tells Gemini that it started', async () => {
    const unfinished = { ...result('change_mail は実行を始めたが、結果を待つのを打ち切った。'), isError: true, unfinished: true }
    const { engine, sessions, recordTool } = await setup((_name, _input, ctx) =>
      Object.assign(new Promise<ToolExecution>((resolve) => ctx.signal.addEventListener('abort', () => resolve(unfinished))), {
        completion: new Promise<void>(() => {})
      }))
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'change_mail', args: { operation: 'archive' } }] } })
    await vi.advanceTimersByTimeAsync(0)
    session.message({ toolCallCancellation: { ids: ['a'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(recordTool).toHaveBeenCalledWith(expect.any(Number), 'change_mail', { operation: 'archive' }, unfinished)
    expect(session.toolResponses).toEqual([])
    const told = (session.contents.at(-1) as { turns: Array<{ parts: Array<{ text: string }> }> }).turns[0].parts[0].text
    expect(told.startsWith(stampUserMessage('ja-JP', marker('ja-JP', 'systemNotice'), new Date()))).toBe(true)
    expect(told).toContain(unfinished.content)
    await engine.stop()
  })

  it('keeps the session open while a function call waits for approval, and closes it once the result is back and the conversation is quiet', async () => {
    const call = held()
    let signal: AbortSignal | null = null
    const { engine, sessions } = await setup((_name, _input, ctx) => {
      signal = ctx.signal
      return call.task
    })
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    // The idle close is 30 seconds in this setup, and a confirmation may wait for five minutes.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(session.closed).toBe(false)
    expect(signal!.aborted).toBe(false)
    call.answer('approved')
    call.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(session.closed).toBe(true)
    await engine.stop()
  })

  it('keeps the session open while the reply that arrived is still playing, and closes it once the reply has played and the conversation is quiet', async () => {
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    // Gemini sends a reply faster than it plays: a minute of it arrives at once.
    session.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice(60), mimeType: 'audio/pcm;rate=24000' } }] } } })
    await vi.advanceTimersByTimeAsync(55_000)
    expect(session.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000 + 31_000)
    expect(session.closed).toBe(true)
    await engine.stop()
  })

  it('counts the quiet from the end of a short reply that arrives late in the idle time', async () => {
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    // The idle close is 30 seconds in this setup.
    await vi.advanceTimersByTimeAsync(28_300)
    session.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice(0.4), mimeType: 'audio/pcm;rate=24000' } }] } } })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(session.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(28_000)
    expect(session.closed).toBe(true)
    await engine.stop()
  })

  it('counts the quiet from an interruption, since the renderer drops the rest of the reply then', async () => {
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice(60), mimeType: 'audio/pcm;rate=24000' } }] } } })
    session.message({ serverContent: { interrupted: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(session.closed).toBe(true)
    await engine.stop()
  })

  it('reports the usage of the audio sent after the last reply when the session closes and when the engine stops', async () => {
    const { engine, sessions, events } = await setup()
    const sessionSeconds = (): number | undefined => events.flatMap((event) => (event.type === 'usage' ? [event.usage.sessionSeconds] : [])).at(-1)
    await open(engine, sessions)
    for (let second = 0; second < 10; second++) engine.pushAudio(new Float32Array(16_000))
    sessions[0].message({ serverContent: { turnComplete: true } })
    expect(sessionSeconds()).toBe(10)
    // The session stays open, and billed, until the conversation has been quiet for the idle time.
    for (let second = 0; second < 5; second++) engine.pushAudio(new Float32Array(16_000))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sessions[0].closed).toBe(true)
    expect(sessionSeconds()).toBe(15)
    await open(engine, sessions)
    for (let second = 0; second < 20; second++) engine.pushAudio(new Float32Array(16_000))
    await engine.stop()
    expect(sessionSeconds()).toBe(35)
  })

  it('closes a session whose setup did not complete in time, and plays nothing it sends afterwards', async () => {
    const { engine, sessions } = await setup()
    const audio: Float32Array[] = []
    engine.events.on('audio', (samples) => audio.push(samples))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    expect(sessions[0].closed).toBe(true)
    sessions[0].message({ setupComplete: {} })
    sessions[0].message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([0, 64]).toString('base64'), mimeType: 'audio/pcm' } }] } } })
    expect(audio).toHaveLength(0)
    await engine.stop()
  })

  it('stops at once while a session is still opening, closes it when it arrives, and reports no error', async () => {
    let connect!: () => void
    mocks.connected = new Promise((resolve) => (connect = resolve))
    const { engine, sessions, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = engine.stop().then(() => (stopped = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(true)
    expect(engine.state).toBe('off')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions[0].closed).toBe(true)
    await stopping
  })

  it('closes a session that arrives only after its opening already failed', async () => {
    let connect!: () => void
    mocks.connected = new Promise((resolve) => (connect = resolve))
    const { engine, sessions } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions[0].closed).toBe(true)
    await engine.stop()
  })

  it('opens a new session at once when the provider ends one while the user is speaking, and waits for the next speech when the user is silent', async () => {
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    first.params.callbacks.onclose('session time limit')
    // What the user says meanwhile goes into the pre-roll and is sent first once the next session is set up.
    engine.pushAudio(new Float32Array(1600))
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(2)
    const second = sessions[1]
    expect(second.params.resumptionHandle).toBe('h1')
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.state).toBe('open')
    expect(second.realtime).toHaveLength(1)
    engine.activity(false)
    second.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(2)
    expect(engine.state).toBe('idle')
    await engine.stop()
  })

  it('reports an error once: as the failure to connect before the setup, and as an error after it', async () => {
    const t = createTranslator('ja-JP')
    const { engine, sessions, events } = await setup()
    // The screen words each message as the renderer does.
    const errors = (): string[] => events.flatMap((e) => (e.type === 'error' ? [readErrorText(e.message, 'ja-JP') ?? e.message] : []))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sessions[0].params.callbacks.onerror(new Error('quota exceeded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors()).toEqual([t('voice.live.connectFailed', { detail: 'quota exceeded' })])
    const session = await open(engine, sessions)
    session.params.callbacks.onerror(new Error('quota exceeded'))
    expect(errors().slice(1)).toEqual(['quota exceeded'])
    await engine.stop()
  })

  it('reports no usage for a session that never opened, since it carried no audio', async () => {
    const { engine, sessions, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sessions[0].params.callbacks.onerror(new Error('quota exceeded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.state).toBe('error')
    expect(events.filter((event) => event.type === 'usage')).toEqual([])
    await engine.stop()
  })

  it('aborts the calls still running when the provider ends the session, and answers none of them to the next one', async () => {
    const call = held()
    let signal: AbortSignal | null = null
    const { engine, sessions } = await setup((_name, _input, ctx) => {
      signal = ctx.signal
      return call.task
    })
    const first = await open(engine, sessions)
    first.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    first.params.callbacks.onclose('session time limit')
    expect(signal!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    const second = sessions[1]
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    call.answer('approved')
    call.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.toolResponses).toEqual([])
    await engine.stop()
  })

  it('reopens a session the provider ends only once per start of speech, so a provider that ends each one at once cannot make it reconnect in a loop', async () => {
    const { engine, sessions } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      const session = sessions[sessions.length - 1]
      session.message({ setupComplete: {} })
      await vi.advanceTimersByTimeAsync(0)
      engine.pushAudio(new Float32Array(1600))
      session.params.callbacks.onclose('code 1007')
      await vi.advanceTimersByTimeAsync(0)
    }
    // Each session costs money and is sent the pre-roll again.
    expect(sessions).toHaveLength(2)
    engine.activity(false)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sessions[2].message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    sessions[2].params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(4)
    sessions[3].message({ setupComplete: {} })
    await engine.stop()
  })

  it('sends nothing but the history to a session before its setup completes, so a memory note that settles meanwhile is neither sent nor recorded', async () => {
    const { engine, sessions, findMemories } = await setup()
    let ready!: (memories: InjectableMemory[]) => void
    findMemories.mockImplementationOnce(() => new Promise((resolve) => (ready = resolve)))
    const first = await open(engine, sessions)
    first.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    first.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    const second = sessions[1]
    ready([CAFE])
    await vi.advanceTimersByTimeAsync(0)
    expect(second.contents).toEqual([])
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.contents).toEqual([
      { turns: [{ role: 'user', parts: [{ text: '前の話' }] }, { role: 'user', parts: [{ text: expect.stringContaining(noticeAt(new Date())) }] }], turnComplete: false }
    ])
    expect(mocks.record.mock.calls.map((c) => c[0].kind)).toEqual(['user'])
    await engine.stop()
  })
})
