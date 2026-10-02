import type { BridgeClip, AizuchiClip, BridgePlan, ClipRole, SpeechSegment, TurnTimings } from '@shared/ipc'
import type { AizuchiClassification } from '@shared/aizuchi-classifier'

/**
 * Opens a turn with an aizuchi and a bridging phrase. Playback starts the moment the VAD decides
 * speech has ended, and once the final transcript arrives the words already spoken are handed to
 * brain. Waiting for the final transcript would delay the aizuchi by the ASR time, measured at a
 * p50 of about 0.4 s, so the kind of aizuchi comes from the classifier's AizuchiClassification over
 * the partial transcripts instead.
 *
 * The bridge synthesizes the phrase that the BridgePlan looked ahead for, such as "会議の件ですね。",
 * and plays it after the aizuchi and before the answer. Whether an utterance may have one at all is
 * the caller's to decide. brain is told of a bridge only when it will play, because it starts its
 * answer as the continuation of that line. If the answer's own text got queued first, the bridge
 * does not play and the outcome is recorded in the measurements.
 *
 * An utterance is identified by startedAt, the time capture began. A speech that yields no turn,
 * because its transcription failed, meant nothing or was dropped as echo, cancels it. An opening
 * lasts until a newer utterance becomes a turn, which replaces the older turn and its bridge.
 *
 * A bridge brain was told of plays before the answer, unless the user's speech replaces the turn,
 * and it never starts over the user. A capture that opens in silence may be the user going on: a
 * bridge not yet handed to the player waits while it is open and, should it end in speech, until
 * that speech's transcript, and it plays once the capture comes to nothing. A capture that opens
 * while the player sounds is as often the echo of the opening's own clip, and the barge-in judgement
 * settles which while that sound lasts, stopping the opening when it is the user. A bridge already
 * queued behind the aizuchi plays on as part of that sound, and one synthesized meanwhile joins it,
 * but none starts the sound again over that capture, where the judgement would begin anew on the
 * voice the capture already holds. With barge-in off the VAD is muted while the opening sounds, so
 * no capture opens then.
 *
 * A bridge promises that an answer follows, so one that has not started sounding is withdrawn when
 * no answer will: the speech is cancelled, or its turn ends without saying anything.
 */

/** No aizuchi opens a turn this soon after one played while the user was speaking, because "うん。なるほど。" back to back sounds wrong. */
const LISTENING_OVERLAP_MS = 2500

export interface OpeningInput {
  startedAt: number
  speechEndAt: number
  /**
   * The utterance may open with an aizuchi. It was settled when the capture began, and the look-ahead
   * was told the same while the user spoke, so that its phrase follows the aizuchi that plays.
   */
  aizuchi: boolean
  /** The classification available when speech ended, which picks the aizuchi; nothing waits for a newer one. Without it no aizuchi plays. */
  classification: AizuchiClassification | null
  /** The bridge this utterance may have, or null when it may have none. */
  bridge: OpeningBridge | null
  /** Milliseconds since the last aizuchi that played while the user was speaking. */
  sinceListeningMs: number
}

export interface OpeningBridge {
  /** The look-ahead, waited out to the end of the request in flight. The phrase comes from it, and only has to play before the answer. */
  plan: Promise<BridgePlan | null>
  /**
   * The aizuchi classification has already found the utterance to be one that takes a bridge, so a
   * phrase still unsettled when the final transcript arrives is told to brain as coming and plays once
   * it settles. Without that finding the look-ahead's answer can still rule the bridge out, so a phrase
   * unsettled by then is neither told nor played.
   */
  screened: boolean
}

export interface OpeningPorts {
  /** Picks the aizuchi for this classification, or nothing. */
  pickAizuchi(classification: AizuchiClassification | null): AizuchiClip | null
  /** Queues the clip and returns what was queued, by which its start is recognized and a bridge withdrawn. */
  play(clip: { audio: string | null; text: string }, role: ClipRole): SpeechSegment
  /** Synthesizes the bridge phrase. */
  synthesizeBridge(text: string): Promise<BridgeClip>
  /** Whether the answer's own text was queued for playback after this time, which makes the bridge late. */
  bodyQueuedAfter(speechEndAt: number): boolean
  /** Records a measurement of an utterance's opening: when one of its clips started sounding, or why its bridge did not. */
  measure(startedAt: number, timings: TurnTimings): void
  /** Whether the player sounds now, or is about to. */
  sounding(): boolean
  /** Drops this bridge if it has not started yet. */
  withdrawBridge(queued: SpeechSegment): void
}

interface Opening {
  startedAt: number
  speechEndAt: number
  aizuchi: AizuchiClip | null
  /** The aizuchi as it was handed to play. */
  queuedAizuchi: SpeechSegment | null
  /**
   * It is pending while the look-ahead runs, and decided once the phrase is settled, which may be
   * null: from the start for an utterance that may have no bridge, and at the claim for an unscreened
   * one still pending then.
   */
  bridge: { state: 'pending'; screened: boolean } | { state: 'decided'; text: string | null }
  /** The synthesized bridge, kept until it may sound. */
  synthesized: BridgeClip | null
  /** The bridge as it was handed to play. */
  queuedBridge: SpeechSegment | null
  /** The final transcript has claimed it for its turn. */
  claimed: boolean
  /** Its capture opened in silence, so it may be the user going on, and older bridges wait for its transcript. */
  holdsOlder: boolean
}

export interface ClaimedOpening {
  aizuchi: string | null
  bridge: string | null
  /** A bridge may still play and its phrase is not settled yet. brain is told that a short opening phrase is still coming. */
  bridgePending: boolean
}

export class TurnOpening {
  /** The openings in the order their speech ended. */
  private openings: Opening[] = []
  /** The capture open after the newest speech end, and whether it opened while the player sounded. */
  private capture: { overSound: boolean } | null = null

  constructor(private readonly ports: OpeningPorts) {}

  begin(input: OpeningInput): void {
    const aizuchi =
      input.aizuchi && input.sinceListeningMs >= LISTENING_OVERLAP_MS ? this.ports.pickAizuchi(input.classification) : null
    const opening: Opening = {
      startedAt: input.startedAt,
      speechEndAt: input.speechEndAt,
      aizuchi,
      queuedAizuchi: null,
      bridge: input.bridge ? { state: 'pending', screened: input.bridge.screened } : { state: 'decided', text: null },
      synthesized: null,
      queuedBridge: null,
      claimed: false,
      holdsOlder: !this.capture?.overSound
    }
    this.openings.push(opening)
    // The capture that ends in this speech is the utterance's own.
    this.capture = null
    if (aizuchi) opening.queuedAizuchi = this.ports.play(aizuchi, 'aizuchi')
    this.release()
    void input.bridge?.plan.then((plan) => {
      if (!this.alive(opening) || opening.bridge.state !== 'pending') return
      const text = plan?.bridge || null
      opening.bridge = { state: 'decided', text }
      if (text) this.requestBridge(opening, text)
    })
  }

  /** Whether this opening still leads into a turn that may come or is under way. */
  private alive(opening: Opening): boolean {
    return this.openings.includes(opening)
  }

  private requestBridge(opening: Opening, text: string): void {
    this.ports.synthesizeBridge(text).then(
      (bridge) => {
        if (!this.alive(opening)) return
        opening.synthesized = bridge
        this.release()
      },
      (error: unknown) => {
        console.error('aizuchi bridge failed:', error)
        if (this.alive(opening)) this.ports.measure(opening.startedAt, { bridge: 'failed' })
      }
    )
  }

  /** Hands the player every synthesized bridge that may sound now. */
  private release(): void {
    this.openings.forEach((opening, index) => {
      if (!opening.synthesized || opening.queuedBridge || !this.maySound(index)) return
      if (this.ports.bodyQueuedAfter(opening.speechEndAt)) {
        opening.synthesized = null
        this.ports.measure(opening.startedAt, { bridge: 'late' })
        return
      }
      opening.queuedBridge = this.ports.play(opening.synthesized, 'bridge')
    })
  }

  /** Whether the bridge of the opening at this index may start now. */
  private maySound(index: number): boolean {
    if (this.openings.slice(index + 1).some((newer) => newer.holdsOlder)) return false
    return !this.capture || (this.capture.overSound && this.ports.sounding())
  }

  /** A capture opened. */
  captureStarted(): void {
    this.capture = { overSound: this.ports.sounding() }
  }

  /** A capture closed. When it ended in no speech, the bridge it held back plays. */
  captureEnded(): void {
    if (!this.capture) return
    this.capture = null
    this.release()
  }

  /**
   * Called when a clip actually starts playing, and records the time since its utterance's speech
   * ended and the clip's length. An aizuchi played while the user was speaking belongs to no opening.
   */
  clipStarted(segment: SpeechSegment, durationMs: number, now: number): void {
    const opening = this.openings.find((o) => o.queuedAizuchi === segment || o.queuedBridge === segment)
    if (!opening) return
    const sinceEnd = Math.max(0, Math.round(now - opening.speechEndAt))
    const clipMs = Math.round(durationMs)
    this.ports.measure(
      opening.startedAt,
      segment === opening.queuedAizuchi
        ? { aizuchiMs: sinceEnd, aizuchiClipMs: clipMs }
        : { bridgeMs: sinceEnd, bridgeClipMs: clipMs, bridge: 'played' }
    )
  }

  /**
   * Claims the opening of the utterance whose final transcript arrived and returns the aizuchi and
   * bridge wording for brain. A bridge that has not played yet is still handed over, on the
   * assumption that it plays before the answer; how often it did not is tracked as bridge=late. An
   * unscreened bridge whose phrase is not settled yet is given up here. The openings of older
   * utterances end with it, as this turn replaces theirs.
   */
  claim(startedAt: number): ClaimedOpening | null {
    const index = this.openings.findIndex((o) => o.startedAt === startedAt && !o.claimed)
    if (index < 0) return null
    for (const older of this.openings.slice(0, index)) this.withdrawBridge(older)
    this.openings = this.openings.slice(index)
    const opening = this.openings[0]
    opening.claimed = true
    if (opening.bridge.state === 'pending' && !opening.bridge.screened) opening.bridge = { state: 'decided', text: null }
    return {
      aizuchi: opening.aizuchi?.text ?? null,
      bridge: opening.bridge.state === 'decided' ? opening.bridge.text : null,
      bridgePending: opening.bridge.state === 'pending'
    }
  }

  /** Called when the speech yields no turn. Its aizuchi has already been heard, and an older bridge it held back may play. */
  cancel(startedAt: number): void {
    const opening = this.openings.find((o) => o.startedAt === startedAt && !o.claimed)
    if (!opening) return
    this.withdrawBridge(opening)
    this.openings = this.openings.filter((o) => o !== opening)
    this.release()
  }

  /**
   * Called when the turn an opening was claimed for ends without saying anything, or is replaced by
   * typed input, which leaves its bridge nothing to lead into.
   */
  withdraw(): void {
    for (const opening of this.openings) if (opening.claimed) this.withdrawBridge(opening)
    this.openings = this.openings.filter((o) => !o.claimed)
  }

  private withdrawBridge(opening: Opening): void {
    if (opening.queuedBridge) this.ports.withdrawBridge(opening.queuedBridge)
  }

  /** The user talked over the turn, so nothing more of any opening plays. */
  interrupt(): void {
    this.openings = []
  }
}
