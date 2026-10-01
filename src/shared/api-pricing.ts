import type { RoundUsage } from './ipc'
import type { ConversationModel } from './llm-catalog'

/**
 * The list prices of the conversation models, in USD per million tokens, from each provider's pricing
 * page on 2026-09-23 at the standard tier. The live engine's prices are in voice-engine, and the agent
 * CLIs report their own cost.
 *
 * - Anthropic: the cache write is the five-minute price, because every breakpoint the adapter places
 *   is `ephemeral` without a ttl.
 * - OpenAI: a request whose input passes 272K tokens is billed at twice the input prices and 1.5 times
 *   the output price for the whole request.
 * - Google: the implicit cache the adapter relies on has no write or storage charge. Grounding costs
 *   $14 per 1,000 search queries after 5,000 free ones a month shared by every Gemini 3 model; the free
 *   allowance is not subtracted, since other uses of the same key draw on it too.
 * - Cerebras lists no cache price, so cached tokens are priced as input.
 */

export interface TokenPrice {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

interface ModelPrice extends TokenPrice {
  /** The input size above which the long-context prices apply to the whole request. */
  longContext?: { above: number; inputFactor: number; outputFactor: number }
}

const OPENAI_LONG_CONTEXT = { above: 272_000, inputFactor: 2, outputFactor: 1.5 }

const MODEL_PRICES: Record<string, ModelPrice> = {
  'anthropic:claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'anthropic:claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  'anthropic:claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'openai:gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2, longContext: OPENAI_LONG_CONTEXT },
  'openai:gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12, longContext: OPENAI_LONG_CONTEXT },
  'openai:gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20, longContext: OPENAI_LONG_CONTEXT },
  'google:gemini-3.8-flash': { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 },
  'google:gemini-3.5-flash-lite': { input: 0.3, cacheRead: 0.03, cacheWrite: 0, output: 2.5 },
  'cerebras:qwen-3.8-27b': { input: 0.99, cacheRead: 0.99, cacheWrite: 0.99, output: 1.49 },
  'cerebras:gpt-oss-120b': { input: 0.35, cacheRead: 0.35, cacheWrite: 0.35, output: 0.75 }
}

/** The fee in USD for one provider-side web search. Cerebras offers no web search. */
const WEB_SEARCH_PRICE: Record<ConversationModel['provider'], number> = {
  anthropic: 10 / 1000,
  openai: 10 / 1000,
  google: 14 / 1000,
  cerebras: 0
}

/**
 * The cost in USD of one response, or null for a model the price list does not have. The tokens of
 * `usage.input` exclude the cached ones on every provider; on OpenAI they still include the cache
 * writes, which are billed at their own price, so those are taken out of the input first.
 */
export function llmCost(model: Pick<ConversationModel, 'provider' | 'id'>, usage: RoundUsage): number | null {
  const price = MODEL_PRICES[`${model.provider}:${model.id}`]
  if (!price) return null
  const uncached = model.provider === 'openai' ? Math.max(usage.input - usage.cacheCreation, 0) : usage.input
  const promptSize = usage.input + usage.cacheRead + (model.provider === 'openai' ? 0 : usage.cacheCreation)
  const long = price.longContext && promptSize > price.longContext.above ? price.longContext : null
  const inputFactor = long?.inputFactor ?? 1
  const outputFactor = long?.outputFactor ?? 1
  const tokens =
    (uncached * price.input + usage.cacheRead * price.cacheRead + usage.cacheCreation * price.cacheWrite) * inputFactor +
    usage.output * price.output * outputFactor
  return tokens / 1_000_000 + usage.webSearches * WEB_SEARCH_PRICE[model.provider]
}
