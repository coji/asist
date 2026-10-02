import OpenAI from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  Tool
} from 'openai/resources/responses/responses'
import type { ConversationMessage, ConversationRequest, ConversationResult, SearchSource, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import type { ConversationLocale } from '@shared/conversation-locale'
import { effortFor } from '@shared/llm-catalog'
import {
  AdapterStream,
  parseToolArguments,
  statusError,
  streamCutOff,
  toolResultText,
  withoutSchemaKeys,
  type JsonRequest,
  type ProviderAdapter,
  type ProviderCredential
} from './adapter'
import { streamEvents, streamFailure } from './openai-stream'

/**
 * OpenAI, through the Responses API, because chat completions does not accept function tools and a
 * reasoning effort at the same time.
 *
 * - No conversation state is kept on the server (store: false), so the whole history goes into `input`
 *   on every request.
 * - The output items of a response (reasoning, message, function_call, web_search_call) are kept in
 *   `native` in order. A reasoning item holds the encrypted reasoning, and unless it is sent back
 *   across tool round trips and across turns the reasoning is lost and the prompt cache misses. It is
 *   sent back only to the same model, because another model cannot reuse it.
 * - A function call's arguments are complete when its item completes, so a tool can start before the
 *   response ends.
 * - Text produced with web search carries citations inline in the form `([title](URL))`. They are
 *   stripped because the text is spoken aloud; the sources reach the UI through the search event
 *   instead, and `native` keeps the text as it arrived.
 * - Paid from the ChatGPT plan, the same endpoint takes the OAuth access token as its bearer, but only
 *   streamed and with `input` as a list, and it refuses `max_output_tokens` (400, "Unsupported parameter",
 *   measured on 2026-10-02), so such a response has no output limit and never stops on max_tokens.
 */

const PROVIDER = 'openai'

let cached: { key: string; client: OpenAI } | null = null
function clientFor(key: string): OpenAI {
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 0 }) }
  return cached.client
}

/** The access token of a ChatGPT sign-in is sent where the SDK would send an API key. */
async function clientOf(credential: ProviderCredential): Promise<OpenAI> {
  return clientFor(credential.type === 'api-key' ? credential.key : await credential.accessToken())
}

/** The output limit, which a request paid from the ChatGPT plan has to leave out. */
const outputLimit = (credential: ProviderCredential, maxTokens: number): { max_output_tokens?: number } =>
  credential.type === 'api-key' ? { max_output_tokens: maxTokens } : {}

/**
 * The output items of a response that can go back to the model. The API refuses a reasoning item unless
 * the item that followed it in its response comes right after it, recognized by that item's id (400,
 * "provided without its required following item"). A response cut off by a broken stream or the output
 * limit keeps reasoning whose item never completed, or the text cut off after it without an id, so such
 * reasoning is left out however the response was stored.
 */
function withPairedReasoning(items: readonly ResponseInputItem[]): ResponseInputItem[] {
  const kept: ResponseInputItem[] = []
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    const next = kept[0] as { id?: unknown } | undefined
    if (item.type === 'reasoning' && typeof next?.id !== 'string') continue
    kept.unshift(item)
  }
  return kept
}

export function toResponsesInput(messages: readonly ConversationMessage[], model: string, locale: ConversationLocale): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER && message.native.model === model) {
        input.push(...withPairedReasoning(message.native.payload as ResponseInputItem[]))
        continue
      }
      for (const part of message.parts) {
        if (part.type === 'text') input.push({ role: 'assistant', content: part.text })
        else if (part.type === 'tool_call') {
          input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) })
        }
      }
      continue
    }
    // Function results go right after their calls, and the text of the same user message follows them.
    const texts: string[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result') input.push({ type: 'function_call_output', call_id: part.callId, output: toolResultText(locale, part) })
      else if (part.type === 'text') texts.push(part.text)
    }
    if (texts.length > 0) input.push({ role: 'user', content: texts.join('\n\n') })
  }
  return input
}

/**
 * `strict` is set to false on purpose: ASIST's schemas have optional properties and do not meet the
 * conditions for strict mode, and leaving the flag out makes the API attempt strict mode and then drop
 * it silently.
 */
export function toResponsesTools(request: Pick<ConversationRequest, 'tools' | 'webSearch'>): Tool[] {
  const functions: FunctionTool[] = request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: withoutSchemaKeys(tool.inputSchema, ['$schema']),
    strict: false
  }))
  return request.webSearch ? [...functions, { type: 'web_search', search_context_size: 'low' }] : functions
}

const CITATION = /[ \t]*\(?\[[^\]\n]*\]\(https?:\/\/[^)\s]*\)\)?/g
/**
 * The start of a citation that is still being written at the end of the text: an opening parenthesis, a
 * title in brackets followed by as much of `(https://…` as has arrived, or a whole link inside an opening
 * parenthesis whose closing one has not arrived yet. Brackets that closed without `(` after them, or `(`
 * without the scheme, can no longer become a citation and do not match.
 */
const PARTIAL_CITATION =
  /[ \t]*(?:\(|\(\[[^\]\n]*\]\(https?:\/\/[^)\s]*\)|\(?\[[^\]\n]*(?:\](?:\((?:h(?:t(?:t(?:p(?:s?(?::(?:\/(?:\/[^)\s]*)?)?)?)?)?)?)?)?)?)?)$/
/** How many characters may be held back while it is still undecided whether they are a citation; beyond that they are emitted as text. */
const CITATION_HOLD_MAX = 600

/** Removes citation links from the text deltas, holding back a partial link until it closes. */
export class CitationFilter {
  private pending = ''

  push(delta: string): string {
    this.pending += delta
    const open = this.pending.search(PARTIAL_CITATION)
    if (open === -1 || this.pending.length - open > CITATION_HOLD_MAX) return this.flush()
    const ready = this.pending.slice(0, open)
    this.pending = this.pending.slice(open)
    return ready.replace(CITATION, '')
  }

  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest.replace(CITATION, '')
  }
}

const uniqueSources = (sources: SearchSource[]): SearchSource[] => [...new Map(sources.map((source) => [source.url, source])).values()]

class OpenAIStream extends AdapterStream {
  private readonly items: ResponseOutputItem[] = []

  constructor(
    private readonly credential: ProviderCredential,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(async () => this.run(await clientOf(credential)))
  }

  protected nativeSnapshot(openText: string): ConversationMessage['native'] {
    // Text cut off mid-stream never became an item, so it is appended as assistant text to keep what was already spoken.
    const payload: unknown[] = [...this.items]
    if (openText) payload.push({ role: 'assistant', content: openText })
    return payload.length > 0 ? { provider: PROVIDER, model: this.request.model.id, payload } : undefined
  }

  private async run(client: OpenAI): Promise<ConversationResult> {
    const { request } = this
    const effort = effortFor(request.model)
    const tools = toResponsesTools(request)
    const params: ResponseCreateParamsStreaming = {
      model: request.model.id,
      instructions: request.system.map((layer) => layer.text).join('\n\n'),
      input: toResponsesInput(request.messages, request.model.id, request.locale),
      ...(tools.length > 0 ? { tools } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      ...outputLimit(this.credential, request.maxTokens),
      store: false,
      stream: true
    }
    const stream = await client.responses.create(params, { signal: request.signal })

    const citations = request.webSearch ? new CitationFilter() : null
    const queries: string[] = []
    const cited: SearchSource[] = []
    const listed: SearchSource[] = []
    let refused = false
    let response: Response | null = null
    for await (const event of streamEvents('OpenAI', stream)) {
      switch (event.type) {
        case 'response.output_text.delta':
          this.emitText(citations ? citations.push(event.delta) : event.delta)
          break
        case 'response.output_item.added':
          if (event.item.type === 'web_search_call') this.emitSearch({ phase: 'start' })
          break
        case 'response.output_text.annotation.added': {
          const annotation = event.annotation as { type?: string; url?: string; title?: string }
          if (annotation.type === 'url_citation' && annotation.url) cited.push({ url: annotation.url, title: annotation.title || annotation.url, cited: true })
          break
        }
        case 'response.refusal.done':
          refused = true
          break
        case 'response.output_item.done': {
          const item = event.item
          // A function call the output limit cut off ends incomplete with its arguments cut short. It is
          // neither run nor sent back, since a call without its result is refused, and the response ends
          // on max_tokens.
          if (item.type === 'function_call' && item.status === 'incomplete') break
          if (item.type === 'function_call') {
            // The arguments are read before the call joins the output: one that fails to parse is never
            // handed to the turn, which so has no result for it, and a call sent back without its result
            // is refused.
            const input = parseToolArguments(item.name, item.arguments)
            this.items.push(item)
            this.emitToolCall({ type: 'tool_call', id: item.call_id, name: item.name, input })
            break
          }
          this.items.push(item)
          if (item.type === 'message') {
            if (citations) this.emitText(citations.flush())
            this.closeText()
          } else if (item.type === 'web_search_call' && item.action.type === 'search') {
            const action = item.action as { query?: string; queries?: string[]; sources?: Array<{ url: string }> }
            queries.push(...(action.queries ?? (action.query ? [action.query] : [])))
            listed.push(...(action.sources ?? []).map((source) => ({ url: source.url, title: source.url })))
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete':
          response = event.response
          break
        case 'response.failed':
          // The stream closes normally on a failure, so the failure has to be raised here.
          throw streamFailure('OpenAI', event.response.error?.code, event.response.error?.message)
        case 'error':
          throw streamFailure('OpenAI', event.code, event.message)
      }
    }
    if (!response) streamCutOff(request.signal, 'OpenAI')
    if (citations) this.emitText(citations.flush())
    this.closeText()
    if (this.items.some((item) => item.type === 'web_search_call')) {
      // Citations carry a title; without any citation the URLs the search returned are listed instead.
      this.emitSearch({ phase: 'done', query: queries[0] ?? '', sources: uniqueSources(cited.length > 0 ? cited : listed) })
    }

    const hasToolCall = this.parts.some((part) => part.type === 'tool_call')
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined
    const stop: StopReason = incomplete === 'max_output_tokens' ? 'max_tokens' : hasToolCall ? 'tool_calls' : incomplete === 'content_filter' || refused ? 'refusal' : 'end'
    if (incomplete && stop === 'end') throw new Error(`OpenAI: the response was cut short (${incomplete})`)

    return {
      message: { role: 'assistant', parts: [...this.parts], native: { provider: PROVIDER, model: request.model.id, payload: [...this.items] } },
      stop,
      usage: roundUsage(response.usage, this.items)
    }
  }
}

/** The input tokens count the ones read from and written to the cache as well. Every web_search_call item of the output is one billed search. */
function roundUsage(usage: OpenAI.Responses.ResponseUsage | undefined, output: readonly OpenAI.Responses.ResponseOutputItem[]): RoundUsage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0
  const writtenTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0
  return {
    input: Math.max((usage?.input_tokens ?? 0) - cachedTokens - writtenTokens, 0),
    cacheRead: cachedTokens,
    cacheCreation: writtenTokens,
    output: usage?.output_tokens ?? 0,
    webSearches: output.filter((item) => item.type === 'web_search_call').length
  }
}

/**
 * A response read to its end from a stream, for a caller that needs only the whole of it. Paid from the
 * ChatGPT plan, the completion event carries an empty `output` (measured on 2026-10-03), so the output is
 * the items as each one completed.
 */
async function streamedResponse(client: OpenAI, params: Omit<ResponseCreateParamsStreaming, 'stream'>, signal: AbortSignal): Promise<Response> {
  const stream = await client.responses.create({ ...params, stream: true }, { signal })
  const output: ResponseOutputItem[] = []
  for await (const event of streamEvents('OpenAI', stream)) {
    if (event.type === 'response.output_item.done') output.push(event.item)
    if (event.type === 'response.completed' || event.type === 'response.incomplete') return { ...event.response, output }
    if (event.type === 'response.failed') throw streamFailure('OpenAI', event.response.error?.code, event.response.error?.message)
    if (event.type === 'error') throw streamFailure('OpenAI', event.code, event.message)
  }
  streamCutOff(signal, 'OpenAI')
}

/** The text of a response's messages. Only a response that was not streamed carries it as `output_text`. */
const outputText = (response: Response): string =>
  response.output.flatMap((item) => (item.type === 'message' ? item.content : [])).map((part) => (part.type === 'output_text' ? part.text : '')).join('')

/**
 * The models a ChatGPT sign-in may use. This endpoint answers with `{ models: [{ slug }] }` instead of the
 * list the SDK parses, and fetching one model refuses the token for lack of the api.model.read scope.
 */
async function planModels(credential: Extract<ProviderCredential, { type: 'chatgpt' }>, signal: AbortSignal): Promise<string[]> {
  const response = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${await credential.accessToken()}` }, signal })
  if (!response.ok) throw statusError(response.status, `OpenAI: listing the models of the ChatGPT plan failed (HTTP ${response.status})`)
  const body = (await response.json()) as { models?: Array<{ slug?: unknown }> }
  if (!Array.isArray(body.models)) throw new Error('OpenAI: the models of the ChatGPT plan came back in an unknown form')
  return body.models.flatMap((model) => (typeof model.slug === 'string' ? [model.slug] : []))
}

export const openaiAdapter: ProviderAdapter = {
  stream: (request, credential) => new OpenAIStream(credential, request),

  async completeJson(request: JsonRequest, credential: ProviderCredential) {
    const effort = effortFor(request.model)
    const client = await clientOf(credential)
    const params = {
      model: request.model.id,
      instructions: request.system,
      ...(effort ? { reasoning: { effort } } : {}),
      text: { format: { type: 'json_schema' as const, name: 'result', schema: request.schema, strict: true } },
      ...outputLimit(credential, request.maxTokens),
      store: false
    }
    const response =
      credential.type === 'api-key'
        ? await client.responses.create({ ...params, input: request.user }, { signal: request.signal })
        : await streamedResponse(client, { ...params, input: [{ role: 'user', content: request.user }] }, request.signal)
    return {
      usage: roundUsage(response.usage, response.output),
      value: () => {
        if (response.status !== 'completed') {
          throw new Error(`OpenAI: the JSON response did not complete (${response.incomplete_details?.reason ?? response.error?.message ?? response.status})`)
        }
        return JSON.parse(credential.type === 'api-key' ? response.output_text : outputText(response))
      }
    }
  },

  async retrieveModel(id, credential, signal) {
    if (credential.type === 'api-key') {
      await new OpenAI({ apiKey: credential.key, maxRetries: 0 }).models.retrieve(id, { signal })
      return
    }
    if (!(await planModels(credential, signal)).includes(id)) throw statusError(404, `OpenAI: the ChatGPT plan does not offer ${id}`)
  },

  async listModels(credential, signal) {
    if (credential.type === 'api-key') await new OpenAI({ apiKey: credential.key, maxRetries: 0 }).models.list({ signal })
    else await planModels(credential, signal)
  }
}
