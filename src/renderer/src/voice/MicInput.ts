import { StreamResampler } from '@shared/pcm'
import { MicCapture } from './MicCapture'
import { NativeMicSource } from './NativeMic'
import { DfnDenoiser } from './DfnDenoiser'

/**
 * The microphone as 16 kHz mono frames, for the voice pipeline and for the live engines alike. The
 * native helper, which cancels the echo in the OS, is tried first when the caller asks for it, and
 * getUserMedia takes over when it cannot start. DeepFilterNet works on the helper's 48 kHz audio only;
 * getUserMedia brings Chromium's own noise suppression.
 */

const NATIVE_SAMPLE_RATE = 48_000
const TARGET_SAMPLE_RATE = 16_000

export interface MicInputOptions {
  /** Whether to try the native helper. The caller takes it from the settings and the platform capabilities. */
  native: boolean
  /** DeepFilterNet on the native helper's audio. Until the model has loaded, and if it fails, the audio arrives unsuppressed. */
  noiseSuppression: boolean
}

export class MicInput {
  private mic = new MicCapture()
  private nativeMic = new NativeMicSource()
  private dfn = new DfnDenoiser()
  private generation = 0
  private nativeRunning = false

  /** Whether the frames come from the native helper, whose echo cancellation also attenuates the microphone during double talk. */
  get native(): boolean {
    return this.nativeRunning
  }

  /**
   * onLost is called when the source stops delivering, because the native helper died or the device
   * went away; the caller builds capture again. A stop while this runs leaves nothing started. It
   * throws only when getUserMedia fails.
   */
  async start(options: MicInputOptions, onFrame: (frame: Float32Array) => void, onLost: () => void): Promise<void> {
    const generation = this.generation
    if (options.native && (await this.startNative(options.noiseSuppression, onFrame, onLost))) {
      this.nativeRunning = true
      return
    }
    if (generation !== this.generation) return
    await this.mic.start(onFrame, onLost)
  }

  stop(): void {
    this.generation++
    this.nativeMic.stop()
    this.dfn.dispose()
    this.nativeRunning = false
    this.mic.stop()
  }

  private startNative(
    noiseSuppression: boolean,
    onFrame: (frame: Float32Array) => void,
    onLost: () => void
  ): Promise<boolean> {
    const resampler = new StreamResampler(NATIVE_SAMPLE_RATE, TARGET_SAMPLE_RATE)
    const deliver = (chunk: Float32Array): void => {
      const frame = resampler.process(chunk)
      if (frame.length > 0) onFrame(frame)
    }
    let pipeline: (frame: Float32Array) => void = deliver
    if (noiseSuppression) {
      void this.dfn.init()
      this.dfn.reset()
      this.dfn.onOutput = deliver
      pipeline = (frame) => this.dfn.push(frame)
    }
    return this.nativeMic.start(pipeline, onLost)
  }
}
