import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessage, ConversationRequest, ToolCallPart } from '@shared/conversation'
import { isTransientApiError } from '@shared/api-errors'

/** The Cerebras adapter. These tests run fake chat completion chunks and check the conversion to the ASIST types. */

const mocks = vi.hoisted(() => ({
  chunks: [] as unknown[],
  /** Runs once every chunk has been read, before the stream ends. */
  atEnd: null as (() => void) | null,
  params: [] as Array<Record<string, unknown>>,
  clients: [] as Array<{ baseURL?: string }>,
  /** The body of a request made without streaming. */
  response: null as unknown,
  /** A response body in server-sent events, read by the openai package's own parser instead of `chunks`. */
  sse: null as string | null
}))

vi.mock('openai', async () => ({
  // The class the openai package raises a failure inside a stream with, as its own parser does below.
  APIError: (await import('openai/core/error')).APIError,
  default: class FakeOpenAI {
    constructor(options: { baseURL?: string }) {
      mocks.clients.push(options)
    }
    chat = {
      completions: {
        create: async (params: Record<string, unknown>, options: { signal: AbortSignal }) => {
          mocks.params.push(params)
          if (!params.stream) return mocks.response
          if (mocks.sse !== null) {
            const { Stream } = await import('openai/core/streaming')
            return Stream.fromSSEResponse(new Response(mocks.sse), new AbortController(), undefined)
          }
          return (async function* () {
            for (const chunk of mocks.chunks) {
              // The openai package ends a stream quietly once its request is aborted.
              if (options.signal.aborted) return
              yield chunk
            }
            mocks.atEnd?.()
          })()
        }
      }
    }
  }
}))

const request = (over: Partial<ConversationRequest> = {}): ConversationRequest => ({
  model: { provider: 'cerebras', id: 'qwen-3-235b-a22b-instruct-2507' },
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

const delta = (value: Record<string, unknown>, finish: string | null = null): unknown => ({ choices: [{ delta: value, finish_reason: finish }] })
const USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
/** The last chunk as Cerebras documents it: the finish reason and the usage of the whole response ride on it together. */
const last = (value: Record<string, unknown>, finish: string): unknown => ({ ...(delta(value, finish) as object), usage: USAGE })

async function open(over: Partial<ConversationRequest> = {}) {
  const { cerebrasAdapter } = await import('../src/main/services/llm/cerebras')
  const stream = cerebrasAdapter.stream(request(over), 'key')
  const seen = { text: [] as string[], calls: [] as ToolCallPart[] }
  stream.on('text', (chunk) => seen.text.push(chunk))
  stream.on('toolCall', (call) => seen.calls.push(call))
  return { stream, seen }
}

beforeEach(() => {
  vi.resetModules()
  mocks.chunks = []
  mocks.atEnd = null
  mocks.params.length = 0
  mocks.clients.length = 0
  mocks.response = null
  mocks.sse = null
})

describe('toChatMessages', () => {
  it('puts a tool result as a tool message right after the assistant that called it, and the text in a user message after that', async () => {
    const { toChatMessages } = await import('../src/main/services/llm/cerebras')
    const messages: ConversationMessage[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c1', name: 'show_weather', input: { location: '大阪' } }],
        // The payload of another provider is not sent.
        native: { provider: 'openai', model: 'gpt-5.5', payload: [{ type: 'reasoning' }] }
      },
      {
        role: 'user',
        parts: [
          { type: 'tool_result', callId: 'c1', name: 'show_weather', content: 'HTTP 503', isError: true },
          { type: 'text', text: '[注]' }
        ]
      }
    ]
    expect(toChatMessages('SYSTEM', messages, 'ja-JP')).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'show_weather', arguments: '{"location":"大阪"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'エラー: HTTP 503' },
      { role: 'user', content: '[注]' }
    ])
  })
})

describe('the Cerebras stream', () => {
  it('sends to the Cerebras endpoint and drops the leading newlines left after the reasoning, across chunks, while keeping newlines inside the text', async () => {
    mocks.chunks = [delta({ reasoning: '考え中' }), delta({ content: '\n' }), delta({ content: '\n晴天' }), last({ content: 'です。\n明日も。' }, 'stop')]
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(mocks.clients[0].baseURL).toBe('https://api.cerebras.ai/v1')
    // A leading newline would make the first sentence that is read aloud empty.
    expect(seen.text).toEqual(['晴天', 'です。\n明日も。'])
    expect(result.message).toEqual({ role: 'assistant', parts: [{ type: 'text', text: '晴天です。\n明日も。' }] })
    expect(result.stop).toBe('end')
  })

  it('completes a tool call that arrives in pieces when the next call starts or the response ends', async () => {
    mocks.chunks = [
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'show_weather', arguments: '{"loca' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'tion":"大阪"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_tasks', arguments: '' } }] }),
      delta({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }
    ]
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(seen.calls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'show_weather', input: { location: '大阪' } },
      { type: 'tool_call', id: 'c2', name: 'list_tasks', input: {} }
    ])
    expect(result.stop).toBe('tool_calls')
    expect(result.usage).toEqual({ input: 100, cacheRead: 900, cacheCreation: 0, output: 20, webSearches: 0 })
  })

  it('reports max_tokens for a reply cut off by the output limit and fails when web search is requested, which it does not have', async () => {
    mocks.chunks = [last({ content: '長い' }, 'length')]
    expect((await (await open()).stream.final()).stop).toBe('max_tokens')
    await expect((await open({ webSearch: true })).stream.final()).rejects.toThrow('no built-in web search')
    expect(mocks.params).toHaveLength(1)
  })

  it('drops a tool call the output limit cut off and reports max_tokens, so the brain asks for the rest instead of failing the turn', async () => {
    mocks.chunks = [
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'add_note', arguments: '{"body":"一行目' } }] }),
      last({}, 'length')
    ]
    const cut = await open()
    const result = await cut.stream.final()
    expect(result.stop).toBe('max_tokens')
    expect(cut.seen.calls).toEqual([])
    expect(result.message.parts).toEqual([])
  })

  it('keeps the whole call before the one the output limit cut off, whose result the brain sends with the request for the rest', async () => {
    mocks.chunks = [
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'add_note', arguments: '{"body":"短い"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'add_note', arguments: '{"body":"長い' } }] }),
      last({}, 'length')
    ]
    const { stream, seen } = await open()
    const result = await stream.final()
    const whole = { type: 'tool_call', id: 'c1', name: 'add_note', input: { body: '短い' } }
    expect(seen.calls).toEqual([whole])
    expect(result.stop).toBe('max_tokens')
    expect(result.message.parts).toEqual([whole])
  })

  it('fails as a transient error when the timeout of the round cuts the response off, instead of finishing it with what arrived', async () => {
    mocks.chunks = [delta({ content: '要約は' }), delta({ content: 'ここまで。' }, 'stop'), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }]
    const controller = new AbortController()
    const { stream } = await open({ signal: controller.signal })
    stream.on('text', () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
    const error = await stream.final().then(() => null, (reason: unknown) => reason)
    expect(isTransientApiError(error)).toBe(true)
  })

  it('fails as a transient error on a stream the server ended without a finish reason, as when a connection drops', async () => {
    mocks.chunks = [delta({ content: '要約は' })]
    const error = await (await open()).stream.final().then(() => null, (reason: unknown) => reason)
    expect(isTransientApiError(error)).toBe(true)
  })

  it('fails as a transient error on a server error sent inside the stream, which the openai package raises without a status', async () => {
    const failure = { error: { message: 'The server had an error while processing your request.', type: 'server_error', param: null, code: null } }
    mocks.sse = `data: ${JSON.stringify(delta({ content: '要約は' }))}\n\ndata: ${JSON.stringify(failure)}\n\n`
    const error = await (await open()).stream.final().then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(isTransientApiError(error)).toBe(true)
  })

  it('keeps an answer cut off between its finish reason and its usage, by the server or by the timeout of the round, and reports no usage for it', async () => {
    mocks.chunks = [delta({ content: '要約です。' }, 'stop')]
    const closed = await (await open()).stream.final()
    expect(closed).toMatchObject({ message: { parts: [{ type: 'text', text: '要約です。' }] }, stop: 'end', usage: null })

    mocks.chunks = [delta({ content: '晴れです。' }, 'stop'), { choices: [], usage: USAGE }]
    const controller = new AbortController()
    const { stream } = await open({ signal: controller.signal })
    stream.on('text', () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
    expect(await stream.final()).toMatchObject({ message: { parts: [{ type: 'text', text: '晴れです。' }] }, stop: 'end', usage: null })
  })

  it('keeps an answer whose finish reason arrived before the timeout of the round fired', async () => {
    mocks.chunks = [delta({ content: '要約です。' }, 'stop'), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }]
    const controller = new AbortController()
    mocks.atEnd = () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const result = await (await open({ signal: controller.signal })).stream.final()
    expect(result.stop).toBe('end')
    expect(result.message.parts).toEqual([{ type: 'text', text: '要約です。' }])
  })
})

describe('the Cerebras JSON call', () => {
  it('reads the usage of the response and fails on a response that carries none, instead of counting no tokens', async () => {
    const { cerebrasAdapter } = await import('../src/main/services/llm/cerebras')
    const call = () =>
      cerebrasAdapter.completeJson(
        { model: request().model, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal },
        'key'
      )
    mocks.response = { choices: [{ message: { content: '{"bridge":"x"}' } }], usage: USAGE }
    const response = await call()
    expect(response.usage).toEqual({ input: 100, cacheRead: 0, cacheCreation: 0, output: 5, webSearches: 0 })
    expect(response.value()).toEqual({ bridge: 'x' })
    mocks.response = { choices: [{ message: { content: '{"bridge":"x"}' } }] }
    await expect(call()).rejects.toThrow()
  })
})
