import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMessage, ConversationRequest, SearchEvent, ToolCallPart } from '@shared/conversation'
import { isTransientApiError } from '@shared/api-errors'
import { summarizeTurnUsage } from '@shared/turn-usage'

/** The Google adapter. These tests run fake generateContentStream chunks and check the conversion to the ASIST types. */

const mocks = vi.hoisted(() => ({
  chunks: [] as unknown[],
  failWith: null as unknown,
  params: [] as Array<{ model: string; contents: unknown[]; config: Record<string, unknown> }>
}))

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class FakeGoogle {
    models = {
      generateContentStream: async (params: { model: string; contents: unknown[]; config: Record<string, unknown> }) => {
        mocks.params.push(params)
        if (mocks.failWith) throw mocks.failWith
        return (async function* () {
          for (const chunk of mocks.chunks) yield chunk
        })()
      },
      generateContent: async (params: { model: string; contents: unknown[]; config: Record<string, unknown> }) => {
        mocks.params.push(params)
        return { text: '{"bridge":"x"}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }
      }
    }
  }
}))

const MODEL = { provider: 'google' as const, id: 'gemini-3.8-flash' }

const request = (over: Partial<ConversationRequest> = {}): ConversationRequest => ({
  model: MODEL,
  locale: 'ja-JP',
  maxTokens: 1000,
  system: [
    { name: 'base', text: 'BASE' },
    { name: 'memory', text: 'MEMORY' }
  ],
  tools: [{ name: 'show_weather', description: '天気', inputSchema: { $schema: 'x', type: 'object', additionalProperties: false, properties: {} } }],
  webSearch: false,
  messages: [{ role: 'user', parts: [{ type: 'text', text: '大阪の天気' }] }],
  signal: new AbortController().signal,
  ...over
})

const chunk = (parts: unknown[], extra: Record<string, unknown> = {}): unknown => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] })

async function open(over: Partial<ConversationRequest> = {}) {
  const { googleAdapter } = await import('../src/main/services/llm/google')
  const stream = googleAdapter.stream(request(over), 'key')
  const seen = { text: [] as string[], calls: [] as ToolCallPart[], search: [] as SearchEvent[] }
  stream.on('text', (delta) => seen.text.push(delta))
  stream.on('toolCall', (call) => seen.calls.push(call))
  stream.on('search', (event) => seen.search.push(event))
  return { stream, seen }
}

beforeEach(() => {
  vi.resetModules()
  mocks.chunks = []
  mocks.failWith = null
  mocks.params.length = 0
})

describe('toContents', () => {
  const signed = { functionCall: { id: 'g1', name: 'show_weather', args: { location: '大阪' } }, thoughtSignature: 'sig' }
  const assistant: ConversationMessage = {
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'g1', name: 'show_weather', input: { location: '大阪' } }],
    native: { provider: 'google', model: 'gemini-3.8-flash', payload: { role: 'model', parts: [signed] } }
  }

  it('sends the signed part back to the same model unchanged, because a tool call without its signature returns a 400', async () => {
    const { toContents } = await import('../src/main/services/llm/google')
    expect(toContents([assistant], 'gemini-3.8-flash')).toEqual([{ role: 'model', parts: [signed] }])
  })

  it('rebuilds a reply from another model out of its parts, puts results before the text, and returns a failure as error', async () => {
    const { toContents } = await import('../src/main/services/llm/google')
    const messages: ConversationMessage[] = [
      assistant,
      {
        role: 'user',
        parts: [
          { type: 'text', text: '[注]' },
          { type: 'tool_result', callId: 'g1', name: 'show_weather', content: 'HTTP 503', isError: true }
        ]
      }
    ]
    expect(toContents(messages, 'gemini-3.8-pro')).toEqual([
      { role: 'model', parts: [{ functionCall: { id: 'g1', name: 'show_weather', args: { location: '大阪' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'g1', name: 'show_weather', response: { error: 'HTTP 503' } } }, { text: '[注]' }] }
    ])
  })

  it('merges consecutive messages of the same role into one Content and sends no empty text', async () => {
    const { toContents } = await import('../src/main/services/llm/google')
    const messages: ConversationMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'a' }] },
      { role: 'user', parts: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '' }] },
      { role: 'user', parts: [{ type: 'text', text: 'c' }] }
    ]
    // The API rejects contents whose roles do not alternate, and an empty text.
    expect(toContents(messages, 'gemini-3.8-flash')).toEqual([{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }])
  })
})

describe('the Google stream', () => {
  it('leaves the thoughts unspoken, joins the text into one part, and keeps the signed functionCall in native as it arrived', async () => {
    const call = { functionCall: { id: 'g1', name: 'show_weather', args: { location: '大阪' } }, thoughtSignature: 'sig' }
    mocks.chunks = [
      chunk([{ text: '考え中', thought: true }]),
      chunk([{ text: '調べ' }]),
      chunk([{ text: 'ますね。' }]),
      chunk([call]),
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 30 } }
    ]
    const { stream, seen } = await open()
    const result = await stream.final()
    expect(seen.text).toEqual(['調べ', 'ますね。'])
    expect(seen.calls).toEqual([{ type: 'tool_call', id: 'g1', name: 'show_weather', input: { location: '大阪' } }])
    expect(result.stop).toBe('tool_calls')
    expect(result.message.parts).toEqual([{ type: 'text', text: '調べますね。' }, seen.calls[0]])
    expect(result.message.native).toEqual({ provider: 'google', model: 'gemini-3.8-flash', payload: { role: 'model', parts: [{ text: '調べますね。' }, call] } })
    // Thought tokens are billed as output.
    expect(result.usage).toEqual({ input: 100, cacheRead: 900, cacheCreation: 0, output: 50, webSearches: 0 })
    expect(mocks.params[0].config).toMatchObject({ systemInstruction: 'BASE\n\nMEMORY', maxOutputTokens: 1000 })
    expect(mocks.params[0].config.tools).toEqual([
      { functionDeclarations: [{ name: 'show_weather', description: '天気', parametersJsonSchema: { type: 'object', additionalProperties: false, properties: {} } }] }
    ])
  })

  it('sends a call and its result with the same id, also for a call that came without one, to the same model and to another', async () => {
    mocks.chunks = [chunk([{ functionCall: { name: 'show_weather', args: {} }, thoughtSignature: 'sig' }], { finishReason: 'STOP' })]
    const { stream, seen } = await open()
    const result = await stream.final()
    const id = seen.calls[0].id
    expect(id).not.toBe('')
    const { toContents } = await import('../src/main/services/llm/google')
    const results: ConversationMessage = { role: 'user', parts: [{ type: 'tool_result', callId: id, name: 'show_weather', content: '{}' }] }
    // Gemini matches results to calls by id when they come in another order, and a missing or different id pairs them wrongly.
    for (const model of [MODEL.id, 'gemini-3.8-pro']) {
      const [call, response] = toContents([result.message, results], model)
      expect(call.parts?.find((part) => part.functionCall)?.functionCall?.id).toBe(id)
      expect(response.parts?.[0]?.functionResponse?.id).toBe(id)
    }
  })

  it('reports the start of a Google search from its call part, keeps the call and result parts in native, and reads the sources from the last chunk', async () => {
    const searchCall = { toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['最新ニュース'] }, id: 's1' }, thoughtSignature: 'sig-call' }
    const searchResult = { toolResponse: { toolType: 'GOOGLE_SEARCH_WEB', response: {}, id: 's1' }, thoughtSignature: 'sig-result' }
    mocks.chunks = [
      chunk([searchCall]),
      chunk([searchResult]),
      chunk([{ text: 'ニュースです。' }]),
      {
        candidates: [
          {
            finishReason: 'STOP',
            groundingMetadata: {
              webSearchQueries: ['最新ニュース'],
              groundingChunks: [{ web: { uri: 'https://a.example', title: 'a.example' } }, { web: { uri: 'https://b.example' } }, { web: { uri: 'https://c.example', title: 'c.example' } }],
              groundingSupports: [{ segment: { text: 'ニュースです。' }, groundingChunkIndices: [2] }],
              searchEntryPoint: { renderedContent: '<style>.chip{}</style><div class="container"><a class="chip" href="https://s.example">最新ニュース</a></div>' }
            }
          }
        ]
      }
    ]
    const { stream, seen } = await open({ webSearch: true })
    const result = await stream.final()
    // Grounding is billed per search query the model ran.
    expect(result.usage.webSearches).toBe(1)
    expect(mocks.params[0].config.tools).toEqual([{ functionDeclarations: expect.any(Array), googleSearch: {} }])
    // Without this, a request that carries both function tools and Google search returns a 400.
    expect(mocks.params[0].config.toolConfig).toEqual({ includeServerSideToolInvocations: true })
    expect(result.message.parts).toEqual([{ type: 'text', text: 'ニュースです。' }])
    expect((result.message.native!.payload as { parts: unknown[] }).parts).toEqual([searchCall, searchResult, { text: 'ニュースです。' }])
    // The cited source comes first, a chunk's title is the site's domain, and the Search Suggestions block passes through unchanged.
    expect(seen.search).toEqual([
      { phase: 'start' },
      {
        phase: 'done',
        query: '最新ニュース',
        sources: [
          { url: 'https://c.example', title: 'c.example', site: 'c.example', cited: true },
          { url: 'https://a.example', title: 'a.example', site: 'a.example' },
          { url: 'https://b.example', title: 'https://b.example' }
        ],
        suggestions: '<style>.chip{}</style><div class="container"><a class="chip" href="https://s.example">最新ニュース</a></div>'
      }
    ])
  })

  it('ends the text part where a search starts, so the text said before the search and the answer after it stay two parts', async () => {
    mocks.chunks = [
      chunk([{ text: 'Let me look that up.' }]),
      chunk([{ toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['weather'] }, id: 's1' }, thoughtSignature: 'sig-call' }]),
      chunk([{ toolResponse: { toolType: 'GOOGLE_SEARCH_WEB', response: {}, id: 's1' }, thoughtSignature: 'sig-result' }]),
      chunk([{ text: 'It will be sunny tomorrow.' }], { finishReason: 'STOP' })
    ]
    const { stream } = await open({ webSearch: true, locale: 'en-US' })
    const result = await stream.final()
    // The conversation reads the pause at the search as the end of a sentence, and matches what it said to these parts.
    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Let me look that up.' },
      { type: 'text', text: 'It will be sunny tomorrow.' }
    ])
  })

  it('keeps the tokens of search results out of the context a grounded answer reports, since they are never sent again', async () => {
    mocks.chunks = [
      chunk([{ text: 'ニュースです。' }], { finishReason: 'STOP' }),
      { usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900, toolUsePromptTokenCount: 3000, candidatesTokenCount: 20 } }
    ]
    const result = await (await open({ webSearch: true })).stream.final()
    // The history compacts by this size, so search results counted in it would start a compaction early.
    expect(summarizeTurnUsage([result.usage]).contextTokens).toBe(1000)
  })

  it('leaves a search call whose result never arrived out of what is sent back after a broken stream', async () => {
    mocks.chunks = [chunk([{ text: '調べます。' }]), chunk([{ toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['x'] }, id: 's1' }, thoughtSignature: 'sig' }])]
    const { stream } = await open({ webSearch: true })
    await expect(stream.final()).rejects.toThrow()
    expect(stream.snapshot()!.native!.payload).toEqual({ role: 'model', parts: [{ text: '調べます。' }] })
  })

  it('fails as a transient error on a stream that ended without a finish reason, as when a connection drops, even after a whole tool call', async () => {
    const failure = async (): Promise<unknown> => (await open()).stream.final().then(() => null, (reason: unknown) => reason)
    mocks.chunks = [chunk([{ text: '調べます。' }])]
    expect(isTransientApiError(await failure())).toBe(true)
    // A functionCall arrives whole, so only the missing finish reason shows that the rest of the response was lost.
    mocks.chunks = [chunk([{ functionCall: { id: 'g1', name: 'show_weather', args: {} } }])]
    expect(isTransientApiError(await failure())).toBe(true)
  })

  it('maps the output limit to max_tokens and a safety stop to refusal, and fails on a finish reason it does not know', async () => {
    mocks.chunks = [chunk([{ text: '長い' }], { finishReason: 'MAX_TOKENS' })]
    expect((await (await open()).stream.final()).stop).toBe('max_tokens')
    mocks.chunks = [chunk([], { finishReason: 'SAFETY' })]
    expect((await (await open()).stream.final()).stop).toBe('refusal')
    mocks.chunks = [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]
    expect((await (await open()).stream.final()).stop).toBe('refusal')
    // A malformed function call must not pass as a reply that finished speaking.
    mocks.chunks = [chunk([], { finishReason: 'MALFORMED_FUNCTION_CALL' })]
    await expect((await open()).stream.final()).rejects.toThrow('MALFORMED_FUNCTION_CALL')
  })

  it('reports the 400 for an invalid key as an authentication failure with status 401 and passes other 400s through', async () => {
    const { ApiError } = await import('@google/genai')
    mocks.failWith = new ApiError({ status: 400, message: 'API key not valid. Please pass a valid API key.' })
    await expect((await open()).stream.final()).rejects.toMatchObject({ status: 401 })
    mocks.failWith = new ApiError({ status: 400, message: 'Function call is missing a thought_signature' })
    await expect((await open()).stream.final()).rejects.toMatchObject({ status: 400 })
  })
})

describe('the Google JSON call', () => {
  const thinkingSent = async (model: ConversationRequest['model']): Promise<{ streamed: unknown; json: unknown }> => {
    const { googleAdapter } = await import('../src/main/services/llm/google')
    mocks.params.length = 0
    mocks.chunks = [chunk([{ text: 'はい。' }], { finishReason: 'STOP' })]
    await (await open({ model })).stream.final()
    await googleAdapter.completeJson({ model, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal }, 'key')
    const [streamed, json] = mocks.params.map((params) => params.config.thinkingConfig)
    return { streamed, json }
  }

  it('thinks as deeply as the settings say, as the stream does', async () => {
    const { ThinkingLevel } = await import('@google/genai')
    expect(await thinkingSent({ ...MODEL, effort: 'high' })).toEqual({ streamed: { thinkingLevel: ThinkingLevel.HIGH }, json: { thinkingLevel: ThinkingLevel.HIGH } })
  })

  it('thinks as deeply as the stream does for a model whose depth the settings leave out', async () => {
    const { streamed, json } = await thinkingSent({ provider: 'google', id: 'gemini-3.5-flash-lite' })
    expect(streamed).toBeDefined()
    expect(json).toEqual(streamed)
  })
})
