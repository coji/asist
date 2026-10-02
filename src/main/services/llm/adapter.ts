import type {
  ConversationMessage,
  ConversationPart,
  ConversationRequest,
  ConversationResult,
  ConversationStream,
  JsonSchema,
  SearchEvent,
  ToolCallPart
} from '@shared/conversation'
import type { ConversationLocale } from '@shared/conversation-locale'
import { errorPrefix } from '@shared/conversation-markers'
import type { ConversationModel } from '@shared/llm-catalog'
import type { RoundUsage } from '@shared/ipc'

/**
 * The contract every provider adapter implements. An adapter only converts between the types in
 * shared/conversation and its own API's shape, and never lets an SDK type escape. The credential arrives
 * with each call instead of being held, because a key is also verified before it is saved.
 */

/**
 * What a request is authorized with. Every provider takes an API key; OpenAI also takes the ChatGPT plan
 * of the account signed in with ChatGPT, whose access token expires within the hour and is fetched for
 * each request. `account` names the registration, which stays the same while the token changes.
 */
export type ProviderCredential = { type: 'api-key'; key: string } | { type: 'chatgpt'; account: string; accessToken: () => Promise<string> }

export const apiKeyCredential = (key: string): ProviderCredential => ({ type: 'api-key', key })

/** The key of an adapter that takes nothing but an API key. */
export function apiKeyOf(credential: ProviderCredential): string {
  if (credential.type !== 'api-key') throw new Error(`a ${credential.type} credential reached an adapter that takes only an API key`)
  return credential.key
}

export interface JsonRequest {
  model: ConversationModel
  system: string
  user: string
  /**
   * The top level is an object. Every property has to be required and `additionalProperties` false,
   * because that is the intersection all providers' structured output accepts.
   */
  schema: JsonSchema
  maxTokens: number
  signal: AbortSignal
}

/**
 * A one-shot JSON response. Its usage is known once the response arrives, while reading its value can
 * still fail, as on JSON that the output limit cut short. The provider bills such a response all the
 * same, so the caller records the usage before it reads the value.
 */
export interface JsonResponse {
  usage: RoundUsage
  value(): unknown
}

export interface ProviderAdapter {
  stream(request: ConversationRequest, credential: ProviderCredential): ConversationStream
  completeJson(request: JsonRequest, credential: ProviderCredential): Promise<JsonResponse>
  /** Checks that the model exists and the credential may use it. A failure carries the HTTP status, where 401 means the credential is rejected. */
  retrieveModel(id: string, credential: ProviderCredential, signal: AbortSignal): Promise<void>
  /** Checks only that the credential authenticates. */
  listModels(credential: ProviderCredential, signal: AbortSignal): Promise<void>
}

/** An error carrying an HTTP status, which is what the checks in shared read to tell a transient failure from a rejected key. */
export function statusError(status: number, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { status })
}

/**
 * The base every adapter's stream builds on: it dispatches the events and keeps what is confirmed so
 * far. Text deltas accumulate and become one text part at the next tool call, at the start of a search
 * or at the end of the response; text that is only whitespace is never confirmed.
 */
export abstract class AdapterStream implements ConversationStream {
  private readonly textListeners: Array<(delta: string) => void> = []
  private readonly toolCallListeners: Array<(call: ToolCallPart) => void> = []
  private readonly searchListeners: Array<(event: SearchEvent) => void> = []
  private readonly confirmed: ConversationPart[] = []
  private openText = ''
  private result: Promise<ConversationResult> | null = null

  /** Defers the run by a microtask so the caller has finished attaching its on() listeners before the first event. */
  protected start(run: () => Promise<ConversationResult>): void {
    this.result = Promise.resolve().then(run)
    // A stream that is dropped without final() must not raise an unhandled rejection.
    this.result.catch(() => {})
  }

  on(event: 'text', listener: (delta: string) => void): this
  on(event: 'toolCall', listener: (call: ToolCallPart) => void): this
  on(event: 'search', listener: (event: SearchEvent) => void): this
  on(event: 'text' | 'toolCall' | 'search', listener: never): this {
    if (event === 'text') this.textListeners.push(listener)
    else if (event === 'toolCall') this.toolCallListeners.push(listener)
    else this.searchListeners.push(listener)
    return this
  }

  final(): Promise<ConversationResult> {
    if (!this.result) throw new Error('stream was not started')
    return this.result
  }

  snapshot(): ConversationMessage | null {
    const parts = [...this.confirmed]
    if (this.openText.trim()) parts.push({ type: 'text', text: this.openText })
    if (parts.length === 0) return null
    const native = this.nativeSnapshot(this.openText.trim() ? this.openText : '')
    return { role: 'assistant', parts, ...(native === undefined ? {} : { native }) }
  }

  /** The provider's raw output for what is confirmed so far; undefined for providers that have none. */
  protected abstract nativeSnapshot(openText: string): ConversationMessage['native']

  protected get parts(): readonly ConversationPart[] {
    return this.confirmed
  }

  protected emitText(delta: string): void {
    if (!delta) return
    this.openText += delta
    for (const listener of this.textListeners) listener(delta)
  }

  protected closeText(): void {
    if (this.openText.trim()) this.confirmed.push({ type: 'text', text: this.openText })
    this.openText = ''
  }

  protected emitToolCall(call: ToolCallPart): void {
    this.closeText()
    this.confirmed.push(call)
    for (const listener of this.toolCallListeners) listener(call)
  }

  /**
   * A search that starts ends the text before it, where the conversation pauses. Gemini goes on writing
   * the same text part after its search, and a part that ran across the pause would not match the spoken
   * reply, which puts a space there in a language that writes words apart.
   */
  protected emitSearch(event: SearchEvent): void {
    if (event.phase === 'start') this.closeText()
    for (const listener of this.searchListeners) listener(event)
  }
}

/**
 * The failure of a response whose stream ended before its terminal event. The openai package ends a
 * stream quietly both when its request is aborted mid-response (isTransportAbortError in
 * openai/core/streaming.js) and when the server closes it early, and @google/genai ends one quietly
 * when the body closes between two events, since Gemini's stream has no end marker. So only a missing
 * terminal event tells that the response was cut off. An abort, such as a round's timeout, is raised as
 * it was given; otherwise the failure says "premature close", which api-errors reads as a dropped
 * connection and so as transient. A response whose terminal event arrived stands, even when an abort
 * came after it.
 */
export function streamCutOff(signal: AbortSignal, provider: string): never {
  signal.throwIfAborted()
  throw new Error(`${provider}: premature close, the stream ended before the response did`)
}

/** Empty arguments mean no arguments. Invalid JSON throws instead of running the tool with broken arguments. */
export function parseToolArguments(name: string, json: string): Record<string, unknown> {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch (error) {
    throw new Error(`tool ${name} was called with arguments that are not JSON: ${json.slice(0, 200)}`, { cause: error })
  }
}

/** For APIs whose tool results carry no error flag, a failure is reported inside the text itself. */
export const toolResultText = (locale: ConversationLocale, part: { content: string; isError?: boolean }): string =>
  part.isError ? `${errorPrefix(locale)} ${part.content}` : part.content

export function withoutSchemaKeys(schema: JsonSchema, dropped: readonly string[]): JsonSchema {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!dropped.includes(key)) out[key] = walk(child)
    }
    return out
  }
  return walk(schema) as JsonSchema
}
