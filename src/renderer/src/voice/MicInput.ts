import { StreamResampler } from '@shared/pcm'
import { MicCapture } from './MicCapture'
import { NativeMicSource } from './NativeMic'
import { DfnDenoiser } from './DfnDenoiser'

/**
 * The microphone as 16 kHz mono frames, for the voice pipeline and for the live engine alike. The
 * native helper, which cancels the echo in the OS, is tried first when the caller asks for it, and
 * getUserMedia takes over when it cannot start or when main has given up on it. DeepFilterNet works on the
 * helper's 48 kHz audio only; getUserMedia brings Chromium's own noise suppression.
 */

const NATIVE_SAMPLE_RATE = 48_000
const TARGET_SAMPLE_RATE = 16_000

export interface MicInputOptions {
  /** Whether to try the native helper. The caller takes it from the settings and the platform capabilities. */
  native: boolean
  /** DeepFilterNet on the native helper's audio. Until the model has loaded, and if it fails, the audio arrives unsuppressed. */
  noiseSuppression: boolean
}

/**
 * Receives each 16 kHz frame and whether it closes what the source handed over at once. DeepFilterNet hands one
 * delivery of the native helper on in several frames.
 */
export type MicFrameHandler = (frame: Float32Array, deliveryEnds: boolean) => void

export class MicInput {
  private mic = new MicCapture()
  private nativeMic = new NativeMicSource()
  private dfn = new DfnDenoiser()
  private generation = 0
  private nativeRunning = false
  /**
   * main gave up on the native helper while it ran, which it does only after respawning a helper that keeps
   * breaking. Starting the helper again would also clear the failures main counted, and the helper would be
   * given up on and started over without end, so the input stays on getUserMedia until the microphone is
   * turned off.
   */
  private nativeGivenUp = false

  /** Whether the frames come from the native helper, whose echo cancellation also attenuates the microphone during double talk. */
  get native(): boolean {
    return this.nativeRunning
  }

  /**
   * Opens the input, closing first whatever is open. onLost is called when the source stops delivering,
   * because main gave up on the native helper or the device went away; the caller starts the input again.
   * A stop while this runs leaves nothing started. It throws only when getUserMedia fails.
   */
  async start(options: MicInputOptions, onFrame: MicFrameHandler, onLost: () => void): Promise<void> {
    this.close()
    const generation = this.generation
    const helperGivenUp = (): void => {
      this.nativeGivenUp = true
      onLost()
    }
    if (
      options.native &&
      !this.nativeGivenUp &&
      (await this.startNative(options.noiseSuppression, onFrame, helperGivenUp))
    ) {
      this.nativeRunning = true
      return
    }
    if (generation !== this.generation) return
    await this.mic.start((frame) => onFrame(frame, true), onLost)
  }

  /** Closes the input as the microphone turns off. The next start tries the native helper again. */
  stop(): void {
    this.close()
    this.nativeGivenUp = false
  }

  /** Closes the input to build it again, which keeps a helper main gave up on out of the next start. */
  close(): void {
    this.generation++
    this.nativeMic.stop()
    this.dfn.dispose()
    this.nativeRunning = false
    this.mic.stop()
  }

  private startNative(noiseSuppression: boolean, onFrame: MicFrameHandler, onLost: () => void): Promise<boolean> {
    const resampler = new StreamResampler(NATIVE_SAMPLE_RATE, TARGET_SAMPLE_RATE)
    const deliver = (chunk: Float32Array, deliveryEnds: boolean): void => {
      const frame = resampler.process(chunk)
      if (frame.length > 0) onFrame(frame, deliveryEnds)
    }
    let pipeline = (frame: Float32Array): void => deliver(frame, true)
    if (noiseSuppression) {
      void this.dfn.init()
      this.dfn.reset()
      this.dfn.onOutput = deliver
      pipeline = (frame) => this.dfn.push(frame)
    }
    return this.nativeMic.start(pipeline, onLost)
  }
}
