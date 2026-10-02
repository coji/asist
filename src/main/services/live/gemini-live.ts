import mitt, { type Emitter } from 'mitt'
import type { AppSettings, LiveConnection, LiveEvent, LiveUsage, TurnEvent } from '@shared/ipc'
import type { LiveEngineInfo } from '@shared/voice-engine'
import { geminiLiveCost } from '@shared/voice-engine'
import { errMessage } from '@shared/api-errors'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from '../conversation-locale'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import type { ToolExecution, ToolExecutionTask } from '@shared/tool-registry'
import { buildMemoryInjection, type InjectableMemory } from '@shared/memory-injection'
import { record, turnScheduler, type ConversationOwner } from '../brain/session'
import type { HistoryMessage } from '../brain/history'
import { decodeOutput } from './audio'
import { GeminiCalls } from './gemini-calls'
import type { GeminiFunctionDeclaration } from './gemini-tools'
import { LiveSessionLifecycle } from './session-lifecycle'
import { TranscriptTracker, type TranscriptRole } from './transcripts'

/**
 * Gemini Live. One model listens, thinks, calls functions and speaks. It does not use brain's runTurn and
 * borrows only the tool registry and execution, the system prompt, memory, the conversation log and the
 * history seed from brain's parts.
 *
 * Functions are declared NON_BLOCKING so that the model keeps talking while one runs, and results come
 * back WHEN_IDLE so that they never cut the sentence being spoken. Tools still execute in the main
 * process, so the approval gate for writes keeps working. A session drops after about ten minutes and is
 * continued with a resumption handle, which is valid for two hours; without one, the history seed is sent
 * instead.
 *
 * The user and assistant lines of the conversation log are written from the input and output transcripts,
 * that is from what was actually heard, since no other text of the conversation exists. A turn id is
 * allocated per exchange, which closes on the first final assistant transcript.
 */

export type LiveEngineEvents = {
  /** Mono Float32 at 24 kHz, played in the order it arrives. */
  audio: Float32Array
  event: LiveEvent
}

/** The part of the SDK's Session that is used. Tests substitute a fake. */
export interface GeminiSession {
  sendRealtimeInput(params: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }): void
  sendClientContent(params: { turns: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>; turnComplete: boolean }): void
  sendToolResponse(params: { functionResponses: GeminiFunctionResponse[] }): void
  close(): void
}

export interface GeminiFunctionResponse {
  id: string
  name: string
  response: Record<string, unknown>
  scheduling: 'WHEN_IDLE' | 'INTERRUPT' | 'SILENT'
}

/** The part of the SDK's LiveServerMessage that is used. */
export interface GeminiServerMessage {
  setupComplete?: unknown
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> }
    turnComplete?: boolean
    interrupted?: boolean
    generationComplete?: boolean
    inputTranscription?: { text?: string; finished?: boolean }
    outputTranscription?: { text?: string; finished?: boolean }
  }
  toolCall?: { functionCalls?: GeminiFunctionCall[] }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
}

/** One function call of a toolCall message. */
export interface GeminiFunctionCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export interface GeminiConnectParams {
  model: string
  systemInstruction: string
  voice: string
  functionDeclarations: GeminiFunctionDeclaration[]
  resumptionHandle: string | null
  callbacks: {
    onmessage: (message: GeminiServerMessage) => void
    onerror: (error: Error) => void
    onclose: (reason: string) => void
  }
}

export interface GeminiLiveDeps {
  settings: () => AppSettings
  now?: () => number
  apiKey: () => string | undefined
  connect: (params: GeminiConnectParams) => Promise<GeminiSession>
  systemInstruction: (startedAt: Date) => string
  functionDeclarations: () => GeminiFunctionDeclaration[]
  executeTool: (name: string, input: Record<string, unknown>, ctx: { turnId: number; signal: AbortSignal; emit: (event: TurnEvent) => void }) => ToolExecutionTask
  /** Whether the registry lets the tool run at the same time as other calls, which a writing tool does not. */
  isParallel: (name: string) => boolean
  recordTool: (turnId: number, name: string, input: Record<string, unknown>, execution: ToolExecution) => void
  /** Looks for the memories related to the user's utterance. */
  findMemories: (text: string) => Promise<readonly InjectableMemory[]>
  /** The memory block of the system instruction, whose memories a note leaves out, or null when memory is unavailable. */
  memoryBlock: () => string | null
  /** Records a note sent to the model after the utterance of the turn, with the ids of the memories it shows. */
  recordNote: (turnId: number, text: string, memoryIds: string[]) => void
  /** Records typed input in the conversation log. A spoken user line is written when its transcript is final. */
  recordUser: (turnId: number, text: string) => void
  history: () => HistoryMessage[]
  emitTurn: (event: TurnEvent) => void
}

/** Wraps a sentence the app wants read out word for word, such as a timer that ran out. */
const READ_ALOUD: PromptText = {
  ja: `{systemNotice} 次の文をそのまま読み上げる: {text}`,
  en: `{systemNotice} Read the following sentence aloud exactly as it is: {text}`
}

const OPEN_TIMEOUT_MS = 15_000
/**
 * How long the transcript stays quiet before an utterance is final. It is long enough not to cut at a
 * pause inside a sentence, which runs around 0.5 seconds, and short enough to separate two utterances.
 */
const TRANSCRIPT_QUIET_MS = 1500
/** How long a resumption handle is reused. The provider allows two hours, and this leaves a margin. */
const RESUMPTION_TTL_MS = 100 * 60_000
/**
 * How much of the session's audio a memory shown to it is assumed to stay in its context. The sliding
 * window cuts the oldest turns once the context passes its trigger and keeps half of it (SlidingWindow
 * in @google/genai), without saying when. Five minutes of audio is about 9,600 tokens at the 32 tokens a
 * second Gemini counts for audio, inside that half for a context of 32,000 tokens or more. A memory shown
 * earlier may have been cut, and a note shows it again when an utterance calls for it, which costs a
 * repeated note at most.
 */
const SESSION_MEMORY_AUDIO_SECONDS = 5 * 60
const INPUT_MIME = 'audio/pcm;rate=16000'
const OUTPUT_RATE = 24_000

export class GeminiLiveEngine implements ConversationOwner {
  readonly events: Emitter<LiveEngineEvents> = mitt<LiveEngineEvents>()
  private readonly now: () => number
  private readonly lifecycle: LiveSessionLifecycle
  private readonly transcripts: TranscriptTracker
  /** Response latency measurement: when the last user transcript arrived and whether audio is still awaited. */
  private lastUserDeltaAt = -Infinity
  private awaitingFirstAudio = false
  /**
   * The session the engine owns, from the call that creates it until it is closed. Connecting resolves
   * only once the socket is open, so the session itself is filled in then, and closing reaches it from
   * that moment. Anything else is sent only once it is `ready`: its setup has completed and, when it
   * opened blank, it has had the history as its context.
   */
  private owned: { session: GeminiSession | null; ready: boolean } | null = null
  /**
   * The last handle the provider offered as resumable, with the memories the session held when it
   * arrived. A handle carries the session's state only up to the moment it was issued, and the provider
   * offers none while it generates or runs a call, so what is sent after it is lost on a resume.
   */
  private resumption: { handle: string; at: number; memories: ReadonlyMap<string, number> } | null = null
  private inputSeconds = 0
  private outputSeconds = 0
  private readonly calls: GeminiCalls
  /**
   * The memories sent to the current session in its notes and recall results, each with the session's
   * audio seconds when it was sent, which a note does not show again while they are recent. A session
   * that opens blank is seeded with the transcript, which carries neither, so it holds none of them
   * whatever earlier sessions were shown. A resumed session holds those its handle held.
   */
  private sessionMemories = new Map<string, number>()
  private exchangeTurnId: number | null = null
  /** Whether the renderer has been told of the exchange's turn, which only a function call needs. */
  private exchangeStarted = false

  constructor(
    private readonly info: LiveEngineInfo,
    private readonly deps: GeminiLiveDeps
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.lifecycle = new LiveSessionLifecycle({
      idleMs: deps.settings().liveIdleSeconds * 1000,
      now: this.now,
      open: (signal) => this.openSession(signal),
      close: () => this.closeSession(),
      transmit: (base64, seconds) => this.transmitAudio(base64, seconds),
      working: () => this.calls.working,
      emit: (event) => this.events.emit('event', event)
    })
    this.calls = new GeminiCalls({
      executeTool: deps.executeTool,
      isParallel: deps.isParallel,
      recordTool: deps.recordTool,
      emitTurn: deps.emitTurn,
      session: () => this.session,
      touch: () => this.lifecycle.touch(),
      memoriesSent: (ids) => this.memoriesSent(ids)
    })
    this.transcripts = new TranscriptTracker({
      quietMs: TRANSCRIPT_QUIET_MS,
      onDelta: (role, text) => this.onTranscriptDelta(role, text),
      onFinal: (role, text) => this.onTranscriptFinal(role, text)
    })
  }

  get state(): LiveConnection {
    return this.lifecycle.state
  }

  async start(): Promise<void> {
    this.lifecycle.start()
  }

  async stop(): Promise<void> {
    if (!this.lifecycle.enabled) return
    this.transcripts.flush('user')
    this.transcripts.flush('assistant')
    await this.lifecycle.stop()
    this.transcripts.dispose()
  }

  /** Mono Float32 from the microphone at 16 kHz. */
  pushAudio(frame: Float32Array): void {
    this.lifecycle.pushAudio(frame)
  }

  /** The renderer's VAD heard a human voice start or stop. The start opens a closed session. */
  activity(active: boolean): void {
    this.lifecycle.activity(active)
  }

  private async openSession(signal: AbortSignal): Promise<void> {
    const key = this.deps.apiKey()
    if (!key) {
      const info = LLM_PROVIDER_INFO.google
      throw new Error(errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }))
    }
    const settings = this.deps.settings().geminiLive
    const resumption = this.resumption && this.now() - this.resumption.at < RESUMPTION_TTL_MS ? this.resumption : null
    const resume = resumption?.handle ?? null
    // Built before the timer exists, since building it reads the history, which can fail.
    const systemInstruction = this.deps.systemInstruction(new Date(this.now()))
    const owned: { session: GeminiSession | null; ready: boolean } = { session: null, ready: false }
    this.owned = owned
    let connected!: Promise<GeminiSession>
    const setup = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error(errorText('voice.live.openTimeout', { engine: this.info.label }))), OPEN_TIMEOUT_MS)
      signal.addEventListener('abort', () => fail(signal.reason), { once: true })
      connected = this.deps.connect({
        model: settings.model,
        voice: settings.voice,
        systemInstruction,
        functionDeclarations: this.deps.functionDeclarations(),
        resumptionHandle: resume,
        callbacks: {
          onmessage: (message) => {
            if (this.owned !== owned) return
            if (message.setupComplete !== undefined) {
              clearTimeout(timer)
              resolve()
            }
            this.onMessage(message)
          },
          onerror: (error) => {
            if (this.owned !== owned) return
            console.error('gemini-live error:', errMessage(error))
            // While the session is still opening, the error is why it did not open, and the failure to connect reports it.
            if (owned.ready) this.events.emit('event', { type: 'error', message: errMessage(error) })
            else fail(error)
          },
          onclose: (reason) => {
            if (this.owned !== owned) return
            if (owned.ready) this.onClosed(reason)
            else fail(new Error(errorText('voice.live.closed', { engine: this.info.label, reason })))
          }
        }
      })
      connected.then(
        (session) => {
          owned.session = session
          // The opening failed and was let go before the session arrived.
          if (this.owned !== owned) session.close()
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
      )
    })
    await setup
    const session = await connected
    // A session that could not be resumed opens blank, so the recent history is sent as its context.
    if (!resume) this.seedHistory(session)
    this.sessionMemories = new Map(resumption?.memories)
    owned.ready = true
  }

  /** The session anything but closing is sent to, which is none while one is still opening. */
  private get session(): GeminiSession | null {
    return this.owned?.ready ? this.owned.session : null
  }

  private async closeSession(): Promise<void> {
    const session = this.owned?.session ?? null
    this.disown()
    if (!session) return
    try {
      session.sendRealtimeInput({ audioStreamEnd: true })
    } catch {
      // The session is already closed.
    }
    session.close()
  }

  private transmitAudio(base64: string, seconds: number): void {
    if (!this.session) return
    this.session.sendRealtimeInput({ audio: { data: base64, mimeType: INPUT_MIME } })
    this.inputSeconds += seconds
  }

  private onClosed(reason: string): void {
    this.disown()
    if (this.lifecycle.enabled) console.warn(`gemini-live: connection closed (${reason})`)
    this.lifecycle.ended()
  }

  /**
   * Lets go of the session, whether the engine or the provider closed it, and of the calls that still owe it
   * a result. Gemini bills the audio sent to a session after its last turnComplete too, and no turnComplete
   * reports it once the session is gone, so a session that opened reports the usage here as well. One that
   * never opened was sent nothing.
   */
  private disown(): void {
    const opened = this.owned?.ready === true
    this.owned = null
    this.calls.abortAll()
    if (opened) this.emitUsage()
  }

  private seedHistory(session: GeminiSession): void {
    const messages = this.deps.history().slice(-30)
    if (messages.length === 0) return
    session.sendClientContent({
      turns: messages.map((message) => ({ role: message.role === 'user' ? 'user' : 'model', parts: [{ text: message.content }] })),
      turnComplete: false
    })
  }

  private onMessage(message: GeminiServerMessage): void {
    const content = message.serverContent
    if (content) {
      if (content.inputTranscription?.text) this.pushTranscript('user', content.inputTranscription.text)
      if (content.inputTranscription?.finished) this.transcripts.flush('user')
      if (content.outputTranscription?.text) this.pushTranscript('assistant', content.outputTranscription.text)
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const samples = decodeOutput(part.inlineData.data)
          this.outputSeconds += samples.length / OUTPUT_RATE
          this.emitAudio(samples)
        }
      }
      if (content.interrupted) {
        // The transcript of what was spoken is finalized before the interruption is announced. In the
        // other order the final text reaches the renderer after it closed the line, and the same sentence
        // appears twice.
        this.transcripts.flush('assistant')
        // The renderer drops the rest of the reply on this event.
        this.lifecycle.assistantInterrupted()
        this.events.emit('event', { type: 'interrupted' })
      }
      if (content.turnComplete) {
        this.transcripts.flush('assistant')
        this.emitUsage()
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) this.calls.submit(call, this.ensureTurnStarted())
    this.calls.cancel(message.toolCallCancellation?.ids ?? [])
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumption = { handle: message.sessionResumptionUpdate.newHandle, at: this.now(), memories: new Map(this.sessionMemories) }
    }
    if (message.goAway) console.warn(`gemini-live: GoAway (${message.goAway.timeLeft ?? '?'})`)
  }

  private memoriesSent(ids: readonly string[]): void {
    for (const id of ids) this.sessionMemories.set(id, this.inputSeconds + this.outputSeconds)
  }

  /** The memories the session can still be assumed to hold. */
  private memoriesHeld(): Set<string> {
    const now = this.inputSeconds + this.outputSeconds
    return new Set([...this.sessionMemories].flatMap(([id, at]) => (now - at < SESSION_MEMORY_AUDIO_SECONDS ? [id] : [])))
  }

  private sendUserText(text: string): void {
    this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
    this.lifecycle.touch()
  }

  /** Typed input. No transcript event is emitted, because the renderer already shows the typed text in the feed. */
  async sendText(text: string): Promise<void> {
    await this.lifecycle.ensureOpen()
    const turnId = this.exchange()
    this.deps.recordUser(turnId, text)
    this.sendUserText(`${marker(conversationLocale(), 'typedInput')} ${text}`)
  }

  async notify(text: string): Promise<void> {
    await this.lifecycle.ensureOpen()
    this.sendUserText(text)
  }

  async say(text: string): Promise<void> {
    await this.lifecycle.ensureOpen()
    const locale = conversationLocale()
    this.sendUserText(fillPrompt(promptText(locale, READ_ALOUD), { systemNotice: marker(locale, 'systemNotice'), text }))
  }

  /** The turn id of the current exchange, taken on first use. */
  private exchange(): number {
    this.exchangeTurnId ??= turnScheduler.allocateTurnId()
    return this.exchangeTurnId
  }

  /** Tells the renderer about this exchange's turn before any tool or panel appears. */
  private ensureTurnStarted(): number {
    const turnId = this.exchange()
    if (!this.exchangeStarted) {
      this.exchangeStarted = true
      this.deps.emitTurn({ type: 'started', turnId, origin: 'live' })
    }
    return turnId
  }

  /** Ends the exchange, emitting done only for a turn the renderer was told of. */
  private finishExchange(fullText: string): void {
    if (this.exchangeTurnId !== null && this.exchangeStarted) {
      this.deps.emitTurn({ type: 'done', turnId: this.exchangeTurnId, fullText })
    }
    this.exchangeTurnId = null
    this.exchangeStarted = false
  }

  /** Passes the model's audio to the renderer and measures the response latency. */
  private emitAudio(samples: Float32Array): void {
    // Gemini sends a reply faster than it plays, and its turnComplete waits only for the playback it assumes,
    // so a long reply can arrive more than the idle time before its turnComplete. The renderer plays the
    // audio at its rate in the order it arrives.
    this.lifecycle.assistantSpeaks((samples.length / OUTPUT_RATE) * 1000)
    if (this.awaitingFirstAudio) {
      this.awaitingFirstAudio = false
      const responseMs = Math.round(this.now() - this.lastUserDeltaAt)
      if (responseMs >= 0) this.events.emit('event', { type: 'latency', responseMs })
    }
    this.events.emit('audio', samples)
  }

  /** Reports the usage as a running total, of which the ledger records what it has not recorded yet. */
  private emitUsage(): void {
    const usage: LiveUsage = { sessionSeconds: Math.round(this.inputSeconds), costUsd: geminiLiveCost(this.inputSeconds, this.outputSeconds) }
    this.events.emit('event', { type: 'usage', usage })
  }

  private pushTranscript(role: TranscriptRole, delta: string): void {
    if (role === 'user') {
      this.lastUserDeltaAt = this.now()
      this.awaitingFirstAudio = true
      this.lifecycle.touch()
    }
    this.transcripts.push(role, delta)
  }

  /** The text of a transcript collected so far, which is not final yet. */
  private onTranscriptDelta(role: TranscriptRole, text: string): void {
    const turnId = this.exchange()
    this.events.emit('event', role === 'user' ? { type: 'userTranscript', turnId, text, final: false } : { type: 'assistantTranscript', turnId, text, final: false })
  }

  /** A transcript is final, because it went quiet, the model signalled its end, or the engine stopped. */
  private onTranscriptFinal(role: TranscriptRole, text: string): void {
    // The input transcript can arrive after the model's reply. A pending user utterance is finalized
    // before the reply is recorded, so that the conversation log keeps the order user then assistant.
    if (role === 'assistant' && this.transcripts.pending('user')) this.transcripts.flush('user')
    const turnId = this.exchange()
    if (role === 'user') {
      record({ kind: 'user', turnId, text })
      this.events.emit('event', { type: 'userTranscript', turnId, text, final: true })
      this.injectMemories(turnId, text)
      return
    }
    record({ kind: 'assistant', turnId, text })
    this.events.emit('event', { type: 'assistantTranscript', turnId, text, final: true })
    this.finishExchange(text)
  }

  /**
   * Any memory related to the user's utterance that the session does not hold yet is added to its
   * context silently, without asking for a reply, and is recorded on the utterance's turn only once a
   * session has it. The note is written when it is sent rather than when the search starts, so that two
   * searches that end together do not both show the same memory.
   */
  private injectMemories(turnId: number, text: string): void {
    void this.deps
      .findMemories(text)
      .then((memories) => {
        const session = this.session
        if (!session) return
        const note = buildMemoryInjection(memories, {
          locale: conversationLocale(),
          memoryBlock: this.deps.memoryBlock(),
          excludeIds: this.memoriesHeld()
        })
        if (!note) return
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: note.text }] }], turnComplete: false })
        this.memoriesSent(note.ids)
        this.deps.recordNote(turnId, note.text, note.ids)
      })
      .catch((err) => console.error('gemini-live memory injection failed:', errMessage(err)))
  }
}
