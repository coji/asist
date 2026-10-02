import type { ConversationLocale } from './conversation-locale'
import type { RoundUsage } from './ipc'
import type { ConversationModel, LlmProvider } from './llm-catalog'

/**
 * Provider-neutral types for talking to a conversation model. No SDK type appears here: the brain,
 * history, conversation log and disconnect recovery handle only these types, and the per-provider
 * adapters in main/services/llm/ convert them to and from each API's shape.
 */

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

/** A tool result. It carries the tool's name because Gemini matches results to calls by name. */
export interface ToolResultPart {
  type: 'tool_result'
  callId: string
  name: string
  content: string
  isError?: boolean
}

export type ConversationPart = TextPart | ToolCallPart | ToolResultPart

/**
 * The provider's output as returned. It holds opaque values the model produced, such as thinking
 * signatures, encrypted reasoning and search results. It replaces `parts` only when the request goes
 * back to the same provider and model; for any other target the request is rebuilt from `parts`.
 */
export interface NativeOutput {
  provider: LlmProvider
  model: string
  payload: unknown
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  parts: ConversationPart[]
  /** Present only on assistant messages. */
  native?: NativeOutput
}

/** The layers of the system prompt in the order they are sent, from the one that changes least often. */
export const SYSTEM_LAYER_NAMES = ['base', 'memory', 'summary'] as const

/**
 * One layer of the system prompt. Providers with prompt cache breakpoints place one after each layer.
 * No layer changes from turn to turn: the messages are cached behind the system prompt, so such a
 * layer would send the whole history again on every turn.
 */
export interface SystemLayer {
  name: (typeof SYSTEM_LAYER_NAMES)[number]
  text: string
}

export type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface ConversationRequest {
  model: ConversationModel
  /** The language of the conversation, which an adapter needs for the text it puts around a tool result. */
  locale: ConversationLocale
  maxTokens: number
  system: readonly SystemLayer[]
  tools: readonly ToolSpec[]
  /** Enables the provider's built-in web search. */
  webSearch: boolean
  messages: readonly ConversationMessage[]
  signal: AbortSignal
}

/**
 * Why a response stopped.
 * - end: the model finished.
 * - tool_calls: it waits for tool results.
 * - max_tokens: the output limit cut it off.
 * - refusal: the model declined.
 * - pause: a provider-side tool ran long; append the response and send the same request again.
 */
export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'pause'

export interface SearchSource {
  title: string
  url: string
  /** The site to show next to the title, when the URL is a redirect that would show the provider's host instead. */
  site?: string
  /** True when the answer draws on this source, which the provider says in a citation. */
  cited?: boolean
  /** The passage the answer cites, when the provider returns one. */
  snippet?: string
}

/**
 * Progress of the provider's built-in web search. Sources come with `done`; a provider whose
 * citations arrive only after the answer adds them with `cited`. `suggestions` is Google's Search
 * Suggestions block, HTML that the Gemini API terms require to be shown with the grounded answer, as
 * it is.
 */
export type SearchEvent =
  | { phase: 'start' }
  | { phase: 'done'; query: string; sources: SearchSource[]; suggestions?: string }
  | { phase: 'cited'; sources: SearchSource[] }

export interface ConversationResult {
  message: ConversationMessage
  stop: StopReason
  /**
   * Null when the response ended but its usage never arrived, which only a provider that sends the
   * usage after the finish reason, Cerebras, can do. Nothing stands in for it.
   */
  usage: RoundUsage | null
  /**
   * A provider-side tool (web search) has not returned its result within this response. The next user
   * message must hold tool results only: added text makes the API treat the search as abandoned.
   */
  pendingServerTool?: boolean
}

export interface ConversationStream {
  on(event: 'text', listener: (delta: string) => void): this
  /** A tool call whose arguments are complete, so it can run before the response ends. */
  on(event: 'toolCall', listener: (call: ToolCallPart) => void): this
  on(event: 'search', listener: (event: SearchEvent) => void): this
  final(): Promise<ConversationResult>
  /**
   * The assistant message confirmed so far, including text cut off mid-block; null when nothing has
   * arrived. After a dropped stream it goes into the history so the model can be asked to continue.
   */
  snapshot(): ConversationMessage | null
}

/**
 * Whether a message carries anything the model can read back. A response can end with nothing in it, and
 * the Messages API refuses an assistant message without content anywhere but at the end of a request.
 */
export const hasContent = (message: ConversationMessage): boolean => message.parts.length > 0

export const textOf = (message: ConversationMessage): string =>
  message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')

export const toolCallsOf = (message: ConversationMessage): ToolCallPart[] =>
  message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')

export const userText = (text: string): ConversationMessage => ({ role: 'user', parts: [{ type: 'text', text }] })
