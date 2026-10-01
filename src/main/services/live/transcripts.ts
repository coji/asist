/**
 * Assembles the live transcripts.
 *
 * Gemini streams a transcript in fragments. Fragments are collected and become one final utterance once
 * nothing follows for quietMs, or at once when Gemini signals the end, which flush handles. The final
 * text is what the conversation log keeps.
 */

export type TranscriptRole = 'user' | 'assistant'

export interface TranscriptTrackerOptions {
  quietMs: number
  onDelta: (role: TranscriptRole, text: string) => void
  onFinal: (role: TranscriptRole, text: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class TranscriptTracker {
  private readonly buffers: Record<TranscriptRole, string> = { user: '', assistant: '' }
  private readonly timers: Record<TranscriptRole, unknown> = { user: null, assistant: null }
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: TranscriptTrackerOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** The text collected so far, which is not final yet. */
  pending(role: TranscriptRole): string {
    return this.buffers[role]
  }

  push(role: TranscriptRole, delta: string): void {
    if (!delta) return
    this.buffers[role] += delta
    this.options.onDelta(role, this.buffers[role])
    this.arm(role)
  }

  /** Finalizes at once on an end-of-utterance signal, and does nothing when there is no text. */
  flush(role: TranscriptRole): string {
    this.disarm(role)
    const text = this.buffers[role].trim()
    this.buffers[role] = ''
    if (text) this.options.onFinal(role, text)
    return text
  }

  dispose(): void {
    this.disarm('user')
    this.disarm('assistant')
  }

  private arm(role: TranscriptRole): void {
    this.disarm(role)
    this.timers[role] = this.setTimer(() => {
      this.timers[role] = null
      this.flush(role)
    }, this.options.quietMs)
  }

  private disarm(role: TranscriptRole): void {
    if (this.timers[role] !== null) this.clearTimer(this.timers[role])
    this.timers[role] = null
  }
}
