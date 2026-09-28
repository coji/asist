import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import type * as LiveAPI from 'openai/resources/live/live'
import type { LiveEvent } from '@shared/ipc'
import { marker } from '@shared/conversation-markers'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'

/** These tests drive the GPT-Live engine end to end against a fake socket. */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nextTurnId: 100
}))

vi.mock('../src/main/services/brain/session', () => ({
  record: mocks.record,
  turnScheduler: { allocateTurnId: () => mocks.nextTurnId++ }
}))
vi.mock('../src/main/services/tts', () => ({ synthesize: vi.fn() }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP', uiLocale: 'ja-JP' }) }))

type Handler = (...args: unknown[]) => void

/** Follows LiveWS: a server's error event reaches both 'event' and 'error', and a send on a closing socket becomes an 'error'. */
class FakeSocket {
  readonly sent: LiveAPI.ClientEvent[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly socket = { readyState: 1 }
  closed = false
  send(event: LiveAPI.ClientEvent): void {
    if (this.socket.readyState > 1) {
      this.fire('error', new Error('cannot send on a closed WebSocket'))
      return
    }
    this.sent.push(event)
  }
  close(): void {
    this.closed = true
  }
  on(event: string, listener: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  fire(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name) ?? []) handler(...args)
  }
  emit(event: LiveAPI.ServerEvent): void {
    this.fire('event', event)
    if (event.type === 'error') this.fire('error', Object.assign(new Error(JSON.stringify(event)), { error: event }))
  }
  started(): void {
    this.emit({ type: 'session.started', event_id: 'e1', session: { id: 's', expires_at: 0, model: 'gpt-live-1', status: 'active' } })
  }
  ofType<T extends LiveAPI.ClientEvent['type']>(type: T): Array<Extract<LiveAPI.ClientEvent, { type: T }>> {
    return this.sent.filter((event): event is Extract<LiveAPI.ClientEvent, { type: T }> => event.type === type)
  }
}

async function setup(options: { history?: () => Array<{ role: 'user' | 'assistant'; content: string }> } = {}): Promise<{
  engine: import('../src/main/services/live/gpt-live').GptLiveEngine
  sockets: FakeSocket[]
  events: LiveEvent[]
  audio: Float32Array[]
  beginTurn: ReturnType<typeof vi.fn>
}> {
  const { GptLiveEngine } = await import('../src/main/services/live/gpt-live')
  const sockets: FakeSocket[] = []
  const events: LiveEvent[] = []
  const audio: Float32Array[] = []
  const beginTurn = vi.fn((_text: string, _typed: boolean) => ({ turnId: 42, signal: new AbortController().signal, completion: Promise.resolve() }))
  const engine = new GptLiveEngine(LIVE_ENGINE_INFO['gpt-live'], {
    settings: () => ({ liveIdleSeconds: 30, gptLive: { model: 'gpt-live-1', voice: 'marin' }, persona: '' }) as never,
    client: () => ({}) as never,
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    beginTurn,
    onTurnEvent: () => () => {},
    instructions: () => 'INSTRUCTIONS',
    history: options.history ?? (() => [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんにちは。' }
    ])
  })
  engine.events.on('event', (event) => events.push(event))
  engine.events.on('audio', (samples) => audio.push(samples))
  await engine.start()
  return { engine, sockets, events, audio, beginTurn }
}

describe('GptLiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.record.mockClear()
    mocks.nextTurnId = 100
  })
  afterEach(() => vi.useRealTimers())

  it('opens on the first speech, puts voice, delegation and history in session.start, and sends the buffered audio first', async () => {
    const { engine, sockets, events } = await setup()
    engine.pushAudio(new Float32Array(160).fill(0.1))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    const start = sockets[0].ofType('session.start')[0]
    expect(start.session).toMatchObject({
      model: 'gpt-live-1',
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
      delegation: { type: 'client' },
      instructions: 'INSTRUCTIONS'
    })
    expect(start.session.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'こんにちは' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'こんにちは。' }] }
    ])
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(1)
    expect(events.map((e) => e.type === 'connection' && e.state)).toContain('connecting')
    expect(events.at(-2)).toMatchObject({ type: 'connection', state: 'open' })
    expect(events.at(-1)).toMatchObject({ type: 'latency', connectMs: 0 })
    engine.pushAudio(new Float32Array(160))
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(2)
    await engine.stop()
  })

  it('opens no socket when the history cannot be read, and reports the failure to connect', async () => {
    const { engine, sockets, events } = await setup({
      history: () => {
        throw new Error('conversation log unreadable')
      }
    })
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sockets).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('conversation log unreadable') })
    await engine.stop()
  })

  it('turns a settled input transcript into a brain turn and sends the brain text as commentary with the delegation id', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    socket.emit({ type: 'session.input_transcript.delta', delta: '天気は', event_id: 'b', start_ms: 1, end_ms: 2 })
    expect(events.filter((e) => e.type === 'userTranscript').map((e) => e.type === 'userTranscript' && e.text)).toEqual(['明日の', '明日の天気は'])
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn).toHaveBeenCalledOnce()
    expect(beginTurn.mock.calls[0][0]).toBe('明日の天気は')
    expect(beginTurn.mock.calls[0][1]).toBe(false)
    // The brain records an utterance it took over, so the final transcript is not recorded again here.
    expect(mocks.record).not.toHaveBeenCalled()
    const route = beginTurn.mock.calls[0][2] as { open: (ctx: unknown) => { push: (s: string) => void; drain: () => Promise<void> } }
    const sink = route.open({ turnId: 42, signal: new AbortController().signal, emit: vi.fn(), locale: 'ja-JP' })
    sink.push('晴れです。')
    sink.push('')
    await sink.drain()
    expect(socket.ofType('session.commentary.append')).toEqual([{ type: 'session.commentary.append', delegation_id: 'dlg1', content: '晴れです。' }])
    await engine.stop()
  })

  it('records and shows nothing of an exchange the voice answers by itself but the user line, emits Float32 audio, and measures the response time', async () => {
    const { engine, sockets, events, audio } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    socket.emit({ type: 'session.input_transcript.delta', delta: 'おはよう', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(200)
    socket.emit({ type: 'session.output_audio.delta', delta: Buffer.from([0, 64, 0, 192]).toString('base64') })
    expect(audio).toHaveLength(1)
    expect(audio[0][0]).toBeCloseTo(0.5, 3)
    expect(events.find((e) => e.type === 'latency' && e.responseMs > 0)).toMatchObject({ responseMs: 200 })
    socket.emit({ type: 'session.output_transcript.delta', delta: 'おはようございます。', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(1500)
    // A greeting is the voice's own, and brain never saw it, so the log keeps neither side of it.
    expect(mocks.record).not.toHaveBeenCalled()
    expect(events.flatMap((e) => (e.type === 'userTranscript' || e.type === 'assistantTranscript' ? [[e.type, e.text, e.final]] : []))).toEqual([
      ['userTranscript', 'おはよう', false],
      ['userTranscript', 'おはよう', true]
    ])
    await engine.stop()
  })

  it('passes typed text to the voice side as context and starts the brain turn as typed', async () => {
    const { engine, sockets, beginTurn } = await setup()
    const sending = engine.sendText('3分タイマー')
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await sending
    expect(sockets[0].ofType('session.thinking.append')[0]).toMatchObject({ delegation_id: null, content: '[ユーザーが文字で入力した] 3分タイマー' })
    expect(beginTurn).toHaveBeenCalledWith('3分タイマー', true, expect.anything())
    await engine.stop()
  })

  it('derives the cost from the usage, closes an idle session, and opens a new one on the next speech', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    sockets[0].emit({ type: 'session.usage.updated', event_id: 'u', usage: { seconds: 120 } })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 120, costUsd: 0.1 } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sockets[0].ofType('session.close')).toHaveLength(1)
    expect(sockets[0].closed).toBe(true)
    expect(engine.state).toBe('idle')
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    sockets[1].started()
    sockets[1].emit({ type: 'session.usage.updated', event_id: 'u2', usage: { seconds: 60 } })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 180, costUsd: 0.15 } })
    await engine.stop()
    expect(sockets[1].closed).toBe(true)
    expect(engine.state).toBe('off')
  })

  it('closes the socket of a session that did not start in time, and ignores what that socket reports afterwards', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    // GPT-Live bills a session by the second for as long as it is open.
    expect(sockets[0].closed).toBe(true)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].started()
    sockets[1].emit({ type: 'session.usage.updated', event_id: 'u1', usage: { seconds: 10 } })
    sockets[0].started()
    sockets[0].emit({ type: 'session.usage.updated', event_id: 'u0', usage: { seconds: 600 } })
    expect(events.filter((e) => e.type === 'usage').at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 10, costUsd: expect.any(Number) } })
    await engine.stop()
  })

  it('stops at once while a session is still opening, closes its socket and reports no error', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = engine.stop().then(() => (stopped = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(true)
    expect(sockets[0].closed).toBe(true)
    expect(engine.state).toBe('off')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    // The session the socket starts afterwards is no longer the engine's.
    sockets[0].started()
    expect(engine.state).toBe('off')
    await stopping
  })

  it('reports a server error once with its message, as the failure to connect when it comes before the session started', async () => {
    const t = createTranslator('ja-JP')
    const { engine, sockets, events } = await setup()
    // The screen words each message as the renderer does.
    const errors = (): string[] => events.flatMap((e) => (e.type === 'error' ? [readErrorText(e.message, 'ja-JP') ?? e.message] : []))
    const serverError = { type: 'error' as const, event_id: 'x', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid value for voice.' } }
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit(serverError)
    await vi.advanceTimersByTimeAsync(0)
    expect(errors()).toEqual([t('voice.live.connectFailed', { detail: 'Invalid value for voice.' })])
    expect(sockets[0].closed).toBe(true)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].emit(serverError)
    expect(errors().slice(1)).toEqual(['Invalid value for voice.'])
    await engine.stop()
  })

  it('sends nothing once the server has begun to close the socket, and goes idle when it has closed', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    engine.activity(false)
    const appended = socket.ofType('session.input_audio.append').length
    socket.socket.readyState = 2
    for (let i = 0; i < 3; i++) engine.pushAudio(new Float32Array(512))
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    socket.socket.readyState = 3
    socket.fire('close', 1000, '')
    expect(engine.state).toBe('idle')
    expect(socket.ofType('session.input_audio.append')).toHaveLength(appended)
    await engine.stop()
  })

  it('closes the user line on screen under the turn it was shown with when the utterance is handed to brain', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn).toHaveBeenCalledOnce()
    const lines = events.flatMap((e) => (e.type === 'userTranscript' ? [[e.turnId, e.text, e.final]] : []))
    expect(lines).toEqual([
      [100, '明日の天気は', false],
      [100, '明日の天気は', true]
    ])
    // Brain records the utterance it took over.
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('hands the whole transcript to brain even when the transcript of the backchannel settles while it still arrives', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.output_transcript.delta', delta: 'うん、', event_id: 'b', start_ms: 1, end_ms: 2 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    // The input transcript keeps arriving for 1.2 seconds, and the backchannel's settles 1.5 seconds after it began.
    for (const [i, delta] of ['天気', 'を', '教え', 'て'].entries()) {
      await vi.advanceTimersByTimeAsync(300)
      socket.emit({ type: 'session.input_transcript.delta', delta, event_id: `t${i}`, start_ms: 2, end_ms: 3 })
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn).toHaveBeenCalledOnce()
    expect(beginTurn.mock.calls[0][0]).toBe('明日の天気を教えて')
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('keeps the utterance whole when the voice says a backchannel while the user pauses, and hands all of it to the delegation', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の午後三時に', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(300)
    socket.emit({ type: 'session.output_transcript.delta', delta: 'うん', event_id: 'b', start_ms: 1, end_ms: 2 })
    // The backchannel's transcript goes quiet for 1.5 seconds while the user is still pausing.
    await vi.advanceTimersByTimeAsync(1000)
    socket.emit({ type: 'session.input_transcript.delta', delta: '会議を', event_id: 'c', start_ms: 2, end_ms: 3 })
    await vi.advanceTimersByTimeAsync(600)
    socket.emit({ type: 'session.input_transcript.delta', delta: '入れて', event_id: 'd', start_ms: 3, end_ms: 4 })
    socket.emit({ type: 'session.delegation.created', event_id: 'e', offset_ms: 4, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の午後三時に会議を入れて'])
    const finals = events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [e.text] : []))
    expect(finals).toEqual(['明日の午後三時に会議を入れて'])
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  /**
   * Opens a session and lets a delegation with nothing heard at all run, which hands brain the notice
   * that no transcript arrived. The tests compare what follows with it rather than with its wording.
   */
  async function withNoTranscriptNotice(): Promise<Awaited<ReturnType<typeof setup>> & { socket: FakeSocket; noTranscript: string }> {
    const context = await setup()
    context.engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = context.sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.delegation.created', event_id: 'd0', offset_ms: 0, delegation: { id: 'dlg0', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(2200)
    expect(context.beginTurn).toHaveBeenCalledOnce()
    return { ...context, socket, noTranscript: context.beginTurn.mock.calls[0][0] as string }
  }

  it('hands brain a request that went quiet before a late delegation, followed by a note that no utterance of the delegation’s own arrived', async () => {
    const { engine, socket, events, beginTurn, noTranscript } = await withNoTranscriptNotice()
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気を調べて', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(2600)
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(2200)
    const [request, note, ...rest] = (beginTurn.mock.calls[1][0] as string).split('\n')
    expect([request, rest]).toEqual(['明日の天気を調べて', []])
    // The request may be that line, so brain is not told that its transcript never arrived.
    expect(note).toBeTruthy()
    expect(note).not.toBe(noTranscript)
    expect(events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [e.text] : []))).toEqual(['明日の天気を調べて'])
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('hands brain a backchannel followed by that note, not as the request, when a delegation with no transcript of its own comes 1.6 s after it', async () => {
    const { engine, socket, beginTurn, noTranscript } = await withNoTranscriptNotice()
    // A backchannel while the voice reads, then a question whose transcript never arrives.
    socket.emit({ type: 'session.input_transcript.delta', delta: 'うん', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(1600)
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(2200)
    const [backchannel, note, ...rest] = (beginTurn.mock.calls[1][0] as string).split('\n')
    expect([backchannel, rest]).toEqual(['うん', []])
    expect(note).toBeTruthy()
    expect(note).not.toBe(noTranscript)
    await engine.stop()
  })

  it('hands brain what the user said before the voice asked back together with the answer, as one input in order, and shows each on a line of its own', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: 'あれ調べて', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(1600)
    socket.emit({ type: 'session.output_transcript.delta', delta: '何を調べる?', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(800)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気', event_id: 'c', start_ms: 2, end_ms: 3 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 3, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['あれ調べて\n明日の天気'])
    const finals = events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [[e.turnId, e.text]] : []))
    expect(finals).toEqual([[100, 'あれ調べて'], [101, '明日の天気']])
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('hands typed input the utterances said before it, ahead of the typed text, which alone carries the typed note', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: 'タイマーをかけたい', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(1600)
    await engine.sendText('3分')
    // The turn is not marked as typed as a whole, which would have brain read the spoken line as typed too.
    expect(beginTurn.mock.calls.map((c) => [c[0], c[1]])).toEqual([[`タイマーをかけたい\n${marker('ja-JP', 'typedInputNote')} 3分`, false]])
    await engine.stop()
  })

  it('hands typed input the utterance still being transcribed ahead of it, closes that line, and leaves nothing of it for the next delegation', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: 'えっと明日の', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(300)
    await engine.sendText('ペンを買っておいて')
    expect(events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [e.text] : []))).toEqual(['えっと明日の'])
    await vi.advanceTimersByTimeAsync(1600)
    socket.emit({ type: 'session.input_transcript.delta', delta: '教えて', event_id: 'b', start_ms: 1, end_ms: 2 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 2, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [`えっと明日の\n${marker('ja-JP', 'typedInputNote')} ペンを買っておいて`, false],
      ['教えて', false]
    ])
    await engine.stop()
  })

  it('does not hand a request what was said longer ago than a quiet session stays open, though the provider ended the session meanwhile', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit({ type: 'session.input_transcript.delta', delta: 'おはよう', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(1600)
    // The provider or the network ends the session while the user is quiet, so no idle close follows.
    engine.activity(false)
    sockets[0].fire('close', 1006, 'abnormal')
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    const sending = engine.sendText('明日の天気は?')
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].started()
    await sending
    expect(beginTurn.mock.calls.map((c) => [c[0], c[1]])).toEqual([['明日の天気は?', true]])
    await engine.stop()
  })

  it('does not hand a request made after the session closed for quiet what was said before that', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit({ type: 'session.input_transcript.delta', delta: 'おはよう', event_id: 'a', start_ms: 0, end_ms: 1 })
    engine.activity(false)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sockets[0].closed).toBe(true)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[1]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'b', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気は'])
    await engine.stop()
  })

  it('hands the whole utterance to brain when its transcript only begins after the delegation, and closes one line for it', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(500)
    for (const [i, delta] of ['明日の', '天気を', '教えて'].entries()) {
      socket.emit({ type: 'session.input_transcript.delta', delta, event_id: `t${i}`, start_ms: 2, end_ms: 3 })
      await vi.advanceTimersByTimeAsync(150)
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気を教えて'])
    const finals = events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [[e.turnId, e.text]] : []))
    expect(finals).toEqual([[100, '明日の天気を教えて']])
    // Brain records the utterance it took over, so no part of it is recorded here as a line of its own.
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('waits for a transcript that begins just before the start limit until it goes quiet, rather than handing brain the part heard by then', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(1800)
    for (const [i, delta] of ['明日の', '天気を', '教えて', 'ほしい'].entries()) {
      socket.emit({ type: 'session.input_transcript.delta', delta, event_id: `t${i}`, start_ms: 2, end_ms: 3 })
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気を教えてほしい'])
    await engine.stop()
  })

  it('tells brain that no transcript arrived when none begins in time, and takes one that never goes quiet at the longest wait', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.delegation.created', event_id: 'd1', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(1900)
    expect(beginTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(beginTurn).toHaveBeenCalledOnce()
    socket.emit({ type: 'session.delegation.created', event_id: 'd2', offset_ms: 2, delegation: { id: 'dlg2', type: 'delegation', target: 'client' } })
    let waited = 0
    while (beginTurn.mock.calls.length === 1 && waited < 60_000) {
      socket.emit({ type: 'session.input_transcript.delta', delta: 'あ', event_id: `t${waited}`, start_ms: 2, end_ms: 3 })
      await vi.advanceTimersByTimeAsync(200)
      waited += 200
    }
    expect(beginTurn).toHaveBeenCalledTimes(2)
    expect(waited).toBeGreaterThanOrEqual(10_000)
    expect(waited).toBeLessThanOrEqual(10_200)
    await engine.stop()
  })

  it('ends a delegation still waiting for its transcript when the engine stops, and carries nothing of it into the next start', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'a', start_ms: 0, end_ms: 1 })
    sockets[0].emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await engine.stop()
    await vi.advanceTimersByTimeAsync(3000)
    // The line on screen closes as it was heard, and no turn starts for an engine that is off.
    expect(events.filter((e) => e.type === 'userTranscript' && e.final).map((e) => e.type === 'userTranscript' && e.text)).toEqual(['明日の天気は'])
    expect(beginTurn).not.toHaveBeenCalled()
    // A sentence from a brain turn still running opens no session, which nothing would close.
    await engine.sayOutsideDelegation('晴れです。')
    expect(sockets).toHaveLength(1)

    await engine.start()
    const saying = engine.sayOutsideDelegation('お待たせしました。')
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[1]
    socket.started()
    await saying
    // The next utterance is a line of its own, which the stopped delegation does not take for brain,
    // and the next delegation hands brain nothing heard before the stop.
    socket.emit({ type: 'session.output_transcript.delta', delta: 'うん。', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(100)
    socket.emit({ type: 'session.input_transcript.delta', delta: 'はい', event_id: 'c', start_ms: 2, end_ms: 3 })
    await vi.advanceTimersByTimeAsync(3000)
    const finals = events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [[e.turnId, e.text]] : []))
    expect(finals).toEqual([[100, '明日の天気は'], [101, 'はい']])
    expect(beginTurn).not.toHaveBeenCalled()
    socket.emit({ type: 'session.delegation.created', event_id: 'd2', offset_ms: 3, delegation: { id: 'dlg2', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(2200)
    expect(beginTurn).toHaveBeenCalledOnce()
    const handed = beginTurn.mock.calls[0][0] as string
    expect(handed.split('\n')[0]).toBe('はい')
    expect(handed).not.toContain('明日の天気は')
    expect(mocks.record).not.toHaveBeenCalled()
    // Nobody has spoken since the start, so a session the provider ends stays closed.
    socket.fire('close', 1000, '')
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    expect(engine.state).toBe('idle')
    await engine.stop()
  })
})
