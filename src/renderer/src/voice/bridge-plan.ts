import type { BridgePlan, BridgePlanRequest } from '@shared/ipc'
import { PartialLookahead } from './lookahead'

/**
 * Looks ahead while the user is still speaking: every updated partial transcript goes to a fast
 * model, and the newest result feeds the aizuchi classification and the bridging phrase once speech
 * ends. The requests run through PartialLookahead, one at a time within a capture.
 */

/** A partial transcript shorter than this carries nothing to plan on. */
const MIN_PLAN_CHARS = 4
/** Once speech has ended, even a short partial transcript is sent once, since the bridging phrase is built from it. */
const MIN_FINISH_CHARS = 2

export interface PlannerPorts {
  plan(input: BridgePlanRequest): Promise<BridgePlan>
  /** Called whenever a plan comes back; the HUD displays it. */
  onPlan(plan: BridgePlan, input: BridgePlanRequest): void
  onFailure(error: unknown): void
}

export class BridgePlanner {
  private readonly lookahead: PartialLookahead<BridgePlanRequest, BridgePlan>

  constructor(ports: PlannerPorts) {
    this.lookahead = new PartialLookahead({
      request: (input) => ports.plan(input),
      fold: (_latest, plan) => plan,
      onResult: (plan, input) => ports.onPlan(plan, input),
      onFailure: (error) => ports.onFailure(error)
    })
  }

  /** Called when capture starts. The plan of the previous capture still reaches the end of speech that waits for it, and no longer counts as the latest. */
  reset(): void {
    this.lookahead.reset()
  }

  /** Takes an updated partial transcript. Text identical to the last one is not sent again. */
  observe(input: BridgePlanRequest): void {
    const text = input.text.trim()
    if (text.length >= MIN_PLAN_CHARS) this.lookahead.send({ ...input, text })
  }

  /** The latest plan, or null. The aizuchi is decided from this, because it cannot wait for a newer one. */
  current(): BridgePlan | null {
    return this.lookahead.current()
  }

  /**
   * Marks the end of speech. If this capture has no plan and nothing in flight it sends the last
   * partial transcript, and if a request is in flight it waits for it. Waiting is allowed here
   * because the bridging phrase only has to play before the answer itself.
   */
  finish(input: BridgePlanRequest): Promise<BridgePlan | null> {
    const text = input.text.trim()
    if (!this.lookahead.busy && this.lookahead.current() === null && text.length >= MIN_FINISH_CHARS) {
      this.lookahead.send({ ...input, text })
    }
    return this.lookahead.settled()
  }
}
