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

import { providerKey } from './keys'
import { apiKeyCredential, type ProviderCredential } from './adapter'
import { ADAPTERS, completeJson } from './call'
import { credentialIdentity, providerCredential } from './credentials'

/**
 * Validation of the models in use, plus the lightweight one-shot JSON call on the bridge model. A
 * configuration is only persisted once each model in use has been fetched from the real API with that
 * provider's key, so a configuration that cannot run is never stored.
 */

export { providerKey, saveProviderKey } from './keys'

let validatedConfiguration: string | null = null
const validationFlights = new Map<string, Promise<void>>()
type ProviderCredentials = Partial<Record<LlmProvider, ProviderCredential>>

/** The identity of the credential that authenticated against the real API in this process, per provider. */
const verifiedKeys = new Map<LlmProvider, string>()

function forgetIfUnauthenticated(error: unknown, provider: LlmProvider, identity: string): void {
  if (error instanceof ApiKeyValidationError && error.code === 'authentication' && verifiedKeys.get(provider) === identity) {
    verifiedKeys.delete(provider)
  }
}

/** The state of the provider's API key alone, whichever way OpenAI is used; the ChatGPT sign-in has a status of its own. */
function keyState(provider: LlmProvider): ApiKeyState {
  let key: string | undefined
  try {
    key = providerKey(provider)
  } catch (error) {
    if (error instanceof SecretUnreadableError) return 'unreadable'
    throw error
  }
  return key === undefined ? 'missing' : verifiedKeys.get(provider) === credentialIdentity(apiKeyCredential(key)) ? 'verified' : 'saved'
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

/** The credentials of the providers the models use, with OpenAI's chosen by `openaiAuth`. No other provider's is read. */
export function credentialsOf(models: readonly ConfiguredApiModel[], openaiAuth = getSettings().openaiAuth): ProviderCredentials {
  const credentials: ProviderCredentials = {}
  for (const { provider } of models) {
    const credential = providerCredential(provider, openaiAuth)
    if (credential) credentials[provider] = credential
  }
  return credentials
}

function validationFingerprint(credentials: ProviderCredentials, models: readonly ConfiguredApiModel[]): string {
  return JSON.stringify(models.map(({ provider, id }) => [provider, id.trim(), credentials[provider] ? credentialIdentity(credentials[provider]) : '']))
}

/** Whether the current combination of keys and models was verified against the real API in this process. */
export function configuredApiKeyVerified(): boolean {
  const models = configuredModels()
  return validatedConfiguration === validationFingerprint(credentialsOf(models), models)
}

const RETRIEVE_TIMEOUT_MS = 15_000

function retrieveModel(model: ConfiguredApiModel, credential: ProviderCredential): Promise<void> {
  return ADAPTERS[model.provider].retrieveModel(model.id, credential, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

function listModels(provider: LlmProvider, credential: ProviderCredential): Promise<void> {
  return ADAPTERS[provider].listModels(credential, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

/**
 * Checks that each configured model can be fetched from the real API with its provider's key. A
 * provider without a key counts as an authentication failure, and only one validation of the same
 * configuration runs at a time.
 */
export async function validateConfiguration(
  models: readonly ConfiguredApiModel[] = configuredModels(),
  credentials: ProviderCredentials = credentialsOf(models)
): Promise<void> {
  const fingerprint = validationFingerprint(credentials, models)
  const existing = validationFlights.get(fingerprint)
  if (existing) return existing

  const operation = (async () => {
    try {
      await validateConfiguredApiModels(models, (model) => {
        const credential = credentials[model.provider]
        if (!credential) {
          const info = LLM_PROVIDER_INFO[model.provider]
          throw new ApiKeyValidationError(
            'authentication',
            errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }),
            model
          )
        }
        return retrieveModel(model, credential).then(() => verifiedKeys.set(model.provider, credentialIdentity(credential)))
      })
      validatedConfiguration = fingerprint
    } catch (error) {
      // An explicit revalidation that failed must not leave the same configuration usable through the earlier success.
      if (validatedConfiguration === fingerprint) validatedConfiguration = null
      if (error instanceof ApiKeyValidationError && error.model) {
        const credential = credentials[error.model.provider]
        forgetIfUnauthenticated(error, error.model.provider, credential ? credentialIdentity(credential) : '')
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
  if (own.length > 0) return validateConfiguration(own, { [provider]: apiKeyCredential(key) })
  try {
    await listModels(provider, apiKeyCredential(key))
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
