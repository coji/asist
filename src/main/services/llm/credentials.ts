import type { OpenAiAuthMethod, LlmProvider } from '@shared/llm-catalog'
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
    return account ? { type: 'chatgpt', account: account.clientId, accessToken: () => auth.accessToken() } : undefined
  }
  const key = providerKey(provider)
  return key === undefined ? undefined : apiKeyCredential(key)
}

/** What tells one credential from another when a verified configuration is remembered: the key, or the ChatGPT registration. */
export const credentialIdentity = (credential: ProviderCredential): string =>
  credential.type === 'api-key' ? credential.key : `chatgpt:${credential.account}`
