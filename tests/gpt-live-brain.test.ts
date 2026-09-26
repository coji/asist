import { mkdtempSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mitt from 'mitt'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LiveAPI from 'openai/resources/live/live'
import type { AgentJob, LiveEvent, TurnEvent } from '@shared/ipc'
import type { ConversationMessage, ConversationPart, ConversationResult } from '@shared/conversation'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'

/**
 * These tests put the GPT-Live engine, on a fake socket, in front of whole brain turns on a fake
 * conversation stream, so that what the conversation log, the next request and the screen get is checked
 * where the voice and brain meet.
 */

type Handler = (...args: unknown[]) => void

/** One round of the conversation model, which streams the chunks as text. */
type RoundScript = (round: { text: (...chunks: string[]) => void }) => Promise<void>

class FakeStream {
  private readonly handlers = new Map<string, Handler[]>()
  private readonly parts: ConversationPart[] = []
  constructor(private readonly script: RoundScript) {}

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  snapshot(): ConversationMessage | null {
    return this.parts.length > 0 ? { role: 'assistant', parts: [...this.parts] } : null
  }

  async final(): Promise<ConversationResult> {
    await this.script({
      text: (...chunks) => {
        for (const chunk of chunks) for (const handler of this.handlers.get('text') ?? []) handler(chunk)
        this.parts.push({ type: 'text', text: chunks.join('') })
      }
    })
    return { message: { role: 'assistant', parts: [...this.parts] }, stop: 'end', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 20 } }
  }
}

const mocks = vi.hoisted(() => ({
  userData: '',
  rounds: [] as RoundScript[],
  requests: [] as Array<{ messages: ConversationMessage[] }>,
  jobs: new Map<string, AgentJob>()
}))

vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/store', () => ({
  dataPath: (...parts: string[]) => path.join(mocks.userData, ...parts)
}))
vi.mock('../src/main/services/llm', () => ({
  providerKey: () => 'test-key',
  completeText: vi.fn(async () => ({ text: '', stop: 'end' })),
  streamConversation: (request: { messages: ConversationMessage[] }) => {
    mocks.requests.push({ messages: structuredClone(request.messages) })
    const script = mocks.rounds.shift()
    if (!script) throw new Error('no scripted round left')
    return new FakeStream(script)
  }
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({
    uiLocale: 'ja-JP',
    conversationLocale: 'ja-JP',
    region: 'JP',
    persona: '',
    ttsEngine: 'voicevox',
    conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
    conversationLogRetentionDays: 30,
    agentMode: 'readonly',
    agentEngine: 'claude'
  })
}))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))
vi.mock('../src/main/services/tts', () => ({ synthesizeSentence: vi.fn() }))
vi.mock('../src/main/services/agent', () => ({
  events: mitt(),
  contextBlock: () => null,
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
vi.mock('../src/main/services/aizuchi', () => ({ randomClip: async () => null }))
vi.mock('../src/main/services/memory', () => ({
  promptBlock: () => null,
  list: () => [],
  search: vi.fn(() => [])
}))
vi.mock('../src/main/services/panel-fetchers', () => ({ fetchPanel: vi.fn() }))
vi.mock('../src/main/services/user-local-data', () => ({ getLocalDataService: () => ({}) }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => ({}) }))
vi.mock('../src/main/services/timers', () => ({ create: vi.fn() }))

/** Follows LiveWS as far as the engine uses it. */
class FakeSocket {
  readonly sent: LiveAPI.ClientEvent[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly socket = { readyState: 1 }
  send(event: LiveAPI.ClientEvent): void {
    this.sent.push(event)
  }
  close(): void {}
  on(event: string, listener: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  emit(event: LiveAPI.ServerEvent): void {
    for (const handler of this.handlers.get('event') ?? []) handler(event)
  }
  input(delta: string): void {
    this.emit({ type: 'session.input_transcript.delta', delta, event_id: delta, start_ms: 0, end_ms: 1 })
  }
  output(delta: string): void {
    this.emit({ type: 'session.output_transcript.delta', delta, event_id: delta, start_ms: 0, end_ms: 1 })
  }
  delegate(id: string): void {
    this.emit({ type: 'session.delegation.created', event_id: id, offset_ms: 0, delegation: { id, type: 'delegation', target: 'client' } })
  }
  commentary(): Array<[string | null | undefined, string]> {
    return this.sent.flatMap((event) => (event.type === 'session.commentary.append' ? [[event.delegation_id, event.content] as [string | null | undefined, string]] : []))
  }
}

/** Starts GPT-Live wired to brain as the app wires it, with its session open. */
async function setup(): Promise<{
  engine: import('../src/main/services/live/gpt-live').GptLiveEngine
  socket: FakeSocket
  turnEvents: TurnEvent[]
  liveEvents: LiveEvent[]
}> {
  const brain = await import('../src/main/services/brain')
  const session = await import('../src/main/services/brain/session')
  const { liveRoute } = await import('../src/main/services/brain/speech-route')
  const { GptLiveEngine } = await import('../src/main/services/live/gpt-live')
  const turnEvents: TurnEvent[] = []
  const liveEvents: LiveEvent[] = []
  brain.events.on('event', (event) => turnEvents.push(event))
  const sockets: FakeSocket[] = []
  const engine = new GptLiveEngine(LIVE_ENGINE_INFO['gpt-live'], {
    settings: () => ({ liveIdleSeconds: 30, gptLive: { model: 'gpt-live-1', voice: 'marin' } }) as never,
    client: () => ({}) as never,
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    beginTurn: (text, typed, route) => brain.beginTurn({ text }, typed ? { typed: true } : {}, 'live', false, { route }),
    onTurnEvent: (listener) => {
      brain.events.on('event', listener)
      return () => brain.events.off('event', listener)
    },
    instructions: () => '',
    history: () => session.history.toTranscript()
  })
  engine.events.on('event', (event) => liveEvents.push(event))
  session.setSpeechRoute(liveRoute((sentence, signal) => engine.sayOutsideDelegation(sentence, signal)))
  await engine.start()
  engine.activity(true)
  await vi.advanceTimersByTimeAsync(0)
  const socket = sockets[0]
  socket.emit({ type: 'session.started', event_id: 's', session: { id: 's', expires_at: 0, model: 'gpt-live-1', status: 'active' } })
  await vi.advanceTimersByTimeAsync(0)
  return { engine, socket, turnEvents, liveEvents }
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

const textOf = (message: ConversationMessage): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')

const startedTurns = (events: TurnEvent[]): number[] => events.flatMap((e) => (e.type === 'started' ? [e.turnId] : []))

/** Waits for brain to finish the turns started so far. */
async function turnsDone(events: TurnEvent[]): Promise<void> {
  await vi.waitFor(() => {
    const started = startedTurns(events)
    expect(started.length).toBeGreaterThan(0)
    expect(started.every((turnId) => events.some((e) => e.type === 'done' && e.turnId === turnId))).toBe(true)
  })
}

describe('GPT-Live in front of brain', () => {
  beforeAll(async () => {
    await import('../src/main/services/brain')
  }, 30_000)

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-gpt-live-'))
    mocks.rounds = []
    mocks.requests = []
    mocks.jobs = new Map()
  })
  afterEach(() => vi.useRealTimers())

  it('records a reply the voice reads in two stretches once, under brain’s turn, and the next request ends with the user', async () => {
    mocks.rounds.push(async (round) => round.text('明日は晴れです。', '傘はいりません。'))
    mocks.rounds.push(async (round) => round.text('どういたしまして。'))
    const { engine, socket, turnEvents, liveEvents } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)
    expect(socket.commentary().map(([, content]) => content).join('')).toBe('明日は晴れです。傘はいりません。')
    // The voice reads it in its own words, pausing between the sentences for longer than a transcript takes to go quiet.
    socket.output('明日は晴れですよ。')
    await vi.advanceTimersByTimeAsync(1600)
    socket.output('傘はいらないですね。')
    await vi.advanceTimersByTimeAsync(1600)
    socket.input('ありがとう')
    socket.delegate('dlg2')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)

    const next = mocks.requests[1].messages
    expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(textOf(next[1])).toBe('明日は晴れです。傘はいりません。')
    const [first, second] = startedTurns(turnEvents)
    expect(readLog().flatMap((r) => (r.kind === 'assistant' ? [[r.turnId, r.text]] : []))).toEqual([
      [first, '明日は晴れです。傘はいりません。'],
      [second, 'どういたしまして。']
    ])
    // Brain's text is what the screen shows, so the voice's wording of it is not shown as well.
    expect(liveEvents.some((e) => e.type === 'assistantTranscript')).toBe(false)
    await engine.stop()
  })

  it('hands a backchannel the user says during the reading to the next request, without a turn or a record of its own', async () => {
    mocks.rounds.push(async (round) => round.text('明日は晴れです。', '傘はいりません。'))
    mocks.rounds.push(async (round) => round.text('どういたしまして。'))
    const { engine, socket, turnEvents } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)
    const recordsBefore = readLog().length
    socket.output('明日は晴れですよ。')
    socket.input('うん')
    await vi.advanceTimersByTimeAsync(1600)
    // The voice read on without delegating, so the backchannel waits for the next turn.
    expect(startedTurns(turnEvents)).toHaveLength(1)
    expect(readLog()).toHaveLength(recordsBefore)
    socket.output('傘はいらないですね。')
    await vi.advanceTimersByTimeAsync(1600)
    socket.input('ありがとう')
    socket.delegate('dlg2')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)

    expect(readLog().flatMap((r) => (r.kind === 'user' ? [r.text] : []))).toEqual(['明日の天気は', 'うん\nありがとう'])
    const next = mocks.requests[1].messages
    expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(textOf(next[2])).toMatch(/うん\nありがとう$/)
    await engine.stop()
  })

  it('records none of the line the voice says after it delegates, so the request starts and ends with the user’s words', async () => {
    mocks.rounds.push(async (round) => round.text('晴れです。'))
    const { engine, socket, turnEvents } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    socket.output('明日の天気ですね、')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)
    expect(mocks.requests[0].messages.map((m) => m.role)).toEqual(['user'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(readLog().map((r) => [r.kind, r.text])).toEqual([
      ['user', '明日の天気は'],
      ['message', undefined],
      ['assistant', '晴れです。']
    ])
    await engine.stop()
  })

  it('records a job report the voice reads once, under the report’s turn', async () => {
    mocks.rounds.push(async (round) => round.text('調査が終わりました。'))
    mocks.rounds.push(async (round) => round.text('どういたしまして。'))
    const { engine, socket, turnEvents } = await setup()
    const { initJobReporting } = await import('../src/main/services/brain/job-reporting')
    const agent = await import('../src/main/services/agent')
    initJobReporting()
    const job = { id: 'j1', title: '調査', status: 'done', summary: '完了した' } as AgentJob
    mocks.jobs.set(job.id, job)
    agent.events.emit('event', { type: 'update', job })
    await vi.advanceTimersByTimeAsync(0)
    await turnsDone(turnEvents)
    expect(socket.commentary()).toEqual([[null, '調査が終わりました。']])
    socket.output('調査、終わったよ。')
    await vi.advanceTimersByTimeAsync(1600)
    socket.input('ありがとう')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    await turnsDone(turnEvents)

    const next = mocks.requests[1].messages
    expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(textOf(next[1])).toBe('調査が終わりました。')
    const [report] = startedTurns(turnEvents)
    expect(readLog().flatMap((r) => (r.kind === 'assistant' && r.turnId === report ? [r.text] : []))).toEqual(['調査が終わりました。'])
    expect(readLog().filter((r) => r.kind === 'assistant')).toHaveLength(2)
    await engine.stop()
  })

  it('shows an interjection the voice reads and records it once, under the interjection’s turn', async () => {
    const { engine, socket, turnEvents } = await setup()
    const { interject } = await import('../src/main/services/brain/interject')
    const interjecting = interject('タイマーが終わりました。')
    await vi.advanceTimersByTimeAsync(0)
    await interjecting
    socket.output('タイマー、終わりましたよ。')
    await vi.advanceTimersByTimeAsync(1600)
    const [turnId] = startedTurns(turnEvents)
    expect(turnEvents.flatMap((e) => (e.type === 'delta' && e.turnId === turnId ? [e.text] : [])).join('')).toBe('タイマーが終わりました。')
    expect(readLog().map((r) => [r.kind, r.turnId, r.text])).toEqual([['assistant', turnId, 'タイマーが終わりました。']])
    await engine.stop()
  })
})
