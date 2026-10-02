import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Emitter } from 'mitt'
import type { LiveEvent } from '@shared/ipc'
import type { LiveEngineEvents } from '../src/main/services/live/gemini-live'

/** The entry point of the live engine between the engine, the usage ledger and the renderer. */

interface FakeEngine {
  events: Emitter<LiveEngineEvents>
  /** What the engine reports while it stops. */
  stopping: () => void
}

const mocks = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  engines: [] as FakeEngine[]
}))

vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ voiceEngine: 'gemini-live', geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' } })
}))
vi.mock('../src/main/services/usage-ledger', () => ({ recordUsage: mocks.recordUsage }))
vi.mock('../src/main/services/llm', () => ({ providerKey: () => 'key' }))
vi.mock('../src/main/services/conversation-locale', () => ({ conversationLocale: () => 'ja-JP' }))
vi.mock('../src/main/services/memory', () => ({}))
vi.mock('../src/main/services/agent', () => ({}))
vi.mock('../src/main/services/brain/session', () => ({ emit: vi.fn(), history: {}, record: vi.fn(), setConversationOwner: vi.fn() }))
vi.mock('../src/main/services/brain/prompt', () => ({ buildLiveSystemInstruction: vi.fn() }))
vi.mock('../src/main/services/brain/conversation-log', () => ({ summarizeToolInput: vi.fn(), summarizeToolResult: vi.fn() }))
vi.mock('../src/main/services/brain/tools', () => ({ executeClientTool: vi.fn(), toolGuide: vi.fn(), toolRegistry: vi.fn(), tools: vi.fn() }))
vi.mock('../src/main/services/live/gemini-tools', () => ({ toGeminiFunctionDeclarations: vi.fn() }))
vi.mock('../src/main/services/live/gemini-connect', () => ({ connectGemini: vi.fn() }))
vi.mock('../src/main/services/live/gemini-live', async () => {
  const { default: mitt } = await import('mitt')
  class GeminiLiveEngine implements FakeEngine {
    readonly events = mitt<LiveEngineEvents>()
    stopping = (): void => {}
    constructor() {
      mocks.engines.push(this)
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {
      this.stopping()
    }
  }
  return { GeminiLiveEngine }
})

beforeEach(() => {
  vi.resetModules()
  mocks.recordUsage.mockReset()
  mocks.engines.length = 0
})

describe('the usage of the live engine', () => {
  it('records the usage a stopped engine reports as it lets its session go, and keeps it from the renderer, which cleared the run when the microphone went off', async () => {
    const live = await import('../src/main/services/live')
    const forwarded: LiveEvent[] = []
    live.events.on('event', (event) => forwarded.push(event))
    await expect(live.start()).resolves.toEqual({ ok: true })
    const [engine] = mocks.engines
    engine.events.emit('event', { type: 'usage', usage: { sessionSeconds: 10, costUsd: 0.001 } })
    engine.stopping = () => {
      engine.events.emit('event', { type: 'assistantTranscript', turnId: 1, text: 'はい。', final: true })
      engine.events.emit('event', { type: 'usage', usage: { sessionSeconds: 70, costUsd: 0.006 } })
    }

    await live.stop()

    expect(mocks.recordUsage.mock.calls.map(([item]) => item.seconds)).toEqual([10, 60])
    expect(forwarded.map((event) => event.type)).toEqual(['usage', 'assistantTranscript'])
  })
})
