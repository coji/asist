import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'

const mocks = vi.hoisted(() => ({
  conversationLocale: 'ja-JP',
  connect: vi.fn(async () => ({}))
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly live = { connect: mocks.connect }
  },
  Behavior: { NON_BLOCKING: 'NON_BLOCKING' },
  FunctionResponseScheduling: { WHEN_IDLE: 'WHEN_IDLE', INTERRUPT: 'INTERRUPT', SILENT: 'SILENT' },
  Modality: { AUDIO: 'AUDIO' },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ conversationLocale: mocks.conversationLocale })
}))

/**
 * The Live models whose session the API closes at setup without a thinking level, and the levels it opens
 * them with, as measured on 2026-10-02 (it refuses minimal as well). This is a fact about the API, which
 * the catalog's own field cannot show once it is lost, so it is kept here and checked against the catalog.
 */
const NEEDS_THINKING_LEVEL = new Set(['gemini-3.8-live-extended-thinking'])
const ACCEPTED_THINKING_LEVELS = ['LOW', 'MEDIUM', 'HIGH']

const params = {
  model: 'gemini-3.8-live',
  systemInstruction: 'system',
  voice: 'Puck',
  functionDeclarations: [],
  resumptionHandle: null,
  callbacks: { onmessage: vi.fn(), onerror: vi.fn(), onclose: vi.fn() }
}

async function connectedConfig(model = params.model): Promise<{
  speechConfig: { languageCode: string }
  inputAudioTranscription: { languageCodes: string[] }
  outputAudioTranscription: { languageCodes: string[] }
  thinkingConfig?: { thinkingLevel?: string }
}> {
  const { connectGemini } = await import('../src/main/services/live/gemini-connect')
  await connectGemini('key', { ...params, model })
  return mocks.connect.mock.calls.at(-1)![0].config
}

beforeEach(() => {
  vi.resetModules()
  mocks.connect.mockClear()
  mocks.conversationLocale = 'ja-JP'
})

describe('the Gemini Live connection', () => {
  it('pins every language of the session to Japanese while the conversation is Japanese', async () => {
    const config = await connectedConfig()
    expect(config.speechConfig.languageCode).toBe('ja-JP')
    expect(config.inputAudioTranscription.languageCodes).toEqual(['ja-JP'])
    expect(config.outputAudioTranscription.languageCodes).toEqual(['ja-JP'])
  })

  it('pins them to the conversation language, and to a region the speech APIs know', async () => {
    mocks.conversationLocale = 'es-419'
    const config = await connectedConfig()
    expect(config.speechConfig.languageCode).toBe('es-MX')
    expect(config.inputAudioTranscription.languageCodes).toEqual(['es-MX'])
    expect(config.outputAudioTranscription.languageCodes).toEqual(['es-MX'])
  })

  it('opens every catalog model the Live API closes at setup without a thinking level with a level it accepts', async () => {
    const models = LIVE_ENGINE_INFO['gemini-live'].models.filter((model) => NEEDS_THINKING_LEVEL.has(model.id))
    for (const model of models) {
      const config = await connectedConfig(model.id)
      expect(ACCEPTED_THINKING_LEVELS, model.id).toContain(config.thinkingConfig?.thinkingLevel)
    }
  })
})
