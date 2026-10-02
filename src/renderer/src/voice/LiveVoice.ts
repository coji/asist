import mitt, { type Emitter } from 'mitt'
import { MicInput } from './MicInput'
import { SileroVad } from './SileroVad'
import { errorText } from '@shared/i18n/error-text'
import { displayError } from '@/display-error'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * The microphone input for the live engine, Gemini Live, and the engine's voice that comes back. The
 * 16 kHz frames go to the main process untouched, because the live model itself decides what it hears
 * and when speech has ended. The renderer only signals the main process when it catches a voice, so
 * that a closed session opens, and reports the level the orb displays.
 */

export type LiveVoiceState = 'off' | 'loading' | 'on'

type LiveVoiceEvents = {
  state: LiveVoiceState
  level: number
  error: string
  /** The model's voice, mono Float32 at 24 kHz, in the order it arrives. */
  audio: Float32Array
}

/** A frame counts as voiced when Silero's voice probability reaches this. */
const SPEECH_PROB = 0.5
/** How long a voice must hold before it counts. Real speech reaches it in about 60 ms, so the delay is not felt. */
const SPEECH_CONFIRM_MS = 100
/** The RMS floor used when Silero is unavailable. A noise picked up here only opens the session, which does little harm. */
const ENERGY_THRESHOLD = 0.02
/** How long the voice must be gone before speech counts as stopped. */
const QUIET_MS = 600

export class LiveVoice {
  readonly events: Emitter<LiveVoiceEvents> = mitt<LiveVoiceEvents>()
  private state: LiveVoiceState = 'off'
  private generation = 0
  private microphone = new MicInput()
  private silero = new SileroVad()
  private voicedMs = 0
  private quietMs = 0
  private speaking = false
  /**
   * Stops listening to the voice of the engine this run started. Main sends voice until it has handled
   * the stop and does not keep it in order with the answer to the next start, so a run hands on only the
   * voice that carries the number main gave its own start.
   */
  private stopVoice: (() => void) | null = null
  /** Set from the settings. The change takes effect the next time the microphone is turned on. */
  nativeMicPreferred = true
  noiseSuppression = true

  get current(): LiveVoiceState {
    return this.state
  }

  async enable(): Promise<void> {
    if (this.state !== 'off') return
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation
    this.setState('loading')
    void this.silero.init()
    try {
      const permitted = await window.api.requestMicPermission()
      if (!current()) return
      if (!permitted) throw new Error(errorText(osMessageKey('voice.mic.notPermitted', platformCapabilities().os)))
      const started = await window.api.liveStart()
      if (!current()) return
      if (!started.ok) throw new Error(started.reason ?? errorText('voice.live.startFailed'))
      const run = started.run
      this.stopVoice = window.api.onLiveAudio(({ run: spokenBy, samples }) => {
        if (spokenBy === run) this.events.emit('audio', samples instanceof Float32Array ? samples : new Float32Array(samples))
      })
      const feed = (frame: Float32Array): void => {
        if (!current()) return
        this.silero.push(frame)
        this.observe(frame)
        void window.api.livePush(frame).catch(() => {})
      }
      await this.microphone.start(
        { native: this.nativeMicPreferred, noiseSuppression: this.noiseSuppression },
        feed,
        () => void this.recover()
      )
      if (!current()) return
      this.setState('on')
    } catch (err) {
      if (!current()) return
      this.events.emit('error', displayError(err))
      this.disable()
    }
  }

  /** Turns the microphone off. The next time it turns on, the native helper is tried again. */
  disable(): void {
    this.microphone.stop()
    this.shutDown()
  }

  /**
   * Builds capture and the live session again after the machine sleeps and wakes or the input source goes
   * away. A native helper main gave up on stays out until the microphone is turned off.
   */
  async recover(): Promise<void> {
    if (this.state === 'off') return
    this.microphone.close()
    this.shutDown()
    await this.enable()
  }

  private shutDown(): void {
    this.generation++
    this.stopVoice?.()
    this.stopVoice = null
    this.silero.dispose()
    this.speaking = false
    this.voicedMs = 0
    this.quietMs = 0
    if (this.state !== 'off') void window.api.liveStop().catch(() => {})
    this.setState('off')
  }

  /** Tells the main process that speech started or stopped, from the level and how long a voice has held. */
  private observe(frame: Float32Array): void {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / Math.max(1, frame.length))
    this.events.emit('level', Math.min(1, rms * 12))
    const ms = (frame.length / 16_000) * 1000
    const prob = this.silero.currentProb()
    const voiced = prob === null ? rms > ENERGY_THRESHOLD : prob >= SPEECH_PROB
    if (voiced) {
      this.voicedMs += ms
      this.quietMs = 0
      if (!this.speaking && this.voicedMs >= SPEECH_CONFIRM_MS) {
        this.speaking = true
        void window.api.liveActivity(true).catch(() => {})
      }
      return
    }
    this.quietMs += ms
    if (this.quietMs >= QUIET_MS) {
      this.voicedMs = 0
      if (this.speaking) {
        this.speaking = false
        void window.api.liveActivity(false).catch(() => {})
      }
    }
  }

  private setState(next: LiveVoiceState): void {
    if (this.state === next) return
    this.state = next
    this.events.emit('state', next)
  }
}

export const liveVoice = new LiveVoice()
