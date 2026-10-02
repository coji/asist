import { withTimeoutSignal } from '@shared/abort'
import {
  ApiKeyValidationError,
  classifyApiKeyValidationError,
  validateConfiguredApiModels,
  type ConfiguredApiModel
} from '@shared/api-key-validation'
import type { JsonSchema } from '@shared/conversation'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO, type LlmProvider } from '@shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'
import type { ApiKeyState, AppSettings } from '@shared/ipc'
import { modelsInUse, type ModelSetting } from '@shared/settings'
import { t } from '../i18n'
import { SecretUnreadableError } from '../encrypted-secrets'
import { getSettings } from '../settings'
import { providerKey, type ProviderKeys } from './keys'
import { ADAPTERS, completeJson } from './call'

/**
 * Validation of the models in use, plus the lightweight one-shot JSON call on the bridge model. A
 * configuration is only persisted once each model in use has been fetched from the real API with that
 * provider's key, so a configuration that cannot run is never stored.
 */

export { providerKey, saveProviderKey } from './keys'

let validatedConfiguration: string | null = null
const validationFlights = new Map<string, Promise<void>>()
/** The key value that authenticated against the real API in this process, per provider. */
const verifiedKeys = new Map<LlmProvider, string>()

function forgetIfUnauthenticated(error: unknown, provider: LlmProvider, key: string): void {
  if (error instanceof ApiKeyValidationError && error.code === 'authentication' && verifiedKeys.get(provider) === key) {
    verifiedKeys.delete(provider)
  }
}

function keyState(provider: LlmProvider): ApiKeyState {
  let key: string | undefined
  try {
    key = providerKey(provider)
  } catch (error) {
    if (error instanceof SecretUnreadableError) return 'unreadable'
    throw error
  }
  return key === undefined ? 'missing' : verifiedKeys.get(provider) === key ? 'verified' : 'saved'
}

/**
 * A provider counts as verified only while the key in the environment is still the one that was verified.
 * A saved key that cannot be decrypted is reported for its own provider, so the status still shows the
 * others and the screen can ask for that one key again.
 */
export function llmKeyStates(): Record<LlmProvider, ApiKeyState> {
  return Object.fromEntries(LLM_PROVIDERS.map((provider) => [provider, keyState(provider)])) as Record<LlmProvider, ApiKeyState>
}

/** The models in use, as the checks against the real API name them. */
export function configuredModels(
  settings: Pick<AppSettings, ModelSetting | 'bridgePhrase'> = getSettings()
): ConfiguredApiModel[] {
  return modelsInUse(settings).map(({ setting, model }) => ({ label: t(`llmModels.targets.${setting}`), provider: model.provider, id: model.id }))
}

/** The keys of the providers the models use. No other provider's key is read. */
function keysOf(models: readonly ConfiguredApiModel[]): ProviderKeys {
  const keys: ProviderKeys = {}
  for (const { provider } of models) {
    const key = providerKey(provider)
    if (key) keys[provider] = key
  }
  return keys
}

function validationFingerprint(keys: ProviderKeys, models: readonly ConfiguredApiModel[]): string {
  return JSON.stringify(models.map(({ provider, id }) => [provider, id.trim(), keys[provider] ?? '']))
}

/** Whether the current combination of keys and models was verified against the real API in this process. */
export function configuredApiKeyVerified(): boolean {
  const models = configuredModels()
  return validatedConfiguration === validationFingerprint(keysOf(models), models)
}

const RETRIEVE_TIMEOUT_MS = 15_000

function retrieveModel(model: ConfiguredApiModel, key: string): Promise<void> {
  return ADAPTERS[model.provider].retrieveModel(model.id, key, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

function listModels(provider: LlmProvider, key: string): Promise<void> {
  return ADAPTERS[provider].listModels(key, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

/**
 * Checks that each configured model can be fetched from the real API with its provider's key. A
 * provider without a key counts as an authentication failure, and only one validation of the same
 * configuration runs at a time.
 */
export async function validateConfiguration(
  models: readonly ConfiguredApiModel[] = configuredModels(),
  keys: ProviderKeys = keysOf(models)
): Promise<void> {
  const fingerprint = validationFingerprint(keys, models)
  const existing = validationFlights.get(fingerprint)
  if (existing) return existing

  const operation = (async () => {
    try {
      await validateConfiguredApiModels(models, (model) => {
        const key = keys[model.provider]
        if (!key) {
          const info = LLM_PROVIDER_INFO[model.provider]
          throw new ApiKeyValidationError(
            'authentication',
            errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }),
            model
          )
        }
        return retrieveModel(model, key).then(() => verifiedKeys.set(model.provider, key))
      })
      validatedConfiguration = fingerprint
    } catch (error) {
      // An explicit revalidation that failed must not leave the same configuration usable through the earlier success.
      if (validatedConfiguration === fingerprint) validatedConfiguration = null
      if (error instanceof ApiKeyValidationError && error.model) {
        forgetIfUnauthenticated(error, error.model.provider, keys[error.model.provider] ?? '')
      }
      throw error
    }
  })().finally(() => {
    if (validationFlights.get(fingerprint) === operation) validationFlights.delete(fingerprint)
  })
  validationFlights.set(fingerprint, operation)
  return operation
}

/**
 * Checks a candidate key for a provider before it is saved. If a configured model uses that provider
 * the model itself is fetched; otherwise listing the models checks only that the key authenticates.
 * No saved key is read, so entering a key again replaces one that can no longer be decrypted.
 */
export async function validateProviderKey(
  provider: LlmProvider,
  rawKey: string,
  models: readonly ConfiguredApiModel[] = configuredModels()
): Promise<void> {
  const key = rawKey.trim()
  if (!key || /[\r\n]/.test(key)) throw new Error(errorText('llmModels.errors.keyEmpty'))
  const own = models.filter((model) => model.provider === provider)
  if (own.length > 0) return validateConfiguration(own, { [provider]: key })
  try {
    await listModels(provider, key)
    verifiedKeys.set(provider, key)
  } catch (error) {
    const classified = classifyApiKeyValidationError(error, { label: t('llmModels.targets.apiKey'), provider, id: '' })
    forgetIfUnauthenticated(classified, provider, key)
    throw classified
  }
}

/** First-run setup needs the current key to authenticate, not merely to be present, so a stored key alone is not enough. */
export async function configuredApiKeyAvailable(): Promise<boolean> {
  try {
    if (!configuredApiKeyVerified()) await validateConfiguration()
    return true
  } catch {
    return false
  }
}

/**
 * A one-shot call on the bridge model that returns JSON matching the schema. The provider's
 * structured output guarantees the shape, so no JSON is dug out of free text here.
 */
export function quickJson(system: string, user: string, schema: JsonSchema, signal?: AbortSignal): Promise<unknown> {
  return completeJson(getSettings().bridgeModel, system, user, schema, 1024, withTimeoutSignal(signal, 30_000), 'bridge')
}
