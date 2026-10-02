import { errMessage, isChatGptSignInFailure } from './api-errors'
import { errorText } from './i18n/error-text'
import { LLM_PROVIDER_INFO, type LlmProvider } from './llm-catalog'

/** Before an API key is saved, the configured models are checked to be actually resolvable with it. */

export interface ConfiguredApiModel {
  /** What the model is called on the screen, already in the language of the interface. */
  label: string
  provider: LlmProvider
  /** The model ID. An empty string means the key itself is checked, by listing the models. */
  id: string
}

export type ApiKeyValidationFailure =
  | 'authentication'
  | 'permission'
  | 'model-unavailable'
  | 'billing'
  | 'rate-limit'
  | 'service'
  | 'request'
  | 'connection'

export class ApiKeyValidationError extends Error {
  constructor(
    readonly code: ApiKeyValidationFailure,
    message: string,
    readonly model?: ConfiguredApiModel,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ApiKeyValidationError'
  }
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * What an error names as the thing that could not be reached. The label arrives already translated,
 * and the ID is put in parentheses rather than in quotation marks, which differ between languages.
 */
const targetOf = (model: ConfiguredApiModel): string => (model.id ? `${model.label} (${model.id})` : model.label)

export function classifyApiKeyValidationError(
  error: unknown,
  model: ConfiguredApiModel
): ApiKeyValidationError {
  const status = httpStatus(error)
  const provider = LLM_PROVIDER_INFO[model.provider].label
  const target = targetOf(model)
  const fail = (code: ApiKeyValidationFailure, message: string): ApiKeyValidationError =>
    new ApiKeyValidationError(code, message, model, { cause: error })
  if (status === 401) return fail('authentication', isChatGptSignInFailure(error) ? errMessage(error) : errorText('llmModels.errors.authentication', { provider }))
  if (status === 403) return fail('permission', errorText('llmModels.errors.permission', { provider, target }))
  if (status === 404) return fail('model-unavailable', errorText('llmModels.errors.modelUnavailable', { target }))
  if (status === 402) return fail('billing', errorText('llmModels.errors.billing', { provider }))
  if (status === 429) return fail('rate-limit', errorText('llmModels.errors.rateLimit', { provider }))
  if (status !== undefined && (status >= 500 || status === 408)) {
    return fail('service', errorText('llmModels.errors.service', { provider }))
  }
  if (status !== undefined) return fail('request', errorText('llmModels.errors.request', { provider, target, status }))
  return fail('connection', errorText('llmModels.errors.connection', { provider, target }))
}

/** The same ID on the same provider is queried once, and a model left unconfigured is rejected before saving. */
export async function validateConfiguredApiModels(
  models: readonly ConfiguredApiModel[],
  retrieve: (model: ConfiguredApiModel) => Promise<unknown>
): Promise<void> {
  const seen = new Set<string>()
  for (const configured of models) {
    const model = { ...configured, id: configured.id.trim() }
    if (!model.id) {
      throw new ApiKeyValidationError('model-unavailable', errorText('llmModels.errors.modelIdMissing', { target: model.label }), model)
    }
    const key = `${model.provider}/${model.id}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      await retrieve(model)
    } catch (error) {
      if (error instanceof ApiKeyValidationError) throw error
      throw classifyApiKeyValidationError(error, model)
    }
  }
}
