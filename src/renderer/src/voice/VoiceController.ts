import mitt, { type Emitter } from 'mitt'
import type { HangoverMode, VapState } from '@shared/ipc'
import { isMeaningfulTranscript } from '@shared/asr-filter'
import { conversationFeatures, type ConversationLocale } from '@shared/conversation-locale'
import {
  ListeningRecorder,
  shouldBackchannel,
  type BackchannelDecision
} from '@shared/listening-aizuchi'
import type { ListeningAizuchi } from '@shared/ipc'
import { shouldNod, type NodKind } from '@shared/nod'
import { classifyOverlap } from '@shared/user-backchannel'
import { ECHO_TAIL_MS } from '@shared/self-echo'
import { errorText } from '@shared/i18n/error-text'
import { whisperLanguageName } from '@shared/asr-models'
import { MicCapture, StreamResampler } from './MicCapture'
import { VapAudio } from './VapAudio'
import { NativeMicSource } from './NativeMic'
import { VadSegmenter, type VadUtterance } from './VadSegmenter'
import { SileroVad } from './SileroVad'
import { DfnDenoiser } from './DfnDenoiser'
import { AsrEngine, type AsrProgress } from './AsrEngine'
import { speechPlayer } from './SpeechPlayer'
import { conversationLocale } from '@/conversation-locale'
import { displayError, errorMessageOf } from '@/display-error'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

export type VoiceState = 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'

export interface SpeechEnd {
  /** When capture started. It matches this event to the utterance of the same speech. */
  startedAt: number
  /** When speech ended, with the hangover's silence subtracted. */
  speechEndAt: number
  vadMs: number
  vadMode: HangoverMode
  /** The partial transcript as of the end of speech. It is older than the final one and can be missing the tail. */
  partialText: string
  /** The length of the utterance in milliseconds, without the silence. */
  utteranceMs: number
  /** The aizuchi played during this capture, and whether the user carried on after each one. */
  listening: ListeningAizuchi[]
}

/** A VAP estimate older than this is not used, which covers a stopped or backed-up worker. It allows the 80 ms frame, about 20 ms of inference and the IPC. */
const VAP_STALE_MS = 500

type VoiceEvents = {
  state: VoiceState
  level: number
  progress: number
  /** The rolling partial transcript while the user is still speaking. */
  partial: string
  /**
   * The VAD has decided that speech ended. It arrives before the utterance event, and the aizuchi
   * that opens the turn plays from here rather than waiting for the final transcript.
   */
  speechend: SpeechEnd
  utterance: {
    text: string
    vadMs: number
    /** Which path decided the end of speech, early, extended or fixed. The HUD displays it as the EoT statistics. */
    vadMode: HangoverMode
    asrMs: number
    partialText: string
    /** When speech ended, on performance.now(). It is the same value the speechend event carried. */
    speechEndAt: number
    /** When capture started, on performance.now(). It decides whether an aizuchi clip falls inside the echo window. */
    startedAt: number
  }
  /**
   * The speech a speechend announced will not become an utterance: its transcription failed, the
   * transcript meant nothing, or the microphone stopped first. Every speechend is followed by one
   * utterance or one of these, with the same startedAt.
   */
  speechdropped: { startedAt: number }
  /** The user started speaking over the assistant. Playback stops right after this event. */
  bargein: undefined
  /** A short sound from the user during playback was taken as an aizuchi and let pass; the reading continues. */
  userBackchannel: undefined
  /** A break in a long utterance where an aizuchi fits, with its kind and the grounds for it. */
  backchannel: BackchannelDecision
  /** A nod, an aizuchi without a sound, which makes the orb sway slightly. */
  nod: NodKind
  error: string
}

/**
 * Drives the voice input from microphone through VAD to ASR. While the user speaks it runs rolling
 * partial transcriptions, and at the end it transcribes the final buffer.
 */
export class VoiceController {
  readonly events: Emitter<VoiceEvents> = mitt<VoiceEvents>()

  private mic = new MicCapture()
  /** Capture through macOS voice processing, which cancels the echo. If it is unavailable, mic takes over. */
  private nativeMic = new NativeMicSource()
  /** DeepFilterNet noise suppression. Unavailable or backed up, it passes the audio through unsuppressed. */
  private dfn = new DfnDenoiser()
  private nativeActive = false
  private asr = new AsrEngine()
  private vad: VadSegmenter
  /** Tells noise from voice. Where it is unavailable, the energy VAD runs alone. */
  private silero = new SileroVad()
  private state: VoiceState = 'off'
  /** The speeches, by startedAt, whose final transcript is still awaited. */
  private awaitingTranscript = new Set<number>()
  private backend: 'server' | 'local' = 'server'
  private captureGeneration = 0
  private recoveryPromise: Promise<void> | null = null
  /** Final transcriptions run in the order they were recorded, so a later one finishing first cannot rewind the conversation. */
  private transcriptionTail: Promise<void> = Promise.resolve()
  /** Final transcriptions queued or running in the main process. Discarding a generation stops the real work over IPC too. */
  private serverRequests = new Set<string>()
  private localWorkInFlight = 0
  private partialTimer: ReturnType<typeof setInterval> | null = null
  private partialInflight = false
  private partialRequestGeneration = 0
  private lastPartial = ''

  bargeIn = true
  /**
   * The milliseconds of human voice a barge-in must accumulate to be confirmed. Real speech raises
   * Silero's probability within about 60 ms, so the delay is not felt, and only a noise, which
   * brings no evidence at all, is refused.
   */
  bargeInMinSpeechMs = 100
  /**
   * Setting this to true is the user's explicit consent to use the in-browser Whisper, several
   * hundred megabytes of it. By default nothing is downloaded and nothing falls back to it.
   */
  localFallbackEnabled = false
  partialIntervalMs = 600
  /** While the assistant speaks, a barge-in is confirmed only after the voice holds this long, so a momentary echo does not stop it. */
  bargeInConfirmMs = 250
  /** Whether a quiet aizuchi such as "うん" plays at a break in a long utterance. Set from the settings. */
  listeningAizuchi = true
  /** Prefers capture through macOS voice processing. Set from the settings, and takes effect when the microphone restarts. */
  nativeMicPreferred = true
  /** DeepFilterNet noise suppression, which applies to native capture only. Set from the settings, and takes effect when the microphone restarts. */
  noiseSuppression = true
  /** The aizuchi classifier's reading that the sentence is unfinished, wired up by conversation. It extends the VAD's hangover. */
  holdProvider: (() => boolean) | null = null
  /** VAP turn taking, which moves the hangover and times the aizuchi. Set from the settings. */
  vapEnabled = false
  /**
   * The language the conversation is held in, set from the settings and read at each use. The aizuchi
   * and the turn-taking model exist for Japanese only, so in another language they stay out of the
   * pipeline however the settings that switch them are saved.
   */
  conversationLocale: ConversationLocale = 'ja-JP'
  private vapState: VapState | null = null
  private vapStateAt = 0
  private vapUnsubscribe: (() => void) | null = null
  private vapAudio = new VapAudio((user, assistant) => {
    void window.api.vapPush(user, assistant).catch(() => {})
  })
  /**
   * What is being done with a voice that came in during playback. While pending, the decision is
   * open and the volume is down; as backchannel, it was read as an aizuchi and the reading carries
   * on, until a voice that keeps going turns it into an interruption.
   */
  private overlap: 'none' | 'pending' | 'backchannel' = 'none'
  /** The current capture was let pass as an aizuchi, so at the end it is discarded rather than transcribed. */
  private captureIsBackchannel = false
  private lastBackchannelAt = 0
  private listening = new ListeningRecorder()
  private lastNodAt = 0
  private captureStartedAt = 0
  private boostReleaseTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.vad = new VadSegmenter({
      onSpeechStart: () => {
        this.captureIsBackchannel = false
        if (speechPlayer.isPlaying) this.beginOverlap()
        this.captureStartedAt = performance.now()
        this.lastPartial = ''
        this.listening.reset()
        this.startPartialLoop()
        this.settleState()
      },
      onLevel: (rms) => {
        this.events.emit('level', Math.min(1, rms * 12))
        this.maybeConfirmBargein()
        this.maybeBackchannel()
      },
      onSpeechEnd: (utterance) => this.endCapture(utterance)
    })
    this.vad.speechProbProvider = () => this.silero.currentProb()
    this.vad.eotProvider = () => (this.vapFresh() ? this.vapState!.eotUser : null)
    this.vad.holdProvider = () => this.holdProvider?.() ?? false
    speechPlayer.onOutputSamples = (samples) => {
      if (this.usesMaai() && this.state !== 'off') {
        this.vapAudio.pushAssistant(samples, speechPlayer.outputSampleRate)
      } else {
        this.vapAudio.clearAssistant()
      }
    }
    speechPlayer.events.on('segmentstart', ({ segment }) => {
      if (this.boostReleaseTimer) clearTimeout(this.boostReleaseTimer)
      this.boostReleaseTimer = null
      // Chromium's echo canceller lets echo through, so the threshold rises during playback.
      // Native capture through Apple's VPIO cancels the echo in the OS and attenuates the
      // microphone further during double talk, so a boost on top of that would put an
      // interrupting voice out of reach of the threshold.
      this.vad.thresholdBoost = this.nativeActive ? 1 : 3
      // The listening aizuchi answers the capture in progress. Muting would throw that capture
      // away, and it is not the assistant taking the floor either.
      if (segment.clip === 'listening') return
      if (!this.bargeIn) this.vad.muted = true
      // A reply that starts while the user is already speaking overlaps the voice just as a voice
      // that starts during the reply does.
      else if (this.vad.isSpeaking) this.beginOverlap()
    })
    // Reverberation and the tail of the echo linger in the microphone just after playback ends,
    // so the normal threshold returns only after a wait.
    speechPlayer.events.on('idle', () => {
      if (this.boostReleaseTimer) clearTimeout(this.boostReleaseTimer)
      this.boostReleaseTimer = setTimeout(() => {
        this.boostReleaseTimer = null
        this.vad.thresholdBoost = 1
        this.vad.muted = false
      }, ECHO_TAIL_MS)
    })
  }

  get current(): VoiceState {
    return this.state
  }

  /**
   * Opens the decision on a voice that overlaps playback. Nothing stops at once: the voice has to
   * hold first, or an echo mistaken for speech would stop it. While the decision is open the volume
   * goes down, which both keeps the assistant off the user's words and makes the response feel
   * immediate. With barge-in off the user's voice never stops the assistant.
   */
  private beginOverlap(): void {
    if (!this.bargeIn || this.overlap !== 'none') return
    this.overlap = 'pending'
    // An aizuchi or bridge lasts about a second and sounds broken off if ducked. A real
    // interruption stops it once confirmed anyway.
    if (!speechPlayer.isPlayingClip) speechPlayer.duck()
  }

  /**
   * Sorts a voice that came in during playback into an aizuchi to let pass, an interruption to stop
   * for, or noise. Energy gives the immediate reaction within 250 ms, Silero's evidence of a human
   * voice is what refuses noise, and bc_det detects the aizuchi. While Silero is not ready
   * speechDuration equals voicedDuration, so noise is refused exactly as it was before Silero.
   */
  private maybeConfirmBargein(): void {
    if (this.overlap === 'none') return
    if (!speechPlayer.isPlaying || !this.vad.isSpeaking) {
      // Playback ended, or the capture was reset as noise. This continues as ordinary speech and
      // the volume comes back up.
      this.overlap = 'none'
      speechPlayer.unduck()
      return
    }
    const verdict = classifyOverlap({
      voicedMs: this.vad.voicedDuration,
      speechMs: this.vad.speechDuration,
      bcDet: this.vapFresh() ? this.vapState!.bcDetUser : null,
      confirmMs: this.bargeInConfirmMs,
      minSpeechMs: this.bargeInMinSpeechMs
    })
    if (verdict === 'bargein') {
      this.overlap = 'none'
      this.captureIsBackchannel = false
      // The event goes out while the interrupted reply is still playing, so that it is counted
      // against the turn being read before the stop closes that turn's measurements.
      this.events.emit('bargein')
      speechPlayer.interrupt()
      return
    }
    if (this.overlap === 'backchannel') return
    if (verdict === 'backchannel') {
      // An aizuchi: the reading continues, the volume comes back up, and this capture is not
      // transcribed.
      this.overlap = 'backchannel'
      this.captureIsBackchannel = true
      speechPlayer.unduck()
      this.events.emit('userBackchannel')
      return
    }
    // Noise: the volume comes back up early, so playback spends as little time as possible
    // quietening on its own.
    if (verdict === 'noise') {
      this.overlap = 'none'
      speechPlayer.unduck()
    }
  }

  /** Fires an aizuchi at a break in a long utterance. conversation plays it. */
  private maybeBackchannel(): void {
    if (!this.listeningAizuchi || !conversationFeatures(this.conversationLocale).aizuchi) return
    // A capture that is only noise gets no aizuchi; a human voice has to be confirmed first.
    if (!this.vad.speechConfirmed) return
    // A voice returning after an aizuchi means it landed on a pause inside a sentence.
    if (this.vad.isSpeaking && this.vad.silenceDuration === 0) this.listening.voiced()
    const now = performance.now()
    const decision = shouldBackchannel({
      userSpeaking: this.vad.isSpeaking,
      assistantSpeaking: speechPlayer.isPlaying,
      silenceMs: this.vad.silenceDuration,
      utteranceMs: this.vad.utteranceDuration,
      partialText: this.lastPartial,
      msSinceLast: now - this.lastBackchannelAt,
      vap: this.vapFresh()
        ? {
            eotUser: this.vapState!.eotUser,
            bcReact: this.vapState!.bcReact,
            bcEmo: this.vapState!.bcEmo
          }
        : null
    })
    if (decision) {
      this.lastBackchannelAt = now
      this.listening.fired(decision, now - this.captureStartedAt)
      this.events.emit('backchannel', decision)
    }
  }

  /** Decides on a nod each time the nod model's estimate arrives, once per frame. Orb plays it. */
  private maybeNod(): void {
    if (!this.vad.speechConfirmed) return
    const now = performance.now()
    const kind = shouldNod({
      userSpeaking: this.vad.isSpeaking,
      assistantSpeaking: speechPlayer.isPlaying,
      nod: this.vapFresh()
        ? { short: this.vapState!.nodShort, long: this.vapState!.nodLong }
        : null,
      msSinceLast: now - this.lastNodAt
    })
    if (kind) {
      this.lastNodAt = now
      this.events.emit('nod', kind)
    }
  }

  /** Milliseconds since the last aizuchi, which keeps the turn's opening aizuchi from doubling up. */
  get msSinceBackchannel(): number {
    return performance.now() - this.lastBackchannelAt
  }

  /** Whether MaAI takes part in this conversation: its four models are trained on Japanese. */
  private usesMaai(): boolean {
    return this.vapEnabled && conversationFeatures(this.conversationLocale).maai
  }

  /** Whether the newest VAP estimate can be used. A stopped or backed-up worker leaves it stale. */
  private vapFresh(): boolean {
    return (
      this.usesMaai() && this.vapState !== null && performance.now() - this.vapStateAt < VAP_STALE_MS
    )
  }

  setHangover(ms: number): void {
    this.vad.hangoverMs = Math.max(150, Math.min(1500, ms))
  }

  /**
   * Prepares the in-browser Whisper on an explicit request. Because it may fetch the model, enable
   * never calls it on its own while localFallbackEnabled is false.
   */
  async prepareLocalAsr(onProgress?: (info: AsrProgress) => void): Promise<string> {
    return this.asr.init((info) => {
      this.events.emit('progress', info.progress)
      onProgress?.(info)
    })
  }

  cancelLocalAsrPreparation(): void {
    this.asr.reset(errorText('speechRecognition.errors.preparationCancelled'))
  }

  async enable(): Promise<void> {
    if (this.state !== 'off') return
    const generation = ++this.captureGeneration
    const current = (): boolean => generation === this.captureGeneration
    this.setState('loading')
    // The model that tells noise from voice, about 2 MB and bundled with the app, loads while the
    // microphone is being prepared. A failure leaves ready false and the energy VAD running alone,
    // so nothing waits for it and nothing is refused over it.
    void this.silero.init()
    try {
      const permitted = await window.api.requestMicPermission()
      if (!current()) return
      if (!permitted) throw new Error(errorText(osMessageKey('voice.mic.notPermitted', platformCapabilities().os)))
      // With local ASR explicitly enabled, the UI must not sit for 15 seconds waiting for the
      // server. Local is chosen and prepared at once, and the move up to the server is attempted
      // after the microphone has started.
      let status = await window.api.getStatus()
      if (!status.asr && !this.localFallbackEnabled) {
        // Only when local has not been chosen does this wait for the more accurate server to start.
        for (let i = 0; i < 10 && !status.asr; i++) {
          await new Promise((r) => setTimeout(r, 1500))
          if (!current()) return
          status = await window.api.getStatus()
        }
      }
      if (!current()) return
      if (!status.asr && !this.localFallbackEnabled) {
        throw new Error(errorText('speechRecognition.errors.serverUnavailable'))
      }
      this.backend = status.asr ? 'server' : 'local'
      console.log(`ASR backend: ${this.backend}`)
      if (this.backend === 'local') {
        await this.prepareLocalAsr()
        if (!current()) return
      }
      // The VAP worker is resident: it is started here and turning the microphone off leaves it running.
      if (this.usesMaai()) {
        this.vapUnsubscribe ??= window.api.onVapState((state) => {
          this.vapState = state
          this.vapStateAt = performance.now()
          this.maybeNod()
        })
        void window.api.vapStart().catch(() => {})
      }
      const feed = (frame: Float32Array): void => {
        this.silero.push(frame)
        this.vad.push(frame)
        if (this.usesMaai()) this.vapAudio.pushUser(frame)
      }
      this.nativeActive = false
      if (this.nativeMicPreferred) {
        const nativeActive = await this.startNativeCapture(feed)
        if (!current()) return
        this.nativeActive = nativeActive
      }
      if (!this.nativeActive) {
        // A microphone that goes away is looked for again, as when the native helper dies; with
        // none left, enable fails and reports it.
        await this.mic.start(feed, () => void this.recover())
        // Each start releases its own resources. Calling the shared stop from an older start
        // would also stop a recording that an off-then-on cycle has already begun.
        if (!current()) return
      }
      this.settleState()
      if (this.backend === 'local') void this.probeUpgrade()
    } catch (err) {
      if (!current()) return
      this.events.emit('error', displayError(err))
      this.disable()
    }
  }

  /**
   * Tries to capture through macOS voice processing. On success the 48 kHz frames go to 16 kHz,
   * through DeepFilterNet first where the settings ask for it, and on to feed. If it cannot start
   * it returns false and the caller switches to getUserMedia.
   */
  private async startNativeCapture(feed: (frame: Float32Array) => void): Promise<boolean> {
    if (typeof window.api.micNativeStart !== 'function') return false
    const resampler = new StreamResampler(48_000, 16_000)
    const deliver = (chunk: Float32Array): void => {
      const frame = resampler.process(chunk)
      if (frame.length > 0) feed(frame)
    }
    let pipeline: (frame: Float32Array) => void = deliver
    if (this.noiseSuppression) {
      // Until the model has loaded, and if it fails, the audio arrives unsuppressed.
      void this.dfn.init()
      this.dfn.reset()
      this.dfn.onOutput = deliver
      pipeline = (frame) => this.dfn.push(frame)
    }
    // A helper that dies rebuilds capture: native is tried again, and getUserMedia takes over if
    // that fails.
    return this.nativeMic.start(pipeline, () => void this.recover())
  }

  /** Moves up to the server if it comes up later, even while local is in use. */
  private async probeUpgrade(): Promise<void> {
    if (this.backend === 'server') return
    try {
      const status = await window.api.getStatus()
      if (status.asr) {
        this.handleAsrStatus(true)
      }
    } catch {
      /* keep local */
    }
  }

  disable(): void {
    this.captureGeneration++
    const serverRequests = [...this.serverRequests]
    this.serverRequests.clear()
    for (const requestId of serverRequests) {
      void window.api.transcribeCancel(requestId).catch(() => {})
    }
    // Detaching the chain keeps a new generation's final transcription out of the queue of an
    // aborted one.
    this.transcriptionTail = Promise.resolve()
    const dropped = [...this.awaitingTranscript]
    this.awaitingTranscript.clear()
    this.stopPartialLoop()
    this.overlap = 'none'
    this.captureIsBackchannel = false
    speechPlayer.unduck()
    this.nativeMic.stop()
    this.dfn.dispose()
    this.nativeActive = false
    this.vapAudio.reset()
    this.vapState = null
    this.mic.stop()
    this.vad.reset()
    this.silero.dispose()
    if (this.backend === 'local' || this.localWorkInFlight > 0) {
      this.asr.reset(errorText('speechRecognition.errors.stoppedWithMic'))
    }
    for (const startedAt of dropped) this.events.emit('speechdropped', { startedAt })
    this.setState('off')
  }

  /**
   * Applies what the service watchdog reports. Recovery goes straight back to the server, and a
   * stop sends the next final transcription to local, or to an explicit configuration error.
   */
  handleAsrStatus(available: boolean): void {
    if (available) {
      if (this.backend !== 'server') console.log('ASR backend upgraded: local → server')
      this.backend = 'server'
      return
    }
    if (this.backend === 'server') {
      this.backend = 'local'
      this.stopPartialLoop()
      console.warn('ASR server unavailable; next utterance will use configured recovery path')
    }
  }

  /**
   * Builds capture again after the machine sleeps and wakes or the input device changes. If the
   * microphone was off, it asks for no permission and only checks whether the backend can move up.
   */
  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    const wasEnabled = this.state !== 'off'
    const recovery = (async () => {
      if (!wasEnabled) {
        await this.probeUpgrade()
        return
      }

      this.disable()
      await this.enable()
    })()
    this.recoveryPromise = recovery.finally(() => {
      this.recoveryPromise = null
    })
    return this.recoveryPromise
  }

  private startPartialLoop(): void {
    // The in-browser Whisper is too slow to transcribe partials.
    if (this.backend !== 'server' || this.partialIntervalMs <= 0) return
    this.stopPartialLoop()
    this.partialTimer = setInterval(() => void this.partialTick(), this.partialIntervalMs)
  }

  private stopPartialLoop(): void {
    if (this.partialTimer) clearInterval(this.partialTimer)
    this.partialTimer = null
    this.partialRequestGeneration++
    this.partialInflight = false
  }

  private async partialTick(): Promise<void> {
    if (this.partialInflight) return
    // A capture that is only noise does not run through Whisper.
    if (!this.vad.speechConfirmed) return
    // The last 5 seconds keep a partial transcription cheap however long the utterance runs, so it
    // does not compete with the final one.
    const samples = this.vad.snapshot(5000)
    if (!samples) return
    const captureGeneration = this.captureGeneration
    const captureStartedAt = this.captureStartedAt
    const requestGeneration = ++this.partialRequestGeneration
    this.partialInflight = true
    try {
      const text = (await window.api.transcribePartial(this.normalize(samples))).trim()
      if (
        requestGeneration === this.partialRequestGeneration &&
        captureGeneration === this.captureGeneration &&
        captureStartedAt === this.captureStartedAt &&
        text &&
        this.vad.isSpeaking &&
        isMeaningfulTranscript(text, this.conversationLocale)
      ) {
        this.lastPartial = text
        this.events.emit('partial', text)
      }
    } catch {
      /* The request is speculative, so the failure is swallowed. */
    } finally {
      if (requestGeneration === this.partialRequestGeneration) this.partialInflight = false
    }
  }

  private normalize(samples: Float32Array): Float32Array {
    let peak = 0
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
    if (peak < 1e-4 || peak >= 0.9) return samples
    const gain = 0.9 / peak
    const out = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
    return out
  }

  /** Every capture ends here, with the utterance the VAD kept, or with nothing when it was noise or the VAD was muted. */
  private endCapture(utterance: VadUtterance | null): void {
    this.stopPartialLoop()
    if (this.overlap !== 'none') {
      this.overlap = 'none'
      speechPlayer.unduck()
    }
    const backchannel = this.captureIsBackchannel
    this.captureIsBackchannel = false
    // A "うん" or "はい" during the reading was let pass as an aizuchi, so it becomes neither a turn
    // nor a transcript.
    if (utterance && !backchannel) this.enqueueUtterance(utterance.samples, utterance.vadMs, utterance.mode)
    this.settleState()
  }

  private enqueueUtterance(samples: Float32Array, vadMs: number, vadMode: HangoverMode): void {
    const generation = this.captureGeneration
    const startedAt = this.captureStartedAt
    const partialText = this.lastPartial
    const speechEndAt = performance.now() - vadMs
    this.events.emit('speechend', {
      startedAt,
      speechEndAt,
      vadMs,
      vadMode,
      partialText,
      utteranceMs: Math.max(0, Math.round(samples.length / 16) - vadMs),
      listening: this.listening.take()
    })
    this.awaitingTranscript.add(startedAt)
    const previous = this.transcriptionTail.catch(() => {})
    const completion = previous.then(() =>
      this.handleUtterance(samples, vadMs, vadMode, generation, startedAt, partialText, speechEndAt)
    )
    // handleUtterance turns a failure into a UI event. Should an exception ever escape it, it must
    // still not become an unhandled rejection or stop the transcriptions behind it.
    this.transcriptionTail = completion.catch(() => {})
  }

  private async handleUtterance(
    samples: Float32Array,
    vadMs: number,
    vadMode: HangoverMode,
    generation: number,
    startedAt: number,
    partialText: string,
    speechEndAt: number
  ): Promise<void> {
    // disable has already reported the speeches of the generation it ended as dropped.
    if (generation !== this.captureGeneration) return
    const t0 = performance.now()
    let heard = false
    try {
      const audio = this.normalize(samples)
      const text = await this.transcribeWithRecovery(
        audio,
        () => generation === this.captureGeneration
      )
      if (generation !== this.captureGeneration) return
      const asrMs = Math.round(performance.now() - t0)
      if (isMeaningfulTranscript(text, this.conversationLocale)) {
        heard = true
        this.events.emit('utterance', {
          text: text.trim(),
          vadMs,
          vadMode,
          asrMs,
          partialText,
          startedAt,
          speechEndAt
        })
      }
    } catch (err) {
      if (generation === this.captureGeneration) {
        this.events.emit('error', displayError(err))
      }
    } finally {
      if (generation === this.captureGeneration) {
        this.awaitingTranscript.delete(startedAt)
        if (!heard) this.events.emit('speechdropped', { startedAt })
        this.settleState()
        void this.probeUpgrade()
      }
    }
  }

  private async transcribeWithRecovery(
    audio: Float32Array,
    isCurrent: () => boolean = () => true
  ): Promise<string> {
    const ensureCurrent = (): void => {
      if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
    }
    ensureCurrent()
    if (this.backend === 'local') {
      if (!this.localFallbackEnabled) {
        throw new Error(errorText('speechRecognition.errors.serverStopped'))
      }
      return this.transcribeLocalWithRetry(audio, isCurrent)
    }

    try {
      const requestId = crypto.randomUUID()
      this.serverRequests.add(requestId)
      try {
        const text = await window.api.transcribe(audio, requestId)
        ensureCurrent()
        return text
      } finally {
        this.serverRequests.delete(requestId)
      }
    } catch (serverError) {
      ensureCurrent()
      if (!this.localFallbackEnabled) {
        throw new Error(errorText('speechRecognition.errors.serverTranscribeFailed', { detail: errorMessageOf(serverError) }))
      }

      // A server that dies after accepting the utterance hands the same audio to local, once.
      this.backend = 'local'
      this.stopPartialLoop()
      return this.transcribeLocalWithRetry(audio, isCurrent)
    }
  }

  private async transcribeLocalWithRetry(
    audio: Float32Array,
    isCurrent: () => boolean
  ): Promise<string> {
    this.localWorkInFlight++
    try {
      let firstError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
        try {
          await this.prepareLocalAsr()
          if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
          return await this.asr.transcribe(audio, whisperLanguageName(conversationLocale()))
        } catch (error) {
          if (!isCurrent()) throw error
          if (attempt === 1) {
            console.error('local ASR failed twice:', firstError, error)
            throw new Error(errorText('speechRecognition.errors.localRecoveryFailed'))
          }
          firstError = error
          this.asr.reset(errorText('speechRecognition.errors.retryingAfterFailure'))
        }
      }
      throw new Error(errorText('speechRecognition.errors.localRecoveryFailed'))
    } finally {
      this.localWorkInFlight--
    }
  }

  /**
   * Listening, capturing and transcribing follow from what is under way: a capture in progress, then
   * a transcript still awaited. Only enable and disable move the state to loading and off.
   */
  private settleState(): void {
    if (this.state === 'off') return
    this.setState(
      this.vad.isSpeaking ? 'capturing' : this.awaitingTranscript.size > 0 ? 'transcribing' : 'listening'
    )
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return
    this.state = next
    this.events.emit('state', next)
  }
}

export const voiceController = new VoiceController()
