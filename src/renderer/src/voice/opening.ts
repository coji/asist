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
 * because its transcription failed, meant nothing or was dropped as echo, cancels it, and an
 * utterance that finishes first has begin replace it. A bridge promises that an answer follows, so
 * one that has not started sounding is withdrawn when no answer will: the speech is cancelled, or
 * its turn ends without saying anything.
 */

/** No aizuchi opens a turn this soon after one played while the user was speaking, because "うん。なるほど。" back to back sounds wrong. */
const LISTENING_OVERLAP_MS = 2500

export interface OpeningInput {
  startedAt: number
  speechEndAt: number
  /** The classification available when speech ended; nothing waits for a newer one. Without it no aizuchi plays. */
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
  /** Queues the clip and returns what was queued, by which a bridge that has not started can be withdrawn. */
  play(clip: { audio: string | null; text: string }, role: ClipRole): SpeechSegment
  /** Synthesizes the bridge phrase. */
  synthesizeBridge(text: string): Promise<BridgeClip>
  /** Whether the answer's own text was queued for playback after this time, which makes the bridge late. */
  bodyQueuedAfter(speechEndAt: number): boolean
  /** Records in the measurements why the bridge did not play, as late or failed. */
  onBridgeOutcome(patch: TurnTimings): void
  /** Drops this bridge if it has not started yet. */
  withdrawBridge(queued: SpeechSegment): void
}

interface Opening {
  startedAt: number
  speechEndAt: number
  aizuchi: AizuchiClip | null
  /**
   * It is pending while the look-ahead runs, and decided once the phrase is settled, which may be
   * null: from the start for an utterance that may have no bridge, and at the claim for an unscreened
   * one still pending then.
   */
  bridge: { state: 'pending'; screened: boolean } | { state: 'decided'; text: string | null }
  /** The bridge as it was handed to play. */
  queuedBridge: SpeechSegment | null
}

export interface ClaimedOpening {
  aizuchi: string | null
  bridge: string | null
  /** A bridge may still play and its phrase is not settled yet. brain is told that a short opening phrase is still coming. */
  bridgePending: boolean
}

export class TurnOpening {
  /** The opening between the end of speech and the final transcript. */
  private current: Opening | null = null
  /**
   * The opening claimed by the final transcript. Synthesizing the bridge can still be running after
   * the claim and may play until the answer arrives, so this is held until the next utterance.
   */
  private claimed: Opening | null = null

  constructor(private readonly ports: OpeningPorts) {}

  begin(input: OpeningInput): void {
    const aizuchi =
      input.sinceListeningMs < LISTENING_OVERLAP_MS ? null : this.ports.pickAizuchi(input.classification)
    const opening: Opening = {
      startedAt: input.startedAt,
      speechEndAt: input.speechEndAt,
      aizuchi,
      bridge: input.bridge ? { state: 'pending', screened: input.bridge.screened } : { state: 'decided', text: null },
      queuedBridge: null
    }
    this.current = opening
    this.claimed = null
    if (aizuchi) this.ports.play(aizuchi, 'aizuchi')
    void input.bridge?.plan.then((plan) => {
      if (!this.alive(opening) || opening.bridge.state !== 'pending') return
      const text = plan?.bridge || null
      opening.bridge = { state: 'decided', text }
      if (text) this.requestBridge(opening, text)
    })
  }

  /** Whether this opening is still current. Once the next utterance begins, a stale bridge does not play. */
  private alive(opening: Opening): boolean {
    return this.current === opening || this.claimed === opening
  }

  private requestBridge(opening: Opening, text: string): void {
    this.ports.synthesizeBridge(text).then(
      (bridge) => {
        if (!this.alive(opening)) return
        if (this.ports.bodyQueuedAfter(opening.speechEndAt)) {
          this.ports.onBridgeOutcome({ bridge: 'late' })
          return
        }
        opening.queuedBridge = this.ports.play(bridge, 'bridge')
      },
      (error: unknown) => {
        console.error('aizuchi bridge failed:', error)
        if (this.alive(opening)) this.ports.onBridgeOutcome({ bridge: 'failed' })
      }
    )
  }

  /**
   * Called when a clip actually starts playing, and returns the time since speech ended and the
   * clip's length as measurements. An aizuchi played while the user was speaking is not part of the
   * turn's measurements.
   */
  clipStarted(role: ClipRole, durationMs: number, now: number): TurnTimings | null {
    const opening = this.current ?? this.claimed
    if (!opening) return null
    const sinceEnd = Math.max(0, Math.round(now - opening.speechEndAt))
    const clipMs = Math.round(durationMs)
    if (role === 'aizuchi') return { aizuchiMs: sinceEnd, aizuchiClipMs: clipMs }
    if (role === 'bridge') return { bridgeMs: sinceEnd, bridgeClipMs: clipMs, bridge: 'played' }
    return null
  }

  /**
   * Claims the opening of the utterance whose final transcript arrived and returns the aizuchi and
   * bridge wording for brain. A bridge that has not played yet is still handed over, on the
   * assumption that it plays before the answer; how often it did not is tracked as bridge=late. An
   * unscreened bridge whose phrase is not settled yet is given up here.
   */
  claim(startedAt: number): ClaimedOpening | null {
    if (!this.current || this.current.startedAt !== startedAt) return null
    const opening = this.current
    this.current = null
    this.claimed = opening
    if (opening.bridge.state === 'pending' && !opening.bridge.screened) opening.bridge = { state: 'decided', text: null }
    return {
      aizuchi: opening.aizuchi?.text ?? null,
      bridge: opening.bridge.state === 'decided' ? opening.bridge.text : null,
      bridgePending: opening.bridge.state === 'pending'
    }
  }

  /** Called when the speech yields no turn. The aizuchi has already been heard, so the record goes and no bridge plays. */
  cancel(startedAt: number): void {
    if (this.current?.startedAt !== startedAt) return
    this.withdrawBridge(this.current)
    this.current = null
  }

  /**
   * Called when the turn the opening was claimed for ends without saying anything, or is replaced by
   * typed input, which leaves its bridge nothing to lead into.
   */
  withdraw(): void {
    if (!this.claimed) return
    this.withdrawBridge(this.claimed)
    this.claimed = null
  }

  private withdrawBridge(opening: Opening): void {
    if (opening.queuedBridge) this.ports.withdrawBridge(opening.queuedBridge)
  }

  /** The user talked over the turn, so nothing more of its opening plays. */
  interrupt(): void {
    this.current = null
    this.claimed = null
  }
}
