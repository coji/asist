import mitt, { type Emitter } from 'mitt'
import { LiveWS } from 'openai/resources/live/ws'
import type { LiveConnection, LiveStartResult } from '@shared/ipc'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import {
  CONVERSATION_LANGUAGE_NAMES,
  fillPrompt,
  promptText,
  type PromptText
} from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'
import { recordUsage } from '../usage-ledger'
import OpenAI from 'openai'
import { providerKey } from '../llm'
import * as memory from '../memory'
import * as agentRunner from '../agent'
import { beginTurn } from '../brain'
import { events as brainEvents, emit as emitTurn, history, record, setConversationOwner, setSpeechRoute } from '../brain/session'
import { PERSONA_HEADING, buildLiveSystemInstruction } from '../brain/prompt'
import { liveRoute } from '../brain/speech-route'
import { summarizeToolInput, summarizeToolResult } from '../brain/conversation-log'
import { executeClientTool, toolGuide, toolRegistry, tools } from '../brain/tools'
import { memoryIdsInToolResult } from '@shared/memory-injection'
import type { LiveEngineBase, LiveEngineEvents } from './engine'
import { GptLiveEngine } from './gpt-live'
import { GeminiLiveEngine } from './gemini-live'
import { toGeminiFunctionDeclarations } from './gemini-tools'
import { connectGemini } from './gemini-connect'

/**
 * The entry point of the live engines. It starts GPT-Live or Gemini Live according to the voiceEngine
 * setting and registers the connections to brain, that is the speech route and the conversation owner.
 * Through ipc, this module is all the renderer talks to.
 */

export const events: Emitter<LiveEngineEvents> = mitt<LiveEngineEvents>()

let engine: LiveEngineBase | null = null
let starting: Promise<LiveStartResult> | null = null

export const connection = (): LiveConnection => engine?.state ?? 'off'

/**
 * The frontend instructions for GPT-Live. It owns the voice and the timing, and leaves the content to
 * brain. The short acknowledgements are the voice model's own doing here rather than the app's, so the
 * division of labour stays in both languages; what the English one leaves out is the Japanese example
 * words for them, which carry a rhythm no other language shares.
 */
const GPT_LIVE_INSTRUCTIONS: PromptText = {
  ja: `あなたは ASIST。日本語で話す、デスクトップに常駐する音声アシスタントの「声の担当」。

# 分担
- あなたが受け持つのは、聞き取り、相槌、短い受け、割り込みの間合い。中身の判断は backend(委任先)がすべて行う。
- 挨拶、相槌、聞き返し、直前に言ったことの言い直し以外は、必ず backend に委任する。委任したら、相手の言葉を一つ使った短い受けを一言だけ言い、backend の返事が来るまで待つ。受けの言い回しは毎回変え、同じ決まり文句を使い回さない。急かさない。
- backend の返事(commentary)が来たら、その内容を自分の言葉として自然に話す。内容を足さない、削らない、数字と固有名詞は変えない。
- 天気、予定、メール、タスク、記憶、ニュース、調べ物、作業の依頼は自分の知識で答えない。必ず委任する。
- {screen} で始まる文脈は、いま画面に出ているカードのこと。「これ」「この画面」はそれを指す。
- ユーザーが文字で入力した文が文脈に来たら、backend の返事を待って話す。

# 話し方
- 話し言葉で短く。相槌は「うん」「はい」「なるほど」のように軽く。受けは相手の言葉を一つ使う。
- 記号、箇条書き、マークダウンは使わない。
- 相手の話の途中で割り込まない。言い終わるのを待つ。相手が割り込んだら止まって聞く。`,
  en: `You are ASIST, the voice of an assistant that lives on this person's desktop. The user speaks {language}, and so do you: listen in {language} and speak in {language}.

# The division of labour
- What is yours is the listening, the short acknowledgements, the brief openers and the timing of interruptions. Every decision about content is made by the backend you delegate to.
- Delegate everything except a greeting, an acknowledgement, a question back, and saying again what you just said. Once you have delegated, say one short line that uses a word of theirs, then wait for the backend's reply. Word that line differently every time; never reuse a set phrase. Do not hurry them.
- When the backend's reply (the commentary) arrives, say what it says as your own words, naturally. Add nothing, drop nothing, and leave the numbers and the proper nouns exactly as they are.
- Never answer from your own knowledge about the weather, the calendar, mail, tasks, memory, news, looking something up, or a piece of work to be done. Delegate all of it.
- Context beginning with {screen} is the card on screen right now. "This" and "this screen" mean that card.
- When something the user typed arrives as context, wait for the backend's reply before you speak.

# How to speak
- Speak, do not write, and keep it short. Keep acknowledgements light. Use one of the user's own words in the line you come back with.
- No symbols, bullet points or markdown.
- Do not cut in while the user is still talking; wait until they finish. When they cut in, stop and listen.`
}

/** The frontend instructions for GPT-Live, followed by the persona and what memory holds. */
export function gptLiveInstructions(): string {
  const settings = getSettings()
  const locale = conversationLocale()
  const parts = [
    fillPrompt(promptText(locale, GPT_LIVE_INSTRUCTIONS), {
      language: CONVERSATION_LANGUAGE_NAMES[locale],
      screen: marker(locale, 'screen')
    })
  ]
  const persona = settings.persona.trim()
  if (persona) parts.push('', `# ${promptText(locale, PERSONA_HEADING)}`, persona)
  const memoryBlock = memory.promptBlock()
  if (memoryBlock) parts.push('', memoryBlock)
  return parts.join('\n')
}

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

function createEngine(): LiveEngineBase {
  const settings = getSettings()
  if (settings.voiceEngine === 'gpt-live') {
    return new GptLiveEngine(LIVE_ENGINE_INFO['gpt-live'], {
      settings: getSettings,
      // The GPT-Live WebSocket is opened from the OpenAI client. Without a key this is null, and the
      // engine reports why.
      client: () => {
        const key = providerKey('openai')
        return key ? new OpenAI({ apiKey: key, maxRetries: 0 }) : null
      },
      connect: (client) => new LiveWS(client, { reconnect: null }),
      beginTurn: (text, typed, route) => beginTurn({ text }, typed ? { typed: true } : {}, 'live', false, { route }),
      onTurnEvent: (listener) => {
        brainEvents.on('event', listener)
        return () => brainEvents.off('event', listener)
      },
      instructions: gptLiveInstructions,
      history: () => {
        history.ensureLoaded()
        return history.toTranscript()
      }
    })
  }
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
    const model = settings.voiceEngine === 'gpt-live' ? settings.gptLive.model : settings.geminiLive.model
    // Each engine reports its usage as a running total, so what is recorded is the growth since the
    // report before.
    let reported = { seconds: 0, costUsd: 0 }
    created.events.on('audio', (samples) => events.emit('audio', samples))
    created.events.on('event', (event) => {
      if (event.type === 'usage' && event.usage.costUsd > reported.costUsd) {
        recordUsage({
          kind: 'live',
          engine: liveEngine,
          model,
          seconds: Math.max(event.usage.sessionSeconds - reported.seconds, 0),
          costUsd: event.usage.costUsd - reported.costUsd
        })
        reported = { seconds: event.usage.sessionSeconds, costUsd: event.usage.costUsd }
      }
      events.emit('event', event)
    })
    if (created instanceof GptLiveEngine) {
      // A job report or an interrupting utterance is read by the voice model as commentary with no
      // delegation id.
      setSpeechRoute(liveRoute((sentence, signal) => created.sayOutsideDelegation(sentence, signal)))
    } else if (created instanceof GeminiLiveEngine) {
      setConversationOwner(created)
    }
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
  setSpeechRoute(null)
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
