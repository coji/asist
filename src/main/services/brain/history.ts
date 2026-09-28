import { userText, type ConversationMessage } from '@shared/conversation'
import { promptText, type ConversationLocale, type PromptText } from '@shared/conversation-locale'
import { estimateTokens } from '@shared/token-estimate'
import { interruptedBeforeReply, interruptedWhileSpeaking, markInterruptedReply } from '@shared/turn-recovery'
import type { ConversationRecord } from './conversation-log'
import { stampUserMessage } from './prompt'

/**
 * Builds the history sent to the API out of the conversation log. Records are applied in order to a
 * list of turns, from which both the messages for the API and the summary of the older part are
 * produced. At startup the latest checkpoint, which holds the whole compacted history, is the base and
 * only the records after it are replayed.
 *
 * The history is a single thread. The messages sent to the API during a turn, the assistant responses
 * and the user messages carrying tool results, are kept as message records and sent again in the same
 * shape on the next turn. Because nothing but the end changes, the prefix stays stable and the prompt
 * cache keeps working, and ids or paths a tool returned can still be referred to in later turns.
 *
 * Turns run one after another, so only the newest turn that has an input, an utterance or a notice,
 * can still be in progress, and the records that follow an input belong to it. A turn before it that
 * never got a reply will never get one: Gemini Live records what it said under an exchange of its
 * own, and a turn cut off by quitting or a crash is not resumed.
 *
 * Compaction is decided in tokens. The context length is the server's usage plus an estimate of what
 * was added since. Above compressAtTokens it runs when the conversation goes quiet; above limitTokens
 * it starts before the turn without being waited for; above hardLimitTokens, which is close to the API
 * window, a turn is not sent at all until it has finished, which guards against replaying a long log
 * with no checkpoint.
 *
 * A compaction keeps the most recent recentTurns turns raw and folds the turns before them, up to the
 * turn in progress, into one handover summary that replaces them. The summary is written from the
 * user and assistant text plus one line per tool with its name and input, because paths and ids
 * appear only in the input; tool results are not passed to it. If the turns kept raw alone exceed half the limit, fewer are
 * kept. Turns added while the summary is being written stay. The summary is rewritten from scratch
 * each time, so it does not grow with every compaction. The compacted history is written to the log as
 * a checkpoint, and a failed summary leaves the history untouched: a crash during the summary call
 * changes nothing, and after a restart the last checkpoint and the records after it rebuild the same
 * state and the attempt is repeated at the next quiet moment.
 */

export interface HistoryTurn {
  t: number
  turnId: number
  /** What the user said or the text of a system notice. It is absent on a turn that only speaks a prepared sentence. */
  user?: string
  notice?: boolean
  /**
   * The reply in the assistant record of the log: brain's text, which GPT-Live rewords as it reads it,
   * or under Gemini Live the transcript of what was spoken. It is what the display and the summary use
   * for turns that have no messages.
   */
  assistant?: string
  interrupted?: 'before-reply' | 'while-speaking'
  failed?: boolean
  /** The messages sent to the API during the turn, after the user's utterance. Tool calls and their results live here. */
  messages: ConversationMessage[]
  /** The note injected alongside the input, which the history also appends after the text. */
  notes?: string
  /** The job status sent with the input, which follows the notes. A turn carries it only when it changed, so the newest one is the one in force. */
  jobStatus?: string
  /** The ids of the memories shown to the model in this turn, from the note and from recall. */
  memoryIds: string[]
  /** The original records, kept so the turn can be written back into a checkpoint. */
  records: ConversationRecord[]
}

/** A text-only history for the voice model, without the tool round trips. */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export type CompactionReason = 'quiet' | 'limit' | 'daily'

export interface CompactionStats {
  reason: CompactionReason
  beforeTokens: number
  afterTokens: number
  summaryChars: number
  summarizedTurns: number
}

export interface HistoryCheckpoint {
  summary: string
  records: ConversationRecord[]
  stats?: CompactionStats
}

export interface HistoryOptions {
  /** How many of the most recent turns stay raw through a compaction. */
  recentTurns: number
  /** Above this context length the history is compacted at the next quiet moment. */
  compressAtTokens: number
  /** Above this context length the compaction starts before the turn, without being waited for. */
  limitTokens: number
  /** Above this context length no turn is sent until a compaction brings it down, as a guard against the API window. */
  hardLimitTokens: number
  /** The records read at startup, oldest first. They may include the latest checkpoint. */
  load: () => ConversationRecord[]
  /** Writes the compacted history to the log as a checkpoint. */
  saveCheckpoint: (checkpoint: HistoryCheckpoint) => void
  /** Takes the existing summary and the newer log, and returns the two merged into one handover summary. */
  summarize: (existingSummary: string, log: string) => Promise<string>
  /** The language the conversation is held in, read on every render so that a change applies at once. */
  locale: () => ConversationLocale
  onError?: (stage: 'summarize' | 'checkpoint', err: unknown) => void
}

const hasReply = (turn: HistoryTurn): boolean =>
  turn.assistant !== undefined || Boolean(turn.interrupted) || Boolean(turn.failed)

/** What stands in the history where the assistant said nothing the model can read back. */
const FAILED_MID_REPLY: PromptText = { ja: `(応答が途中で失敗した)`, en: `(the reply failed part way through)` }
const SAID_NOTHING: PromptText = { ja: `(無言)`, en: `(said nothing)` }
/** The speaker labels of the plain transcript the summarizer reads. */
const LOG_USER: PromptText = { ja: `ユーザー`, en: `User` }
const LOG_NOTICE: PromptText = { ja: `システム通知`, en: `System notice` }
const LOG_ASSISTANT: PromptText = { ja: `アシスタント`, en: `Assistant` }
const LOG_TOOL: PromptText = { ja: `ツール`, en: `tool` }
const LOG_TOOL_FAILED: PromptText = { ja: ` → 失敗`, en: ` -> failed` }

/** A system notice interrupted before any reply is withdrawn, because the retry of the report puts it back. */
const withdrawn = (turn: HistoryTurn): boolean => Boolean(turn.notice) && turn.interrupted === 'before-reply'

/** The part of what was spoken that is not already in the text of the assistant messages sent during the turn. */
function unsentReply(turn: HistoryTurn): string {
  const spoken = turn.assistant ?? ''
  let sent = ''
  for (const message of turn.messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) if (part.type === 'text') sent += part.text
  }
  return sent && spoken.startsWith(sent) ? spoken.slice(sent.length) : spoken
}

function highestTurnId(records: readonly ConversationRecord[]): number {
  let highest = 0
  for (const record of records) {
    const id = record.kind === 'checkpoint' ? highestTurnId(record.records) : record.turnId
    if (id > highest) highest = id
  }
  return highest
}

/** An estimate of what is sent. The provider's raw output is not counted, because it replaces `parts` rather than adding to it. */
const messageTokens = (message: ConversationMessage): number => estimateTokens(JSON.stringify(message.parts))

export class ConversationHistory {
  private turns: HistoryTurn[] = []
  private summaryText = ''
  private loaded = false
  private compacting: Promise<void> | null = null
  /** The context length the server counted last; without it only the estimate is available. */
  private measuredTokens: number | null = null
  /** An estimate of what was added since that measurement. */
  private addedTokens = 0
  /** How many checkpoints this history has written, which tells a measurement whether the history it measured is still the current one. */
  private checkpoints = 0
  private highestLoadedTurnId = 0

  constructor(private readonly options: HistoryOptions) {}

  /**
   * Reads the log into the history on first use. A read that fails throws and leaves the history unloaded
   * for the next use to try again: a conversation that went on without its history would reply without
   * context, and a checkpoint written from it would leave the earlier turns out of every later replay.
   */
  ensureLoaded(): void {
    if (this.loaded) return
    let records = this.options.load()
    this.loaded = true
    this.highestLoadedTurnId = highestTurnId(records)
    const checkpointIndex = records.map((r) => r.kind).lastIndexOf('checkpoint')
    if (checkpointIndex >= 0) {
      const checkpoint = records[checkpointIndex] as Extract<ConversationRecord, { kind: 'checkpoint' }>
      this.summaryText = checkpoint.summary
      for (const record of checkpoint.records) this.apply(record)
      records = records.slice(checkpointIndex + 1)
    }
    for (const record of records) this.apply(record)
    this.addedTokens = 0
  }

  get summary(): string {
    return this.summaryText
  }

  /**
   * The highest turn id in the records read at startup, those before the latest checkpoint and inside
   * it included. The ids of a new launch continue after it, so that none of them is the id of a turn
   * the history replayed or of an earlier turn in the same day's log.
   */
  get highestTurnId(): number {
    return this.highestLoadedTurnId
  }

  /** The number of turns still sent raw. */
  get turnCount(): number {
    return this.turns.length
  }

  /** Applies a record appended to the log, on the same path for the startup replay and for the live conversation. */
  apply(record: ConversationRecord): void {
    if (record.kind === 'checkpoint') return
    if (record.kind === 'user' || record.kind === 'notice') {
      const { notes, jobStatus } = record
      this.turns.push({
        t: record.t,
        turnId: record.turnId,
        user: record.text,
        ...(record.kind === 'notice' ? { notice: true } : {}),
        ...(notes ? { notes } : {}),
        ...(jobStatus ? { jobStatus } : {}),
        messages: [],
        memoryIds: record.kind === 'user' ? [...(record.memoryIds ?? [])] : [],
        records: [record]
      })
      this.addedTokens += estimateTokens(record.text) + (notes ? estimateTokens(notes) : 0) + (jobStatus ? estimateTokens(jobStatus) : 0)
      return
    }
    if (record.kind === 'note') {
      // A live engine can finish a note after the next utterance was recorded, so the note looks for its
      // own turn rather than taking the current one. A turn already folded into the summary takes nothing.
      const turn = this.turns.findLast((candidate) => candidate.turnId === record.turnId && candidate.user !== undefined)
      if (!turn) return
      turn.notes = turn.notes ? `${turn.notes}\n\n${record.text}` : record.text
      turn.memoryIds.push(...record.memoryIds)
      turn.records.push(record)
      this.addedTokens += estimateTokens(record.text)
      return
    }
    const current = this.currentIndex()
    const own = current >= 0 && this.turns[current].turnId === record.turnId ? this.turns[current] : undefined
    // Gemini Live records what it said as soon as its transcript settles, which can be while the turn's
    // tools are still running, so the tool round trip recorded after that still belongs to the turn.
    if (record.kind === 'tool') {
      if (own) {
        if (record.memoryIds) own.memoryIds.push(...record.memoryIds)
        own.records.push(record)
      }
      return
    }
    if (record.kind === 'message') {
      if (own) {
        const message: ConversationMessage = { role: record.role, parts: record.parts, ...(record.native ? { native: record.native } : {}) }
        own.messages.push(message)
        own.records.push(record)
        this.addedTokens += messageTokens(message)
      }
      return
    }
    this.addedTokens += estimateTokens(record.text)
    if (own && !hasReply(own)) {
      own.assistant = record.text
      if (record.interrupted) own.interrupted = record.interrupted
      if (record.failed) own.failed = true
      own.records.push(record)
      return
    }
    this.turns.push({
      t: record.t,
      turnId: record.turnId,
      assistant: record.text,
      ...(record.interrupted ? { interrupted: record.interrupted } : {}),
      ...(record.failed ? { failed: true } : {}),
      messages: [],
      memoryIds: [],
      records: [record]
    })
  }

  /** The ids of the memories already shown to the model in the raw history. An id drops out once its turn is folded into the summary. */
  shownMemoryIds(): Set<string> {
    return new Set(this.turns.flatMap((turn) => turn.memoryIds))
  }

  /** The job status the model last read in the raw history, or null when no turn sent raw carries one any more. */
  lastJobStatus(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]
      if (turn.jobStatus && !withdrawn(turn)) return turn.jobStatus
    }
    return null
  }

  /**
   * The message list for an API request. The user's text carries a stamp of when it was spoken, and
   * the messages sent during the turn follow unchanged. A turn that was interrupted or failed gets an
   * assistant message holding what was spoken plus a marker. A turn's messages never contain a tool
   * call on its own, because a call is only recorded together with its result.
   */
  toMessages(): ConversationMessage[] {
    const out: ConversationMessage[] = []
    for (const turn of this.turns) {
      if (withdrawn(turn)) continue
      if (turn.user !== undefined) {
        const body = turn.notice ? turn.user : stampUserMessage(this.options.locale(), turn.user, new Date(turn.t))
        out.push(userText([body, turn.notes, turn.jobStatus].filter(Boolean).join('\n\n')))
      }
      out.push(...turn.messages)
      if (!hasReply(turn)) continue
      const tail = turn.messages.length > 0 ? turn.messages[turn.messages.length - 1] : undefined
      // On an ordinary turn that ends with assistant text, that text already holds what was spoken.
      if (tail?.role === 'assistant' && !turn.interrupted && !turn.failed) continue
      // Only what is missing from the sent messages, such as text spoken after resuming a dropped
      // stream, is appended together with the marker.
      const remainder = unsentReply(turn)
      const locale = this.options.locale()
      const content = turn.interrupted
        ? turn.interrupted === 'while-speaking'
          ? `${remainder}${interruptedWhileSpeaking(locale)}`
          : interruptedBeforeReply(locale)
        : turn.failed
          ? `${remainder}${promptText(locale, FAILED_MID_REPLY)}`
          : remainder || promptText(locale, SAID_NOTHING)
      out.push({ role: 'assistant', parts: [{ type: 'text', text: content }] })
    }
    return out
  }

  /** A text-only history of what the user said and the replies, used as the initial context of a live engine. */
  toTranscript(): HistoryMessage[] {
    const locale = this.options.locale()
    const out: HistoryMessage[] = []
    for (const turn of this.turns) {
      if (withdrawn(turn)) continue
      if (turn.user !== undefined) out.push({ role: 'user', content: turn.user })
      if (!hasReply(turn)) continue
      out.push({
        role: 'assistant',
        content: turn.interrupted
          ? markInterruptedReply(locale, turn.assistant ?? '')
          : turn.failed
            ? `${turn.assistant ?? ''}${promptText(locale, FAILED_MID_REPLY)}`
            : turn.assistant || promptText(locale, SAID_NOTHING)
      })
    }
    return out
  }

  /** Changes whenever a compaction or a new summary rewrites the history, so a request can say which history it was built from. */
  get revision(): number {
    return this.checkpoints
  }

  /**
   * Receives the context length the server counted for a request, which is the total input of its last
   * round, together with the revision the request was built from. A request built before a compaction
   * finished still carried the turns it removed, so its count no longer describes the history, and the
   * estimate the compaction left stands instead.
   */
  noteContextTokens(tokens: number, revision: number): void {
    if (revision !== this.checkpoints) return
    this.measuredTokens = tokens
    this.addedTokens = 0
  }

  /** The current estimate of the context length, falling back to an estimate over the history alone when nothing was measured. */
  get contextTokens(): number {
    if (this.measuredTokens !== null) return this.measuredTokens + this.addedTokens
    return this.historyTokens()
  }

  private historyTokens(): number {
    return estimateTokens(this.summaryText) + this.toMessages().reduce((n, message) => n + messageTokens(message), 0)
  }

  /** The newest turn that has an input, which is the only one that can still be in progress; -1 when there is none. */
  private currentIndex(): number {
    for (let i = this.turns.length - 1; i >= 0; i--) if (this.turns[i].user !== undefined) return i
    return -1
  }

  /** Where the turn still in progress begins, or the end when every turn is over. */
  private settledBoundary(): number {
    const current = this.currentIndex()
    return current >= 0 && !hasReply(this.turns[current]) ? current : this.turns.length
  }

  /** How far the compaction reaches: the turns that are over, minus the most recent recentTurns of them. */
  private compactionBoundary(): number {
    let boundary = Math.min(this.settledBoundary(), Math.max(0, this.turns.length - this.options.recentTurns))
    // If the turns kept raw alone exceed half the limit, fewer of them are kept until they fit.
    const settledEnd = this.settledBoundary()
    let kept = 0
    for (let i = this.turns.length - 1; i >= boundary; i--) kept += this.turnTokens(this.turns[i])
    while (kept > this.options.limitTokens / 2 && boundary < settledEnd) {
      kept -= this.turnTokens(this.turns[boundary])
      boundary++
    }
    return boundary
  }

  /**
   * Whether a compaction is needed: none, soon at the next quiet moment, now meaning it starts before
   * the turn, or block meaning it starts and no turn is sent until it has finished.
   */
  needsCompaction(): 'none' | 'soon' | 'now' | 'block' {
    if (this.compactionBoundary() === 0) return 'none'
    const tokens = this.contextTokens
    if (tokens >= this.options.hardLimitTokens) return 'block'
    if (tokens >= this.options.limitTokens) return 'now'
    if (tokens >= this.options.compressAtTokens) return 'soon'
    return 'none'
  }

  /**
   * Runs a compaction, and a second call joins the one already running. The turns over by the moment
   * it starts are folded into a handover summary and removed from the history, while turns added after
   * that stay. The 'daily' reason takes the same path; the cleanup job passes it
   * regardless of the thresholds. A failed summary changes nothing and reports why.
   */
  compact(reason: CompactionReason): Promise<void> {
    if (this.compacting) return this.compacting
    this.compacting = this.runCompaction(reason).finally(() => {
      this.compacting = null
    })
    return this.compacting
  }

  private async runCompaction(reason: CompactionReason): Promise<void> {
    const locale = this.options.locale()
    const boundary = this.compactionBoundary()
    if (boundary === 0) return
    const beforeTokens = this.contextTokens
    const target = this.turns.slice(0, boundary)
    const lines: string[] = []
    for (const turn of target) {
      if (withdrawn(turn)) continue
      const speaker = promptText(locale, turn.notice ? LOG_NOTICE : LOG_USER)
      if (turn.user !== undefined) lines.push(`${speaker}: ${turn.user}`)
      for (const record of turn.records) {
        if (record.kind !== 'tool') continue
        const failed = record.isError ? promptText(locale, LOG_TOOL_FAILED) : ''
        lines.push(`(${promptText(locale, LOG_TOOL)} ${record.name} ${record.input}${failed})`)
      }
      if (turn.assistant !== undefined) lines.push(`${promptText(locale, LOG_ASSISTANT)}: ${turn.assistant}`)
    }
    if (lines.length === 0) return

    let summary: string
    try {
      summary = (await this.options.summarize(this.summaryText, lines.join('\n'))).trim()
      if (!summary) throw new Error('summary is empty')
    } catch (err) {
      this.options.onError?.('summarize', err)
      return
    }

    // Turns added while the summary was being written sit after the target, so removing the first
    // `boundary` entries leaves them in place.
    let saved = 0
    for (const turn of target) saved += this.turnTokens(turn)
    this.turns.splice(0, boundary)
    saved += estimateTokens(this.summaryText) - estimateTokens(summary)
    this.summaryText = summary
    this.commit(
      {
        reason,
        beforeTokens,
        afterTokens: Math.max(0, beforeTokens - saved),
        summaryChars: summary.length,
        summarizedTurns: target.length
      },
      saved
    )
  }

  private turnTokens(turn: HistoryTurn): number {
    return (
      (turn.user !== undefined ? estimateTokens(turn.user) : 0) +
      (turn.notes ? estimateTokens(turn.notes) : 0) +
      (turn.jobStatus ? estimateTokens(turn.jobStatus) : 0) +
      (turn.messages.length === 0 && turn.assistant !== undefined ? estimateTokens(turn.assistant) : 0) +
      turn.messages.reduce((n, message) => n + messageTokens(message), 0)
    )
  }

  /** Applies the result of a compaction to the context length estimate and writes the checkpoint. */
  private commit(stats: CompactionStats, savedTokens: number): void {
    if (this.measuredTokens !== null) this.measuredTokens = Math.max(0, this.measuredTokens - savedTokens)
    this.checkpoints++
    try {
      this.options.saveCheckpoint({
        summary: this.summaryText,
        records: this.turns.flatMap((turn) => turn.records),
        stats
      })
    } catch (err) {
      this.options.onError?.('checkpoint', err)
    }
  }

  /** The time of the oldest turn still sent raw, or null when the history is empty. */
  rawWindowStart(): number | null {
    return this.turns.length > 0 ? this.turns[0].t : null
  }

  /** Replaces the summary to keep it short after the cleanup job has turned the conversation into episodes. The recent turns stay. */
  replaceSummary(summary: string): void {
    const next = summary.trim()
    if (next === this.summaryText) return
    this.summaryText = next
    this.commit(
      {
        reason: 'daily',
        beforeTokens: this.contextTokens,
        afterTokens: this.contextTokens,
        summaryChars: next.length,
        summarizedTurns: 0
      },
      0
    )
  }
}
