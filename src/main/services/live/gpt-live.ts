import type OpenAI from 'openai'
import type * as LiveAPI from 'openai/resources/live/live'
import type { TurnEvent } from '@shared/ipc'
import type { LiveEngineInfo } from '@shared/voice-engine'
import { gptLiveCost } from '@shared/voice-engine'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { conversationLocale } from '../conversation-locale'
import { estimateTokens } from '@shared/token-estimate'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import type { HistoryMessage } from '../brain/history'
import { turnScheduler } from '../brain/session'
import { liveRoute } from '../brain/speech-route'
import { decodeOutput } from './audio'
import { LiveEngineBase, type LiveEngineDeps } from './engine'
import type { TranscriptRole } from './transcripts'

/**
 * GPT-Live-1. A full-duplex voice model listens and speaks, while decisions and tools are handed to brain
 * (runTurn) through client delegation.
 *
 * The flow: microphone audio streams in, GPT-Live says its backchannel and sends
 * session.delegation.created, the input transcript just before it becomes the user utterance of a new
 * brain turn, brain's sentences go back through session.commentary.append, and GPT-Live reads them in its
 * own voice. The delegation event carries no text of the utterance, so the transcript is picked up only
 * after it settles. Typed input goes straight to brain, and its reply is read as commentary with no
 * delegation id.
 *
 * The engine writes nothing to the conversation log, and the output transcript is not used at all. Brain
 * records the utterances it is handed and its own replies, and the screen shows brain's text. What the
 * voice says besides is content-free by its instructions, and nothing marks where its reading of one
 * reply ends and the next begins, so its transcript could not be put under the right turn. The input
 * transcript is shown on screen while the user speaks, one line per utterance. A turn the engine starts
 * hands brain its own input together with the utterances before it that no delegation took, unless they
 * are older than a quiet session stays open or were said before a stop.
 *
 * A session is append-only and starts blank when it is reopened, so the recent history is handed over as
 * the initial context every time it opens.
 */

/** Where events sent to GPT-Live go, the part of the SDK's LiveWS that is used. Tests substitute a fake. */
export interface LiveSocket {
  send(event: LiveAPI.ClientEvent): void
  close(): void
  on(event: 'event', listener: (event: LiveAPI.ServerEvent) => void): unknown
  /** `error` is set when the error is a server's error event, which LiveWS also emits as an 'event'. */
  on(event: 'error', listener: (error: Error & { error?: LiveAPI.ErrorEvent }) => void): unknown
  on(event: 'close', listener: (code: number, reason: string) => void): unknown
  /** The WebSocket underneath, whose readyState follows RFC 6455. */
  readonly socket: { readonly readyState: number }
}

/**
 * The readyState of an open WebSocket. LiveWS queues what is sent before it, and after it, once the
 * server has begun to close the socket, reports each send as an 'error' instead of throwing.
 */
const OPEN = 1

export interface GptLiveDeps extends LiveEngineDeps {
  client: () => OpenAI | null
  connect: (client: OpenAI) => LiveSocket
  beginTurn: (text: string, typed: boolean, route: ReturnType<typeof liveRoute>) => void
  /** Brain's turn events, which is how the voice model learns that a panel was opened. */
  onTurnEvent: (listener: (event: TurnEvent) => void) => () => void
  /** The context handed over when the session opens. */
  instructions: () => string
  history: () => HistoryMessage[]
}

/** How long session.started may take before opening fails. */
const OPEN_TIMEOUT_MS = 15_000
/** How long the input transcript stays quiet before a delegation takes it. */
const DELEGATION_QUIET_MS = 400
/**
 * How long a delegation waits for the input transcript to begin, which can be after the delegation.
 * Past it brain is told that no utterance of the delegation's own arrived.
 */
const DELEGATION_START_WAIT_MS = 2000
/**
 * How long a delegation waits at most for a transcript that has begun and keeps arriving, so that a
 * transcript that never goes quiet cannot hold the turn back for good.
 */
const DELEGATION_MAX_WAIT_MS = 10_000
/** What brain is told when the voice delegated a turn whose transcript never arrived. */
const NO_TRANSCRIPT: PromptText = {
  ja: `[声の担当からの依頼。直前の発話の転写が届いていない。文脈から推測して短く応じ、分からなければ聞き返す]`,
  en: `[A request from the voice. The transcript of the utterance before it never arrived. Guess from the context and answer briefly, and ask back when you cannot tell.]`
}
/**
 * What follows the lines no delegation took when a delegation came without an utterance in progress.
 * Its request is either the last of those lines, delegated late, or an utterance whose transcript never
 * arrived, such as a question after a backchannel, and nothing tells the two apart.
 */
const DELEGATED_WITHOUT_UTTERANCE: PromptText = {
  ja: `[声の担当からの依頼。上の発話は聞き取れたが、依頼のときに新しい発話の転写は届いていない。依頼は上の最後の発話かもしれないし、聞き取れなかった別の発話かもしれない。上の発話から答えられれば答え、分からなければ短く聞き返す]`,
  en: `[A request from the voice. The lines above were heard, but no transcript of a new utterance came with the request. The request may be the last of those lines, or something that was not heard. Answer from them if you can, and ask back briefly if you cannot.]`
}

/** The cards on screen, which the voice model cannot see and which "this" refers to. */
const PANELS_ON_SCREEN: PromptText = {
  ja: `{screen} いま {panels} のカードを出している。「これ」「この画面」はそれを指す`,
  en: `{screen} The cards on screen now are {panels}. "This" and "this screen" mean them.`
}

/** The cap on the initial context. The API itself allows 128 messages and 8,192 tokens. */
const INITIAL_MESSAGES_MAX = 60
const INITIAL_TOKENS_MAX = 6000

/** Takes the most recent history from the end, as much of it as the caps allow. */
export function initialItems(messages: readonly HistoryMessage[]): LiveAPI.InitialItem[] {
  const picked: HistoryMessage[] = []
  let tokens = 0
  for (let i = messages.length - 1; i >= 0 && picked.length < INITIAL_MESSAGES_MAX; i--) {
    const cost = estimateTokens(messages[i].content)
    if (tokens + cost > INITIAL_TOKENS_MAX) break
    tokens += cost
    picked.unshift(messages[i])
  }
  return picked.map((message) =>
    message.role === 'user'
      ? { role: 'user', content: [{ type: 'input_text', text: message.content }] }
      : { role: 'assistant', content: [{ type: 'output_text', text: message.content }] }
  )
}

export class GptLiveEngine extends LiveEngineBase {
  private socket: LiveSocket | null = null
  /** Seconds accumulated over earlier sessions, because usage only counts inside the open session. */
  private secondsBefore = 0
  private currentSeconds = 0
  private lastInputDeltaAt = -Infinity
  private readonly unsubscribeTurns: () => void
  /** The kinds of panel opened during a delegated turn, told to the voice model when the turn is done. */
  private readonly panelsByTurn = new Map<number, Set<string>>()
  /** The id the user's utterance in progress is shown under on screen, taken with its first fragment. */
  private utteranceId: number | null = null
  /**
   * The utterances that went quiet before a delegation took them, oldest first, each with when its
   * last fragment arrived: the voice answered them by itself, or its delegation came late. The next
   * brain turn the engine starts is handed them ahead of its own input, which brain records as that
   * turn's user text. They are not recorded as turns of their own, because the history attaches records
   * only to the newest turn with an input, and a user-only turn recorded while brain's turn runs would
   * take that turn's messages and tool results away from it.
   */
  private unhanded: Array<{ text: string; endedAt: number }> = []

  constructor(
    info: LiveEngineInfo,
    private readonly deps: GptLiveDeps
  ) {
    super(info, deps)
    this.unsubscribeTurns = deps.onTurnEvent((event) => this.observeTurn(event))
  }

  override async stop(): Promise<void> {
    await super.stop()
    // Turning the microphone off ends the conversation, so nothing heard before it waits for the next start.
    this.unhanded = []
    this.unsubscribeTurns()
  }

  protected async openSession(signal: AbortSignal): Promise<void> {
    const client = this.deps.client()
    if (!client) {
      const info = LLM_PROVIDER_INFO.openai
      throw new Error(errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }))
    }
    const settings = this.settings().gptLive
    // Read before the socket and the timer exist: a history that cannot be read would otherwise leave an
    // open socket and a pending start that rejects, unobserved, when the timer runs out.
    const instructions = this.deps.instructions()
    const input = initialItems(this.deps.history())
    const socket = this.deps.connect(client)
    this.socket = socket
    this.currentSeconds = 0
    let started = false
    const ready = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error(errorText('voice.live.openTimeout', { engine: this.info.label }))), OPEN_TIMEOUT_MS)
      signal.addEventListener('abort', () => fail(signal.reason), { once: true })
      socket.on('event', (event) => {
        if (this.socket !== socket) return
        if (event.type === 'session.started') {
          started = true
          clearTimeout(timer)
          resolve()
        } else if (event.type === 'error' && !started) {
          // An error before the start is why the session did not start, and the failure to connect reports it.
          fail(new Error(event.error.message))
          return
        }
        this.onServerEvent(event)
      })
      socket.on('error', (error) => {
        // A server's error event arrives here as well, with the event's JSON as its message; the 'event'
        // listener reports it.
        if (this.socket !== socket || error.error) return
        console.error('gpt-live socket error:', errMessage(error))
        if (started) this.events.emit('event', { type: 'error', message: errMessage(error) })
        else fail(error)
      })
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return
        if (started) this.onSocketClosed(code, reason)
        else fail(new Error(errorText('voice.live.closed', { engine: this.info.label, reason: `${code} ${reason}` })))
      })
    })
    this.send({
      type: 'session.start',
      session: {
        model: settings.model,
        audio: { format: { type: 'audio/pcm', rate: this.info.inputRate }, output: { voice: settings.voice } },
        delegation: { type: 'client' },
        instructions,
        input
      }
    })
    await ready
  }

  protected async closeSession(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    if (socket.socket.readyState === OPEN) socket.send({ type: 'session.close' })
    socket.close()
    this.secondsBefore += this.currentSeconds
    this.currentSeconds = 0
  }

  /** Sends to the socket the engine owns, unless the server has begun to close it; its close then ends the session. */
  private send(event: LiveAPI.ClientEvent): void {
    const socket = this.socket
    if (socket && socket.socket.readyState <= OPEN) socket.send(event)
  }

  protected transmitAudio(base64: string): void {
    this.send({ type: 'session.input_audio.append', audio: base64 })
  }

  private onSocketClosed(code: number, reason: string): void {
    this.socket = null
    this.secondsBefore += this.currentSeconds
    this.currentSeconds = 0
    if (this.enabled) console.warn(`gpt-live: connection closed (${code} ${reason})`)
    this.sessionEnded()
  }

  private onServerEvent(event: LiveAPI.ServerEvent): void {
    switch (event.type) {
      case 'session.output_audio.delta':
        this.emitAudio(decodeOutput(event.delta))
        return
      case 'session.input_transcript.delta':
        this.lastInputDeltaAt = this.now()
        this.pushTranscript('user', event.delta)
        return
      case 'session.delegation.created':
        if (event.delegation.target === 'client') void this.delegate(event.delegation.id)
        return
      case 'session.usage.updated':
        this.currentSeconds = event.usage.seconds
        this.emitUsage({ sessionSeconds: this.secondsBefore + this.currentSeconds, costUsd: gptLiveCost(this.secondsBefore + this.currentSeconds) })
        return
      case 'session.closed':
        this.currentSeconds = event.usage.seconds
        if (event.reason !== 'close_requested') console.warn(`gpt-live: session closed (${event.reason})`)
        return
      case 'error':
        console.error('gpt-live error:', event.error.code, event.error.message, event.error.param ?? '')
        this.events.emit('event', { type: 'error', message: event.error.message })
        return
      default:
        return
    }
  }

  /**
   * Takes over a delegation once the input transcript has settled, and starts a brain turn. When no
   * transcript arrived at all, brain is told so instead of the voice model saying it could not hear.
   */
  private async delegate(delegationId: string): Promise<void> {
    const startedAt = this.now()
    while (!this.delegationSettled(startedAt)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // A stop meanwhile ended the delegation, and closed the user's line as it was heard.
    if (!this.enabled) return
    this.deps.beginTurn(this.delegatedInput(), false, liveRoute((sentence, signal) => this.say(sentence, delegationId, signal)))
    this.touch()
  }

  /** What a delegation hands brain: the utterances no delegation took, then its own or a note on its absence. */
  private delegatedInput(): string {
    const own = this.takeUserUtterance()
    const earlier = this.takeUnhanded()
    if (own) return [...earlier, own].join('\n')
    const locale = conversationLocale()
    if (earlier.length === 0) return promptText(locale, NO_TRANSCRIPT)
    return [...earlier, promptText(locale, DELEGATED_WITHOUT_UTTERANCE)].join('\n')
  }

  /** Takes the user's utterance in progress, closing its line on screen under the id it was shown with. */
  private takeUserUtterance(): string {
    const text = this.transcripts.take('user')
    if (text) this.closeUserLine(text)
    return text
  }

  /** The input of a brain turn, after the utterances no delegation took, one per line. */
  private withUnhanded(input: string): string {
    return [...this.takeUnhanded(), input].filter(Boolean).join('\n')
  }

  /**
   * Takes the utterances no delegation took, leaving out those older than liveIdleSeconds. That is how
   * long a quiet conversation keeps its session, so one older than that belongs to an exchange that is
   * over, and handing it with a new request would have brain answer what the user had left. It holds
   * however the session ended in between, whether it closed for quiet, the provider ended it or the
   * network dropped it.
   */
  private takeUnhanded(): string[] {
    const idleMs = this.settings().liveIdleSeconds * 1000
    const fresh = this.unhanded.filter((utterance) => this.now() - utterance.endedAt < idleMs)
    this.unhanded = []
    return fresh.map((utterance) => utterance.text)
  }

  private userLineId(): number {
    this.utteranceId ??= turnScheduler.allocateTurnId()
    return this.utteranceId
  }

  private closeUserLine(text: string): void {
    this.events.emit('event', { type: 'userTranscript', turnId: this.userLineId(), text, final: true })
    this.utteranceId = null
  }

  /** Only the input transcript is pushed, so the role is always the user's. */
  protected onTranscriptDelta(_role: TranscriptRole, text: string): void {
    this.events.emit('event', { type: 'userTranscript', turnId: this.userLineId(), text, final: false })
  }

  /** An utterance that went quiet, or was still arriving when the engine stopped, before a delegation took it. */
  protected onTranscriptFinal(_role: TranscriptRole, text: string): void {
    this.closeUserLine(text)
    this.unhanded.push({ text, endedAt: this.lastInputDeltaAt })
  }

  /**
   * Whether a delegation can take the utterance. A transcript that has begun is taken only once it has
   * gone quiet, whether it began before the delegation or after it, since a transcript still arriving
   * is a fragment of the utterance.
   */
  private delegationSettled(startedAt: number): boolean {
    const waited = this.now() - startedAt
    if (this.transcripts.pending('user') === '') return waited >= DELEGATION_START_WAIT_MS
    return this.now() - this.lastInputDeltaAt >= DELEGATION_QUIET_MS || waited >= DELEGATION_MAX_WAIT_MS
  }

  /** A job report or an interrupting utterance, read by the voice model outside any delegation. */
  sayOutsideDelegation(sentence: string, signal?: AbortSignal): Promise<void> {
    return this.say(sentence, null, signal)
  }

  /** Hands one of brain's sentences to the voice model, opening the session first if it is closed. */
  private async say(sentence: string, delegationId: string | null, signal?: AbortSignal): Promise<void> {
    await this.ensureOpen()
    if (signal?.aborted) return
    this.send({ type: 'session.commentary.append', delegation_id: delegationId, content: sentence })
    this.touch()
  }

  /** Gives the voice model context it does not read aloud, such as typed input or an opened panel. */
  private think(content: string, delegationId: string | null = null): void {
    this.send({ type: 'session.thinking.append', delegation_id: delegationId, content })
  }

  async sendText(text: string): Promise<void> {
    await this.ensureOpen()
    const locale = conversationLocale()
    this.think(`${marker(locale, 'typedInputForVoice')} ${text}`)
    // Typed input takes what was said before it, the utterance still being transcribed included, since
    // the user has moved on to typing: left for a later delegation, it would reach brain after the typed
    // text, though the user said it first.
    const spoken = this.withUnhanded(this.takeUserUtterance())
    // Brain's note for typed input would cover the spoken lines as well and tell brain to read them
    // literally, so with spoken lines the note goes on the typed line alone, and the turn is not
    // marked as typed as a whole.
    const input = spoken ? `${spoken}\n${marker(locale, 'typedInputNote')} ${text}` : text
    this.deps.beginTurn(input, !spoken, liveRoute((sentence, signal) => this.say(sentence, null, signal)))
    this.touch()
  }

  /** Watches brain's events and, once a turn that opened a panel ends, tells the voice model what is on screen. */
  private observeTurn(event: TurnEvent): void {
    if (event.type === 'panel' && event.event.op === 'create') {
      const set = this.panelsByTurn.get(event.turnId) ?? new Set<string>()
      set.add(event.event.type)
      this.panelsByTurn.set(event.turnId, set)
      this.touch()
      return
    }
    if (event.type === 'tool') {
      this.touch()
      return
    }
    if (event.type === 'done' || event.type === 'error') {
      const panels = this.panelsByTurn.get(event.turnId)
      this.panelsByTurn.delete(event.turnId)
      if (panels && panels.size > 0) {
        const locale = conversationLocale()
        this.think(
          fillPrompt(promptText(locale, PANELS_ON_SCREEN), {
            screen: marker(locale, 'screen'),
            panels: [...panels].join(promptText(locale, { ja: '、', en: ', ' }))
          })
        )
      }
    }
  }
}
