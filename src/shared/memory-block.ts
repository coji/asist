/**
 * Freezes the memory block of the system prompt. Changing the block invalidates the prompt cache from
 * that point on, so the block is rebuilt only when at least the freeze interval has passed since the
 * previous turn, and stays frozen while the cache is alive. A change ASIST makes to the memory, a save or a
 * deletion on the memory screen or a curation's merge, takes effect at the next turn through invalidate,
 * so that the prompt never keeps what the user changed or removed; only an edit made outside ASIST waits
 * for the freeze to end.
 */

export const MEMORY_BLOCK_FREEZE_MS = 5 * 60_000

export class FrozenMemoryBlock {
  private block: string | null = null
  private built = false
  private lastTurnAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly build: () => string | null,
    private readonly freezeMs = MEMORY_BLOCK_FREEZE_MS
  ) {}

  /** Called at the start of a turn. While the block is frozen it returns the one built earlier. */
  forTurn(now: number): string | null {
    if (!this.built || now - this.lastTurnAt >= this.freezeMs) {
      this.block = this.build()
      this.built = true
    }
    this.lastTurnAt = now
    return this.block
  }

  /** Makes the next turn rebuild the block. */
  invalidate(): void {
    this.built = false
  }
}
