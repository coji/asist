import { errorText } from '@shared/i18n/error-text'
import { LLM_PROVIDER_INFO, type LlmProvider, type OpenAiAuthMethod } from '@shared/llm-catalog'
import { chatgptAuth } from '../chatgpt'
import { getSettings } from '../settings'
import { apiKeyCredential, type ProviderCredential } from './adapter'
import { providerKey } from './keys'

/**
 * The credential each provider's requests are made with. OpenAI's comes from the method chosen in the
 * settings alone: with ChatGPT chosen an API key in the environment or in the settings is never used, and
 * without a sign-in there is no credential rather than the key.
 */
export function providerCredential(provider: LlmProvider, openaiAuth: OpenAiAuthMethod = getSettings().openaiAuth): ProviderCredential | undefined {
  if (provider === 'openai' && openaiAuth === 'chatgpt') {
    const auth = chatgptAuth()
    const account = auth.account()
    return account ? { type: 'chatgpt', account: account.clientId, accessToken: (signal) => auth.accessToken(signal), forgetToken: (token) => auth.forgetAccessToken(token) } : undefined
  }
  const key = providerKey(provider)
  return key === undefined ? undefined : apiKeyCredential(key)
}

/** The error of a call whose provider has no credential, naming what is missing: the API key or the ChatGPT sign-in. */
export function missingCredentialError(provider: LlmProvider, openaiAuth: OpenAiAuthMethod = getSettings().openaiAuth): Error {
  if (provider === 'openai' && openaiAuth === 'chatgpt') return new Error(errorText('settingsIntegrations.chatgpt.errors.signedOut'))
  const info = LLM_PROVIDER_INFO[provider]
  return new Error(errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }))
}

/** What tells one credential from another when a verified configuration is remembered: the key, or the ChatGPT registration. */
export const credentialIdentity = (credential: ProviderCredential): string =>
  credential.type === 'api-key' ? credential.key : `chatgpt:${credential.account}`
