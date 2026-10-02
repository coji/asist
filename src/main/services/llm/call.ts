import type { LlmPurpose } from '@shared/api-usage'
import { llmCost } from '@shared/api-pricing'
import { textOf, userText, type ConversationRequest, type ConversationStream, type JsonSchema, type StopReason } from '@shared/conversation'
import type { ConversationLocale } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import { LLM_PROVIDER_INFO, type ConversationModel, type LlmProvider } from '@shared/llm-catalog'
import type { RoundUsage } from '@shared/ipc'
import { recordUsage } from '../usage-ledger'
import { providerKey } from './keys'
import type { ProviderAdapter } from './adapter'
import { anthropicAdapter } from './anthropic'
import { cerebrasAdapter } from './cerebras'
import { googleAdapter } from './google'
import { openaiAdapter } from './openai'

/**
 * The entry point for conversation model calls. It only picks the adapter for the provider and knows
 * nothing about API shapes, so callers (the brain, the bridge look-ahead, the summarizer, key
 * verification) deal only with the types in shared/conversation.
 */

export const ADAPTERS: Record<LlmProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
  cerebras: cerebrasAdapter
}

function requireKey(provider: LlmProvider): string {
  const key = providerKey(provider)
  if (!key) {
    const info = LLM_PROVIDER_INFO[provider]
    throw new Error(errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }))
  }
  return key
}

function recordCall(purpose: LlmPurpose, model: ConversationModel, usage: RoundUsage): void {
  recordUsage({ kind: 'llm', purpose, provider: model.provider, model: model.id, calls: 1, ...usage, costUsd: llmCost(model, usage) })
}

/**
 * A response that fails or is aborted is not recorded: its usage never arrives, even though the
 * provider may bill the tokens it produced before the failure. Neither is one that finished without
 * its usage, which is only logged.
 */
export function streamConversation(request: ConversationRequest, purpose: LlmPurpose): ConversationStream {
  const stream = ADAPTERS[request.model.provider].stream(request, requireKey(request.model.provider))
  stream.final().then(
    (result) => {
      if (result.usage) recordCall(purpose, request.model, result.usage)
      else console.warn(`llm: a ${purpose} response of ${request.model.id} finished without its usage, so it is not recorded`)
    },
    () => {}
  )
  return stream
}

/** The text of a one-shot response and why it stopped: one cut off by the output limit still returns what it wrote. */
export async function completeText(
  model: ConversationModel,
  locale: ConversationLocale,
  system: string,
  user: string,
  maxTokens: number,
  signal: AbortSignal,
  purpose: LlmPurpose
): Promise<{ text: string; stop: StopReason }> {
  const stream = streamConversation({
    model,
    locale,
    maxTokens,
    system: [{ name: 'base', text: system }],
    tools: [],
    webSearch: false,
    messages: [userText(user)],
    signal
  }, purpose)
  const result = await stream.final()
  return { text: textOf(result.message), stop: result.stop }
}

/** Nothing here validates the result: the provider's structured output is what makes it match the schema. */
export async function completeJson(
  model: ConversationModel,
  system: string,
  user: string,
  schema: JsonSchema,
  maxTokens: number,
  signal: AbortSignal,
  purpose: LlmPurpose
): Promise<unknown> {
  const response = await ADAPTERS[model.provider].completeJson({ model, system, user, schema, maxTokens, signal }, requireKey(model.provider))
  recordCall(purpose, model, response.usage)
  return response.value()
}
