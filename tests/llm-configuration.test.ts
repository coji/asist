import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'

/**
 * Validation of the models in the settings. The conversation model and the aizuchi model are each
 * looked up through the API of their own provider, and a provider without a key is reported as an
 * authentication failure.
 */

/** What an error names as the conversation model, which is its label in the interface language and its ID. */
const conversationTarget = (id: string): string =>
  `${createTranslator('ja-JP')('llmModels.targets.conversationModel')} (${id})`

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  compatibleRetrieve: vi.fn(),
  compatibleList: vi.fn(),
  compatibleClients: [] as Array<{ apiKey?: string; baseURL?: string }>,
  googleGet: vi.fn(),
  googleList: vi.fn(),
  googleClients: [] as Array<{ apiKey?: string }>,
  settings: {
    uiLocale: 'ja-JP',
    conversationModel: { provider: 'anthropic', id: 'claude-main' },
    bridgeModel: { provider: 'anthropic', id: 'claude-fast' },
    bridgePhrase: true
  }
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    models = { retrieve: mocks.retrieve }
  }
}))
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    models = { retrieve: mocks.compatibleRetrieve, list: mocks.compatibleList }
    constructor(options: { apiKey?: string; baseURL?: string }) {
      mocks.compatibleClients.push(options)
    }
  }
}))

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class FakeGoogle {
    models = { get: mocks.googleGet, list: mocks.googleList }
    constructor(options: { apiKey?: string }) {
      mocks.googleClients.push(options)
    }
  }
}))

vi.mock('../src/main/services/settings', () => ({
  getSettings: () => mocks.settings
}))
vi.mock('../src/main/services/api-key-secrets', () => ({ savedApiKey: () => null }))

const previous = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.compatibleClients.length = 0
  mocks.googleClients.length = 0
  mocks.googleGet.mockResolvedValue({ name: 'models/x' })
  mocks.googleList.mockResolvedValue({ page: [] })
  mocks.settings.conversationModel = { provider: 'anthropic', id: 'claude-main' }
  mocks.settings.bridgeModel = { provider: 'anthropic', id: 'claude-fast' }
  mocks.settings.bridgePhrase = true
  mocks.retrieve.mockResolvedValue({ type: 'model' })
  mocks.compatibleRetrieve.mockResolvedValue({ object: 'model' })
  mocks.compatibleList.mockResolvedValue({ data: [] })
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
})

afterEach(() => {
  for (const [name, value] of [
    ['ANTHROPIC_API_KEY', previous.anthropic],
    ['OPENAI_API_KEY', previous.openai],
    ['GEMINI_API_KEY', previous.google]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('LLM configuration validation fingerprint', () => {
  it('runs concurrent validations of the same configuration as a single request and records the result as verified', async () => {
    const llm = await import('../src/main/services/llm')

    await Promise.all([llm.configuredApiKeyAvailable(), llm.configuredApiKeyAvailable()])

    expect(mocks.retrieve.mock.calls.map(([id]) => id)).toEqual(['claude-main', 'claude-fast'])
    expect(llm.configuredApiKeyVerified()).toBe(true)
  })

  it('stops reporting the key as verified when the model fingerprint in the settings changes, and validates again', async () => {
    const llm = await import('../src/main/services/llm')
    await llm.configuredApiKeyAvailable()
    expect(llm.configuredApiKeyVerified()).toBe(true)

    mocks.settings.conversationModel = { provider: 'anthropic', id: 'claude-next' }
    expect(llm.configuredApiKeyVerified()).toBe(false)
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(true)

    expect(mocks.retrieve.mock.calls.map(([id]) => id)).toEqual([
      'claude-main',
      'claude-fast',
      'claude-next',
      'claude-fast'
    ])
  })
})

describe('the bridge phrase model while the bridge phrase is off', () => {
  it('is not looked up, so a missing key for its provider does not fail the configuration', async () => {
    mocks.settings.bridgePhrase = false
    mocks.settings.bridgeModel = { provider: 'openai', id: 'gpt-fast' }
    const llm = await import('../src/main/services/llm')

    await expect(llm.validateConfiguration()).resolves.toBeUndefined()
    expect(mocks.retrieve.mock.calls.map(([id]) => id)).toEqual(['claude-main'])
    expect(mocks.compatibleRetrieve).not.toHaveBeenCalled()
    expect(llm.configuredApiKeyVerified()).toBe(true)
  })

  it('is looked up again once the bridge phrase is turned on', async () => {
    mocks.settings.bridgePhrase = false
    const llm = await import('../src/main/services/llm')
    await llm.validateConfiguration()

    mocks.settings.bridgePhrase = true
    expect(llm.configuredApiKeyVerified()).toBe(false)
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(true)
    expect(mocks.retrieve.mock.calls.map(([id]) => id)).toEqual(['claude-main', 'claude-main', 'claude-fast'])
  })
})

describe('a conversation model from another provider', () => {
  it('looks up the conversation model and the aizuchi model through the API of their own provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    mocks.settings.conversationModel = { provider: 'openai', id: 'gpt-x' }
    const llm = await import('../src/main/services/llm')

    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(true)

    expect(mocks.compatibleRetrieve.mock.calls.map(([id]) => id)).toEqual(['gpt-x'])
    expect(mocks.compatibleClients).toEqual([{ apiKey: 'openai-key', maxRetries: 0 }])
    expect(mocks.retrieve.mock.calls.map(([id]) => id)).toEqual(['claude-fast'])
    expect(llm.configuredApiKeyVerified()).toBe(true)
  })

  it('reports an authentication failure without any lookup when the provider has no key', async () => {
    mocks.settings.conversationModel = { provider: 'openai', id: 'gpt-x' }
    const llm = await import('../src/main/services/llm')

    await expect(llm.validateConfiguration()).rejects.toThrow('OPENAI_API_KEY')
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(false)
    expect(mocks.compatibleRetrieve).not.toHaveBeenCalled()
    expect(mocks.retrieve).not.toHaveBeenCalled()
  })

  it('validates a candidate key against the configured model of that provider, or against the model list when no model uses it', async () => {
    mocks.settings.conversationModel = { provider: 'openai', id: 'gpt-x' }
    const llm = await import('../src/main/services/llm')

    await llm.validateProviderKey('openai', ' candidate ')
    expect(mocks.compatibleRetrieve.mock.calls.map(([id]) => id)).toEqual(['gpt-x'])
    expect(mocks.compatibleClients.at(-1)).toMatchObject({ apiKey: 'candidate' })
    expect(mocks.retrieve).not.toHaveBeenCalled()

    await llm.validateProviderKey('google', 'g-key')
    expect(mocks.googleList).toHaveBeenCalledTimes(1)
    expect(mocks.googleClients.at(-1)).toEqual({ apiKey: 'g-key' })
    expect(mocks.compatibleList).not.toHaveBeenCalled()

    await llm.validateProviderKey('cerebras', 'c-key')
    expect(mocks.compatibleClients.at(-1)).toMatchObject({ apiKey: 'c-key', baseURL: 'https://api.cerebras.ai/v1' })

    mocks.compatibleList.mockRejectedValueOnce({ status: 401 })
    await expect(llm.validateProviderKey('cerebras', 'bad')).rejects.toThrow(errorText('llmModels.errors.authentication', { provider: 'Cerebras' }))
    await expect(llm.validateProviderKey('cerebras', '')).rejects.toThrow(errorText('llmModels.errors.keyEmpty'))
  })
})

describe('the record of which provider keys are verified', () => {
  it('marks a provider verified only once the environment holds the very key that was validated', async () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    const llm = await import('../src/main/services/llm')
    expect(llm.llmKeyStates()).toEqual({ anthropic: 'saved', openai: 'saved', google: 'missing', cerebras: 'missing' })

    await llm.validateProviderKey('google', 'g-key')
    expect(llm.llmKeyStates().google).toBe('missing')
    process.env.GEMINI_API_KEY = 'g-key'
    expect(llm.llmKeyStates().google).toBe('verified')
    process.env.GEMINI_API_KEY = 'other-key'
    expect(llm.llmKeyStates().google).toBe('saved')
  })

  it('marks a provider verified after a successful lookup of the configured model and drops that state on an authentication failure', async () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    mocks.settings.conversationModel = { provider: 'openai', id: 'gpt-x' }
    const llm = await import('../src/main/services/llm')

    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(true)
    expect(llm.llmKeyStates()).toMatchObject({ anthropic: 'verified', openai: 'verified' })

    mocks.compatibleRetrieve.mockRejectedValueOnce({ status: 401 })
    mocks.settings.conversationModel = { provider: 'openai', id: 'gpt-y' }
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(false)
    expect(llm.llmKeyStates()).toMatchObject({ anthropic: 'verified', openai: 'saved' })

    // A model that is merely not found still means the key itself was accepted.
    mocks.compatibleRetrieve.mockRejectedValueOnce({ status: 404 })
    await expect(llm.validateProviderKey('openai', 'openai-key')).rejects.toThrow(errorText('llmModels.errors.modelUnavailable', { target: conversationTarget('gpt-y') }))
    expect(llm.llmKeyStates().openai).toBe('saved')
    await llm.validateProviderKey('openai', 'openai-key')
    expect(llm.llmKeyStates().openai).toBe('verified')
    mocks.compatibleRetrieve.mockRejectedValueOnce({ status: 404 })
    await expect(llm.validateProviderKey('openai', 'openai-key')).rejects.toThrow(errorText('llmModels.errors.modelUnavailable', { target: conversationTarget('gpt-y') }))
    expect(llm.llmKeyStates().openai).toBe('verified')
  })

  it('reports the 400 that Gemini returns for an invalid key as an authentication failure', async () => {
    const { ApiError } = await import('@google/genai')
    const llm = await import('../src/main/services/llm')
    mocks.googleList.mockRejectedValueOnce(new ApiError({ status: 400, message: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}' }))
    await expect(llm.validateProviderKey('google', 'bad')).rejects.toThrow(errorText('llmModels.errors.authentication', { provider: 'Google' }))
  })
})
