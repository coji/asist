import type { HangoverMode } from '@shared/ipc'
import { VAP_EOT_CONFIRM, VAP_EOT_HOLD_BELOW } from '@shared/maai-thresholds'

/**
 * Detects the stretches of speech by combining two signals, each with its own job, in this one
 * place. Keeping the voice decision here rather than at each consumer is what makes it impossible
 * for one consumer to miss the gate.
 *
 * - Energy, against an adaptive noise floor, cuts the stretches out and gives the immediate
 *   reaction. The start of speech, silence, ducking and how quickly barge-in feels like it responds
 *   all follow the level, because Silero's probability lags by about one chunk, 32 ms, and routing
 *   the start through it would be felt. Energy also sets the floor against a television, a distant
 *   conversation and the echo of the assistant's own speech, which raises thresholdBoost while it
 *   plays.
 * - Silero VAD decides whether what was cut out is a human voice. It accumulates into
 *   speechDuration, which the decision to send audio to ASR and the noise rejection of a confirmed
 *   barge-in read, and speechConfirmed, a longer stretch that the partial transcripts and the aizuchi
 *   played while the user speaks wait for. A noise such as typing or an object set down has high
 *   energy but adds nothing to speechDuration, which stops ASR from hallucinating words out of it. While
 *   speechProbProvider returns null, because Silero is not ready or has failed, audio energy alone
 *   decides, so no failure here can discard speech.
 */

/** samples holds the whole stretch of speech, vadMs the hangover the end decision took, and mode the path that decision went through. */
export interface VadUtterance {
  samples: Float32Array
  vadMs: number
  mode: HangoverMode
}

/** How far a capture had gone at some point, so that what it captures afterwards can be judged on its own. */
export interface CaptureMark {
  spokenMs: number
  voicedMs: number
  speechMs: number
}

export interface VadEvents {
  onSpeechStart?: () => void
  /**
   * Ends every capture that onSpeechStart opened: with the utterance, or with null when the capture
   * held too little voice or the VAD was muted in the middle of it.
   */
  onSpeechEnd?: (utterance: VadUtterance | null) => void
  /** The RMS, roughly 0 to 1, that the level meter in the UI displays. */
  onLevel?: (rms: number) => void
}

const SAMPLE_RATE = 16_000

const PRE_ROLL_MS = 300
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 20_000
const NOISE_FLOOR_INIT = 0.008
const NOISE_FLOOR_ALPHA = 0.05
const SPEECH_RATIO = 3.0
/**
 * About -38 dBFS. Both captures apply automatic gain: on 2026-09-30 a normal voice reached this VAD at
 * -12 to -28 dBFS, a softer one down to -26 dBFS, and the assistant's own echo through the native helper
 * up to -36 dBFS. A lower floor mostly opens captures on echo and room sounds.
 */
const MIN_THRESHOLD = 0.012
/**
 * The shortest capture that goes to ASR is a 「はい」. Measured at this VAD's input on 2026-09-30, with the
 * built-in microphone and a Bluetooth headset through both captures, the shortest 「はい」 and 「うん」 had
 * 128 ms voiced, of which Silero confirmed 43 ms; the minimums sit about a frame below that.
 */
const MIN_VOICED_MS = 100
/** A voiced frame counts as speech when Silero VAD's voice probability reaches this. */
const SPEECH_PROB_THRESHOLD = 0.5
/**
 * The speech Silero has to confirm before audio goes to ASR. Typing, a knock on a desk and a cup set down
 * got none in the same measurements, however loud; a cough or a cleared throat can get more than a short
 * 「はい」 does, and is transcribed as 「うん」.
 */
const MIN_SPEECH_MS = 30
/** The speech after which a capture counts as a human voice, for the partial transcripts and the aizuchi, which one word or a cough must not start. */
const CONFIRMED_SPEECH_MS = 150

/*
 * The VAP moves the hangover. A silence whose EoT, the probability that the turn has ended, stays
 * high ends the utterance early, and one whose EoT is low, a pause inside a sentence with more to
 * come, extends it. While the VAP is not ready or its value is stale the provider returns null and
 * the configured fixed value applies. The EoT thresholds and the measurements behind them are
 * specific to the model and live in maai-thresholds.
 */
/** How long a high EoT must hold. A momentary spike, where an aizuchi would fit, must not end the utterance early. */
const VAP_EOT_PERSIST_MS = 200
/** The shortest hangover an early end can use. */
const VAP_EARLY_HANGOVER_MS = 300
/** The longest hangover an extension can use. */
const VAP_EXTENDED_HANGOVER_MS = 900

/**
 * Whether a capture holds an utterance. The lengths let a single 「はい」 through, so what keeps a noise, such
 * as a run of keystrokes, from being transcribed into words is Silero's confirmation. The length is measured
 * without the silence after the speech, so an early VAP end that shortens the hangover does not discard a
 * short utterance.
 */
function holdsUtterance(spokenMs: number, voicedMs: number, speechMs: number): boolean {
  return spokenMs >= MIN_UTTERANCE_MS && voicedMs >= MIN_VOICED_MS && speechMs >= MIN_SPEECH_MS
}

/** The levels a capture opened on, and the loudest frame it held. */
interface CaptureLevels {
  loudestRms: number
  noiseFloor: number
  threshold: number
  boost: number
}

const dbfs = (rms: number): string => `${rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : '-inf'}dBFS`

export class VadSegmenter {
  private preRoll: Float32Array[] = []
  private preRollSamples = 0
  private utterance: Float32Array[] = []
  private utteranceSamples = 0
  private speaking = false
  private silenceMs = 0
  private voicedMs = 0
  private speechMs = 0
  private noiseFloor = NOISE_FLOOR_INIT
  private levels: CaptureLevels = { loudestRms: 0, noiseFloor: 0, threshold: 0, boost: 1 }
  /** Speech ends once silence lasts this long. The settings can tune it. */
  hangoverMs = 350
  /** While true, every frame is ignored outright. */
  muted = false
  /** Raised while the assistant speaks, so its echo does not trip barge-in. */
  thresholdBoost = 1
  /**
   * Supplies Silero VAD's voice probability. The newest value, about one 32 ms chunk behind, is
   * accurate enough. While it returns null, because Silero is not ready or has failed, energy alone
   * decides.
   */
  speechProbProvider: (() => number | null) | null = null
  /**
   * Supplies the VAP's EoT, the probability that the user's turn has ended. It moves the hangover
   * according to whether a silence is an ending or a pause with more to come. While it returns
   * null, the configured fixed hangover applies.
   */
  eotProvider: (() => number | null) | null = null
  /**
   * Reports whether the aizuchi classifier reads the partial transcript as an unfinished sentence.
   * A silence while it is true is waiting for the rest, so the hangover extends whatever the VAP
   * says: measured on 2026-09-20, the classifier's hold reached F1 0.95 on unseen material, which
   * is more reliable than the VAP's EoT.
   */
  holdProvider: (() => boolean) | null = null
  /** How long, in milliseconds, the EoT has stayed at or above the confirm threshold within the current silence. */
  private eotHighMs = 0

  constructor(private readonly events: VadEvents) {}

  get isSpeaking(): boolean {
    return this.speaking
  }

  /** The milliseconds of the current utterance that were voiced by energy. The immediate barge-in decision reads it. */
  get voicedDuration(): number {
    return this.voicedMs
  }

  /**
   * The milliseconds of the current utterance confirmed as a human voice, which is what rejects
   * noise when a barge-in is confirmed. While Silero is not ready it equals voicedDuration.
   */
  get speechDuration(): number {
    return this.speechMs
  }

  /** The current silence in milliseconds. It decides whether a pause inside a sentence invites an aizuchi. */
  get silenceDuration(): number {
    return this.speaking ? this.silenceMs : 0
  }

  /** Whether the captured audio is confirmed as a human voice. The partial transcripts and the aizuchi wait for it. */
  get speechConfirmed(): boolean {
    return this.speechMs >= CONFIRMED_SPEECH_MS
  }

  /** The milliseconds since speech started. */
  get utteranceDuration(): number {
    return this.speaking ? (this.utteranceSamples / SAMPLE_RATE) * 1000 : 0
  }

  /** How far the capture in progress has gone, up to the end of its last voice. */
  mark(): CaptureMark {
    return { spokenMs: this.utteranceDuration - this.silenceDuration, voicedMs: this.voicedMs, speechMs: this.speechMs }
  }

  /** Whether what the capture in progress took in after the mark would be kept as an utterance on its own. */
  holdsUtteranceSince(mark: CaptureMark): boolean {
    const now = this.mark()
    return holdsUtterance(now.spokenMs - mark.spokenMs, now.voicedMs - mark.voicedMs, now.speechMs - mark.speechMs)
  }

  /**
   * A snapshot of the utterance buffer being captured, for the partial transcripts. With maxMs only
   * the tail comes back, because the load Whisper carries grows linearly with the length of the
   * utterance and the tail is enough to read the intent from.
   */
  snapshot(maxMs = Infinity): Float32Array | null {
    if (!this.speaking || this.utteranceSamples < SAMPLE_RATE / 2) return null
    const all = this.concat()
    const maxSamples = Math.floor((maxMs / 1000) * SAMPLE_RATE)
    return all.length > maxSamples ? all.slice(all.length - maxSamples) : all
  }

  push(frame: Float32Array): void {
    if (this.muted) {
      if (this.speaking) {
        console.log(`vad: capture muted ${this.describeCapture()}`)
        this.reset()
        this.events.onSpeechEnd?.(null)
      }
      return
    }

    const rms = this.rms(frame)
    this.events.onLevel?.(rms)
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * SPEECH_RATIO) * this.thresholdBoost
    const frameMs = (frame.length / SAMPLE_RATE) * 1000

    if (!this.speaking) {
      // The noise floor learns only from quiet frames, those at or below the threshold. Mixing a
      // loud frame into it sends the floor up, multiplied again by the boost during playback, and
      // locks speech out.
      if (rms <= threshold) {
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA
      }
      this.appendPreRoll(frame)
      // The start follows energy alone so that ducking and barge-in stay immediate. If a noise
      // starts a capture, too little voice accumulates and the utterance is discarded at the end.
      if (rms > threshold) {
        this.speaking = true
        this.silenceMs = 0
        this.utterance = [...this.preRoll]
        this.utteranceSamples = this.preRollSamples
        this.levels = { loudestRms: rms, noiseFloor: this.noiseFloor, threshold, boost: this.thresholdBoost }
        this.events.onSpeechStart?.()
      }
      return
    }

    this.utterance.push(frame)
    this.utteranceSamples += frame.length
    this.levels.loudestRms = Math.max(this.levels.loudestRms, rms)
    if (rms > threshold) {
      this.silenceMs = 0
      this.eotHighMs = 0
      this.voicedMs += frameMs
      const prob = this.speechProbProvider?.() ?? null
      if (prob === null || prob >= SPEECH_PROB_THRESHOLD) this.speechMs += frameMs
    } else {
      this.silenceMs += frameMs
      const eot = this.eotProvider?.() ?? null
      if (eot !== null && eot >= VAP_EOT_CONFIRM) this.eotHighMs += frameMs
      else this.eotHighMs = 0
    }

    const utteranceMs = (this.utteranceSamples / SAMPLE_RATE) * 1000
    const hangover = this.effectiveHangover()
    if (this.silenceMs >= hangover.ms) {
      this.finalize(utteranceMs, hangover.mode)
    } else if (utteranceMs >= MAX_UTTERANCE_MS) {
      this.finalize(utteranceMs, 'fixed')
    }
  }

  /**
   * Moves the hangover according to what the silence is. A sentence the classifier reads as
   * unfinished extends it, up to 900 ms. A silence whose VAP EoT stays high ends the utterance
   * early, down to 300 ms, and a low EoT extends it; anything else, and a VAP that is not ready,
   * keeps the configured value. A configured value already shorter than the early bound, or longer
   * than the extended bound, is left alone and the mode stays fixed.
   */
  private effectiveHangover(): { ms: number; mode: HangoverMode } {
    if (this.holdProvider?.() && VAP_EXTENDED_HANGOVER_MS > this.hangoverMs) {
      return { ms: VAP_EXTENDED_HANGOVER_MS, mode: 'extended' }
    }
    const eot = this.eotProvider?.() ?? null
    if (eot === null) return { ms: this.hangoverMs, mode: 'fixed' }
    if (this.eotHighMs >= VAP_EOT_PERSIST_MS && VAP_EARLY_HANGOVER_MS < this.hangoverMs) {
      return { ms: VAP_EARLY_HANGOVER_MS, mode: 'early' }
    }
    if (eot <= VAP_EOT_HOLD_BELOW && VAP_EXTENDED_HANGOVER_MS > this.hangoverMs) {
      return { ms: VAP_EXTENDED_HANGOVER_MS, mode: 'extended' }
    }
    return { ms: this.hangoverMs, mode: 'fixed' }
  }

  private finalize(utteranceMs: number, mode: HangoverMode): void {
    const vadMs = Math.round(this.silenceMs)
    const kept = holdsUtterance(utteranceMs - vadMs, this.voicedMs, this.speechMs)
    // Every capture is logged with its levels, so that a voice that did nothing, or a noise that
    // started a turn, can be traced back to the thresholds.
    console.log(`vad: capture ${kept ? 'kept' : 'discarded'} ${this.describeCapture()}`)
    const samples = kept ? this.concat() : null
    this.reset()
    this.events.onSpeechEnd?.(samples ? { samples, vadMs, mode } : null)
  }

  private describeCapture(): string {
    const { loudestRms, noiseFloor, threshold, boost } = this.levels
    const boosts = boost === this.thresholdBoost ? `${boost}` : `${boost}→${this.thresholdBoost}`
    const utteranceMs = (this.utteranceSamples / SAMPLE_RATE) * 1000
    return (
      `(loudest=${dbfs(loudestRms)} floor=${dbfs(noiseFloor)} threshold=${dbfs(threshold)} boost=${boosts} ` +
      `utterance=${Math.round(utteranceMs)}ms voiced=${Math.round(this.voicedMs)}ms ` +
      `speech=${Math.round(this.speechMs)}ms silence=${Math.round(this.silenceMs)}ms)`
    )
  }

  /** Stopping and restarting capture must not carry the previous utterance buffer over. It reports no end, because the owner is stopping. */
  reset(): void {
    this.speaking = false
    this.silenceMs = 0
    this.eotHighMs = 0
    this.voicedMs = 0
    this.speechMs = 0
    this.utterance = []
    this.utteranceSamples = 0
    this.preRoll = []
    this.preRollSamples = 0
  }

  private appendPreRoll(frame: Float32Array): void {
    this.preRoll.push(frame)
    this.preRollSamples += frame.length
    const maxSamples = (PRE_ROLL_MS / 1000) * SAMPLE_RATE
    while (this.preRollSamples - (this.preRoll[0]?.length ?? 0) > maxSamples) {
      this.preRollSamples -= this.preRoll.shift()!.length
    }
  }

  private concat(): Float32Array {
    const out = new Float32Array(this.utteranceSamples)
    let offset = 0
    for (const chunk of this.utterance) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  private rms(frame: Float32Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    return Math.sqrt(sum / frame.length)
  }
}
