import OpenAI from 'openai'
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { CompletionUsage } from 'openai/resources/completions'
import type { ConversationMessage, ConversationRequest, ConversationResult, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import type { ConversationLocale } from '@shared/conversation-locale'
import { effortFor } from '@shared/llm-catalog'
import { AdapterStream, parseToolArguments, streamCutOff, toolResultText, withoutSchemaKeys, type JsonRequest, type ProviderAdapter } from './adapter'

/**
 * Cerebras, called through the openai package: its API is OpenAI-compatible chat completions, and its
 * own SDK is only a typed thin client over the same HTTP.
 *
 * - Thinking arrives separately in delta.reasoning while the answer arrives in delta.content, and
 *   tools and thinking can be used together. The thinking does not have to be sent back in the
 *   history, so no `native` output is kept.
 * - Qwen leaves the newline that follows the end of thinking (`</think>`) at the start of the answer,
 *   so leading newlines of each response are dropped.
 * - Chat completions never signals that a tool call's arguments are complete, so a call is confirmed
 *   when the next index starts or when the response ends on anything but the output limit.
 * - There is no built-in web search.
 */

const BASE_URL = 'https://api.cerebras.ai/v1'

let cached: { key: string; client: OpenAI } | null = null
const newClient = (key: string): OpenAI => new OpenAI({ apiKey: key, baseURL: BASE_URL, maxRetries: 0 })
function clientFor(key: string): OpenAI {
  if (cached?.key !== key) cached = { key, client: newClient(key) }
  return cached.client
}

/** Converts the history into chat completions messages; a tool message has to follow its assistant message directly. */
export function toChatMessages(system: string, messages: readonly ConversationMessage[], locale: ConversationLocale): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = system ? [{ role: 'system', content: system }] : []
  for (const message of messages) {
    if (message.role === 'assistant') {
      let text = ''
      const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
      for (const part of message.parts) {
        if (part.type === 'text') text += part.text
        else if (part.type === 'tool_call') calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } })
      }
      out.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) })
      continue
    }
    const texts: string[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push({ role: 'tool', tool_call_id: part.callId, content: toolResultText(locale, part) })
      else if (part.type === 'text') texts.push(part.text)
    }
    if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') })
  }
  return out
}

interface CallDraft {
  id: string
  name: string
  args: string
}

class CerebrasStream extends AdapterStream {
  constructor(
    client: OpenAI,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(() => this.run(client))
  }

  protected nativeSnapshot(): ConversationMessage['native'] {
    return undefined
  }

  private async run(client: OpenAI): Promise<ConversationResult> {
    const { request } = this
    if (request.webSearch) throw new Error('Cerebras has no built-in web search')
    const effort = effortFor(request.model)
    const tools: ChatCompletionTool[] = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: withoutSchemaKeys(tool.inputSchema, ['$schema']) }
    }))
    const params: ChatCompletionCreateParamsStreaming = {
      model: request.model.id,
      messages: toChatMessages(request.system.map((layer) => layer.text).join('\n\n'), request.messages, request.locale),
      stream: true,
      stream_options: { include_usage: true },
      ...(effort ? { reasoning_effort: effort } : {}),
      max_completion_tokens: request.maxTokens,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    }
    const stream = await client.chat.completions.create(params, { signal: request.signal })

    const drafts = new Map<number, CallDraft>()
    let open: number | null = null
    let leading = true
    let finish: string | null = null
    let usage: CompletionUsage | null = null
    const confirm = (index: number): void => {
      const draft = drafts.get(index)
      if (!draft) return
      this.emitToolCall({ type: 'tool_call', id: draft.id || `call_${index}`, name: draft.name, input: parseToolArguments(draft.name, draft.args) })
    }
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (!choice) continue
      let text = choice.delta?.content ?? ''
      if (leading && text) {
        text = text.replace(/^\n+/, '')
        if (text) leading = false
      }
      this.emitText(text)
      for (const call of choice.delta?.tool_calls ?? []) {
        if (open !== null && open !== call.index) confirm(open)
        open = call.index
        const draft = drafts.get(call.index) ?? { id: '', name: '', args: '' }
        if (call.id) draft.id = call.id
        if (call.function?.name) draft.name += call.function.name
        if (call.function?.arguments) draft.args += call.function.arguments
        drafts.set(call.index, draft)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
    if (finish === null) streamCutOff(request.signal, 'Cerebras')
    // The call still open when the output limit ends the response has its arguments cut off, so it is
    // neither run nor sent back; the calls confirmed before it stand, and the brain asks for the rest.
    const cut = finish === 'length'
    if (open !== null && !cut) confirm(open)
    this.closeText()

    const hasToolCall = this.parts.some((part) => part.type === 'tool_call')
    const stop: StopReason = cut ? 'max_tokens' : hasToolCall ? 'tool_calls' : finish === 'content_filter' ? 'refusal' : 'end'
    // The finish reason ends the response. The usage rides on the last chunk, which is either the one
    // with the finish reason or one more after it, so a stream cut between the two keeps its answer
    // but has no usage.
    return { message: { role: 'assistant', parts: [...this.parts] }, stop, usage: usage ? roundUsage(usage) : null }
  }
}

function roundUsage(usage: CompletionUsage): RoundUsage {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input: Math.max(usage.prompt_tokens - cachedTokens, 0),
    cacheRead: cachedTokens,
    cacheCreation: 0,
    output: usage.completion_tokens,
    webSearches: 0
  }
}

export const cerebrasAdapter: ProviderAdapter = {
  stream: (request, key) => new CerebrasStream(clientFor(key), request),

  async completeJson(request: JsonRequest, key: string) {
    const effort = effortFor(request.model)
    const response = await clientFor(key).chat.completions.create(
      {
        model: request.model.id,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user }
        ],
        ...(effort ? { reasoning_effort: effort } : {}),
        max_completion_tokens: request.maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: request.schema } }
      },
      { signal: request.signal }
    )
    if (!response.usage) throw new Error('Cerebras: the response carried no usage')
    return { value: JSON.parse(response.choices[0]?.message.content ?? ''), usage: roundUsage(response.usage) }
  },

  async retrieveModel(id, key, signal) {
    await newClient(key).models.retrieve(id, { signal })
  },

  async listModels(key, signal) {
    await newClient(key).models.list({ signal })
  }
}
