/**
 * Subscribes to the 48 kHz mono frames that the main process receives from the asist-mic helper
 * (voice processing on macOS, the communications echo canceller on Windows) and forwards over IPC.
 * It is an input source in place of MicCapture's getUserMedia. Starting never throws: it returns
 * false so the caller can switch to getUserMedia, and if the helper dies while running, onDown
 * reports it.
 */
export class NativeMicSource {
  private unsubscribeFrame: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null
  private active = false
  private generation = 0
  private cancelStart: (() => void) | null = null

  /** Returns true only once the helper has started and the frame subscription is in place. */
  async start(onFrame: (frame: Float32Array) => void, onDown: (reason: string) => void): Promise<boolean> {
    this.stop()
    if (typeof window.api.micNativeStart !== 'function') return false
    const generation = this.generation
    const current = (): boolean => generation === this.generation && this.active
    let cancel!: () => void
    const cancelled = new Promise<null>((resolve) => { cancel = () => resolve(null) })
    this.cancelStart = cancel
    // Frames can arrive before the start response, so the subscription has to exist first.
    this.active = true
    this.unsubscribeFrame = window.api.onMicNativeFrame((frame) => {
      // Some environments lose the Float32Array type across the preload boundary, so restore it.
      if (current()) onFrame(frame instanceof Float32Array ? frame : new Float32Array(frame))
    })
    this.unsubscribeStatus = window.api.onMicNativeStatus((status) => {
      if (current() && !status.running) onDown(status.reason ?? 'native mic stopped')
    })
    try {
      const result = await Promise.race([window.api.micNativeStart(), cancelled])
      // The stop has already gone to the main process. Stopping again while handling a stale
      // response would also stop a newer helper that started in the meantime.
      if (!current() || !result) return false
      if (!result.ok) {
        if (result.reason) console.warn(`native mic unavailable: ${result.reason}`)
        this.stop()
        return false
      }
      return true
    } catch (err) {
      if (!current()) return false
      console.warn('native mic unavailable:', err)
      this.stop()
      return false
    } finally {
      if (this.cancelStart === cancel) this.cancelStart = null
    }
  }

  stop(): void {
    this.generation++
    this.cancelStart?.()
    this.cancelStart = null
    if (!this.active && !this.unsubscribeFrame) return
    this.active = false
    this.unsubscribeFrame?.()
    this.unsubscribeFrame = null
    this.unsubscribeStatus?.()
    this.unsubscribeStatus = null
    void window.api.micNativeStop().catch(() => {})
  }
}
