import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRequest } from '@shared/conversation'

/** Every conversation model call that completes leaves its use, priced, in the usage record under what it was for. */

const mocks = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  final: vi.fn(),
  completeJson: vi.fn(),
  generateContent: vi.fn(),
  credential: { type: 'api-key', key: 'key' } as { type: 'api-key'; key: string } | { type: 'chatgpt'; account: string; accessToken: () => Promise<string> }
}))

vi.mock('../src/main/services/usage-ledger', () => ({ recordUsage: mocks.recordUsage }))
vi.mock('../src/main/services/llm/credentials', () => ({ providerCredential: () => mocks.credential }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ openaiAuth: 'api-key' }) }))
const adapter = {
  stream: () => ({ final: mocks.final }),
  completeJson: mocks.completeJson,
  retrieveModel: vi.fn(),
  listModels: vi.fn()
}
vi.mock('../src/main/services/llm/anthropic', () => ({ anthropicAdapter: adapter }))
vi.mock('../src/main/services/llm/openai', () => ({ openaiAdapter: adapter }))
vi.mock('../src/main/services/llm/cerebras', () => ({ cerebrasAdapter: adapter }))
// Google's adapter runs for real, on a fake SDK, to show what a response the adapter cannot read leaves behind.
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class FakeGoogle {
    models = { generateContent: mocks.generateContent }
  }
}))

const { completeJson, streamConversation } = await import('../src/main/services/llm/call')

const usage = { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0, webSearches: 0 }
const request = { model: { provider: 'anthropic', id: 'claude-haiku-4-5' } } as ConversationRequest

beforeEach(() => {
  mocks.recordUsage.mockClear()
  mocks.credential = { type: 'api-key', key: 'key' }
})

describe('recording the use of a conversation model', () => {
  it('records a streamed response once it completes, with its price', async () => {
    mocks.final.mockReturnValue(Promise.resolve({ usage }))
    await streamConversation(request, 'conversation').final()
    await Promise.resolve()
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'llm', purpose: 'conversation', provider: 'anthropic', model: 'claude-haiku-4-5', calls: 1, billing: 'api', costUsd: 1 })
    )
  })

  it('records a response paid from the ChatGPT plan without a price, since the API prices would show a cost nobody pays', async () => {
    mocks.credential = { type: 'chatgpt', account: 'oaiapp_1', accessToken: async () => 'token' }
    mocks.final.mockReturnValue(Promise.resolve({ usage }))
    await streamConversation({ model: { provider: 'openai', id: 'gpt-5.6-terra' } } as ConversationRequest, 'conversation').final()
    await Promise.resolve()
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-terra', input: 1_000_000, billing: 'chatgpt-plan', costUsd: null }))
  })

  it('records nothing for a response that fails, whose usage never arrives', async () => {
    const failed = Promise.reject(new Error('dropped'))
    failed.catch(() => {})
    mocks.final.mockReturnValue(failed)
    await expect(streamConversation(request, 'conversation').final()).rejects.toThrow('dropped')
    await Promise.resolve()
    expect(mocks.recordUsage).not.toHaveBeenCalled()
  })

  it('records nothing for a response that finished without its usage, rather than a use of no tokens, and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mocks.final.mockReturnValue(Promise.resolve({ usage: null }))
      await streamConversation(request, 'conversation').final()
      await Promise.resolve()
      expect(mocks.recordUsage).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('records a JSON call under its purpose and hands back only the value', async () => {
    mocks.completeJson.mockResolvedValueOnce({ usage, value: () => ({ bridge: 'x' }) })
    const value = await completeJson({ provider: 'openai', id: 'unknown-model' }, 's', 'u', { type: 'object' }, 10, new AbortController().signal, 'bridge')
    expect(value).toEqual({ bridge: 'x' })
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'bridge', model: 'unknown-model', costUsd: null }))
  })

  it('records a JSON call whose JSON the output limit cut short, which is billed although it fails', async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: '{"bridge":"京都の',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 4, thoughtsTokenCount: 1020 }
    })
    const model = { provider: 'google' as const, id: 'gemini-3.5-flash-lite' }
    await expect(completeJson(model, 's', 'u', { type: 'object' }, 1024, new AbortController().signal, 'bridge')).rejects.toThrow()
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'bridge', provider: 'google', input: 300, output: 1024 }))
  })
})
