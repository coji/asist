import { StreamResampler } from './MicCapture'

/** MaAI runs inference on 16 kHz audio every 80 ms. */
const FRAME_SAMPLES = 1_280
/**
 * The largest microphone chunk the played audio waits for: the native helper's AVAudioNode tap hands over
 * 100 to 400 ms at a time, the supported range of its buffer size.
 */
const USER_CHUNK_MAX_SAMPLES = 6_400
/**
 * Room for the jitter between the output tap's deliveries and the microphone's. On 2026-10-02 a simulation of
 * 30 s of the tap's 128-sample render quanta against microphone chunks of 10, 21, 100 and 300 ms, each up to
 * 10 ms early or late, lost no played audio with this much and lost some in every case of 10 and 21 ms
 * chunks without it.
 */
const JITTER_SAMPLES = 320

/** Aligns the microphone and the audio actually being played into the equal-length frames MaAI expects. */
export class VapAudio {
  private assistantChunks: Float32Array[] = []
  private assistantSamples = 0
  private resampler: StreamResampler | null = null
  private userChunks: Float32Array[] = []
  private userSamples = 0
  private largestUserChunk = 0

  constructor(private readonly emit: (user: Float32Array, assistant: Float32Array) => void) {}

  /**
   * The played audio kept for the microphone frames still to come. The output tap delivers continuously
   * while the microphone hands over a chunk at a time, so between two chunks a frame and a chunk of played
   * audio can wait; a backlog beyond that, such as a reply played while the microphone was starting, would
   * pair every later frame with audio that much older, for as long as the reply goes on.
   */
  private get assistantAllowance(): number {
    return FRAME_SAMPLES + this.largestUserChunk + JITTER_SAMPLES
  }

  pushAssistant(samples: Float32Array, sampleRate: number): void {
    this.resampler ??= new StreamResampler(sampleRate, 16_000)
    const frame = this.resampler.process(samples)
    if (frame.length === 0) return
    this.assistantChunks.push(frame)
    this.assistantSamples += frame.length
    while (this.assistantSamples > this.assistantAllowance && this.assistantChunks.length > 0) {
      this.assistantSamples -= this.assistantChunks.shift()!.length
    }
  }

  /** The microphone frames must already be 16 kHz. Each time 80 ms is complete it is emitted with the played audio. */
  pushUser(frame: Float32Array): void {
    this.largestUserChunk = Math.max(this.largestUserChunk, Math.min(frame.length, USER_CHUNK_MAX_SAMPLES))
    this.userChunks.push(frame)
    this.userSamples += frame.length
    while (this.userSamples >= FRAME_SAMPLES) {
      const user = takeSamples(this.userChunks, FRAME_SAMPLES)
      this.userSamples -= FRAME_SAMPLES
      // Where no played audio is available, the rest of the frame stays silent.
      const assistant = new Float32Array(FRAME_SAMPLES)
      const available = Math.min(this.assistantSamples, FRAME_SAMPLES)
      if (available > 0) {
        assistant.set(takeSamples(this.assistantChunks, available))
        this.assistantSamples -= available
      }
      this.emit(user, assistant)
    }
  }

  clearAssistant(): void {
    this.assistantChunks = []
    this.assistantSamples = 0
    this.resampler = null
  }

  reset(): void {
    this.userChunks = []
    this.userSamples = 0
    this.largestUserChunk = 0
    this.clearAssistant()
  }
}

/** Takes the requested number of samples off the front of the chunks and leaves the remainder for the next frame. */
function takeSamples(chunks: Float32Array[], count: number): Float32Array {
  const out = new Float32Array(count)
  let offset = 0
  while (offset < count && chunks.length > 0) {
    const head = chunks[0]
    const take = Math.min(head.length, count - offset)
    out.set(head.subarray(0, take), offset)
    if (take === head.length) chunks.shift()
    else chunks[0] = head.subarray(take)
    offset += take
  }
  return out
}
