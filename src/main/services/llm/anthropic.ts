import Anthropic from '@anthropic-ai/sdk'
import type { ConversationMessage, ConversationRequest, ConversationResult, SearchSource, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import { effortFor } from '@shared/llm-catalog'
import { AdapterStream, type JsonRequest, type ProviderAdapter } from './adapter'

/**
 * Anthropic, through the Messages API.
 *
 * - The response content, including thinking with its signature and the web search results with their
 *   encrypted bodies, is kept in `native` and sent back unchanged to the same model. Dropping or
 *   altering thinking in the middle of a tool round trip returns 400. Older thinking from previous
 *   turns may be sent; the API decides what to do with it.
 * - Prompt cache breakpoints go after each of the three system layers and at the end of the messages,
 *   which is the limit of four. The trailing breakpoint is placed again on every request, so even the
 *   rounds inside a turn read everything up to the previous round from the cache. No breakpoint is
 *   stored in the history.
 * - Web search runs on Anthropic's side: a call starts at content_block_start and its result arrives
 *   as web_search_tool_result.
 * - Retries belong to the brain, so maxRetries is 0 and the SDK does not retry on top of it.
 */

const PROVIDER = 'anthropic'
/**
 * `allowed_callers` is limited to direct. Leaving it out also enables the path that narrows search
 * results through code execution, which measured about 7,000 more input tokens; reading the results
 * directly is enough for a spoken conversation.
 */
const WEB_SEARCH: Anthropic.Messages.ToolUnion = { type: 'web_search_20260318', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }

let cached: { key: string; client: Anthropic } | null = null
function clientFor(key: string): Anthropic {
  if (cached?.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 0 }) }
  return cached.client
}

type Block = Anthropic.ContentBlockParam

/** Converts the history into messages and places one cache breakpoint on the last block. */
export function toAnthropicMessages(messages: readonly ConversationMessage[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = messages.map((message) => {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER && message.native.model === model) {
        return { role: 'assistant', content: structuredClone(message.native.payload) as Block[] }
      }
      const content: Block[] = []
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'tool_call') content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
      }
      return { role: 'assistant', content }
    }
    // Tool results come first and text after them; the other order returns 400.
    const content: Block[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: part.callId, content: part.content, ...(part.isError ? { is_error: true } : {}) })
      }
    }
    for (const part of message.parts) if (part.type === 'text') content.push({ type: 'text', text: part.text })
    return { role: 'user', content }
  })
  const last = out[out.length - 1]
  const tail = Array.isArray(last?.content) ? last.content[last.content.length - 1] : undefined
  if (tail && (tail.type === 'text' || tail.type === 'tool_result')) tail.cache_control = { type: 'ephemeral' }
  return out
}

/** Blocks of an interrupted response that can be sent back. Provider-side tool calls are excluded because we cannot supply their results. */
const RESUMABLE = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking'])

const STOPS: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_calls',
  // A response cut off by the context window is treated like one cut off by the output limit: valid but unfinished, so we ask for the rest.
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause'
}

type ToolUseBlock = Extract<Anthropic.ContentBlock, { type: 'tool_use' }>

class AnthropicStream extends AdapterStream {
  private readonly blocks: Anthropic.ContentBlock[] = []
  /**
   * The last tool_use block, until it is known to be whole. The API closes a block that the output
   * limit cut off like any other, with the input parsed as far as it got, and only the stop reason
   * tells the two apart; running such a call would act on half its input, and sending it back without
   * a result is refused with a 400. It becomes a call once another block starts or the response ends
   * on anything but the limit.
   */
  private heldToolUse: ToolUseBlock | null = null

  constructor(
    client: Anthropic,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(() => this.run(client))
  }

  protected nativeSnapshot(openText: string): ConversationMessage['native'] {
    const payload: unknown[] = this.blocks.filter((block) => RESUMABLE.has(block.type))
    if (openText) payload.push({ type: 'text', text: openText })
    return payload.length > 0 ? { provider: PROVIDER, model: this.request.model.id, payload } : undefined
  }

  private async run(client: Anthropic): Promise<ConversationResult> {
    const { request } = this
    const effort = effortFor(request.model)
    const tools: Anthropic.Messages.ToolUnion[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
    }))
    const stream = client.messages.stream(
      {
        model: request.model.id,
        max_tokens: request.maxTokens,
        ...(effort ? { output_config: { effort } } : {}),
        system: request.system.map((layer) => ({ type: 'text', text: layer.text, cache_control: { type: 'ephemeral' } })),
        tools: request.webSearch ? [...tools, WEB_SEARCH] : tools,
        messages: toAnthropicMessages(request.messages, request.model.id)
      },
      { signal: request.signal, maxRetries: 0 }
    )

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        this.releaseToolUse()
        if (event.content_block.type === 'server_tool_use') this.emitSearch({ phase: 'start' })
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.emitText(event.delta.text)
      }
    })
    stream.on('contentBlock', (block) => {
      this.releaseToolUse()
      if (block.type === 'tool_use') {
        this.heldToolUse = block
        return
      }
      this.blocks.push(block)
      if (block.type === 'text') this.closeText()
      else if (block.type === 'web_search_tool_result') {
        const results = Array.isArray(block.content) ? block.content : []
        this.emitSearch({ phase: 'done', query: this.searchQuery(block.tool_use_id), sources: results.map((result) => ({ url: result.url, title: result.title || result.url })) })
      }
    })

    const final = await stream.finalMessage()
    const stop = final.stop_reason ? STOPS[final.stop_reason] : undefined
    if (!stop) throw new Error(`Anthropic: the response ended on an unknown stop reason (${final.stop_reason ?? 'none'})`)
    // A tool_use block the limit cut off is always the last block, and it goes back neither as a call
    // nor in the output sent to the model again.
    const cutToolUse = stop === 'max_tokens' && this.heldToolUse !== null
    if (!cutToolUse) this.releaseToolUse()
    const content = cutToolUse ? final.content.slice(0, -1) : final.content
    this.closeText()
    // The citations sit on the text blocks that follow the search, so the sources of the answer are known only now.
    const cited = new Map<string, SearchSource>()
    for (const block of content) {
      if (block.type !== 'text') continue
      for (const citation of block.citations ?? []) {
        if (citation.type === 'web_search_result_location' && !cited.has(citation.url)) {
          cited.set(citation.url, { url: citation.url, title: citation.title || citation.url, cited: true, snippet: citation.cited_text })
        }
      }
    }
    if (cited.size > 0) this.emitSearch({ phase: 'cited', sources: [...cited.values()] })
    const answered = new Set(content.flatMap((block) => (block.type === 'web_search_tool_result' ? [block.tool_use_id] : [])))
    const pendingServerTool = content.some((block) => block.type === 'server_tool_use' && !answered.has(block.id))
    return {
      message: { role: 'assistant', parts: [...this.parts], native: { provider: PROVIDER, model: request.model.id, payload: content } },
      stop,
      usage: roundUsage(final.usage),
      ...(pendingServerTool ? { pendingServerTool } : {})
    }
  }

  /**
   * The query of the search a result answers. A result pairs with its call by id, not by position: two
   * calls can come before their results, and a call made together with a client tool runs only once the
   * tool's result is sent, so its result opens the next response while the call is in the turn's history.
   */
  private searchQuery(callId: string): string {
    const earlier = this.request.messages.flatMap((message) =>
      message.role === 'assistant' && message.native?.provider === PROVIDER ? (message.native.payload as Anthropic.ContentBlock[]) : []
    )
    const call = [...earlier, ...this.blocks].find((block) => block.type === 'server_tool_use' && block.id === callId)
    const query = call?.type === 'server_tool_use' ? (call.input as { query?: unknown }).query : undefined
    return typeof query === 'string' ? query : ''
  }

  private releaseToolUse(): void {
    const block = this.heldToolUse
    if (!block) return
    this.heldToolUse = null
    this.blocks.push(block)
    this.emitToolCall({ type: 'tool_call', id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
  }
}

function roundUsage(usage: Anthropic.Usage): RoundUsage {
  return {
    input: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0
  }
}

export const anthropicAdapter: ProviderAdapter = {
  stream: (request, key) => new AnthropicStream(clientFor(key), request),

  async completeJson(request: JsonRequest, key: string) {
    const effort = effortFor(request.model)
    const message = await clientFor(key).messages.create(
      {
        model: request.model.id,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema: request.schema } }
      },
      { signal: request.signal, maxRetries: 0 }
    )
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    return { usage: roundUsage(message.usage), value: () => JSON.parse(text) }
  },

  async retrieveModel(id, key, signal) {
    await new Anthropic({ apiKey: key, maxRetries: 0 }).models.retrieve(id, {}, { signal, maxRetries: 0 })
  },

  async listModels(key, signal) {
    await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 }, { signal, maxRetries: 0 })
  }
}
