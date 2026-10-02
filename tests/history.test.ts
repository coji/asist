import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessage, ConversationPart } from '@shared/conversation'
import { estimateTokens } from '@shared/token-estimate'
import { buildMemoryInjection, type InjectableMemory, type MemoryInjection } from '@shared/memory-injection'
import { interruptedBeforeReply, interruptedWhileSpeaking } from '@shared/turn-recovery'

const INTERRUPTED_BEFORE_REPLY = interruptedBeforeReply('ja-JP')
const INTERRUPTED_WHILE_SPEAKING = interruptedWhileSpeaking('ja-JP')
import type { ConversationRecord } from '../src/main/services/brain/conversation-log'
import { ConversationHistory, type HistoryCheckpoint } from '../src/main/services/brain/history'

function makeHistory(opts?: {
  stored?: ConversationRecord[]
  summarize?: (existing: string, log: string) => Promise<string>
  recentTurns?: number
  compressAtTokens?: number
  limitTokens?: number
  hardLimitTokens?: number
}): { history: ConversationHistory; checkpoints: HistoryCheckpoint[]; errors: string[] } {
  const checkpoints: HistoryCheckpoint[] = []
  const errors: string[] = []
  const history = new ConversationHistory({
    recentTurns: opts?.recentTurns ?? 0,
    compressAtTokens: opts?.compressAtTokens ?? 300,
    limitTokens: opts?.limitTokens ?? 600,
    hardLimitTokens: opts?.hardLimitTokens ?? 1_000_000,
    load: () => opts?.stored ?? [],
    saveCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    summarize: opts?.summarize ?? (async () => '要約'),
    locale: () => 'ja-JP',
    onError: (stage, err) => errors.push(`${stage}: ${err instanceof Error ? err.message : String(err)}`)
  })
  return { history, checkpoints, errors }
}

const T0 = new Date(2026, 8, 8, 16, 48).getTime()
const user = (turnId: number, text: string, t = T0 + turnId * 1000): ConversationRecord => ({ t, kind: 'user', turnId, text })
const notice = (turnId: number, text: string): ConversationRecord => ({ t: T0 + turnId * 1000, kind: 'notice', turnId, notice: 'job-done', text })
const assistant = (
  turnId: number,
  text: string,
  extra: { interrupted?: 'before-reply' | 'while-speaking'; failed?: boolean } = {}
): ConversationRecord => ({ t: T0 + turnId * 1000 + 500, kind: 'assistant', turnId, text, ...extra })
const tool = (turnId: number, name: string, input: string, result: string, isError = false): ConversationRecord => ({
  t: T0 + turnId * 1000 + 200,
  kind: 'tool',
  turnId,
  name,
  input,
  result,
  resultLength: result.length,
  durationMs: 10,
  ...(isError ? { isError: true } : {})
})
/** One message a line, the form the log was written in before the messages appended together went into one record. */
const message = (turnId: number, role: 'user' | 'assistant', parts: ConversationPart[]): ConversationRecord => ({
  t: T0 + turnId * 1000 + 300,
  kind: 'message',
  turnId,
  role,
  parts
})
/** The messages a turn appended together, such as a tool call and its results, as the log writes them now. */
const messages = (turnId: number, ...sent: ConversationMessage[]): ConversationRecord => ({
  t: T0 + turnId * 1000 + 300,
  kind: 'messages',
  turnId,
  messages: sent
})

/** A memory note a live engine sent to the model once the utterance of the turn was already recorded. */
const memoryNote = (turnId: number, injection: MemoryInjection): ConversationRecord => ({
  t: T0 + turnId * 1000 + 800,
  kind: 'note',
  turnId,
  text: injection.text,
  memoryIds: injection.ids
})
const CAFE: InjectableMemory = { id: 'm-cafe', kind: 'section', page: '行きつけ', heading: 'いつもの店', text: '中野のカフェ', date: '' }

const text = (role: 'user' | 'assistant', value: string): ConversationMessage => ({ role, parts: [{ type: 'text', text: value }] })
const textOf = (m: ConversationMessage): string => m.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')

/** The records of a turn that calls one tool and then answers, in the form the API receives. */
const toolTurn = (turnId: number, result: string): ConversationRecord[] => [
  user(turnId, '大阪の天気'),
  messages(
    turnId,
    { role: 'assistant', parts: [{ type: 'tool_call', id: `t${turnId}`, name: 'show_weather', input: { location: '大阪' } }] },
    { role: 'user', parts: [{ type: 'tool_result', callId: `t${turnId}`, name: 'show_weather', content: result }] }
  ),
  tool(turnId, 'show_weather', '{"location":"大阪"}', result.slice(0, 200)),
  messages(turnId, text('assistant', '晴天です。')),
  assistant(turnId, '晴天です。')
]

const turn = (h: ConversationHistory, i: number, size = 1): void => {
  h.apply(user(i, `u${i}`))
  h.apply(assistant(i, `a${i}`.repeat(size)))
}

describe('ConversationHistory, derived from the conversation log', () => {
  it('builds messages from the user and assistant records and stamps the user message with the time of the utterance', () => {
    const { history } = makeHistory()
    history.apply(user(1, '明日の天気は'))
    history.apply(assistant(1, '晴天です。'))
    expect(history.toMessages()).toEqual([text('user', '[2026/9/8(火) 16:48] 明日の天気は'), text('assistant', '晴天です。')])
  })

  it('keeps the tool call and its result sent during a turn in place in the following turns', () => {
    const { history } = makeHistory()
    for (const record of toolTurn(1, JSON.stringify({ shown: true, data: { temp: 28, forecast: 'x'.repeat(500) } }))) history.apply(record)
    history.apply(user(2, 'ありがとう'))
    const messages = history.toMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(messages[1].parts).toEqual([{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }])
    expect(JSON.stringify(messages[2].parts)).toContain('x'.repeat(500))
    expect(messages[3]).toEqual(text('assistant', '晴天です。'))
    // The spoken text is already in the last assistant message, so the assistant record is not sent again.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    // The text-only history, which the model on the voice side receives, leaves the tool exchange out.
    expect(history.toTranscript()).toEqual([
      { role: 'user', content: '大阪の天気' },
      { role: 'assistant', content: '晴天です。' },
      { role: 'user', content: 'ありがとう' }
    ])
  })

  it('carries the native provider payload together with the recorded message into the next request', () => {
    const { history } = makeHistory()
    const native = { provider: 'google' as const, model: 'gemini-3.8-flash', payload: { role: 'model', parts: [{ functionCall: { name: 'show_weather', args: {} }, thoughtSignature: 'sig' }] } }
    history.apply(user(1, '大阪の天気'))
    history.apply({ ...message(1, 'assistant', [{ type: 'tool_call', id: 't1', name: 'show_weather', input: {} }]), native } as ConversationRecord)
    // Without it, Gemini rejects a tool call that carries no signature with a 400.
    expect(history.toMessages()[1].native).toEqual(native)
  })

  it('appends the notes after the user text and counts the shown memory ids as recalled until they are folded into the summary', async () => {
    const { history } = makeHistory({ compressAtTokens: 0, limitTokens: 0 })
    history.apply({ ...user(1, 'ラーメン'), notes: '[記憶]\n- 松葉軒', memoryIds: ['m1'] })
    history.apply({ ...tool(1, 'recall', '{"query":"猫"}', '{"hits":[{"id":"m2"}]}'), memoryIds: ['m2'] })
    history.apply(assistant(1, '松葉軒ですね'))
    expect(textOf(history.toMessages()[0])).toBe('[2026/9/8(火) 16:48] ラーメン\n\n[記憶]\n- 松葉軒')
    expect([...history.shownMemoryIds()].sort()).toEqual(['m1', 'm2'])
    turn(history, 2)
    turn(history, 3)
    expect(history.shownMemoryIds().has('m1')).toBe(true)
    await history.compact('daily')
    expect(history.toMessages().some((m) => textOf(m).includes('[記憶]'))).toBe(false)
    expect(history.shownMemoryIds().size).toBe(0)
  })

  it('keeps a memory note sent after an utterance on that utterance, even once the next one has started, so its memory is not injected again', () => {
    const { history } = makeHistory()
    const inject = (): MemoryInjection | null => buildMemoryInjection([CAFE], { locale: 'ja-JP', excludeIds: history.shownMemoryIds() })
    const note = inject()!
    history.apply(user(1, 'いつもの店'))
    history.apply(assistant(1, '中野のカフェですね'))
    // The search for the first utterance finishes after the second one was recorded.
    history.apply(user(2, 'そこまでの道は'))
    history.apply(memoryNote(1, note))
    expect(inject()).toBeNull()
    const messages = history.toMessages().map(textOf)
    expect(messages[0]).toBe(`[2026/9/8(火) 16:48] いつもの店\n\n${note.text}`)
    expect(messages[2]).not.toContain(note.text)
    // The log replayed at startup gives the same history.
    const { history: replayed } = makeHistory({ stored: [user(1, 'いつもの店'), user(2, 'そこまでの道は'), memoryNote(1, note)] })
    replayed.ensureLoaded()
    expect(buildMemoryInjection([CAFE], { locale: 'ja-JP', excludeIds: replayed.shownMemoryIds() })).toBeNull()
  })

  it('injects a memory again once the turn that showed it is folded into the summary, and drops a note that comes for such a turn', async () => {
    const { history } = makeHistory({ recentTurns: 1 })
    const note = buildMemoryInjection([CAFE], { locale: 'ja-JP' })!
    history.apply(user(1, 'いつもの店'))
    history.apply(memoryNote(1, note))
    history.apply(assistant(1, '中野のカフェですね'))
    turn(history, 2)
    expect(history.shownMemoryIds()).toEqual(new Set(['m-cafe']))
    history.noteContextTokens(1_000, history.revision)
    await history.compact('limit')
    expect(history.shownMemoryIds().size).toBe(0)
    history.apply(memoryNote(1, note))
    expect(history.shownMemoryIds().size).toBe(0)
    expect(history.toMessages().some((m) => textOf(m).includes(note.text))).toBe(false)
  })

  it('ends with the user message while the assistant reply of the turn has not arrived', () => {
    const { history } = makeHistory()
    history.apply(user(1, 'a'))
    history.apply(assistant(1, 'b'))
    history.apply(user(2, 'c'))
    expect(history.toMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('marks an interruption after what was spoken, marks it alone when nothing was said, and marks a failure', () => {
    const { history } = makeHistory()
    history.apply(user(1, 'a'))
    history.apply(assistant(1, '明日は晴天で、', { interrupted: 'while-speaking' }))
    history.apply(user(2, 'b'))
    history.apply(assistant(2, '', { interrupted: 'before-reply' }))
    history.apply(user(3, 'c'))
    history.apply(assistant(3, '途中', { failed: true }))
    const contents = history.toMessages().map(textOf)
    expect(contents[1]).toBe(`明日は晴天で、${INTERRUPTED_WHILE_SPEAKING}`)
    expect(contents[3]).toBe(INTERRUPTED_BEFORE_REPLY)
    expect(contents[5]).toBe('途中(応答が途中で失敗した)')
  })

  it('appends what was not sent yet and the marker after the messages already sent when a turn is interrupted after a tool result', () => {
    const { history } = makeHistory()
    history.apply(user(1, '大阪の天気'))
    history.apply(message(1, 'assistant', [{ type: 'tool_call', id: 't1', name: 'show_weather', input: {} }]))
    history.apply(message(1, 'user', [{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{}' }]))
    history.apply(assistant(1, '晴天', { interrupted: 'while-speaking' }))
    const messages = history.toMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[3]).toEqual(text('assistant', `晴天${INTERRUPTED_WHILE_SPEAKING}`))
    // When the text itself was already sent and the interruption came while speaking, only the marker is added.
    history.apply(user(2, 'もう一度'))
    history.apply(message(2, 'assistant', [{ type: 'text', text: '晴天です。' }]))
    history.apply(assistant(2, '晴天です。', { interrupted: 'while-speaking' }))
    expect(history.toMessages().at(-1)).toEqual(text('assistant', INTERRUPTED_WHILE_SPEAKING))
  })

  it('adds only the marker after a reply whose rounds were all sent, when what was spoken puts a space between them', () => {
    const { history } = makeHistory()
    history.apply(user(1, 'What is the weather tomorrow?'))
    history.apply(messages(
      1,
      { role: 'assistant', parts: [{ type: 'text', text: 'Let me look that up.' }, { type: 'tool_call', id: 't1', name: 'show_weather', input: {} }] },
      { role: 'user', parts: [{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{}' }] }
    ))
    history.apply(messages(1, text('assistant', 'It will be sunny tomorrow.')))
    // The words of a language that writes them apart are kept apart on the screen and in the log across the pause.
    history.apply(assistant(1, 'Let me look that up. It will be sunny tomorrow.', { interrupted: 'while-speaking' }))
    expect(history.toMessages().at(-1)).toEqual(text('assistant', INTERRUPTED_WHILE_SPEAKING))
  })

  it('reads a tool call and its results written one message a line, as the log held them before they went into one record', () => {
    const { history } = makeHistory()
    history.apply(user(1, '大阪の天気'))
    history.apply(message(1, 'assistant', [{ type: 'tool_call', id: 't1', name: 'show_weather', input: {} }]))
    history.apply(message(1, 'user', [{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{"temp":28}' }]))
    history.apply(message(1, 'assistant', [{ type: 'text', text: '晴天です。' }]))
    history.apply(assistant(1, '晴天です。'))
    const sent = history.toMessages()
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(sent[2].parts).toEqual([{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{"temp":28}' }])
  })

  it('reads a log that holds an assistant message without content as if the message were not there', () => {
    const { history } = makeHistory({
      stored: [
        user(1, 'ありがとう'),
        { ...message(1, 'assistant', []), native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [] } } as ConversationRecord,
        assistant(1, ''),
        user(2, '明日の天気は')
      ]
    })
    history.ensureLoaded()
    const sent = history.toMessages()
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.every((m) => m.parts.length > 0)).toBe(true)
  })

  it('drops a system notice interrupted before the reply, because the retry of the report adds it again', () => {
    const { history } = makeHistory()
    history.apply({ t: T0, kind: 'notice', turnId: 1, notice: 'job-done', text: '[システム通知] 作業が終わりました' })
    history.apply(assistant(1, '', { interrupted: 'before-reply' }))
    history.apply({ t: T0 + 5000, kind: 'notice', turnId: 2, notice: 'job-done', text: '[システム通知] 作業が終わりました' })
    history.apply(assistant(2, '終わりましたよ。'))
    expect(history.toMessages()).toEqual([text('user', '[システム通知] 作業が終わりました'), text('assistant', '終わりましたよ。')])
  })

  it('keeps the tool round trip of a turn whose spoken reply was recorded while its tool still ran', () => {
    const { history } = makeHistory()
    history.apply(user(5, '東京の天気は'))
    // Gemini Live records what it said once the transcript goes quiet, which can be before the turn's later records.
    history.apply(assistant(5, 'ちょっと見てみますね。'))
    history.apply(message(5, 'assistant', [{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } }]))
    history.apply(message(5, 'user', [{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{"id":"card-42"}' }]))
    history.apply(tool(5, 'recall', '{"query":"東京"}', '{"hits":[]}'))
    history.apply(message(5, 'assistant', [{ type: 'text', text: '晴天です。' }]))
    const messages = history.toMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[1].parts).toEqual([{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } }])
    expect(JSON.stringify(messages[2].parts)).toContain('card-42')
    expect(messages[3]).toEqual(text('assistant', '晴天です。'))
  })

  it('appends the job status after the notes of an utterance or a notice, and names the newest one the model can still read', async () => {
    const { history } = makeHistory({ recentTurns: 1 })
    history.apply({ ...user(1, '進み具合は'), notes: '[注: 文字入力]', jobStatus: 'JOBS-1' })
    history.apply(assistant(1, 'まだです。'))
    history.apply({ ...notice(2, '[システム通知] 終わった'), jobStatus: 'JOBS-2' })
    history.apply(assistant(2, '', { interrupted: 'before-reply' }))
    history.apply(user(3, 'ありがとう'))
    history.apply(assistant(3, 'どういたしまして。'))
    expect(textOf(history.toMessages()[0])).toBe('[2026/9/8(火) 16:48] 進み具合は\n\n[注: 文字入力]\n\nJOBS-1')
    // The withdrawn notice is not sent, so the status it carried was never read.
    expect(history.lastJobStatus()).toBe('JOBS-1')
    history.noteContextTokens(1_000, history.revision)
    await history.compact('limit')
    expect(history.lastJobStatus()).toBeNull()
  })

  it('turns a record that carries only an assistant reply into a standalone assistant message', () => {
    const { history } = makeHistory()
    history.apply(assistant(1, 'タイマーが終わりました。'))
    expect(history.toMessages()).toEqual([text('assistant', 'タイマーが終わりました。')])
  })

  it('starts from the latest checkpoint on load and replays only the records that follow it', () => {
    const stored: ConversationRecord[] = [
      user(1, '古い'),
      assistant(1, '古い返事'),
      { t: T0 + 9000, kind: 'checkpoint', summary: '以前の話', records: [user(2, '残した'), assistant(2, '残した返事')] },
      ...toolTurn(3, '{"temp":28}')
    ]
    const { history } = makeHistory({ stored })
    history.ensureLoaded()
    expect(history.summary).toBe('以前の話')
    expect(history.toMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(textOf(history.toMessages()[0])).toContain('残した')
    expect(history.toMessages()[3].parts).toEqual([{ type: 'tool_call', id: 't3', name: 'show_weather', input: { location: '大阪' } }])
  })
})

describe('loading the history from the log', () => {
  it('throws when the log cannot be read and reads it again on the next use, so no turn runs on an empty history', () => {
    let readable = false
    const history = new ConversationHistory({
      recentTurns: 0,
      compressAtTokens: 300,
      limitTokens: 600,
      hardLimitTokens: 1_000_000,
      load: () => {
        if (!readable) throw new Error('EACCES: permission denied')
        return [user(1, '前の話'), assistant(1, '前の返事')]
      },
      saveCheckpoint: () => {},
      summarize: async () => '要約',
      locale: () => 'ja-JP'
    })
    expect(() => history.ensureLoaded()).toThrow('EACCES')
    readable = true
    history.ensureLoaded()
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('前の話'), '前の返事'])
    expect(history.highestTurnId).toBe(1)
  })
})

describe('context length and the trigger for compaction', () => {
  it('estimates the context from the history until a measurement arrives, then adds what came after it', () => {
    const { history } = makeHistory()
    history.apply(user(1, 'あ'.repeat(40)))
    history.apply(assistant(1, 'い'.repeat(40)))
    expect(history.contextTokens).toBeGreaterThan(0)
    history.noteContextTokens(10_000, history.revision)
    expect(history.contextTokens).toBe(10_000)
    history.apply(user(2, 'う'.repeat(40)))
    expect(history.contextTokens).toBe(10_000 + estimateTokens('う'.repeat(40)))
    const result = JSON.stringify({ shown: true, data: 'x'.repeat(400) })
    history.apply(message(2, 'assistant', [{ type: 'tool_call', id: 't2', name: 'show_weather', input: {} }]))
    history.apply(message(2, 'user', [{ type: 'tool_result', callId: 't2', name: 'show_weather', content: result }]))
    expect(history.contextTokens).toBeGreaterThan(10_000 + estimateTokens('う'.repeat(40)) + estimateTokens(result))
  })

  it('needs no compaction while no turn has been answered', () => {
    const { history } = makeHistory()
    history.apply(user(1, 'u1'))
    history.noteContextTokens(100_000, history.revision)
    expect(history.needsCompaction()).toBe('none')
    history.apply(assistant(1, 'a1'))
    expect(history.needsCompaction()).toBe('now')
  })

  it('reports soon past the threshold, now past the limit, and block past the hard limit', () => {
    const { history } = makeHistory({ compressAtTokens: 300, limitTokens: 600, hardLimitTokens: 900 })
    for (let i = 0; i < 4; i++) turn(history, i)
    history.noteContextTokens(100, history.revision)
    expect(history.needsCompaction()).toBe('none')
    history.noteContextTokens(300, history.revision)
    expect(history.needsCompaction()).toBe('soon')
    history.noteContextTokens(600, history.revision)
    expect(history.needsCompaction()).toBe('now')
    history.noteContextTokens(900, history.revision)
    expect(history.needsCompaction()).toBe('block')
  })

  it('needs no compaction when only the turns that must stay raw are left, however long the context is', () => {
    const { history } = makeHistory({ recentTurns: 30 })
    for (let i = 0; i < 20; i++) turn(history, i)
    history.noteContextTokens(100_000, history.revision)
    expect(history.needsCompaction()).toBe('none')
  })

  /**
   * A turn can be left without a reply for good: under Gemini Live the notice of a finished job and the
   * report spoken for it carry different turn ids, Gemini Live records nothing for a turn cut off
   * before it spoke, and quitting or a crash can end a turn half way.
   */
  it.each([
    ['a notice whose spoken report came under another turn id', [notice(1, '[システム通知] ジョブ「調査」が完了した。'), assistant(2, '調査が終わりました。')]],
    ['an utterance cut off before any reply was recorded', [user(1, '予定を教えて'), message(1, 'assistant', [{ type: 'text', text: '調べ' }])]]
  ])('folds the turns after %s once the context passes the limit', async (_case, unanswered) => {
    const { history } = makeHistory({ recentTurns: 2 })
    for (const record of unanswered) history.apply(record)
    for (let i = 10; i < 40; i++) turn(history, i, 10)
    history.noteContextTokens(10_000, history.revision)
    expect(history.needsCompaction()).toBe('now')
    await history.compact('limit')
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('u38'), 'a38'.repeat(10), expect.stringContaining('u39'), 'a39'.repeat(10)])
  })

  it('keeps the newest turn out of a compaction while its reply has not arrived, even when older turns never got one', async () => {
    const { history } = makeHistory()
    history.apply(user(1, '古い質問'))
    turn(history, 2)
    history.apply(user(3, '明日の天気は'))
    history.noteContextTokens(10_000, history.revision)
    await history.compact('limit')
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('明日の天気は')])
    history.apply(assistant(3, '晴れです。'))
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('明日の天気は'), '晴れです。'])
  })

  it('does not let a measurement of a request built before a compaction undo it, so the next turn starts no second one', async () => {
    let finish!: (text: string) => void
    const { history } = makeHistory({ recentTurns: 30, limitTokens: 200_000, summarize: () => new Promise<string>((resolve) => { finish = resolve }) })
    for (let i = 0; i < 50; i++) turn(history, i, 20)
    history.noteContextTokens(200_001, history.revision)
    expect(history.needsCompaction()).toBe('now')
    // A turn starts the compaction without waiting for it and sends its request with the history as it stands.
    const compaction = history.compact('limit')
    const builtAt = history.revision
    history.apply(user(100, '明日の天気は'))
    history.apply(assistant(100, '晴れです。'))
    finish('引き継ぎ')
    await compaction
    const left = history.contextTokens
    expect(left).toBeLessThan(200_000)
    // The turn ends after the compaction and reports what the server counted on that older request.
    history.noteContextTokens(200_001, builtAt)
    expect(history.contextTokens).toBe(left)
    expect(history.needsCompaction()).not.toBe('now')
    // A request built from the compacted history is measured as usual.
    history.noteContextTokens(200_001, history.revision)
    expect(history.needsCompaction()).toBe('now')
  })
})

describe('compact', () => {
  it('summarizes the answered turns with their text and the tool names and inputs, and passes no tool results', async () => {
    const summarize = vi.fn(async (_existing: string, log: string) => `要約(${log.split('\n').length}行)`)
    const { history, checkpoints } = makeHistory({ compressAtTokens: 300, summarize })
    for (const record of toolTurn(0, JSON.stringify({ secret: 'x'.repeat(200) }))) history.apply(record)
    for (let i = 1; i < 4; i++) turn(history, i, 40)
    history.noteContextTokens(5_000, history.revision)
    await history.compact('quiet')
    expect(summarize).toHaveBeenCalledOnce()
    const log = summarize.mock.calls[0][1]
    expect(log).toBe(
      ['ユーザー: 大阪の天気', '(ツール show_weather {"location":"大阪"})', 'アシスタント: 晴天です。', ...[1, 2, 3].flatMap((i) => [`ユーザー: u${i}`, `アシスタント: ${`a${i}`.repeat(40)}`])].join('\n')
    )
    expect(log).not.toContain('x'.repeat(200))
    expect(history.toMessages()).toEqual([])
    expect(history.summary).toBe('要約(9行)')
    expect(history.contextTokens).toBeLessThan(5_000)
    expect(checkpoints[0].stats).toMatchObject({ reason: 'quiet', summarizedTurns: 4 })
    expect(checkpoints[0].records).toEqual([])
  })

  it('keeps the last recentTurns raw, folds only what is older, and keeps fewer when they alone exceed half of the limit', async () => {
    const summarize = vi.fn(async () => '要約')
    const { history } = makeHistory({ recentTurns: 2, compressAtTokens: 10, limitTokens: 100_000, summarize })
    for (let i = 0; i < 5; i++) turn(history, i)
    history.noteContextTokens(100, history.revision)
    await history.compact('quiet')
    expect(summarize.mock.calls[0][1]).toBe('ユーザー: u0\nアシスタント: a0\nユーザー: u1\nアシスタント: a1\nユーザー: u2\nアシスタント: a2')
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('u3'), 'a3', expect.stringContaining('u4'), 'a4'])

    // The two turns that would stay exceed half of the limit, which is 1.5 turns, so only the one turn that fits is kept.
    const perTurn = estimateTokens('u3') + estimateTokens('a3'.repeat(20))
    const tight = makeHistory({ recentTurns: 2, compressAtTokens: 10, limitTokens: 3 * perTurn, summarize })
    for (let i = 0; i < 4; i++) turn(tight.history, i, 20)
    tight.history.noteContextTokens(1_000, tight.history.revision)
    await tight.history.compact('quiet')
    expect(tight.history.toMessages().map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(tight.history.toMessages()[1])).toBe('a3'.repeat(20))
  })

  it('keeps the turns added while the summary was being written and leaves a turn in progress out of it', async () => {
    let finish!: (text: string) => void
    const summarize = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const { history, checkpoints } = makeHistory({ compressAtTokens: 10, summarize })
    turn(history, 1)
    turn(history, 2)
    history.apply(user(3, 'u3'))
    history.noteContextTokens(100, history.revision)
    const compaction = history.compact('limit')
    expect(summarize).toHaveBeenCalledOnce()
    expect(summarize.mock.calls[0][1]).toBe('ユーザー: u1\nアシスタント: a1\nユーザー: u2\nアシスタント: a2')
    history.apply(assistant(3, 'a3'))
    turn(history, 4)
    finish('引き継ぎ')
    await compaction
    expect(history.summary).toBe('引き継ぎ')
    expect(history.toMessages().map(textOf)).toEqual([expect.stringContaining('u3'), 'a3', expect.stringContaining('u4'), 'a4'])
    expect(checkpoints[0].records.map((r) => [r.kind, (r as { turnId?: number }).turnId])).toEqual([['user', 3], ['assistant', 3], ['user', 4], ['assistant', 4]])
    expect(checkpoints[0].stats).toMatchObject({ reason: 'limit', summarizedTurns: 2 })
  })

  it('passes the existing summary to summarize and replaces it with the rewritten one', async () => {
    const summarize = vi.fn(async () => '統合済み')
    const { history } = makeHistory({
      stored: [{ t: T0, kind: 'checkpoint', summary: '過去の要約', records: [] }],
      compressAtTokens: 10,
      summarize
    })
    history.ensureLoaded()
    for (let i = 0; i < 4; i++) turn(history, i)
    history.noteContextTokens(100, history.revision)
    await history.compact('quiet')
    expect(summarize.mock.calls[0][0]).toBe('過去の要約')
    expect(history.summary).toBe('統合済み')
  })

  it('leaves the history unchanged and reports the reason when summarizing fails', async () => {
    const { history, errors, checkpoints } = makeHistory({
      compressAtTokens: 10,
      summarize: async () => {
        throw new Error('api down')
      }
    })
    for (let i = 0; i < 4; i++) turn(history, i)
    history.noteContextTokens(100, history.revision)
    const before = history.toMessages()
    await history.compact('quiet')
    expect(history.toMessages()).toEqual(before)
    expect(history.summary).toBe('')
    expect(checkpoints).toEqual([])
    expect(errors[0]).toContain('summarize: api down')
    expect(history.needsCompaction()).toBe('soon')
  })

  it('folds every answered turn into the summary for daily whatever the threshold is, and lets replaceSummary swap the summary', async () => {
    const summarize = vi.fn(async () => '一日の要約')
    const { history, checkpoints } = makeHistory({ compressAtTokens: 100_000, summarize })
    for (let i = 0; i < 3; i++) turn(history, i)
    history.noteContextTokens(50, history.revision)
    await history.compact('daily')
    expect(summarize).toHaveBeenCalledOnce()
    expect(history.toMessages()).toEqual([])
    expect(history.summary).toBe('一日の要約')
    expect(history.rawWindowStart()).toBeNull()
    history.replaceSummary('')
    expect(history.summary).toBe('')
    expect(checkpoints.at(-1)!.summary).toBe('')
  })

  it('runs only one compaction at a time', async () => {
    let calls = 0
    const { history } = makeHistory({
      compressAtTokens: 10,
      summarize: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return '要約'
      }
    })
    for (let i = 0; i < 4; i++) turn(history, i)
    history.noteContextTokens(100, history.revision)
    await Promise.all([history.compact('quiet'), history.compact('quiet')])
    expect(calls).toBe(1)
  })
})
