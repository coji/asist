import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessage, ConversationRequest, SearchEvent, ToolCallPart } from '@shared/conversation'

/** The Anthropic adapter. These tests run a fake Messages API stream and check the conversion to the ASIST types. */

type Script = (emit: { event: (event: unknown) => void; block: (block: unknown) => void }) => { content: unknown[]; stop_reason: string | null }

const mocks = vi.hoisted(() => ({
  script: null as Script | null,
  failWith: null as Error | null,
  params: [] as Array<Record<string, unknown>>
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        mocks.params.push(structuredClone({ ...params }))
        const handlers = new Map<string, (value: unknown) => void>()
        return {
          on(event: string, handler: (value: unknown) => void) {
            handlers.set(event, handler)
            return this
          },
          async finalMessage() {
            const final = mocks.script!({ event: (e) => handlers.get('streamEvent')?.(e), block: (b) => handlers.get('contentBlock')?.(b) })
            if (mocks.failWith) throw mocks.failWith
            return { ...final, usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 } }
          }
        }
      }
    }
  }
}))

const MODEL = { provider: 'anthropic' as const, id: 'claude-sonnet-5' }

const request = (over: Partial<ConversationRequest> = {}): ConversationRequest => ({
  model: MODEL,
  locale: 'ja-JP',
  maxTokens: 1000,
  system: [
    { name: 'base', text: 'BASE' },
    { name: 'memory', text: 'MEMORY' }
  ],
  tools: [{ name: 'show_weather', description: '天気', inputSchema: { type: 'object', properties: {} } }],
  webSearch: false,
  messages: [{ role: 'user', parts: [{ type: 'text', text: '大阪の天気' }] }],
  signal: new AbortController().signal,
  ...over
})

async function open(over: Partial<ConversationRequest> = {}) {
  const { anthropicAdapter } = await import('../src/main/services/llm/anthropic')
  const stream = anthropicAdapter.stream(request(over), 'key')
  const seen = { text: [] as string[], calls: [] as ToolCallPart[], search: [] as SearchEvent[] }
  stream.on('text', (delta) => seen.text.push(delta))
  stream.on('toolCall', (call) => seen.calls.push(call))
  stream.on('search', (event) => seen.search.push(event))
  return { stream, seen }
}

const textDelta = (text: string): unknown => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
const THINKING = { type: 'thinking', thinking: '', signature: 'sig' }
const TOOL_USE = { type: 'tool_use', id: 't1', name: 'show_weather', input: { location: '大阪' } }

beforeEach(() => {
  vi.resetModules()
  mocks.script = null
  mocks.failWith = null
  mocks.params.length = 0
})

describe('toAnthropicMessages', () => {
  const assistant: ConversationMessage = {
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }],
    native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [THINKING, TOOL_USE] }
  }
  const results: ConversationMessage = {
    role: 'user',
    parts: [
      { type: 'text', text: '[注]' },
      { type: 'tool_result', callId: 't1', name: 'show_weather', content: 'HTTP 503', isError: true }
    ]
  }

  it('sends the signed thinking back to the same model, puts tool results before the text, and marks only the last block for the cache', async () => {
    const { toAnthropicMessages } = await import('../src/main/services/llm/anthropic')
    expect(toAnthropicMessages([assistant, results], 'claude-sonnet-5')).toEqual([
      { role: 'assistant', content: [THINKING, TOOL_USE] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'HTTP 503', is_error: true },
          { type: 'text', text: '[注]', cache_control: { type: 'ephemeral' } }
        ]
      }
    ])
  })

  it('sets the cache breakpoint on every request without keeping it in the history message, which would exceed the limit next turn', async () => {
    const { toAnthropicMessages } = await import('../src/main/services/llm/anthropic')
    const tail: ConversationMessage = { role: 'assistant', parts: [{ type: 'text', text: '途中' }], native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [{ type: 'text', text: '途中' }] } }
    const sent = toAnthropicMessages([tail], 'claude-sonnet-5')
    expect(sent[0].content).toEqual([{ type: 'text', text: '途中', cache_control: { type: 'ephemeral' } }])
    expect(tail.native!.payload).toEqual([{ type: 'text', text: '途中' }])
  })

  it('rebuilds a reply from another model out of its parts and sends no thinking', async () => {
    const { toAnthropicMessages } = await import('../src/main/services/llm/anthropic')
    expect(toAnthropicMessages([assistant, results], 'claude-haiku-4-5')[0]).toEqual({ role: 'assistant', content: [TOOL_USE] })
  })
})

describe('the Anthropic stream', () => {
  it('puts a cache breakpoint on every system layer and on the last message, never more than four', async () => {
    mocks.script = () => ({ content: [{ type: 'text', text: 'はい' }], stop_reason: 'end_turn' })
    const { stream } = await open({
      system: [
        { name: 'base', text: 'BASE' },
        { name: 'memory', text: 'MEMORY' },
        { name: 'summary', text: 'SUMMARY' }
      ]
    })
    await stream.final()
    const system = mocks.params[0].system as Array<{ text: string; cache_control?: unknown }>
    expect(system.map((block) => [block.text, block.cache_control !== undefined])).toEqual([['BASE', true], ['MEMORY', true], ['SUMMARY', true]])
    // A fifth cache_control block makes the API answer with a 400.
    expect(JSON.stringify(mocks.params[0]).split('"cache_control"').length - 1).toBe(4)
  })

  it('marks each system layer for the cache and reports a completed tool call without waiting for the end of the response', async () => {
    const spoken = { type: 'text', text: '調べますね。' }
    mocks.script = ({ event, block }) => {
      block(THINKING)
      event(textDelta('調べ'))
      event(textDelta('ますね。'))
      block(spoken)
      block(TOOL_USE)
      return { content: [THINKING, spoken, TOOL_USE], stop_reason: 'tool_use' }
    }
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(mocks.params[0].system).toEqual([
      { type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'MEMORY', cache_control: { type: 'ephemeral' } }
    ])
    expect(seen.text).toEqual(['調べ', 'ますね。'])
    expect(seen.calls).toEqual([{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }])
    expect(result.stop).toBe('tool_calls')
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [{ type: 'text', text: '調べますね。' }, seen.calls[0]],
      native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [THINKING, spoken, TOOL_USE] }
    })
    expect(result.usage).toEqual({ input: 100, cacheRead: 900, cacheCreation: 50, output: 20, webSearches: 0 })
  })

  it('reports the start and the results of a web search, and sets pendingServerTool while a search has no result yet', async () => {
    const serverUse = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '最新ニュース' } }
    const searched = { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A', encrypted_content: 'enc' }] }
    mocks.script = ({ event, block }) => {
      event({ type: 'content_block_start', content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' } })
      event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":"最新' } })
      event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'ニュース"}' } })
      block(serverUse)
      block(searched)
      const answer = {
        type: 'text',
        text: 'ニュースです。',
        citations: [
          { type: 'web_search_result_location', url: 'https://a.example', title: 'A', cited_text: '最新ニュースは', encrypted_index: 'idx' },
          { type: 'web_search_result_location', url: 'https://a.example', title: 'A', cited_text: '二度目', encrypted_index: 'idx2' }
        ]
      }
      block(answer)
      return { content: [serverUse, searched, answer], stop_reason: 'end_turn' }
    }
    const done = await open({ webSearch: true })
    const result = await done.stream.final()
    expect((mocks.params[0].tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(['show_weather', 'web_search'])
    // The results go out as soon as the search returns; the citations sit on the text that follows, so they go out once at the end, one per URL.
    expect(done.seen.search).toEqual([
      { phase: 'start' },
      { phase: 'done', query: '最新ニュース', sources: [{ url: 'https://a.example', title: 'A' }] },
      { phase: 'cited', sources: [{ url: 'https://a.example', title: 'A', cited: true, snippet: '最新ニュースは' }] }
    ])
    expect(result.pendingServerTool).toBeUndefined()

    mocks.script = ({ block }) => {
      block(serverUse)
      block(TOOL_USE)
      return { content: [serverUse, TOOL_USE], stop_reason: 'tool_use' }
    }
    expect((await (await open({ webSearch: true })).stream.final()).pendingServerTool).toBe(true)
  })

  it('gives each search the query it was called with, also when two calls come before their results or a result comes in the next response', async () => {
    const osaka = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '大阪 天気' } }
    const kyoto = { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: '京都 天気' } }
    const resultOf = (use: { id: string }) => ({ type: 'web_search_tool_result', tool_use_id: use.id, content: [{ type: 'web_search_result', url: `https://${use.id}.example`, title: use.id, encrypted_content: 'enc' }] })
    const queries = (search: SearchEvent[]) => search.flatMap((event) => (event.phase === 'done' ? [event.query] : []))
    mocks.script = ({ event, block }) => {
      for (const use of [osaka, kyoto]) {
        event({ type: 'content_block_start', content_block: { type: 'server_tool_use', id: use.id, name: 'web_search' } })
        event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify(use.input) } })
        block(use)
      }
      block(resultOf(osaka))
      block(resultOf(kyoto))
      return { content: [osaka, kyoto, resultOf(osaka), resultOf(kyoto)], stop_reason: 'end_turn' }
    }
    const parallel = await open({ webSearch: true })
    await parallel.stream.final()
    expect(queries(parallel.seen.search)).toEqual(['大阪 天気', '京都 天気'])

    // A search called together with a client tool runs once the tool's result is sent, and its result opens the next response.
    const called: ConversationMessage = {
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }],
      native: { provider: 'anthropic', model: MODEL.id, payload: [osaka, TOOL_USE] }
    }
    const results: ConversationMessage = { role: 'user', parts: [{ type: 'tool_result', callId: 't1', name: 'show_weather', content: '{"temp":28}' }] }
    mocks.script = ({ block }) => {
      block(resultOf(osaka))
      return { content: [resultOf(osaka)], stop_reason: 'end_turn' }
    }
    const next = await open({ webSearch: true, messages: [...request().messages, called, results] })
    await next.stream.final()
    expect(queries(next.seen.search)).toEqual(['大阪 天気'])
  })

  it('keeps a broken stream in the snapshot but leaves out the provider-side tool call whose result it cannot supply', async () => {
    mocks.script = ({ event, block }) => {
      block(THINKING)
      block(TOOL_USE)
      block({ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} })
      event(textDelta('少々'))
      return { content: [], stop_reason: null }
    }
    mocks.failWith = new Error('terminated')
    const { stream } = await open({ webSearch: true })
    await expect(stream.final()).rejects.toThrow('terminated')
    expect(stream.snapshot()).toEqual({
      role: 'assistant',
      parts: [
        { type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } },
        { type: 'text', text: '少々' }
      ],
      // Sending a server_tool_use back without its result answers with a 400.
      native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [THINKING, TOOL_USE, { type: 'text', text: '少々' }] }
    })
  })

  /**
   * The API closes a tool_use block that the output limit cut off like a whole one, with its input
   * parsed as far as it got. Running it would act on half the input, and sending it back without a
   * result is refused with a 400.
   */
  it('reports a tool call once the next block starts, and drops one the output limit cut off from the calls and from what goes back', async () => {
    const spoken = { type: 'text', text: '調べますね。' }
    const cut = { type: 'tool_use', id: 't2', name: 'show_weather', input: { location: '東' } }
    const order: string[] = []
    mocks.script = ({ event, block }) => {
      event(textDelta('調べますね。'))
      block(spoken)
      block(TOOL_USE)
      event({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't2', name: 'show_weather' } })
      order.push('second block started')
      block(cut)
      return { content: [spoken, TOOL_USE, cut], stop_reason: 'max_tokens' }
    }
    const { anthropicAdapter } = await import('../src/main/services/llm/anthropic')
    const stream = anthropicAdapter.stream(request(), 'key')
    stream.on('toolCall', (call) => order.push(`call ${call.id}`))
    const result = await stream.final()
    expect(order).toEqual(['call t1', 'second block started'])
    expect(result.stop).toBe('max_tokens')
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [{ type: 'text', text: '調べますね。' }, { type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '大阪' } }],
      native: { provider: 'anthropic', model: 'claude-sonnet-5', payload: [spoken, TOOL_USE] }
    })
  })

  it('treats a reply cut off by the context window like the output limit so it can be continued, and fails on an unknown stop reason', async () => {
    const spoken = { type: 'text', text: '長い' }
    const stopWith = (stop_reason: string): void => {
      mocks.script = ({ block }) => {
        block(spoken)
        return { content: [spoken], stop_reason }
      }
    }
    stopWith('model_context_window_exceeded')
    expect((await (await open()).stream.final()).stop).toBe('max_tokens')
    stopWith('pause_turn')
    expect((await (await open()).stream.final()).stop).toBe('pause')
    stopWith('refusal')
    expect((await (await open()).stream.final()).stop).toBe('refusal')
    stopWith('something_new')
    await expect((await open()).stream.final()).rejects.toThrow('something_new')
  })
})
