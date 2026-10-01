import type { LiveConnection, LiveEvent } from '@shared/ipc'
import { LiveSessionPolicy } from '@shared/live-session-policy'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { encodeInput } from './audio'

/**
 * When the provider's session is open, which is when it is billed. It opens the session when the user
 * starts speaking, closes it once the conversation has been quiet for the idle time, keeps the audio
 * recorded while it is closed and sends that first when it opens, reopens one the provider ended while
 * the user was speaking, and reports the state of the connection. live-session-policy makes the
 * decisions; this class runs them against the clock and the provider. What the session is used for
 * belongs to the engine that owns it.
 */

export type SessionCloseReason = 'idle' | 'stop' | 'error'

export interface LiveSessionLifecycleDeps {
  idleMs: number
  now: () => number
  /**
   * Opens the session. Once it resolves, audio can be sent. The engine owns the socket from the moment
   * it creates it, and ignores what any socket it no longer owns reports. It rejects as soon as `signal`
   * is aborted.
   */
  open: (signal: AbortSignal) => Promise<void>
  /** Closes the socket the engine owns, including one whose opening failed or has not finished. */
  close: (reason: SessionCloseReason) => Promise<void>
  /** Sends base64 PCM16 at 16 kHz. `seconds` is the length of that audio, which the usage counts. */
  transmit: (base64: string, seconds: number) => void
  /**
   * Whether the engine still runs something for the conversation, such as a function call waiting for
   * approval, which gives no sign of life until it ends.
   */
  working: () => boolean
  emit: (event: LiveEvent) => void
}

/**
 * How much audio is buffered while the session is closed. It is long enough that the roughly one second
 * the connection takes does not swallow the start of an utterance.
 */
const PRE_ROLL_MS = 3000
const POLICY_TICK_MS = 1000
const SAMPLE_RATE = 16_000

export class LiveSessionLifecycle {
  private readonly policy: LiveSessionPolicy
  private connection: LiveConnection = 'off'
  private running = false
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
  /** When opening the session started, which gives the connect time. */
  private openStartedAt = -Infinity

  constructor(private readonly deps: LiveSessionLifecycleDeps) {
    this.policy = new LiveSessionPolicy({ idleMs: deps.idleMs, preRollMs: PRE_ROLL_MS, sampleRate: SAMPLE_RATE })
  }

  get state(): LiveConnection {
    return this.connection
  }

  /** Between start and stop, while the microphone is on. */
  get enabled(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.setConnection('idle')
    this.ticker = setInterval(() => {
      if (this.policy.tick(this.deps.now(), this.deps.working()) === 'close') void this.close('idle')
    }, POLICY_TICK_MS)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.reopenForSpeech = false
    await this.close('stop')
    this.setConnection('off')
  }

  /** Mono Float32 from the microphone at 16 kHz. While the session is closed it goes into the pre-roll. */
  pushAudio(frame: Float32Array): void {
    if (!this.running) return
    if (!this.policy.isOpen) {
      this.policy.buffer(frame)
      return
    }
    this.transmit(frame)
  }

  /** The renderer's VAD heard a human voice start or stop. The start opens a closed session. */
  activity(active: boolean): void {
    if (!this.running) return
    this.reopenForSpeech = active
    if (active && this.policy.onUserSpeech(this.deps.now()) === 'open') void this.ensureOpen()
  }

  async ensureOpen(): Promise<void> {
    // A job report or an interjection can still arrive after a stop, and a session opened for it would
    // stay open and billed, with no idle close left to end it.
    if (!this.running || this.policy.isOpen) return
    if (this.opening) return this.opening
    this.openStartedAt = this.deps.now()
    this.setConnection('connecting')
    const abort = new AbortController()
    this.openingAbort = abort
    this.opening = this.deps
      .open(abort.signal)
      .then(() => {
        if (abort.signal.aborted) return
        this.policy.opened(this.deps.now())
        this.setConnection('open')
        const connectMs = Math.round(this.deps.now() - this.openStartedAt)
        this.deps.emit({ type: 'latency', responseMs: 0, connectMs })
        for (const frame of this.policy.takePreRoll()) this.transmit(frame)
      })
      .catch(async (err) => {
        // The close that let the opening go releases what it left.
        if (abort.signal.aborted) return
        // Left open, the socket of a session that did not start can still start late, and the provider
        // bills it for as long as it is open.
        await this.release('error')
        const detail = errMessage(err)
        this.setConnection('error', detail)
        this.deps.emit({ type: 'error', message: errorText('voice.live.connectFailed', { detail }) })
      })
      .finally(() => {
        this.opening = null
        this.openingAbort = null
      })
    return this.opening
  }

  /**
   * The provider ended the session, as at its time limit. Speech in progress opens a new one at once,
   * as the start of speech would have, and meanwhile goes into the pre-roll; while the user is silent,
   * the next speech opens it, as after an idle close.
   */
  ended(): void {
    this.policy.closed()
    if (!this.running) return
    this.setConnection('idle')
    if (!this.reopenForSpeech) return
    this.reopenForSpeech = false
    void this.ensureOpen()
  }

  /** Marks the conversation as still going, such as model audio or a function call, and pushes back the idle close. */
  touch(): void {
    this.policy.activity(this.deps.now())
  }

  private transmit(frame: Float32Array): void {
    const encoded = encodeInput(frame)
    if (encoded) this.deps.transmit(encoded, frame.length / SAMPLE_RATE)
  }

  private async close(reason: SessionCloseReason): Promise<void> {
    if (!this.policy.isOpen && !this.opening) return
    // A stop, or a change of engine, does not wait up to the setup timeout for a session it closes at once.
    this.openingAbort?.abort()
    await this.opening?.catch(() => {})
    await this.release(reason)
    if (this.running) this.setConnection(reason === 'error' ? 'error' : 'idle')
  }

  private async release(reason: SessionCloseReason): Promise<void> {
    this.policy.closed()
    try {
      await this.deps.close(reason)
    } catch (err) {
      console.error('live session close failed:', errMessage(err))
    }
  }

  private setConnection(state: LiveConnection, detail?: string): void {
    this.connection = state
    this.deps.emit({ type: 'connection', state, ...(detail ? { detail } : {}) })
  }
}
