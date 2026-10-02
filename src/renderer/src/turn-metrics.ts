import type { TurnMetricLog, TurnTimings } from '@shared/ipc'

/** What a user request is made from: typed text, or the utterance whose capture began at `utterance`. */
export type RequestInput = { typed: true } | { typed: false; utterance: number }

/** The measurement of one input, from its speech end or its typed request on, through its turn. */
interface Measurement {
  timings: TurnTimings
  typed: boolean
  /** The utterance it measures, by when its capture began. Typed input has none. */
  utterance?: number
  /** When the voice stopped, which end to end is measured from. */
  speechEndAt?: number
  /** The request the input was sent as, and when it was accepted, in epoch milliseconds. */
  request?: { id: string; occurredAt: number }
  turnId?: number
  completed: boolean
  /** How many times this entry has been saved. Among the rows with one id, the reader takes the highest value. */
  revision: number
  /** Whether a value changed after the last save. */
  dirty: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
  /** The input the HUD showed before this utterance, which it shows again should this one yield no turn. */
  shownBefore: Measurement | null
  dropped: boolean
}

type Requested = Measurement & { request: { id: string; occurredAt: number } }

const measurement = (fields: Pick<Measurement, 'timings' | 'typed' | 'utterance' | 'speechEndAt'>, shownBefore: Measurement | null): Measurement => ({
  ...fields,
  completed: false,
  revision: 0,
  dirty: true,
  shownBefore,
  dropped: false
})

/** The upper bound on waiting for playback to end, so that a turn whose body never arrives, or whose speech runs long, is still written. */
const IDLE_WAIT_MS = 120_000

/**
 * Keeps the measurements of each input, from the end of its speech or the sending of its text, through
 * the generation of its response to its actual playback. An utterance gathers its own from its capture,
 * its transcription and its opening, so a speech that ends while an older one is still transcribed
 * or sent never lends that one its values. Values that arrive after the turn is complete, such as when
 * playback really started and how many barge-ins or ignored aizuchi occurred during speech, are appended
 * under the same id with the revision raised. The HUD shows the latest input's measurements, or the one
 * before when the latest yields no turn.
 */
export class TurnMetrics {
  /** The utterances, by when their capture began, until they yield no turn or their measurement closes. */
  private utterances = new Map<number, Measurement>()
  private requests = new Map<string, Requested>()
  private turns = new Map<number, Requested>()
  private shown: Measurement | null = null

  constructor(
    private readonly save: (payload: TurnMetricLog) => Promise<void>,
    private readonly show: (timings: TurnTimings) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => number = () => Date.now()
  ) {}

  /** A speech ended and goes to transcription, measured so far by its capture. The HUD turns to it. */
  beginUtterance(startedAt: number, speechEndAt: number, timings: TurnTimings): void {
    const entry = measurement({ timings, typed: false, utterance: startedAt, speechEndAt }, this.shown)
    this.utterances.set(startedAt, entry)
    this.display(entry)
  }

  /** Adds to the measurements of an utterance, whether it still waits for its transcript or is a turn by now. */
  updateUtterance(startedAt: number, timings: TurnTimings): void {
    const entry = this.utterances.get(startedAt)
    if (entry) this.merge(entry, timings)
  }

  /** The speech yields no turn. The HUD goes back to the input it showed before, unless a newer one has taken it. */
  dropUtterance(startedAt: number): void {
    const entry = this.utterances.get(startedAt)
    if (!entry) return
    this.utterances.delete(startedAt)
    entry.dropped = true
    if (this.shown !== entry) return
    let before = entry.shownBefore
    while (before?.dropped) before = before.shownBefore
    this.shown = before
    this.show({ ...before?.timings })
  }

  /** The input is sent. Only the newest request can become a turn, so older ones stop being measured. */
  beginRequest(id: string, input: RequestInput): void {
    for (const older of this.requests.values()) this.forget(older)
    const entry = input.typed ? measurement({ timings: {}, typed: true }, null) : this.utterances.get(input.utterance)
    if (!entry) return
    const requested: Requested = Object.assign(entry, { request: { id, occurredAt: this.wallNow() }, shownBefore: null })
    this.requests.set(id, requested)
    if (input.typed) this.display(requested)
  }

  discardRequest(id: string): void {
    const entry = this.requests.get(id)
    if (entry) this.forget(entry)
  }

  activate(turnId: number, requestId: string): void {
    const entry = this.requests.get(requestId)
    if (!entry) return
    this.requests.delete(requestId)
    entry.turnId = turnId
    this.turns.set(turnId, entry)
  }

  update(turnId: number, timings: TurnTimings): boolean {
    const entry = this.turns.get(turnId)
    if (!entry) return false
    this.merge(entry, timings)
    return true
  }

  /** Counts an event during playback, a barge-in or an aizuchi that was let pass. An unknown turn is ignored. */
  increment(turnId: number, key: 'userBackchannels' | 'bargeIns'): boolean {
    const entry = this.turns.get(turnId)
    if (!entry) return false
    this.merge(entry, { [key]: (entry.timings[key] ?? 0) + 1 })
    return true
  }

  /** Measures only when the first body segment sounds. A filler played while working, and typed input, are out of scope. */
  playbackStarted(turnId: number, segmentIndex: number): void {
    const entry = this.turns.get(turnId)
    if (segmentIndex !== 0 || !entry || entry.typed || entry.timings.e2eMs !== undefined || entry.speechEndAt === undefined) return
    this.merge(entry, { e2eMs: Math.max(0, Math.round(this.now() - entry.speechEndAt)) })
    if (entry.completed) this.persist(entry)
  }

  /** Handles done from the brain: the measurement is saved, and events during playback are still accepted until playback ends. */
  finish(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (!entry) return
    entry.completed = true
    if (entry.dirty) this.persist(entry)
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = setTimeout(() => this.close(turnId), IDLE_WAIT_MS)
  }

  /**
   * The playback queue has run empty. A turn whose body playback is already measured is closed after
   * the changed values are appended. When the body has not arrived yet, which happens when only an
   * aizuchi finished sounding, the turn keeps waiting.
   */
  playbackIdle(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (!entry || !entry.completed) return
    if (!entry.typed && entry.timings.e2eMs === undefined) return
    this.close(turnId)
  }

  /** Appends what changed since the last save and stops accepting values for the turn. */
  private close(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (entry?.dirty) this.persist(entry)
    this.discard(turnId)
  }

  discard(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (entry) this.forget(entry)
  }

  private forget(entry: Measurement): void {
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    if (entry.utterance !== undefined) this.utterances.delete(entry.utterance)
    if (entry.request) this.requests.delete(entry.request.id)
    if (entry.turnId !== undefined) this.turns.delete(entry.turnId)
  }

  private merge(entry: Measurement, timings: TurnTimings): void {
    entry.timings = { ...entry.timings, ...timings }
    entry.dirty = true
    if (entry === this.shown) this.show({ ...entry.timings })
  }

  private display(entry: Measurement): void {
    this.shown = entry
    this.show({ ...entry.timings })
  }

  private persist(entry: Requested): void {
    const timings = entry.timings
    const hasMeasurement = (['vadMs', 'asrMs', 'aizuchiMs', 'ttftMs', 'ttsMs', 'e2eMs'] as const)
      .some((key) => typeof timings[key] === 'number' && Number.isFinite(timings[key]))
    if (!hasMeasurement) return
    entry.revision += 1
    entry.dirty = false
    const payload: TurnMetricLog = {
      id: entry.request.id,
      revision: entry.revision,
      occurredAt: entry.request.occurredAt,
      ...(entry.typed ? { typed: true } : {}),
      ...timings
    }
    void this.save(payload).catch((firstError: unknown) => {
      setTimeout(() => {
        void this.save(payload).catch((secondError: unknown) => {
          console.warn('metrics persistence failed:', secondError ?? firstError)
        })
      }, 250)
    })
  }
}
