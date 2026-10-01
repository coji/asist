import mitt, { type Emitter } from 'mitt'
import type { AppSettings, LiveConnection, LiveEvent, LiveUsage } from '@shared/ipc'
import { LiveSessionPolicy } from '@shared/live-session-policy'
import type { LiveEngineInfo } from '@shared/voice-engine'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { encodeInput } from './audio'
import { TranscriptTracker, type TranscriptRole } from './transcripts'

/**
 * The part of a live engine that does not depend on the provider's protocol: the audio path to and
 * from the renderer, the policy for opening and closing a session (live-session-policy), the assembly
 * of the transcripts, and the usage and cost estimate. What is done with a transcript, which decides
 * what the screen shows and what the conversation log keeps, belongs to the engine of the provider.
 */

export type LiveEngineEvents = {
  /** Mono Float32 at 24 kHz, played in the order it arrives. */
  audio: Float32Array
  event: LiveEvent
}

export interface LiveEngineDeps {
  settings: () => AppSettings
  now?: () => number
}

/**
 * How long the transcript stays quiet before an utterance is final. It is long enough not to cut at a
 * pause inside a sentence, which runs around 0.5 seconds, and short enough to separate two utterances.
 */
const TRANSCRIPT_QUIET_MS = 1500
/**
 * How much audio is buffered while the session is closed. It is long enough that the roughly one second
 * the connection takes does not swallow the start of an utterance.
 */
const PRE_ROLL_MS = 3000
const POLICY_TICK_MS = 1000

export abstract class LiveEngineBase {
  readonly events: Emitter<LiveEngineEvents> = mitt<LiveEngineEvents>()
  protected readonly now: () => number
  protected readonly settings: () => AppSettings
  protected readonly policy: LiveSessionPolicy
  protected connection: LiveConnection = 'off'
  protected enabled = false
  private ticker: ReturnType<typeof setInterval> | null = null
  private opening: Promise<void> | null = null
  /** Lets a close end the opening in progress at once, rather than wait for its setup or its timeout. */
  private openingAbort: AbortController | null = null
  /**
   * Whether a session the provider ends reopens at once, because the user is speaking. The start of
   * speech allows one such reopen and its end withdraws it, so a provider that ends every session as
   * soon as it starts cannot keep the engine reconnecting, and billing a session each time.
   */
  private reopenForSpeech = false
  protected readonly transcripts: TranscriptTracker
  /** Response latency measurement: when the last user transcript arrived and whether audio is still awaited. */
  private lastUserDeltaAt = -Infinity
  private awaitingFirstAudio = false
  /** When opening the session started, which gives the connect time. */
  private openStartedAt = -Infinity
  protected usage: LiveUsage = { sessionSeconds: 0, costUsd: 0 }

  constructor(
    protected readonly info: LiveEngineInfo,
    deps: LiveEngineDeps
  ) {
    this.settings = deps.settings
    this.now = deps.now ?? (() => Date.now())
    this.policy = new LiveSessionPolicy({
      idleMs: deps.settings().liveIdleSeconds * 1000,
      preRollMs: PRE_ROLL_MS,
      sampleRate: 16_000
    })
    this.transcripts = new TranscriptTracker({
      quietMs: TRANSCRIPT_QUIET_MS,
      onDelta: (role, text) => this.onTranscriptDelta(role, text),
      onFinal: (role, text) => this.onTranscriptFinal(role, text)
    })
  }

  get state(): LiveConnection {
    return this.connection
  }

  async start(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    this.setConnection('idle')
    this.ticker = setInterval(() => {
      if (this.policy.tick(this.now(), this.working()) === 'close') void this.close('idle')
    }, POLICY_TICK_MS)
  }

  async stop(): Promise<void> {
    if (!this.enabled) return
    this.enabled = false
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.reopenForSpeech = false
    this.transcripts.flush('user')
    this.transcripts.flush('assistant')
    await this.close('stop')
    this.transcripts.dispose()
    this.setConnection('off')
  }

  /** Mono Float32 from the microphone at 16 kHz. While the session is closed it goes into the pre-roll. */
  pushAudio(frame: Float32Array): void {
    if (!this.enabled) return
    if (!this.policy.isOpen) {
      this.policy.buffer(frame)
      return
    }
    const encoded = encodeInput(frame)
    if (encoded) this.transmitAudio(encoded, frame.length / 16_000)
  }

  /** The renderer's VAD heard a human voice start or stop. The start opens a closed session. */
  activity(active: boolean): void {
    if (!this.enabled) return
    this.reopenForSpeech = active
    if (active && this.policy.onUserSpeech(this.now()) === 'open') void this.ensureOpen()
  }

  abstract sendText(text: string): Promise<void>

  /**
   * Opens the session. Once it resolves, audio can be sent. The engine owns the socket from the moment
   * it creates it, and ignores what any socket it no longer owns reports. It rejects as soon as `signal`
   * is aborted.
   */
  protected abstract openSession(signal: AbortSignal): Promise<void>
  /** Closes the socket the engine owns, including one whose opening failed or has not finished. */
  protected abstract closeSession(reason: 'idle' | 'stop' | 'error'): Promise<void>
  /** Sends base64 PCM16 at 16 kHz. `seconds` is the length of that audio, which the usage counts. */
  protected abstract transmitAudio(base64: string, seconds: number): void

  protected async ensureOpen(): Promise<void> {
    // A job report or an interjection can still arrive after a stop, and a session opened for it would
    // stay open and billed, with no idle close left to end it.
    if (!this.enabled || this.policy.isOpen) return
    if (this.opening) return this.opening
    this.openStartedAt = this.now()
    this.setConnection('connecting')
    const abort = new AbortController()
    this.openingAbort = abort
    this.opening = this.openSession(abort.signal)
      .then(() => {
        if (abort.signal.aborted) return
        this.policy.opened(this.now())
        this.setConnection('open')
        const connectMs = Math.round(this.now() - this.openStartedAt)
        this.events.emit('event', { type: 'latency', responseMs: 0, connectMs })
        for (const frame of this.policy.takePreRoll()) {
          const encoded = encodeInput(frame)
          if (encoded) this.transmitAudio(encoded, frame.length / 16_000)
        }
      })
      .catch(async (err) => {
        // The close that let the opening go releases what it left.
        if (abort.signal.aborted) return
        // Left open, the socket of a session that did not start can still start late, and the provider
        // bills it for as long as it is open.
        await this.release('error')
        const detail = errMessage(err)
        this.setConnection('error', detail)
        this.events.emit('event', { type: 'error', message: errorText('voice.live.connectFailed', { detail }) })
      })
      .finally(() => {
        this.opening = null
        this.openingAbort = null
      })
    return this.opening
  }

  protected async close(reason: 'idle' | 'stop' | 'error'): Promise<void> {
    if (!this.policy.isOpen && !this.opening) return
    // A stop, or a change of engine, does not wait up to the setup timeout for a session it closes at once.
    this.openingAbort?.abort()
    await this.opening?.catch(() => {})
    await this.release(reason)
    if (this.enabled) this.setConnection(reason === 'error' ? 'error' : 'idle')
  }

  private async release(reason: 'idle' | 'stop' | 'error'): Promise<void> {
    this.policy.closed()
    try {
      await this.closeSession(reason)
    } catch (err) {
      console.error('live session close failed:', errMessage(err))
    }
  }

  /**
   * The provider ended the session, as at its time limit. Speech in progress opens a new one at once,
   * as the start of speech would have, and meanwhile goes into the pre-roll; while the user is silent,
   * the next speech opens it, as after an idle close.
   */
  protected sessionEnded(): void {
    this.policy.closed()
    if (!this.enabled) return
    this.setConnection('idle')
    if (!this.reopenForSpeech) return
    this.reopenForSpeech = false
    void this.ensureOpen()
  }

  /** Marks the conversation as still going, such as model audio or brain work, and pushes back the idle close. */
  protected touch(): void {
    this.policy.activity(this.now())
  }

  /**
   * Whether the engine itself still runs something for the conversation, such as a function call waiting
   * for approval, which gives no sign of life until it ends.
   */
  protected abstract working(): boolean

  protected setConnection(state: LiveConnection, detail?: string): void {
    this.connection = state
    this.events.emit('event', { type: 'connection', state, ...(detail ? { detail } : {}) })
  }

  /** Passes the model's audio to the renderer and measures the response latency. */
  protected emitAudio(samples: Float32Array): void {
    this.touch()
    if (this.awaitingFirstAudio) {
      this.awaitingFirstAudio = false
      const responseMs = Math.round(this.now() - this.lastUserDeltaAt)
      if (responseMs >= 0) this.events.emit('event', { type: 'latency', responseMs })
    }
    this.events.emit('audio', samples)
  }

  protected emitUsage(usage: LiveUsage): void {
    this.usage = usage
    this.events.emit('event', { type: 'usage', usage })
  }

  protected pushTranscript(role: TranscriptRole, delta: string): void {
    if (role === 'user') {
      this.lastUserDeltaAt = this.now()
      this.awaitingFirstAudio = true
      this.touch()
    }
    this.transcripts.push(role, delta)
  }

  /** The text of a transcript collected so far, which is not final yet. */
  protected abstract onTranscriptDelta(role: TranscriptRole, text: string): void
  /** A transcript is final, because it went quiet, the model signalled its end, or the engine stopped. */
  protected abstract onTranscriptFinal(role: TranscriptRole, text: string): void
}
