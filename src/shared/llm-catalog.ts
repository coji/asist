import { z } from 'zod'
import type { MessageKey } from './i18n'
import { errorText } from './i18n/error-text'

/**
 * The providers and models for conversation. The choices offered on the settings screen and what each
 * provider can do live here in one place. Two models are chosen: the conversation model and the
 * bridge phrase model, which prepares a short bridge phrase while the user is
 * still speaking. Memory curation runs through the Agent CLI and does not use this API. How each API
 * is actually called belongs to the per-provider adapters in main/services/llm/.
 */

export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'cerebras'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export interface LlmProviderInfo {
  label: string
  /** The environment variable that holds the key. It wins over the key saved in settings, and no child process receives it. */
  envKey: string
  keyPlaceholder: string
  /** The page where a key is issued. */
  console: string
  /** Where to create the key once that page is open. It is written only for a provider whose URL does not lead there directly. */
  consoleNote?: Extract<MessageKey, `setup.model.consoleNotes.${string}`>
  /** Whether the provider's built-in web search can be used in conversation. */
  webSearch: boolean
}

export const LLM_PROVIDER_INFO: Record<LlmProvider, LlmProviderInfo> = {
  anthropic: {
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-…',
    console: 'https://console.anthropic.com/settings/keys',
    webSearch: true
  },
  openai: {
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-…',
    console: 'https://platform.openai.com/api-keys',
    webSearch: true
  },
  google: {
    label: 'Google',
    envKey: 'GEMINI_API_KEY',
    keyPlaceholder: 'AIza…',
    console: 'https://aistudio.google.com/api-keys',
    webSearch: true
  },
  cerebras: {
    label: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    keyPlaceholder: 'csk-…',
    console: 'https://cloud.cerebras.ai/',
    consoleNote: 'setup.model.consoleNotes.cerebras',
    webSearch: false
  }
}

/**
 * The depth of thinking. Each provider takes it differently: Anthropic as output_config.effort,
 * OpenAI as reasoning.effort, Gemini as thinkingLevel and Cerebras as reasoning_effort. Every model
 * defaults to the shallowest level, low, so that a voice reply does not keep the user waiting: in the
 * Claude 5 generation adaptive thinking stays on even when thinking is omitted, and with its default
 * of high a thousand tokens of thinking came before the reply and TTFT went past 15 seconds, measured
 * on 2026-09-20.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]
const ANTHROPIC_EFFORTS: readonly Effort[] = EFFORT_LEVELS
const LOW_TO_HIGH_EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

export interface ConversationModel {
  provider: LlmProvider
  id: string
  /** The depth of thinking. Omitting it falls back to the model's default, which effortFor resolves. */
  effort?: Effort
}

export const conversationModelSchema = z.strictObject({
  provider: z.enum(LLM_PROVIDERS),
  id: z.string().trim().min(1),
  effort: z.enum(EFFORT_LEVELS).optional()
})

export interface CatalogModel extends ConversationModel {
  label: string
  /** The key of the model's one-line description in the dictionary, because a shared module holds no interface text. */
  note: Extract<MessageKey, `llmModels.notes.${string}`>
  /** The depths the model accepts. When it is empty the parameter is not sent at all. */
  efforts: readonly Effort[]
  /** The depth used when the settings name none. It is null when `efforts` is empty. */
  defaultEffort: Effort | null
}

/** The models offered on the settings screen. Each `id` is the model ID of that provider's own API. */
export const CONVERSATION_MODELS: readonly CatalogModel[] = [
  { provider: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'llmModels.notes.standard', efforts: ANTHROPIC_EFFORTS, defaultEffort: 'low' },
  { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'llmModels.notes.lightWithoutEffort', efforts: [], defaultEffort: null },
  { provider: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5', note: 'llmModels.notes.mostCapable', efforts: ANTHROPIC_EFFORTS, defaultEffort: 'low' },
  { provider: 'openai', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'llmModels.notes.light', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'openai', id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'llmModels.notes.standard', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'openai', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'llmModels.notes.mostCapable', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'google', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'llmModels.notes.standard', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'google', id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', note: 'llmModels.notes.light', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'cerebras', id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B', note: 'llmModels.notes.cerebrasSpeed', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' },
  { provider: 'cerebras', id: 'gpt-oss-120b', label: 'GPT OSS 120B', note: 'llmModels.notes.openWeight', efforts: LOW_TO_HIGH_EFFORTS, defaultEffort: 'low' }
]

/**
 * The pair of models a provider is used with: the standard model for conversation and a fast,
 * lightweight one for the bridge look-ahead. It applies at first setup and when the conversation
 * provider is changed in the settings, so the app works with a key for any single provider. Cerebras
 * has no lightweight tier, so its bridge look-ahead uses the conversation model too.
 */
export const PROVIDER_DEFAULT_MODELS: Record<LlmProvider, { conversation: string; bridge: string }> = {
  anthropic: { conversation: 'claude-sonnet-5', bridge: 'claude-haiku-4-5' },
  openai: { conversation: 'gpt-5.6-terra', bridge: 'gpt-5.6-luna' },
  google: { conversation: 'gemini-3.8-flash', bridge: 'gemini-3.5-flash-lite' },
  cerebras: { conversation: 'qwen-3.8-27b', bridge: 'qwen-3.8-27b' }
}

export function defaultModelsFor(provider: LlmProvider): { conversationModel: ConversationModel; bridgeModel: ConversationModel } {
  const ids = PROVIDER_DEFAULT_MODELS[provider]
  return { conversationModel: { provider, id: ids.conversation }, bridgeModel: { provider, id: ids.bridge } }
}

/**
 * The depths of thinking a model accepts. An id that is not in the catalog falls back to the
 * provider's rule: on Anthropic, Claude 4.6 and later and Opus 4.5 accept it, while Haiku 4.5,
 * Sonnet 4.5 and the 3 generation answer 400. Every other provider takes low, medium and high.
 */
export function effortOptions(model: ConversationModel): readonly Effort[] {
  const known = CONVERSATION_MODELS.find((m) => sameModel(m, model))
  if (known) return known.efforts
  if (model.provider === 'anthropic') return /haiku|sonnet-4-5|-3-/.test(model.id) ? [] : ANTHROPIC_EFFORTS
  return LOW_TO_HIGH_EFFORTS
}

/** The depth sent to the API: the one chosen in the settings, otherwise the model's default, and null for a model that does not accept one. */
export function effortFor(model: ConversationModel): Effort | null {
  const options = effortOptions(model)
  if (model.effort !== undefined) {
    if (!options.includes(model.effort)) throw new Error(errorText('llmModels.errors.effortUnsupported', { model: modelLabel(model) }))
    return model.effort
  }
  if (options.length === 0) return null
  return CONVERSATION_MODELS.find((m) => sameModel(m, model))?.defaultEffort ?? 'low'
}

export const sameModel = (a: ConversationModel, b: ConversationModel): boolean => a.provider === b.provider && a.id === b.id

export const catalogModelsOf = (provider: LlmProvider): CatalogModel[] => CONVERSATION_MODELS.filter((m) => m.provider === provider)

/** The name without the provider, such as "GPT-5.6 Luna". An id that is not in the catalog is shown as it is. */
export const modelName = (model: ConversationModel): string => CONVERSATION_MODELS.find((m) => sameModel(m, model))?.label ?? model.id

/** The display name with the provider, such as "OpenAI · GPT-5.6 Luna". An id that is not in the catalog is shown as it is. */
export function modelLabel(model: ConversationModel): string {
  return `${LLM_PROVIDER_INFO[model.provider].label} · ${modelName(model)}`
}

