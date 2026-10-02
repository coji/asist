import mitt, { type Emitter } from 'mitt'
import type { TurnEvent } from '@shared/ipc'
import { errMessage } from '@shared/api-errors'
import type { RequestFingerprint } from '@shared/cache-diagnosis'
import { LatestTurnScheduler } from '@shared/turn-scheduler'
import { dataPath } from '../store'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'
import { ConversationLog, type ConversationRecord, type ConversationRecordInput, type SystemNotice } from './conversation-log'
import { ConversationHistory } from './history'
import { summarizeHandoff } from './summarizer'
import { silentRoute, ttsRoute, type SpeechRoute } from './speech-route'

/**
 * The shared state of the brain: turn execution, interjections and job reporting all use the same
 * events, scheduler, conversation log and history. The conversation is stored in the log, and both the
 * messages sent to the API and the summaries are derived from it.
 */

type Events = { event: TurnEvent }
export const events: Emitter<Events> = mitt<Events>()
export const emit = (event: TurnEvent): void => events.emit('event', event)

/**
 * Exactly one turn runs at a time: a new input aborts the running turn before it starts. Turn ids
 * continue after the ones the history replays from the log: a record of this launch that came before
 * its first input would otherwise attach to the last turn of an earlier launch that had the same id.
 */
export const turnScheduler = new LatestTurnScheduler(() => {
  history.ensureLoaded()
  return history.highestTurnId + 1
})

/** Where runTurn and interject hand their sentences, by the text-to-speech setting. */
export const currentSpeechRoute = (): SpeechRoute => (getSettings().ttsEngine === 'none' ? silentRoute : ttsRoute)

/**
 * An engine where the model itself decides what to say, such as Gemini Live. While one is registered,
 * job reports and interjections go to it instead of starting a brain turn, and the model says them in
 * its own voice within the conversation.
 */
export interface ConversationOwner {
  /**
   * A notification from the app, such as a finished job, which the model reports in the flow of the
   * conversation. The owner writes it to the conversation log itself, after it has waited for the
   * session that is to read it.
   */
  notify(notice: SystemNotice): Promise<void>
  /** Reads the given sentence verbatim, for example when a timer runs out. */
  say(text: string): Promise<void>
}
let owner: ConversationOwner | null = null
export const conversationOwner = (): ConversationOwner | null => owner
export function setConversationOwner(next: ConversationOwner | null): void {
  owner = next
}

/**
 * Context length thresholds in tokens. Above COMPRESS_AT_TOKENS the history is compacted during a gap
 * in the conversation of five minutes; above LIMIT_TOKENS the compaction starts before the turn,
 * without holding up the speech. The history keeps tool round trips raw and therefore grows fast, but
 * appending at the end keeps the prompt cache warm, so the limit stays at 200,000 with plenty of room
 * inside a 1M window.
 */
export const COMPRESS_AT_TOKENS = 100_000
export const LIMIT_TOKENS = 200_000
/**
 * Above this no turn is sent until a compaction brings the context down. It guards against replaying
 * a long log that has no checkpoint, and stays well below the 1M API window.
 */
export const HARD_LIMIT_TOKENS = 800_000
/** How many of the most recent turns stay raw through a compaction, so that card ids, paths and the thread of the conversation survive. */
const RECENT_TURNS = 30
/** How many days of the conversation log are replayed at startup: today and yesterday. */
const REPLAY_DAYS = 2

export const conversationLog = new ConversationLog({
  dir: dataPath('conversations'),
  retentionDays: () => getSettings().conversationLogRetentionDays,
  onError: (stage, err) => console.error(`conversation log ${stage} failed:`, errMessage(err))
})

export const history = new ConversationHistory({
  recentTurns: RECENT_TURNS,
  compressAtTokens: COMPRESS_AT_TOKENS,
  limitTokens: LIMIT_TOKENS,
  hardLimitTokens: HARD_LIMIT_TOKENS,
  load: () => conversationLog.readRecent(REPLAY_DAYS),
  saveCheckpoint: (checkpoint) => {
    conversationLog.append({
      kind: 'checkpoint',
      summary: checkpoint.summary,
      records: checkpoint.records,
      ...(checkpoint.stats ? { stats: { ...checkpoint.stats } } : {})
    })
  },
  summarize: summarizeHandoff,
  locale: conversationLocale,
  onError: (stage, err) => console.error(`history ${stage} failed:`, errMessage(err))
})

/** The time of the last append to the conversation log, which decides whether the conversation has a gap long enough for compaction and the cleanup jobs. */
let lastActivityAt: number | null = null
export const lastActivity = (): number | null => lastActivityAt

/** Appends to the conversation log and applies the same record to the history: the log is authoritative and the history is derived from it. */
export function record(input: ConversationRecordInput): ConversationRecord {
  // The history reads the log when it is first used. Reading it after this append would apply the
  // record a second time, behind the older records it replays.
  history.ensureLoaded()
  const full = conversationLog.append(input)
  history.apply(full)
  lastActivityAt = full.t
  return full
}

let lastFingerprint: RequestFingerprint | null = null
export const lastRequestFingerprint = (): RequestFingerprint | null => lastFingerprint
export function noteRequestFingerprint(fingerprint: RequestFingerprint): void {
  lastFingerprint = fingerprint
}
