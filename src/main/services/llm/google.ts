import { randomUUID } from 'node:crypto'
import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig, type GenerateContentResponseUsageMetadata, type GroundingMetadata, type Part } from '@google/genai'
import type { ConversationMessage, ConversationRequest, ConversationResult, SearchSource, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { effortFor, modelLabel, type ConversationModel, type Effort } from '@shared/llm-catalog'
import { AdapterStream, statusError, streamCutOff, withoutSchemaKeys, type JsonRequest, type ProviderAdapter } from './adapter'

/**
 * Google, calling the Gemini API's generateContent through @google/genai.
 *
 * - Gemini 3 returns a thoughtSignature on the first functionCall of each step of a turn, and returns
 *   400 unless it is sent back on the same part. With parallel calls only the first one carries it.
 *   The response Content is kept in `native` and sent back unchanged to the same model. Earlier turns
 *   are not validated, so a history produced by another provider can be rebuilt from `parts`.
 * - A functionCall's arguments are never split: they arrive in a single part.
 * - Putting Google search (googleSearch) in the same request as function tools requires
 *   includeServerSideToolInvocations; without it the request returns 400. With it, the search call
 *   (toolCall) and its result (toolResponse) arrive as signed parts, which are kept in `native` and
 *   sent back; measurements show sending them back costs no extra tokens. The toolCall arrives as
 *   soon as the search starts.
 * - The sources (groundingMetadata) arrive at the end of the response and can ride on a final chunk
 *   that has no parts, so every chunk is inspected.
 * - The SDK does not retry unless retryOptions is passed, and retries belong to the brain.
 */

const PROVIDER = 'google'

let cached: { key: string; client: GoogleGenAI } | null = null
function clientFor(key: string): GoogleGenAI {
  if (cached?.key !== key) cached = { key, client: new GoogleGenAI({ apiKey: key }) }
  return cached.client
}

const THINKING_LEVEL: Partial<Record<Effort, ThinkingLevel>> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }

/** The depth of thinking for a model, which every request to it carries; an effort Gemini has no level for throws. */
function thinkingConfig(model: ConversationModel): Pick<GenerateContentConfig, 'thinkingConfig'> {
  const effort = effortFor(model)
  if (!effort) return {}
  const level = THINKING_LEVEL[effort]
  if (!level) throw new Error(errorText('llmModels.errors.effortUnsupported', { model: modelLabel(model) }))
  return { thinkingConfig: { thinkingLevel: level } }
}

/** Converts the history into contents, merging a run of the same role into one Content. */
export function toContents(messages: readonly ConversationMessage[], model: string): Content[] {
  const contents: Content[] = []
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last?.role === role) last.parts = [...(last.parts ?? []), ...parts]
    else contents.push({ role, parts })
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER && message.native.model === model) {
        push('model', [...((message.native.payload as Content).parts ?? [])])
        continue
      }
      const parts: Part[] = []
      for (const part of message.parts) {
        // An empty text part is rejected.
        if (part.type === 'text' && part.text) parts.push({ text: part.text })
        else if (part.type === 'tool_call') parts.push({ functionCall: { id: part.id, name: part.name, args: part.input } })
      }
      push('model', parts)
      continue
    }
    // Function results come first, in the order of the calls, and the text follows them.
    const parts: Part[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        parts.push({ functionResponse: { id: part.callId, name: part.name, response: part.isError ? { error: part.content } : { output: part.content } } })
      }
    }
    for (const part of message.parts) if (part.type === 'text' && part.text) parts.push({ text: part.text })
    push('user', parts)
  }
  return contents
}

/** `$schema` is rejected as an unknown key, while `additionalProperties` is accepted by generateContent and stays. */
const toDeclarationSchema = (schema: Record<string, unknown>): Record<string, unknown> => withoutSchemaKeys(schema, ['$schema'])

export function toConfig(request: ConversationRequest): GenerateContentConfig {
  const declarations = request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: toDeclarationSchema(tool.inputSchema) }))
  const tool = { ...(declarations.length > 0 ? { functionDeclarations: declarations } : {}), ...(request.webSearch ? { googleSearch: {} } : {}) }
  return {
    systemInstruction: request.system.map((layer) => layer.text).join('\n\n'),
    maxOutputTokens: request.maxTokens,
    ...thinkingConfig(request.model),
    ...(Object.keys(tool).length > 0 ? { tools: [tool] } : {}),
    ...(request.webSearch ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
    abortSignal: request.signal
  }
}

const REFUSALS: ReadonlySet<FinishReason> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII
])

/** An invalid key comes back as 400 (API_KEY_INVALID) rather than 401, so it is rewritten to 401 to count as an authentication failure. */
function normalizeError(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 400 && /API_KEY_INVALID|API key not valid/.test(error.message)) {
    return statusError(401, error.message, error)
  }
  return error
}

/**
 * The sources of a grounded answer, the cited ones first. A chunk's uri is a Google redirect and its
 * title is the site's domain, so the domain is shown as the site and the redirect's host is not.
 */
export function groundingSources(grounding: GroundingMetadata | undefined): SearchSource[] {
  const cited = new Set((grounding?.groundingSupports ?? []).flatMap((support) => support.groundingChunkIndices ?? []))
  const sources = (grounding?.groundingChunks ?? []).flatMap((chunk, index) => {
    if (!chunk.web?.uri) return []
    const site = chunk.web.title
    return [{ url: chunk.web.uri, title: site || chunk.web.uri, ...(site ? { site } : {}), ...(cited.has(index) ? { cited: true } : {}) }]
  })
  return [...sources.filter((source) => source.cited), ...sources.filter((source) => !source.cited)]
}

class GoogleStream extends AdapterStream {
  /** The response parts: text is merged into one part, while signed parts and functionCalls are kept as they arrived. */
  private readonly modelParts: Part[] = []

  constructor(
    client: GoogleGenAI,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(() => this.run(client).catch((error) => Promise.reject(normalizeError(error))))
  }

  protected nativeSnapshot(): ConversationMessage['native'] {
    // A search call whose result never arrived cannot be sent back, so it is dropped.
    const answered = new Set(this.modelParts.flatMap((part) => (part.toolResponse?.id ? [part.toolResponse.id] : [])))
    const parts = this.modelParts.filter((part) => !part.toolCall || (part.toolCall.id !== undefined && answered.has(part.toolCall.id)))
    return parts.length > 0 ? { provider: PROVIDER, model: this.request.model.id, payload: { role: 'model', parts } satisfies Content } : undefined
  }

  private addText(part: Part): void {
    const last = this.modelParts[this.modelParts.length - 1]
    const mergeable = last !== undefined && last.text !== undefined && !last.functionCall && !last.thoughtSignature
    if (mergeable) {
      last.text = `${last.text}${part.text ?? ''}`
      if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature
    } else if (part.text || part.thoughtSignature) {
      // A signature can arrive on an otherwise empty text part. Empty text cannot be sent back, so without preceding text the part is discarded.
      if (part.text) this.modelParts.push({ text: part.text, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })
    }
  }

  private async run(client: GoogleGenAI): Promise<ConversationResult> {
    const { request } = this
    const stream = await client.models.generateContentStream({
      model: request.model.id,
      contents: toContents(request.messages, request.model.id),
      config: toConfig(request)
    })
    let usage: GenerateContentResponseUsageMetadata | undefined
    let finish: FinishReason | undefined
    let grounding: GroundingMetadata | undefined
    let blocked: string | undefined
    let query = ''
    for await (const chunk of stream) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata
      if (chunk.promptFeedback?.blockReason) blocked = String(chunk.promptFeedback.blockReason)
      const candidate = chunk.candidates?.[0]
      if (candidate?.groundingMetadata) grounding = candidate.groundingMetadata
      if (candidate?.finishReason) finish = candidate.finishReason
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue
        if (part.toolCall || part.toolResponse) {
          this.modelParts.push(part)
          if (part.toolCall) {
            const asked = (part.toolCall.args as { queries?: unknown } | undefined)?.queries
            if (Array.isArray(asked) && typeof asked[0] === 'string') query = asked[0]
            this.emitSearch({ phase: 'start' })
          }
        } else if (part.functionCall) {
          // Gemini 3.8 Flash and 3.5 Flash Lite gave every call an id, accepted an id they had not issued,
          // and matched results that came in another order to their calls by id, pairing them wrongly when
          // the ids were missing or differed (measured 2026-10-02). A call that comes without an id is given
          // one on the part kept for Gemini as well, so that a call and its result always carry the same id.
          const call = part.functionCall
          const id = call.id ?? randomUUID()
          this.modelParts.push(call.id ? part : { ...part, functionCall: { ...call, id } })
          this.emitToolCall({ type: 'tool_call', id, name: call.name ?? '', input: call.args ?? {} })
        } else if (part.text !== undefined) {
          this.addText(part)
          this.emitText(part.text)
        }
      }
    }
    // A blocked prompt gets no candidate and so no finish reason; any other response ends on one.
    if (finish === undefined && blocked === undefined) streamCutOff(request.signal, 'Gemini')
    this.closeText()
    if (grounding?.webSearchQueries?.length || query) {
      const suggestions = grounding?.searchEntryPoint?.renderedContent
      this.emitSearch({ phase: 'done', query: grounding?.webSearchQueries?.[0] ?? query, sources: groundingSources(grounding), ...(suggestions ? { suggestions } : {}) })
    }

    const hasToolCall = this.parts.some((part) => part.type === 'tool_call')
    let stop: StopReason
    if (hasToolCall) stop = 'tool_calls'
    else if (blocked || (finish && REFUSALS.has(finish))) stop = 'refusal'
    else if (finish === FinishReason.MAX_TOKENS) stop = 'max_tokens'
    else if (finish === FinishReason.STOP) stop = 'end'
    else throw new Error(`Gemini: the response ended on an unknown finish reason (${finish})`)

    return { message: { role: 'assistant', parts: [...this.parts], native: this.nativeSnapshot() }, stop, usage: roundUsage(usage, grounding) }
  }
}

/**
 * Thinking tokens are billed as output, and grounding on Gemini 3 per search query the model runs. The
 * results of a search fed back to the model within the response (toolUsePromptTokenCount) are left
 * out: Google does not bill the context that grounding retrieves as input (its pricing page, checked
 * 2026-09-26), and `input` is also read as the size of the conversation's context, which they never join.
 */
function roundUsage(usage: GenerateContentResponseUsageMetadata | undefined, grounding: GroundingMetadata | undefined): RoundUsage {
  const cachedTokens = usage?.cachedContentTokenCount ?? 0
  return {
    input: Math.max((usage?.promptTokenCount ?? 0) - cachedTokens, 0),
    cacheRead: cachedTokens,
    cacheCreation: 0,
    output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    webSearches: grounding?.webSearchQueries?.length ?? 0
  }
}

export const googleAdapter: ProviderAdapter = {
  stream: (request, key) => new GoogleStream(clientFor(key), request),

  async completeJson(request: JsonRequest, key: string) {
    try {
      const response = await clientFor(key).models.generateContent({
        model: request.model.id,
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxTokens,
          ...thinkingConfig(request.model),
          responseMimeType: 'application/json',
          responseJsonSchema: toDeclarationSchema(request.schema),
          abortSignal: request.signal
        }
      })
      const text = response.text ?? ''
      return { usage: roundUsage(response.usageMetadata, undefined), value: () => JSON.parse(text) }
    } catch (error) {
      throw normalizeError(error)
    }
  },

  async retrieveModel(id, key, signal) {
    try {
      await new GoogleGenAI({ apiKey: key }).models.get({ model: id, config: { abortSignal: signal } })
    } catch (error) {
      throw normalizeError(error)
    }
  },

  async listModels(key, signal) {
    try {
      await new GoogleGenAI({ apiKey: key }).models.list({ config: { pageSize: 1, abortSignal: signal } })
    } catch (error) {
      throw normalizeError(error)
    }
  }
}
