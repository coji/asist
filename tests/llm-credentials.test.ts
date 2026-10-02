import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Which credential an OpenAI request is made with: only the method chosen in the settings, never the other one in its place. */

const mocks = vi.hoisted(() => ({
  openaiAuth: 'api-key' as 'api-key' | 'chatgpt',
  key: 'sk-openai' as string | undefined,
  account: { email: 'someone@example.com', clientId: 'oaiapp_1' } as { email: string; clientId: string } | null,
  accessToken: vi.fn(async () => 'plan-token')
}))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ openaiAuth: mocks.openaiAuth }) }))
vi.mock('../src/main/services/llm/keys', () => ({ providerKey: () => mocks.key }))
vi.mock('../src/main/services/chatgpt', () => ({ chatgptAuth: () => ({ account: () => mocks.account, accessToken: mocks.accessToken }) }))

const { credentialIdentity, providerCredential } = await import('../src/main/services/llm/credentials')

beforeEach(() => {
  mocks.openaiAuth = 'api-key'
  mocks.key = 'sk-openai'
  mocks.account = { email: 'someone@example.com', clientId: 'oaiapp_1' }
})

describe('the credential of a provider', () => {
  it('is the API key while the API key is chosen, even with a ChatGPT sign-in saved', () => {
    expect(providerCredential('openai')).toEqual({ type: 'api-key', key: 'sk-openai' })
  })

  it('is the ChatGPT sign-in while ChatGPT is chosen, whose token is fetched for each request', async () => {
    mocks.openaiAuth = 'chatgpt'
    const credential = providerCredential('openai')
    expect(credential).toMatchObject({ type: 'chatgpt', account: 'oaiapp_1' })
    await expect(credential?.type === 'chatgpt' && credential.accessToken()).resolves.toBe('plan-token')
  })

  it('is none while ChatGPT is chosen and nobody is signed in, rather than the API key that is there', () => {
    mocks.openaiAuth = 'chatgpt'
    mocks.account = null
    expect(providerCredential('openai')).toBeUndefined()
  })

  it('follows a method that is about to be saved rather than the one saved', () => {
    expect(providerCredential('openai', 'chatgpt')).toMatchObject({ type: 'chatgpt' })
  })

  it('is the API key for every other provider, whatever OpenAI uses', () => {
    mocks.openaiAuth = 'chatgpt'
    expect(providerCredential('anthropic')).toEqual({ type: 'api-key', key: 'sk-openai' })
  })

  it('is told apart by the registration of a sign-in, which stays the same while its token changes every hour', () => {
    expect(credentialIdentity({ type: 'chatgpt', account: 'oaiapp_1', accessToken: async () => 'a' })).toBe(credentialIdentity({ type: 'chatgpt', account: 'oaiapp_1', accessToken: async () => 'b' }))
  })
})

describe('the state of what OpenAI would be called with, as the settings screens read it', async () => {
  const { credentialState } = await import('../src/shared/ipc')
  const status = (chatgpt: 'signedIn' | 'signedOut' | 'unreadable') => ({
    llmKeys: { anthropic: 'verified', openai: 'verified', google: 'missing', cerebras: 'missing' } as const,
    chatgpt: { state: chatgpt, email: null }
  })

  it('is the API key while the API key is chosen', () => {
    expect(credentialState(status('signedOut'), 'api-key', 'openai')).toBe('verified')
  })

  it('is the ChatGPT sign-in while ChatGPT is chosen, so a verified API key does not make OpenAI look ready', () => {
    expect(credentialState(status('signedOut'), 'chatgpt', 'openai')).toBe('missing')
    expect(credentialState(status('signedIn'), 'chatgpt', 'openai')).toBe('saved')
    expect(credentialState(status('unreadable'), 'chatgpt', 'openai')).toBe('unreadable')
  })

  it('leaves every other provider on its API key', () => {
    expect(credentialState(status('signedOut'), 'chatgpt', 'google')).toBe('missing')
  })
})
