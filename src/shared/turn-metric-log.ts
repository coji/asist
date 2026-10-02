import { z } from 'zod'
import { CACHE_MISS_REASONS } from './cache-diagnosis'
import { BRIDGE_OUTCOMES, type TurnMetricLog } from './ipc'

/**
 * Validation of one line written to metrics.jsonl. It is the boundary at which the main process stops
 * trusting values that come from the renderer: unknown keys are dropped, and a number passes only when
 * it is finite and non-negative.
 */

const ms = z.number().finite().nonnegative()
const count = z.number().int().nonnegative()

const listeningAizuchi = z.object({
  kind: z.enum(['continuer', 'assessment']),
  source: z.enum(['model', 'text', 'both']),
  atMs: ms,
  continued: z.boolean()
})

export const turnMetricLogSchema = z.object({
  id: z.string().trim().min(1).max(200),
  revision: z.number().int().positive(),
  occurredAt: z.number().int().nonnegative(),
  typed: z.literal(true).optional(),
  vadMs: ms.optional(),
  vadMode: z.enum(['early', 'extended', 'fixed']).optional(),
  asrMs: ms.optional(),
  aizuchiMs: ms.optional(),
  aizuchiClipMs: ms.optional(),
  bridgeMs: ms.optional(),
  bridgeClipMs: ms.optional(),
  bridge: z.enum(BRIDGE_OUTCOMES).optional(),
  ttftMs: ms.optional(),
  ttsMs: ms.optional(),
  e2eMs: ms.optional(),
  inputTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheCreationTokens: count.optional(),
  outputTokens: count.optional(),
  contextTokens: count.optional(),
  rounds: count.optional(),
  toolCalls: count.optional(),
  resumed: z.literal(true).optional(),
  compacted: z.literal(true).optional(),
  injectedMemories: count.optional(),
  injectedTokens: count.optional(),
  memorySearchMs: ms.optional(),
  cacheMissReason: z.enum(CACHE_MISS_REASONS).optional(),
  /**
   * One utterance allows only a few aizuchi, because of the 5-second minimum interval and the
   * 20-second maximum utterance.
   */
  listening: z.array(listeningAizuchi).max(20).optional(),
  userBackchannels: count.optional(),
  bargeIns: count.optional()
})

export type ParsedTurnMetricLog = z.infer<typeof turnMetricLogSchema>

/** Throws with the reason when the value is invalid. An omitted field is absent, not undefined. */
export function parseTurnMetricLog(value: unknown): TurnMetricLog {
  return turnMetricLogSchema.parse(value) as TurnMetricLog
}
