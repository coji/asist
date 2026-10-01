import type { AppSettings } from './settings'

/**
 * When a live session opens and closes. An open session is sent the microphone's audio and Gemini bills
 * the minutes of audio sent, so the session is not held open for as long as the microphone is on: it
 * opens when the user starts speaking and closes once the conversation has been quiet for `idleMs`.
 * Audio recorded while it is closed is kept as a pre-roll and sent first when it opens, which delays
 * the reply by the time the connection takes but keeps the beginning of the utterance. The
 * conversation does not count as quiet while the assistant is speaking or while a function call is
 * still running.
 */

/**
 * Whether a change of settings stops a running live engine: the engine is built from the voice
 * engine, the live model and voice, and how long a quiet session stays open. The main process stops
 * the engine on this change, and the renderer turns the microphone off on the same one, so that the
 * button never says LIVE over an engine that is gone.
 */
export function stopsLiveEngine(
  before: Pick<AppSettings, 'voiceEngine' | 'geminiLive' | 'liveIdleSeconds'>,
  after: Pick<AppSettings, 'voiceEngine' | 'geminiLive' | 'liveIdleSeconds'>
): boolean {
  return (
    before.voiceEngine !== after.voiceEngine ||
    JSON.stringify(before.geminiLive) !== JSON.stringify(after.geminiLive) ||
    before.liveIdleSeconds !== after.liveIdleSeconds
  )
}

export interface LiveSessionPolicyOptions {
  idleMs: number
  /** How much audio, in milliseconds, is kept while the session is closed. */
  preRollMs: number
  sampleRate: number
}

export type LiveSessionDecision = 'open' | 'close' | 'keep'

export class LiveSessionPolicy {
  private open = false
  private lastActivityAt = -Infinity
  private readonly preRoll: Float32Array[] = []
  private preRollSamples = 0

  constructor(private readonly options: LiveSessionPolicyOptions) {}

  get isOpen(): boolean {
    return this.open
  }

  opened(now: number): void {
    this.open = true
    this.lastActivityAt = now
  }

  closed(): void {
    this.open = false
  }

  /** Called when the user spoke, the assistant spoke, or the brain did some work. */
  activity(now: number): void {
    this.lastActivityAt = now
  }

  /** Keeps audio recorded while the session is closed; takePreRoll hands it over to be sent first once it opens. */
  buffer(frame: Float32Array): void {
    if (this.open) return
    this.preRoll.push(frame)
    this.preRollSamples += frame.length
    const limit = (this.options.preRollMs / 1000) * this.options.sampleRate
    while (this.preRollSamples > limit && this.preRoll.length > 1) {
      this.preRollSamples -= this.preRoll.shift()!.length
    }
  }

  takePreRoll(): Float32Array[] {
    const frames = this.preRoll.splice(0)
    this.preRollSamples = 0
    return frames
  }

  /** Called when the user starts speaking, which opens the session if it was closed. */
  onUserSpeech(now: number): LiveSessionDecision {
    this.lastActivityAt = now
    return this.open ? 'keep' : 'open'
  }

  /**
   * Called periodically, and it closes the session once the conversation has been quiet for `idleMs`.
   * While `working`, such as while a function call waits for approval, the quiet time does not start.
   */
  tick(now: number, working: boolean): LiveSessionDecision {
    if (!this.open) return 'keep'
    if (working) {
      this.lastActivityAt = now
      return 'keep'
    }
    return now - this.lastActivityAt >= this.options.idleMs ? 'close' : 'keep'
  }
}
