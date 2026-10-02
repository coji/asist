import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessage, ConversationRequest, SearchEvent, ToolCallPart } from '@shared/conversation'
import { isTransientApiError } from '@shared/api-errors'
import { summarizeTurnUsage } from '@shared/turn-usage'
import type { ProviderCredential } from '../src/main/services/llm/adapter'

/** The OpenAI adapter. These tests run fake Responses API events and check the conversion to the ASIST types. */

const mocks = vi.hoisted(() => ({
  events: [] as unknown[],
  failAfter: null as Error | null,
  /** Runs once every event has been read, before the stream ends. */
  atEnd: null as (() => void) | null,
  /** A response body in server-sent events, read by the openai package's own parser instead of `events`. */
  sse: null as string | null,
  /** The response to a request that is not streamed. */
  response: null as unknown,
  params: [] as Array<Record<string, unknown>>,
  /** The key each client was built with, which is the access token for a ChatGPT sign-in. */
  apiKeys: [] as string[]
}))

vi.mock('openai', async () => ({
  // The class the openai package raises a failure inside a stream with, as its own parser does below.
  APIError: (await import('openai/core/error')).APIError,
  default: class FakeOpenAI {
    constructor(options: { apiKey: string }) {
      mocks.apiKeys.push(options.apiKey)
    }
    responses = {
      create: async (params: Record<string, unknown>, options: { signal: AbortSignal }) => {
        mocks.params.push(params)
        if (params.stream !== true) return mocks.response
        if (mocks.sse !== null) {
          const { Stream } = await import('openai/core/streaming')
          return Stream.fromSSEResponse(new Response(mocks.sse), new AbortController(), undefined)
        }
        return (async function* () {
          for (const event of mocks.events) {
            // The openai package ends a stream quietly once its request is aborted.
            if (options.signal.aborted) return
            yield event
          }
          mocks.atEnd?.()
          if (mocks.failAfter) throw mocks.failAfter
        })()
      }
    }
  }
}))

const MODEL = { provider: 'openai' as const, id: 'gpt-5.5' }

const request = (over: Partial<ConversationRequest> = {}): ConversationRequest => ({
  model: MODEL,
  locale: 'ja-JP',
  maxTokens: 1000,
  system: [
    { name: 'base', text: 'BASE' },
    { name: 'memory', text: 'MEMORY' }
  ],
  tools: [{ name: 'show_weather', description: '天気', inputSchema: { $schema: 'x', type: 'object', properties: { location: { type: 'string' } } } }],
  webSearch: false,
  messages: [{ role: 'user', parts: [{ type: 'text', text: '大阪の天気' }] }],
  signal: new AbortController().signal,
  ...over
})

const REASONING = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }
const CALL = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'show_weather', arguments: '{"location":"大阪"}', status: 'completed' }
const SPOKEN = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '調べますね。' }] }
/**
 * The reasoning items of an input that the API refuses with a 400 ("provided without its required
 * following item"): it pairs a reasoning item with the output item that followed it in its response,
 * by that item's id, so the next item has to be one that carries an id.
 */
const unpairedReasoning = (input: unknown[]): unknown[] =>
  input.filter((item, index) => (item as { type?: string }).type === 'reasoning' && typeof (input[index + 1] as { id?: unknown } | undefined)?.id !== 'string')
const completed = (usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 20 }): unknown => ({
  type: 'response.completed',
  response: { status: 'completed', usage }
})

const PLAN = { type: 'chatgpt' as const, account: 'oaiapp_1', accessToken: async () => 'plan-token' }

async function open(over: Partial<ConversationRequest> = {}, credential: ProviderCredential = { type: 'api-key', key: 'key' }) {
  const { openaiAdapter } = await import('../src/main/services/llm/openai')
  const stream = openaiAdapter.stream(request(over), credential)
  const seen = { text: [] as string[], calls: [] as ToolCallPart[], search: [] as SearchEvent[] }
  stream.on('text', (delta) => seen.text.push(delta))
  stream.on('toolCall', (call) => seen.calls.push(call))
  stream.on('search', (event) => seen.search.push(event))
  return { stream, seen }
}

beforeEach(() => {
  vi.resetModules()
  mocks.events = []
  mocks.failAfter = null
  mocks.atEnd = null
  mocks.sse = null
  mocks.response = null
  mocks.params.length = 0
  mocks.apiKeys.length = 0
})

describe('toResponsesInput', () => {
  const assistant: ConversationMessage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: '調べますね。' },
      { type: 'tool_call', id: 'call_1', name: 'show_weather', input: { location: '大阪' } }
    ],
    native: { provider: 'openai', model: 'gpt-5.5', payload: [REASONING, CALL] }
  }
  const results: ConversationMessage = {
    role: 'user',
    parts: [
      { type: 'tool_result', callId: 'call_1', name: 'show_weather', content: '{"temp":28}' },
      { type: 'tool_result', callId: 'call_2', name: 'show_news', content: 'HTTP 503', isError: true },
      { type: 'text', text: '[注]' }
    ]
  }

  it('sends the output items back to the same model unchanged, encrypted reasoning included, with results after the calls and text last', async () => {
    const { toResponsesInput } = await import('../src/main/services/llm/openai')
    expect(toResponsesInput([assistant, results], 'gpt-5.5', 'ja-JP')).toEqual([
      REASONING,
      CALL,
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":28}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'エラー: HTTP 503' },
      { role: 'user', content: '[注]' }
    ])
  })

  it('rebuilds a reply from another model or provider out of its parts and sends no reasoning', async () => {
    const { toResponsesInput } = await import('../src/main/services/llm/openai')
    const built = [
      { role: 'assistant', content: '調べますね。' },
      { type: 'function_call', call_id: 'call_1', name: 'show_weather', arguments: '{"location":"大阪"}' }
    ]
    expect(toResponsesInput([assistant], 'gpt-5.5-mini', 'ja-JP')).toEqual(built)
    expect(toResponsesInput([{ ...assistant, native: { provider: 'google', model: 'gpt-5.5', payload: {} } }], 'gpt-5.5', 'ja-JP')).toEqual(built)
  })

  it('sends no reasoning item without the item that followed it, from a reply a broken stream or the output limit cut off', async () => {
    const { toResponsesInput } = await import('../src/main/services/llm/openai')
    const search = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: '大阪 天気' } }
    const user = (text: string): ConversationMessage => ({ role: 'user', parts: [{ type: 'text', text }] })
    // As the log keeps them: a broken stream leaves the text it cut off without an id, and the output
    // limit can stop a response while it reasons again after a search.
    const stored: ConversationMessage[] = [
      user('大阪の天気'),
      { role: 'assistant', parts: [{ type: 'text', text: '大阪は' }], native: { provider: 'openai', model: 'gpt-5.5', payload: [REASONING, { role: 'assistant', content: '大阪は' }] } },
      user('続けて'),
      { role: 'assistant', parts: [{ type: 'text', text: '調べますね。' }], native: { provider: 'openai', model: 'gpt-5.5', payload: [REASONING, SPOKEN, search, { ...REASONING, id: 'rs_2' }] } },
      user('続けて')
    ]
    const input = toResponsesInput(stored, 'gpt-5.5', 'ja-JP')
    expect(unpairedReasoning(input)).toEqual([])
    for (const item of [{ role: 'assistant', content: '大阪は' }, REASONING, SPOKEN, search]) expect(input).toContainEqual(item)
  })
})

describe('CitationFilter', () => {
  it('removes a citation link that spans several deltas and keeps ordinary parentheses and brackets', async () => {
    const { CitationFilter } = await import('../src/main/services/llm/openai')
    const filter = new CitationFilter()
    const out = ['警戒が続いています。 (', '[weathernews.jp](https://weathernews', '.jp/news/1?utm_source=openai))', '明日は快晴(予報)で、[メモ]も', 'あります。']
      .map((delta) => filter.push(delta))
      .join('')
    // A citation left in the text would be read aloud as the bare URL.
    expect(out + filter.flush()).toBe('警戒が続いています。明日は快晴(予報)で、[メモ]もあります。')
  })

  it('lets the text after brackets that cannot become a citation through as it arrives, holding only what still can', async () => {
    const { CitationFilter } = await import('../src/main/services/llm/openai')
    const filter = new CitationFilter()
    const out = ['結論から言うと[注]', 'は不要です。', '次に[メモ](', 'メモ帳)を開きます。', '詳しくは [出典', '](https://a.example)です。'].map((delta) => filter.push(delta))
    // Text held until the end of the message reaches the speech synthesis only then.
    expect(out).toEqual(['結論から言うと', '[注]は不要です。', '次に', '[メモ](メモ帳)を開きます。', '詳しくは', 'です。'])
  })

  it('removes the outer parentheses of a citation whose closing ones arrive in separate deltas', async () => {
    const { CitationFilter } = await import('../src/main/services/llm/openai')
    const filter = new CitationFilter()
    const deltas = ['東京は晴れです', ' (', ...'[天気](https://tenki.example/a)', ')', '。']
    const out = deltas.map((delta) => filter.push(delta)).join('')
    // The outer parentheses belong to the citation, so neither may be left in the reply.
    expect(out + filter.flush()).toBe('東京は晴れです。')
  })
})

describe('the OpenAI stream', () => {
  it('keeps the conversation off the server, asks for encrypted reasoning, and joins the system layers into one instructions field', async () => {
    mocks.events = [completed()]
    const { stream } = await open()
    await stream.final()
    // With store: false, a reasoning item that arrived without encrypted_content cannot be sent back.
    expect(mocks.params[0]).toMatchObject({ store: false, instructions: 'BASE\n\nMEMORY', max_output_tokens: 1000 })
    expect(mocks.params[0].include).toContain('reasoning.encrypted_content')
    expect(mocks.params[0].tools).toEqual([
      { type: 'function', name: 'show_weather', description: '天気', parameters: { type: 'object', properties: { location: { type: 'string' } } }, strict: false }
    ])
  })

  it('reports a function call when its item completes and keeps the output items in order in native at the end', async () => {
    mocks.events = [
      { type: 'response.output_item.done', item: REASONING },
      { type: 'response.output_text.delta', delta: '調べ' },
      { type: 'response.output_text.delta', delta: 'ますね。' },
      { type: 'response.output_item.done', item: SPOKEN },
      { type: 'response.output_item.done', item: CALL },
      completed()
    ]
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(seen.text).toEqual(['調べ', 'ますね。'])
    expect(seen.calls).toEqual([{ type: 'tool_call', id: 'call_1', name: 'show_weather', input: { location: '大阪' } }])
    expect(result.stop).toBe('tool_calls')
    expect(result.message.parts).toEqual([{ type: 'text', text: '調べますね。' }, seen.calls[0]])
    expect(result.message.native).toEqual({ provider: 'openai', model: 'gpt-5.5', payload: [REASONING, SPOKEN, CALL] })
    // The tokens read from the cache are part of the reported input, so they are counted separately.
    expect(result.usage).toEqual({ input: 100, cacheRead: 900, cacheCreation: 0, output: 20, webSearches: 0 })
  })

  it('keeps the completed items and the spoken text in the snapshot when the stream breaks, so nothing spoken is lost on the way back', async () => {
    mocks.events = [
      { type: 'response.output_item.done', item: REASONING },
      { type: 'response.output_item.done', item: CALL },
      { type: 'response.output_text.delta', delta: '少々' }
    ]
    mocks.failAfter = new Error('terminated')
    const { stream } = await open()
    await expect(stream.final()).rejects.toThrow('terminated')
    expect(stream.snapshot()).toEqual({
      role: 'assistant',
      parts: [
        { type: 'tool_call', id: 'call_1', name: 'show_weather', input: { location: '大阪' } },
        { type: 'text', text: '少々' }
      ],
      native: { provider: 'openai', model: 'gpt-5.5', payload: [REASONING, CALL, { role: 'assistant', content: '少々' }] }
    })
  })

  it('reports the start of a web search and its results with the titles of the citations, falling back to the URLs the search returned', async () => {
    const searchCall = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: '最新ニュース', sources: [{ type: 'url', url: 'https://a.example' }] } }
    mocks.events = [
      { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
      { type: 'response.output_item.done', item: searchCall },
      { type: 'response.output_text.delta', delta: 'ニュースです。 ([B](https://b.' },
      { type: 'response.output_text.delta', delta: 'example))' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_2', role: 'assistant', content: [] } },
      { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://b.example', title: 'B' } },
      { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://b.example', title: 'B' } },
      completed()
    ]
    const cited = await open({ webSearch: true })
    const result = await cited.stream.final()
    expect(result.message.parts).toEqual([{ type: 'text', text: 'ニュースです。' }])
    expect(cited.seen.text.join('')).toBe('ニュースです。')
    // The fee is per search, on top of the tokens.
    expect(result.usage.webSearches).toBe(1)
    expect(mocks.params[0].tools).toContainEqual(expect.objectContaining({ type: 'web_search' }))
    expect(cited.seen.search).toEqual([{ phase: 'start' }, { phase: 'done', query: '最新ニュース', sources: [{ url: 'https://b.example', title: 'B', cited: true }] }])

    mocks.events = [{ type: 'response.output_item.done', item: searchCall }, completed()]
    const listed = await open({ webSearch: true })
    await listed.stream.final()
    expect(listed.seen.search.at(-1)).toEqual({ phase: 'done', query: '最新ニュース', sources: [{ url: 'https://a.example', title: 'https://a.example' }] })
  })

  it('maps the output limit to max_tokens and a refusal to refusal, and turns a failure inside the stream into an error with a status', async () => {
    mocks.events = [{ type: 'response.output_text.delta', delta: '長い' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]
    expect((await (await open()).stream.final()).stop).toBe('max_tokens')

    mocks.events = [{ type: 'response.refusal.done', refusal: 'no' }, completed()]
    expect((await (await open()).stream.final()).stop).toBe('refusal')

    // The stream closes normally even after a failure, so without an error it would pass as an empty reply.
    mocks.events = [{ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'slow down' } } }]
    await expect((await open()).stream.final()).rejects.toMatchObject({ status: 429 })
  })

  it('fails as a transient error when the server ends the stream before the completion event, as when a connection drops', async () => {
    mocks.events = [{ type: 'response.output_text.delta', delta: '大阪は' }]
    const error = await (await open()).stream.final().then(() => null, (reason: unknown) => reason)
    expect(isTransientApiError(error)).toBe(true)
  })

  it('keeps an answer whose completion event arrived before the timeout of the round fired', async () => {
    mocks.events = [{ type: 'response.output_text.delta', delta: '晴れです。' }, completed()]
    const controller = new AbortController()
    mocks.atEnd = () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const result = await (await open({ signal: controller.signal })).stream.final()
    // A finished reply taken for a cut one would be resumed and spoken again.
    expect(result.stop).toBe('end')
    expect(result.message.parts).toEqual([{ type: 'text', text: '晴れです。' }])
  })

  it('fails as a transient error when the timeout of the round cuts the response off', async () => {
    mocks.events = [{ type: 'response.output_text.delta', delta: '大阪は' }, { type: 'response.output_text.delta', delta: '晴れです。' }, completed()]
    const controller = new AbortController()
    const { stream } = await open({ signal: controller.signal })
    stream.on('text', () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
    const error = await stream.final().then(() => null, (reason: unknown) => reason)
    // A transient failure is retried, or resumed from what was already spoken.
    expect(isTransientApiError(error)).toBe(true)
  })

  it('drops a function call the output limit cut off and reports max_tokens, keeping the whole call before it', async () => {
    const cut = { ...CALL, id: 'fc_2', call_id: 'call_2', arguments: '{"location":', status: 'incomplete' }
    mocks.events = [
      { type: 'response.output_item.done', item: CALL },
      { type: 'response.output_item.done', item: cut },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
    ]
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(seen.calls.map((call) => call.id)).toEqual(['call_1'])
    // The brain sends the result of the whole call with its request for the rest; a call sent back without a result is refused.
    expect(result.stop).toBe('max_tokens')
    expect(result.message.native).toEqual({ provider: 'openai', model: 'gpt-5.5', payload: [CALL] })
  })

  it('counts a prompt written to the cache once, apart from the input, so the context length is the prompt that was sent', async () => {
    const usage = { input_tokens: 60_000, input_tokens_details: { cached_tokens: 20_000, cache_write_tokens: 30_000 }, output_tokens: 10 }
    mocks.events = [completed(usage)]
    const result = await (await open()).stream.final()
    expect(result.usage).toEqual({ input: 10_000, cacheRead: 20_000, cacheCreation: 30_000, output: 10, webSearches: 0 })
    expect(summarizeTurnUsage([result.usage!]).contextTokens).toBe(60_000)
  })

  it('treats an error event inside the stream as transient exactly when a failed response with the same code is', async () => {
    const message = 'The server had an error while processing your request.'
    const transient = async (code: string): Promise<boolean[]> => {
      const failures: unknown[] = []
      // The error event's fields as the SDK's types give them, then nested under `error` as the live API
      // is reported to send them, where the code can be null beside the type.
      for (const data of [
        { type: 'error', code, message, param: null, sequence_number: 3 },
        { type: 'error', sequence_number: 3, error: { type: code, code, message, param: null } },
        { type: 'error', sequence_number: 3, error: { type: code, code: null, message, param: null } }
      ]) {
        mocks.sse = `event: error\ndata: ${JSON.stringify(data)}\n\n`
        failures.push(await (await open()).stream.final().then(() => null, (reason: unknown) => reason))
      }
      mocks.sse = null
      mocks.events = [{ type: 'response.failed', response: { status: 'failed', error: { code, message } } }]
      failures.push(await (await open()).stream.final().then(() => null, (reason: unknown) => reason))
      expect(failures.every((failure) => failure instanceof Error)).toBe(true)
      return failures.map(isTransientApiError)
    }
    expect(await transient('server_error')).toEqual([true, true, true, true])
    expect(await transient('invalid_prompt')).toEqual([false, false, false, false])
  })

  it('keeps in native only the calls it handed over, so a call whose arguments are broken never goes back without a result', async () => {
    const broken = { ...CALL, id: 'fc_2', call_id: 'call_2', arguments: '{"location":' }
    mocks.events = [{ type: 'response.output_item.done', item: CALL }, { type: 'response.output_item.done', item: broken }, completed()]
    const { stream, seen } = await open()
    await expect(stream.final()).rejects.toThrow('show_weather')
    const payload = stream.snapshot()!.native!.payload as Array<{ type: string; call_id?: string }>
    // The API refuses a function_call sent without its output, and the turn has a result only for a call it was handed.
    expect(payload.filter((item) => item.type === 'function_call').map((item) => item.call_id)).toEqual(seen.calls.map((call) => call.id))
  })

  it('fails instead of running a tool call whose arguments are broken', async () => {
    mocks.events = [{ type: 'response.output_item.done', item: { ...CALL, arguments: '{"location":' } }, completed()]
    const { stream, seen } = await open()
    await expect(stream.final()).rejects.toThrow('show_weather')
    expect(seen.calls).toEqual([])
  })
})

describe('the OpenAI JSON call', () => {
  it('hands back the usage of a response the output limit cut short, failing only when its value is read', async () => {
    const { openaiAdapter } = await import('../src/main/services/llm/openai')
    // The reasoning used up the output limit before any JSON was written.
    mocks.response = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '',
      output: [REASONING],
      usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1024 }
    }
    const response = await openaiAdapter.completeJson({ model: MODEL, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 1024, signal: new AbortController().signal }, { type: 'api-key', key: 'key' })
    expect(response.usage).toEqual({ input: 300, cacheRead: 0, cacheCreation: 0, output: 1024, webSearches: 0 })
    expect(() => response.value()).toThrow('max_output_tokens')
  })
})

describe('OpenAI paid from the ChatGPT plan', () => {
  it('sends the access token as the bearer and leaves out the output limit, which the plan refuses', async () => {
    mocks.events = [{ type: 'response.output_item.done', item: SPOKEN }, completed()]
    const { stream } = await open({}, PLAN)
    await stream.final()
    expect(mocks.apiKeys).toEqual(['plan-token'])
    expect(mocks.params[0]).toMatchObject({ stream: true, store: false })
    expect(mocks.params[0]).not.toHaveProperty('max_output_tokens')
  })

  it('keeps the output limit for the API key', async () => {
    mocks.events = [{ type: 'response.output_item.done', item: SPOKEN }, completed()]
    const { stream } = await open()
    await stream.final()
    expect(mocks.params[0]).toMatchObject({ max_output_tokens: 1000 })
  })

  it('streams a JSON call with its input as a list, since the plan accepts nothing else, and reads the JSON from the message', async () => {
    const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '{"bridge":"はい"}' }] }
    mocks.events = [{ type: 'response.completed', response: { status: 'completed', output: [message], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 } } }]
    const { openaiAdapter } = await import('../src/main/services/llm/openai')
    const response = await openaiAdapter.completeJson({ model: MODEL, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 1024, signal: new AbortController().signal }, PLAN)
    expect(mocks.params[0]).toMatchObject({ stream: true, input: [{ role: 'user', content: 'u' }], text: { format: { type: 'json_schema', strict: true } } })
    expect(mocks.params[0]).not.toHaveProperty('max_output_tokens')
    expect(response.value()).toEqual({ bridge: 'はい' })
    expect(response.usage).toMatchObject({ input: 10, output: 5 })
  })

  it('fails a JSON call on the usage limit of the plan sent inside the stream, as a 429', async () => {
    mocks.events = [{ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]
    const { openaiAdapter } = await import('../src/main/services/llm/openai')
    const call = openaiAdapter.completeJson({ model: MODEL, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 1024, signal: new AbortController().signal }, PLAN)
    await expect(call).rejects.toMatchObject({ status: 429 })
  })

  it('finds a model among those the plan lists, since fetching one model needs a scope the sign-in does not have', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', visibility: 'list' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { openaiAdapter } = await import('../src/main/services/llm/openai')
      await openaiAdapter.retrieveModel('gpt-5.6-terra', PLAN, new AbortController().signal)
      await expect(openaiAdapter.retrieveModel('gpt-5.5-mini', PLAN, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
      expect(fetchMock.mock.calls[0]).toEqual(['https://api.openai.com/v1/models', expect.objectContaining({ headers: { authorization: 'Bearer plan-token' } })])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
