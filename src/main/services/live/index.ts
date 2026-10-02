import mitt, { type Emitter } from 'mitt'
import type { LiveConnection, LiveStartResult } from '@shared/ipc'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'
import { recordUsage } from '../usage-ledger'
import { providerKey } from '../llm'
import * as memory from '../memory'
import * as agentRunner from '../agent'
import { emit as emitTurn, history, record, setConversationOwner } from '../brain/session'
import { buildLiveSystemInstruction } from '../brain/prompt'
import { summarizeToolInput, summarizeToolResult } from '../brain/conversation-log'
import { executeClientTool, toolGuide, toolRegistry, tools } from '../brain/tools'
import { memoryIdsInToolResult } from '@shared/memory-injection'
import { GeminiLiveEngine, type LiveEngineEvents } from './gemini-live'
import { toGeminiFunctionDeclarations } from './gemini-tools'
import { connectGemini } from './gemini-connect'

/**
 * The entry point of the live engine. It starts Gemini Live when the voiceEngine setting chooses it and
 * registers it with brain as the owner of the conversation. Through ipc, this module is all the renderer
 * talks to.
 */

export const events: Emitter<LiveEngineEvents> = mitt<LiveEngineEvents>()

let engine: GeminiLiveEngine | null = null
let starting: Promise<LiveStartResult> | null = null

export const connection = (): LiveConnection => engine?.state ?? 'off'

function geminiSystemInstruction(startedAt: Date): string {
  history.ensureLoaded()
  const locale = conversationLocale()
  return buildLiveSystemInstruction({
    locale,
    persona: getSettings().persona,
    toolGuide: toolGuide(locale, { webSearch: false }),
    memoryBlock: memory.promptBlock(),
    historySummary: history.summary,
    jobContext: agentRunner.contextBlock(),
    startedAt
  })
}

function createEngine(): GeminiLiveEngine {
  return new GeminiLiveEngine(LIVE_ENGINE_INFO['gemini-live'], {
    settings: getSettings,
    apiKey: () => providerKey('google'),
    connect: (params) => connectGemini(providerKey('google') ?? '', params),
    systemInstruction: geminiSystemInstruction,
    functionDeclarations: () => toGeminiFunctionDeclarations(tools(conversationLocale())),
    executeTool: (name, input, ctx) => executeClientTool(name, input, ctx, conversationLocale()),
    isParallel: (name) => toolRegistry(conversationLocale()).find(name)?.parallel ?? false,
    recordUser: (turnId, text) => {
      record({ kind: 'user', turnId, text })
    },
    recordTool: (turnId, name, input, execution) => {
      const memoryIds = execution.isError ? [] : memoryIdsInToolResult(name, execution)
      record({
        kind: 'tool',
        turnId,
        name,
        input: summarizeToolInput(input),
        result: summarizeToolResult(execution.content),
        resultLength: execution.resultLength,
        durationMs: execution.durationMs,
        ...(execution.isError ? { isError: true } : {}),
        ...(execution.truncated ? { truncated: true } : {}),
        ...(memoryIds.length > 0 ? { memoryIds } : {})
      })
    },
    findMemories: async (text) => (await memory.search(text, { limit: 8, mode: 'utterance' })).map((hit) => hit.record),
    memoryBlock: () => memory.promptBlock(),
    recordNote: (turnId, text, memoryIds) => {
      record({ kind: 'note', turnId, text, memoryIds })
    },
    history: () => {
      history.ensureLoaded()
      return history.toTranscript()
    },
    emitTurn
  })
}

/** Starts the live engine. The session itself opens when someone starts speaking. */
export function start(): Promise<LiveStartResult> {
  if (starting) return starting
  starting = (async (): Promise<LiveStartResult> => {
    if (engine) return { ok: true }
    const settings = getSettings()
    if (!isLiveEngine(settings.voiceEngine)) return { ok: false, reason: errorText('voice.live.notLiveEngine') }
    const info = LIVE_ENGINE_INFO[settings.voiceEngine]
    if (!providerKey(info.provider)) {
      const provider = LLM_PROVIDER_INFO[info.provider]
      return { ok: false, reason: errorText('llmModels.errors.keyMissing', { provider: provider.label, envKey: provider.envKey }) }
    }
    const created = createEngine()
    const liveEngine = settings.voiceEngine
    const model = settings.geminiLive.model
    // The engine reports its usage as a running total, so what is recorded is the growth since the
    // report before.
    let reported = { seconds: 0, costUsd: 0 }
    created.events.on('audio', (samples) => events.emit('audio', samples))
    created.events.on('event', (event) => {
      if (event.type === 'usage') {
        if (event.usage.costUsd > reported.costUsd) {
          recordUsage({
            kind: 'live',
            engine: liveEngine,
            model,
            seconds: Math.max(event.usage.sessionSeconds - reported.seconds, 0),
            costUsd: event.usage.costUsd - reported.costUsd
          })
          reported = { seconds: event.usage.sessionSeconds, costUsd: event.usage.costUsd }
        }
        // An engine that is stopping reports its last usage after the renderer cleared the live state of the
        // microphone it turned off, which would then show a run that has ended. The ledger has it.
        if (engine !== created) return
      }
      events.emit('event', event)
    })
    setConversationOwner(created)
    engine = created
    try {
      await created.start()
    } catch (err) {
      await teardown()
      return { ok: false, reason: errMessage(err) }
    }
    return { ok: true }
  })().finally(() => {
    starting = null
  })
  return starting
}

async function teardown(): Promise<void> {
  const current = engine
  engine = null
  setConversationOwner(null)
  if (current) await current.stop()
}

export async function stop(): Promise<void> {
  await starting?.catch(() => undefined)
  await teardown()
}

export function push(frame: Float32Array): void {
  engine?.pushAudio(frame)
}

export function activity(active: boolean): void {
  engine?.activity(active)
}

export async function text(value: string): Promise<void> {
  if (!engine) throw new Error(errorText('voice.live.notRunning'))
  await engine.sendText(value)
}
