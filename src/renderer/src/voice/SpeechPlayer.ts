import mitt, { type Emitter } from 'mitt'
import type { ClipRole, SpeechSegment } from '@shared/ipc'
import { speechTag } from '@shared/conversation-locale'
import { estimateSpeechMs } from '@shared/speech-rate'
import { conversationLocale } from '@/conversation-locale'
import { PcmScheduler } from './pcm-scheduler'
import { isAnswerSegment } from './answer-segment'
import { SegmentStream } from './segment-stream'
import { pauseAfter } from './sentence-pause'

type SpeechEvents = {
  /** A segment has actually started playing. durationMs is the audio's length, estimated from the character count for Web Speech. */
  segmentstart: { segment: SpeechSegment; durationMs: number }
  /** The queue emptied and speech ended. turnId is the last turn that was accepted. */
  idle: { turnId: number }
  /** The live model's audio started playing, or broke off and stopped. */
  streamstart: undefined
  streamidle: undefined
}

/** The lead before live audio starts playing, which absorbs the tens of milliseconds of jitter in how the chunks arrive. */
const STREAM_LEAD_S = 0.12
/** Without a next chunk for this long, the stream counts as stopped. */
const STREAM_IDLE_MS = 400

/** The volume while a barge-in is waiting to be confirmed. A false detection restores it. */
const DUCK_LEVEL = 0.25
/** The ducking time constant in seconds: fast, but not so abrupt that it clicks. */
const DUCK_RAMP_S = 0.03
const OUTPUT_RESUME_TIMEOUT_MS = 5_000
const DECODE_TIMEOUT_MS = 15_000
const MIN_PLAYBACK_TIMEOUT_MS = 8_000
const PLAYBACK_GRACE_MS = 5_000
/** The speed of the system voice, where 1 is the voice's own rate. */
const FALLBACK_RATE = 1.1
/**
 * Japanese read by the system voice at that rate, measured per character. A language written in
 * letters is estimated from a speaking rate instead (shared/speech-rate.ts), which leaves it about a
 * tenth long here, because that estimate is for the normal rate.
 */
const FALLBACK_MS_PER_SYLLABLE = 140

/**
 * The playback queue of speech segments. The turn id acts as a generation, so segments of an older
 * turn are dropped, and the output level for the orb comes from here.
 *
 * The WebAudio graph plays out through a MediaStreamAudioDestinationNode into an <audio> element.
 * Chromium's echo canceller, the echoCancellation of getUserMedia, does not take WebAudio's direct
 * output at ctx.destination into its reference signal, so played straight out the assistant's own
 * speech is never cancelled from the microphone. Going through the <audio> element puts it in the
 * reference signal, which keeps the echo out acoustically when speakers are in use.
 */
export class SpeechPlayer {
  readonly events: Emitter<SpeechEvents> = mitt<SpeechEvents>()

  private readonly ctx = new AudioContext()
  private readonly analyser = this.ctx.createAnalyser()
  private readonly masterGain = this.ctx.createGain()
  private readonly audioEl = new Audio()
  private readonly levelBuf: Uint8Array<ArrayBuffer>
  private queue: SpeechSegment[] = []
  private playing = false
  private ducked = false
  private sourceNode: AudioBufferSourceNode | null = null
  private sourceWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Lets interrupt and recover fail a wait on resume, play or decode. */
  private pendingStageCancel: ((error: Error) => void) | null = null
  private currentTurn = -1
  /** When a sentence of the answer was last queued. It tells whether the bridge beat the answer. */
  private bodyQueuedAt = -Infinity
  /** A decode or Web Speech callback that began before an interrupt belongs to an older generation and is ignored. */
  private playbackGeneration = 0
  private fallbackActive = false
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackFinish: (() => void) | null = null
  private fallbackUtterance: SpeechSynthesisUtterance | null = null
  /** The segment playing and what the karaoke subtitle computes its progress from. A streamed segment's length settles while it plays. */
  private current: { segment: SpeechSegment; startedAt: number; durationMs: number; stream?: SegmentStream } | null = null
  /** The piece of an answer that played last and when it ended, which decides the pause before the next piece of the same answer. */
  private lastAnswer: { turnId: number; text: string; endedAt: number } | null = null
  /** A segment waiting on a decode or on the output resuming, which is not yet audible. */
  private starting: SpeechSegment | null = null
  /** The audio of the streamed segments that are queued, starting or playing. A segment dropped from the queue takes its audio with it. */
  private readonly segmentStreams = new WeakMap<SpeechSegment, SegmentStream>()
  private activeSegmentStream: SegmentStream | null = null
  private readonly liveScheduler = new PcmScheduler(this.ctx, this.analyser)
  private streaming = false
  private streamIdleTimer: ReturnType<typeof setTimeout> | null = null
  private streamGeneration = 0
  /**
   * The live chunks wait for the output here one after another. play() marks the <audio> element as
   * playing at once and settles its promise in a later task, so a chunk that arrived meanwhile would
   * find nothing to wait for and be scheduled ahead of the one before it.
   */
  private streamOutput: Promise<void> = Promise.resolve()

  constructor() {
    this.analyser.fftSize = 512
    const dest = this.ctx.createMediaStreamDestination()
    this.analyser.connect(this.masterGain)
    this.masterGain.connect(dest)
    this.audioEl.srcObject = dest.stream
    this.audioEl.autoplay = true
    this.levelBuf = new Uint8Array(this.analyser.fftSize)
    // The output tap feeds the VAP's assistant channel. A failure here does not affect playback.
    void this.initOutputTap()
  }

  /**
   * Receives the waveform actually being played, for the VAP's channel 1. The samples arrive at the
   * volume after ducking, at outputSampleRate.
   */
  onOutputSamples: ((samples: Float32Array) => void) | null = null

  get outputSampleRate(): number {
    return this.ctx.sampleRate
  }

  /** Taps the waveform after masterGain, what is actually played, through an AudioWorklet. */
  private async initOutputTap(): Promise<void> {
    const source = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel && channel.length > 0) {
      const copy = channel.slice(0)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('speech-tap', TapProcessor)
`
    try {
      const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
      try {
        await this.ctx.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
      const tap = new AudioWorkletNode(this.ctx, 'speech-tap')
      tap.port.onmessage = (event: MessageEvent<Float32Array>): void => {
        this.onOutputSamples?.(event.data)
      }
      this.masterGain.connect(tap)
    } catch (err) {
      console.warn('speech output tap unavailable:', err)
    }
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** True while live audio is playing or still scheduled. */
  get isStreaming(): boolean {
    return this.streaming
  }

  /**
   * Plays the live model's audio in the order it arrives. The first chunk is scheduled a little
   * ahead and every later one directly after the previous, and a chunk that arrives past its
   * scheduled time continues from that moment instead. The path is the same one synthesized speech
   * takes, analyser to masterGain to the <audio> element, so echo cancellation and the orb's level
   * work unchanged.
   */
  streamPush(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0 || this.ctx.state === 'closed') return
    const generation = this.streamGeneration
    this.streamOutput = this.streamOutput
      .then(() => this.withLocalTimeout(this.ensureOutput(), OUTPUT_RESUME_TIMEOUT_MS))
      .then(() => {
        if (generation !== this.streamGeneration) return
        this.liveScheduler.schedule(samples, sampleRate, this.streaming ? 0 : STREAM_LEAD_S)
        if (!this.streaming) {
          this.streaming = true
          this.events.emit('streamstart', undefined)
        }
        this.armStreamIdle(this.liveScheduler.remainingSeconds * 1000 + STREAM_IDLE_MS)
      })
      .catch((err) => console.error('live audio playback failed:', err))
  }

  /** Drops every scheduled chunk and stops, for an interrupt. */
  streamClear(): void {
    this.streamGeneration++
    this.liveScheduler.stop()
    this.finishStream()
  }

  private armStreamIdle(ms: number): void {
    if (this.streamIdleTimer) clearTimeout(this.streamIdleTimer)
    this.streamIdleTimer = setTimeout(() => {
      this.streamIdleTimer = null
      const remaining = this.liveScheduler.remainingSeconds
      if (remaining <= 0.01) this.finishStream()
      else this.armStreamIdle(remaining * 1000 + STREAM_IDLE_MS)
    }, ms)
  }

  private finishStream(): void {
    if (this.streamIdleTimer) clearTimeout(this.streamIdleTimer)
    this.streamIdleTimer = null
    if (!this.streaming) return
    this.streaming = false
    this.events.emit('streamidle', undefined)
  }

  /** Brings the output into a state where it can sound: the AudioContext resumed and the <audio> element playing. */
  private async ensureOutput(): Promise<void> {
    if (this.ctx.state === 'closed') throw new Error('AudioContext is closed')
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.audioEl.paused) await this.audioEl.play()
  }

  /** Whether what is playing, or about to start, is a single clip such as an aizuchi or a bridge. */
  get isPlayingClip(): boolean {
    const segment = this.current?.segment ?? this.starting
    return this.playing && segment !== null && segment.index === -1
  }

  /** The turn whose reply is sounding, or about to, or -1 while only a clip or nothing plays. */
  get readingTurn(): number {
    const segment = this.current?.segment ?? this.starting
    return this.playing && segment !== null && segment.index >= 0 ? segment.turnId : -1
  }

  /**
   * The text of the segment being read and how far through it is, from 0 to 1, for the karaoke
   * subtitle. An aizuchi clip, which has index -1, is not included.
   */
  karaoke(): { turnId: number; text: string; ratio: number } | null {
    if (!this.playing || !this.current || this.current.segment.index < 0) return null
    const { segment, startedAt, stream } = this.current
    const durationMs = stream ? stream.durationMs : this.current.durationMs
    const ratio = durationMs > 0 ? Math.min(1, (performance.now() - startedAt) / durationMs) : 1
    return { turnId: segment.turnId, text: segment.text, ratio }
  }

  /** The current output level, from 0 to 1, which drives the orb. */
  level(): number {
    if (!this.playing && !this.streaming) return 0
    if (this.fallbackActive) return 0.4 + 0.3 * Math.abs(Math.sin(performance.now() / 90))
    this.analyser.getByteTimeDomainData(this.levelBuf)
    let sum = 0
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128
      sum += v * v
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4)
  }

  /**
   * Starts accepting a new turn, normally keeping only the aizuchi clips, those with index -1. A
   * system report passes preserveQueued so that it is appended after the user's answer being read.
   */
  beginTurn(turnId: number, preserveQueued = false): void {
    this.currentTurn = turnId
    if (!preserveQueued) this.queue = this.queue.filter((s) => s.index === -1)
  }

  enqueue(segment: SpeechSegment): void {
    if (segment.turnId !== this.currentTurn) return
    if (isAnswerSegment(segment)) this.bodyQueuedAt = performance.now()
    if (segment.stream) this.segmentStreams.set(segment, new SegmentStream(segment.stream.sampleRate, segment.text))
    this.queue.push(segment)
    if (!this.playing) void this.playNext()
  }

  /** Receives the next samples of a streamed segment. Audio for a segment that was dropped in the meantime is ignored. */
  pushSegmentAudio(turnId: number, index: number, samples: Float32Array, last: boolean): void {
    const candidates = [this.current?.segment, this.starting, ...this.queue]
    const segment = candidates.find((s) => s?.turnId === turnId && s.index === index && s.stream)
    if (segment) this.segmentStreams.get(segment)?.push(samples, last)
  }

  /** Whether body text was queued after the given time. Aizuchi, bridges and work fillers do not count. */
  bodyQueuedAfter(time: number): boolean {
    return this.bodyQueuedAt > time
  }

  /**
   * Plays a single clip at once without interrupting anything. volume is what plays an aizuchi
   * quietly while the user speaks. A preview replaces only the previous preview, because pressing
   * the button means stopping the sample now playing and hearing the new one.
   */
  playClip(
    audioBase64: string | null,
    text: string,
    options: { role: ClipRole; volume?: number }
  ): SpeechSegment {
    if (options.role === 'preview') this.cancelPreview()
    const segment: SpeechSegment = {
      turnId: this.currentTurn,
      index: -1,
      text,
      audio: audioBase64,
      phonemes: null,
      clip: options.role,
      ...(options.volume !== undefined ? { volume: options.volume } : {})
    }
    this.enqueueRaw(segment)
    return segment
  }

  /** Drops a clip that still waits in the queue. One that has started plays to its end. */
  dropWaiting(segment: SpeechSegment): void {
    this.queue = this.queue.filter((s) => s !== segment)
  }

  /** Drops the preview playing and any preview waiting, leaving aizuchi and body segments alone. */
  private cancelPreview(): void {
    const rest = this.queue.filter((s) => s.clip !== 'preview')
    const current = this.current?.segment ?? this.starting
    if (current?.clip === 'preview') {
      this.stopPlayback()
      this.queue = rest
      if (rest.length > 0) void this.playNext()
      return
    }
    this.queue = rest
  }

  private enqueueRaw(segment: SpeechSegment): void {
    this.queue.push(segment)
    if (!this.playing) void this.playNext()
  }

  /**
   * Turns the volume down while a barge-in waits to be confirmed. Interrupting straight away would
   * chop the conversation up whenever a noise is mistaken for speech, so the volume drops first,
   * the voice is checked for how long it holds, and a real one then interrupts while a noise is
   * undone by unduck.
   */
  duck(): void {
    if (!this.playing || this.ducked) return
    this.ducked = true
    const t = this.ctx.currentTime
    this.masterGain.gain.cancelScheduledValues(t)
    this.masterGain.gain.setTargetAtTime(DUCK_LEVEL, t, DUCK_RAMP_S)
  }

  /** Restores the volume, after a false detection or when playback ends. */
  unduck(): void {
    if (!this.ducked) return
    this.ducked = false
    const t = this.ctx.currentTime
    this.masterGain.gain.cancelScheduledValues(t)
    this.masterGain.gain.setTargetAtTime(1, t, DUCK_RAMP_S)
  }

  /** Stops at once and drops the queue, for a barge-in. The idle it reports carries the turn that was stopped. */
  interrupt(): void {
    this.stopPlayback()
    this.currentTurn = -1
  }

  /**
   * Stops and drops the body segments, those with index 0 or above including work fillers, and lets
   * the single clips carry on. It is what new input uses to stop the previous turn being read: the
   * aizuchi that started at the end of speech belongs to that new input, so it keeps playing.
   */
  discardBody(): void {
    this.bodyQueuedAt = -Infinity
    const clips = this.queue.filter((s) => s.index === -1)
    if (this.isPlayingClip) {
      this.currentTurn = -1
      this.queue = clips
      return
    }
    this.stopPlayback()
    this.currentTurn = -1
    this.queue = clips
    if (clips.length > 0) void this.playNext()
  }

  private stopPlayback(): void {
    this.playbackGeneration++
    this.cancelPendingStage(new DOMException('speech playback was interrupted', 'AbortError'))
    this.queue = []
    this.current = null
    this.starting = null
    this.unduck()
    this.clearSourceWatchdog()
    this.activeSegmentStream?.stop()
    this.activeSegmentStream = null
    if (this.sourceNode) {
      this.sourceNode.onended = null
      try {
        this.sourceNode.stop()
      } catch {
        /* already stopped */
      }
      this.sourceNode = null
    }
    if (this.fallbackUtterance) {
      this.fallbackUtterance.onstart = null
      this.fallbackUtterance.onend = null
      this.fallbackUtterance.onerror = null
      this.fallbackUtterance = null
    }
    window.speechSynthesis?.cancel()
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
    this.fallbackFinish = null
    const wasPlaying = this.playing
    this.playing = false
    this.fallbackActive = false
    if (wasPlaying) this.events.emit('idle', { turnId: this.currentTurn })
  }

  private async playNext(generation = this.playbackGeneration): Promise<void> {
    if (generation !== this.playbackGeneration) return
    // What is still current here is the segment that just ended; a clip or a filler after an answer's piece breaks the pair.
    const ended = this.current?.segment
    if (ended) this.lastAnswer = isAnswerSegment(ended) ? { turnId: ended.turnId, text: ended.text, endedAt: performance.now() } : null
    const segment = this.queue.shift()
    if (!segment) {
      this.playing = false
      this.fallbackActive = false
      this.current = null
      this.starting = null
      this.unduck()
      this.events.emit('idle', { turnId: this.currentTurn })
      return
    }
    this.playing = true
    this.starting = segment
    // The time spent waiting for this piece's audio counts towards the pause.
    const previous = this.lastAnswer
    if (previous && isAnswerSegment(segment) && previous.turnId === segment.turnId) {
      const wait = pauseAfter(previous.text) - (performance.now() - previous.endedAt)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (generation !== this.playbackGeneration) return
    }

    if (segment.audio || segment.stream) {
      try {
        if (segment.stream) await this.playStreamed(segment, generation)
        else await this.playSynthesized(segment, generation)
        return
      } catch (err) {
        if (generation !== this.playbackGeneration) return
        console.error('audio playback failed:', err)
      }
    }
    // The system voice would read a listening aizuchi at full volume over the user, so it is skipped.
    if (segment.clip === 'listening') {
      void this.playNext(generation)
      return
    }
    this.playFallback(segment, generation)
  }

  private get outputRunning(): boolean {
    return this.ctx.state === 'running' && !this.audioEl.paused
  }

  /** Resumes the output for a queued segment. The waits can be failed by an interrupt, and false means the generation moved on meanwhile. */
  private async resumeOutput(generation: number): Promise<boolean> {
    if (this.ctx.state === 'closed') throw new Error('AudioContext is closed')
    if (this.ctx.state === 'suspended') {
      await this.waitForStage(
        this.ctx.resume(),
        OUTPUT_RESUME_TIMEOUT_MS,
        'the AudioContext did not resume'
      )
    }
    if (generation !== this.playbackGeneration) return false
    if (this.audioEl.paused) {
      await this.waitForStage(
        this.audioEl.play(),
        OUTPUT_RESUME_TIMEOUT_MS,
        'the audio output did not start'
      )
    }
    return generation === this.playbackGeneration
  }

  /** The node a segment plays into, which carries the segment's own volume. */
  private segmentDestination(segment: SpeechSegment): AudioNode {
    if (segment.volume == null || segment.volume >= 1) return this.analyser
    const gain = this.ctx.createGain()
    gain.gain.value = segment.volume
    gain.connect(this.analyser)
    return gain
  }

  private async playStreamed(segment: SpeechSegment, generation: number): Promise<void> {
    const stream = this.segmentStreams.get(segment)
    if (!stream) throw new Error('streamed segment has no audio')
    if (!this.outputRunning && !(await this.resumeOutput(generation))) return
    this.fallbackActive = false
    this.activeSegmentStream = stream
    stream.start(this.ctx, this.segmentDestination(segment), {
      onStarted: () => {
        this.current = { segment, startedAt: performance.now(), durationMs: stream.durationMs, stream }
        this.starting = null
        this.events.emit('segmentstart', { segment, durationMs: stream.durationMs })
      },
      onFinished: () => {
        if (generation !== this.playbackGeneration) return
        this.activeSegmentStream = null
        void this.playNext(generation)
      }
    })
  }

  private async playSynthesized(segment: SpeechSegment, generation: number): Promise<void> {
    if (!this.outputRunning && !(await this.resumeOutput(generation))) return
    const bytes = Uint8Array.from(atob(segment.audio!), (c) => c.charCodeAt(0))
    const buffer = await this.waitForStage(
      this.ctx.decodeAudioData(bytes.buffer),
      DECODE_TIMEOUT_MS,
      'decoding the synthesized audio did not finish'
    )
    if (generation !== this.playbackGeneration) return
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      if (generation !== this.playbackGeneration) return
      this.clearSourceWatchdog()
      if (this.sourceNode === source) this.sourceNode = null
      void this.playNext(generation)
    }
    source.onended = finish
    source.connect(this.segmentDestination(segment))
    this.fallbackActive = false
    this.sourceNode = source
    this.current = { segment, startedAt: performance.now(), durationMs: buffer.duration * 1000 }
    this.starting = null
    try {
      source.start()
    } catch (error) {
      source.onended = null
      if (this.sourceNode === source) this.sourceNode = null
      this.current = null
      throw error
    }
    // Sleep or a device change can swallow onended, which must not stall the rest of the queue forever.
    this.sourceWatchdog = setTimeout(() => {
      if (generation !== this.playbackGeneration || this.sourceNode !== source) return
      source.onended = null
      try {
        source.stop()
      } catch {
        // The source has already stopped.
      }
      finish()
    }, Math.max(MIN_PLAYBACK_TIMEOUT_MS, buffer.duration * 1000 + PLAYBACK_GRACE_MS))
    this.events.emit('segmentstart', { segment, durationMs: buffer.duration * 1000 })
  }

  /** Falls back to the operating system's speech synthesis. */
  private playFallback(segment: SpeechSegment, generation: number): void {
    if (generation !== this.playbackGeneration) return
    const text = segment.text
    this.fallbackActive = true
    // Web Speech's progress API is unreliable, so progress is estimated from the text.
    const durationMs = estimateSpeechMs(text, FALLBACK_MS_PER_SYLLABLE)
    this.current = { segment, startedAt: performance.now(), durationMs }
    this.starting = null
    if (window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = speechTag(conversationLocale())
      utterance.rate = FALLBACK_RATE
      let finished = false
      let started = false
      const finish = (): void => {
        if (finished || generation !== this.playbackGeneration) return
        finished = true
        if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
        this.fallbackTimer = null
        this.fallbackFinish = null
        if (this.fallbackUtterance === utterance) this.fallbackUtterance = null
        void this.playNext(generation)
      }
      this.fallbackFinish = finish
      this.fallbackUtterance = utterance
      utterance.onstart = (): void => {
        if (
          started ||
          generation !== this.playbackGeneration ||
          this.fallbackUtterance !== utterance
        ) return
        started = true
        this.events.emit('segmentstart', { segment, durationMs })
      }
      utterance.onend = finish
      utterance.onerror = finish
      // Web Speech can return neither end nor error across sleep and wake or when the voice service stops.
      this.fallbackTimer = setTimeout(finish, Math.max(8_000, text.length * 220 + 5_000))
      try {
        speechSynthesis.speak(utterance)
      } catch (error) {
        console.error('system speech playback failed:', error)
        finish()
      }
    } else {
      const finish = (): void => {
        if (generation !== this.playbackGeneration) return
        this.fallbackTimer = null
        this.fallbackFinish = null
        void this.playNext(generation)
      }
      this.fallbackFinish = finish
      this.fallbackTimer = setTimeout(finish, Math.max(1, text.length * 120))
    }
  }

  /** Clears the stalled state of the AudioContext and Web Speech after the machine sleeps and wakes. */
  recover(): void {
    const generation = this.playbackGeneration
    // A decode, resume or play that has hung has its wait failed, which moves playNext on to Web Speech.
    if (this.playing && !this.sourceNode && !this.fallbackActive) {
      this.cancelPendingStage(new Error('falling back to recover the audio output'))
    }
    if (this.sourceNode && this.current && !this.fallbackActive) {
      const segment = this.current.segment
      const recoverOutput = async (): Promise<void> => {
        if (this.ctx.state === 'closed') throw new Error('AudioContext is closed')
        if (this.ctx.state === 'suspended') {
          await this.withLocalTimeout(this.ctx.resume(), OUTPUT_RESUME_TIMEOUT_MS)
        }
        if (this.audioEl.paused) {
          await this.withLocalTimeout(this.audioEl.play(), OUTPUT_RESUME_TIMEOUT_MS)
        }
      }
      void recoverOutput().catch(() => {
        if (generation !== this.playbackGeneration || this.current?.segment !== segment) return
        this.failSourceToFallback(segment, generation)
      })
    } else {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      if (this.audioEl.paused) void this.audioEl.play().catch(() => {})
    }
    if (!this.fallbackActive || !window.speechSynthesis) return
    if (window.speechSynthesis.paused) window.speechSynthesis.resume()
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      this.fallbackFinish?.()
    }
  }

  private waitForStage<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (this.pendingStageCancel === cancel) this.pendingStageCancel = null
        callback()
      }
      const timeout = setTimeout(
        () => finish(() => reject(new Error(`${message} (${timeoutMs}ms)`))),
        timeoutMs
      )
      const cancel = (error: Error): void => finish(() => reject(error))
      this.pendingStageCancel = cancel
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) =>
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      )
    })
  }

  private cancelPendingStage(error: Error): void {
    this.pendingStageCancel?.(error)
  }

  private clearSourceWatchdog(): void {
    if (this.sourceWatchdog) clearTimeout(this.sourceWatchdog)
    this.sourceWatchdog = null
  }

  private failSourceToFallback(segment: SpeechSegment, generation: number): void {
    const source = this.sourceNode
    this.clearSourceWatchdog()
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // The source has already stopped.
      }
    }
    this.sourceNode = null
    this.current = null
    this.playFallback(segment, generation)
  }

  private withLocalTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('audio recovery timed out')), timeoutMs)
      promise.then(
        (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        }
      )
    })
  }
}

export const speechPlayer = new SpeechPlayer()
