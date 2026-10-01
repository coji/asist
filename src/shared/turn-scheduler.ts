/**
 * Runs conversation turns strictly one at a time and aborts the running turn when a new one arrives.
 * A turn that is waiting for the user's answer holds a newer turn's abort off until it lets go. Every turn
 * runs, in the order it started: one that a newer turn replaced while it waited runs with its signal
 * already aborted and closes at once, so that what the user said in it is still recorded.
 */

export interface TurnRunContext {
  turnId: number
  signal: AbortSignal
  /**
   * Keeps the turn from being aborted until the returned release is called. A newer turn started
   * meanwhile aborts it at the release and still waits for it to end. An abort() alone meanwhile is
   * dropped: it is a barge-in with no words after it, which has stopped the speech already, and the turn
   * goes on to reply with the result of what the user answers, which the user has not heard yet.
   */
  hold: () => () => void
}

export interface TurnHandle {
  turnId: number
  signal: AbortSignal
  completion: Promise<void>
}

interface ScheduledTurn {
  turnId: number
  controller: AbortController
  holds: number
  abortAtRelease: boolean
}

export class LatestTurnScheduler {
  private nextTurnId: number | null = null
  private current: ScheduledTurn | null = null
  private tail: Promise<void> = Promise.resolve()

  /**
   * `firstTurnId` is read once, when the first id is taken, so that the ids can continue from what an
   * earlier launch left in the conversation log rather than start again at the same numbers.
   */
  constructor(private readonly firstTurnId: () => number = () => 1) {}

  start(run: (ctx: TurnRunContext) => Promise<void>): TurnHandle {
    if (this.current) this.replace(this.current)

    const turn: ScheduledTurn = { turnId: this.takeTurnId(), controller: new AbortController(), holds: 0, abortAtRelease: false }
    const { turnId, controller } = turn
    const previous = this.tail.catch(() => {})
    const completion = previous
      .then(() => run({ turnId, signal: controller.signal, hold: () => this.hold(turn) }))
      .finally(() => {
        if (this.current?.turnId === turnId) this.current = null
      })

    this.current = turn
    // A failed turn must not block the turns behind it.
    this.tail = completion.catch(() => {})
    return { turnId, signal: controller.signal, completion }
  }

  /** For system interjections. It never takes over a user turn, and returns null instead. */
  startIfIdle(run: (ctx: TurnRunContext) => Promise<void>): TurnHandle | null {
    if (this.current !== null) return null
    return this.start(run)
  }

  /** Aborts the turn at once, unless it holds for the user's answer (see TurnRunContext.hold). */
  abort(turnId: number): void {
    if (this.current?.turnId === turnId && this.current.holds === 0) this.current.controller.abort()
  }

  private replace(turn: ScheduledTurn): void {
    if (turn.holds > 0) turn.abortAtRelease = true
    else turn.controller.abort()
  }

  private hold(turn: ScheduledTurn): () => void {
    turn.holds++
    let released = false
    return () => {
      if (released) return
      released = true
      turn.holds--
      if (turn.holds === 0 && turn.abortAtRelease) turn.controller.abort()
    }
  }

  get activeTurnId(): number | null {
    return this.current?.turnId ?? null
  }

  /**
   * Takes a turnId without running a turn, for Gemini Live's exchanges, which come from the model itself
   * but still go into the conversation log and the events. It draws from the same counter as start, so
   * the ids never collide.
   */
  allocateTurnId(): number {
    return this.takeTurnId()
  }

  private takeTurnId(): number {
    this.nextTurnId ??= this.firstTurnId()
    return this.nextTurnId++
  }

  async waitForIdle(): Promise<void> {
    await this.tail
  }
}
