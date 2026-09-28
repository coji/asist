import fs from 'node:fs'
import path from 'node:path'
import { expiredDatedFiles, localDateKey } from '@shared/local-date'
import type { ConversationPart, NativeOutput } from '@shared/conversation'
import { errorText } from '@shared/i18n/error-text'

/**
 * The conversation log. For each turn it appends the user's utterance, the assistant's utterance, the
 * tool calls, the messages sent to the API and the system notices, one record per line, to a daily
 * JSONL file at conversations/YYYY-MM-DD.jsonl. Memory curation and the restored conversation read it,
 * and the history sent to the API and the summaries are built from it.
 */

/** A notice from the app, recorded separately from what the user said. */
export type NoticeKind = 'job-done' | 'job-error'

export type ConversationRecord =
  | {
      t: number
      kind: 'user'
      turnId: number
      text: string
      /**
       * The note sent along with the utterance, such as the injected "[記憶]" block. The history
       * appends it after the text too, so that what the model read is preserved.
       */
      notes?: string
      /** The ids of the memories shown in the note. They are not injected again while they are still in the raw recent history. */
      memoryIds?: string[]
      /** The status of the agent jobs sent with the utterance. It is recorded only when it differs from the one the model read last. */
      jobStatus?: string
    }
  | {
      t: number
      kind: 'notice'
      turnId: number
      notice: NoticeKind
      text: string
      /** The note sent along with the notice, which the history appends after the text as it does for an utterance. */
      notes?: string
      /** The status of the agent jobs sent with the notice, recorded as for an utterance. */
      jobStatus?: string
    }
  | {
      t: number
      /**
       * A note the engine added to the model's context after the input it belongs to was recorded, such
       * as the memories Gemini Live finds for an utterance once its transcript is final. The history
       * appends it to that turn's notes, since the model read it there. It is not written with the
       * utterance, because holding the utterance back for the search would let the reply be recorded
       * before it.
       */
      kind: 'note'
      turnId: number
      text: string
      /** The ids of the memories the note shows. They are not injected again while the turn is still in the raw recent history. */
      memoryIds: string[]
    }
  | {
      t: number
      /**
       * A message sent to the API during the turn. These follow the user's utterance in the order
       * they were sent, and the next turn sends them in the same shape, so the history only grows at
       * the end and the prompt cache keeps working. An assistant message that contains tool calls is
       * recorded only once the user message with their results is ready, so that the history never
       * holds a tool call without a result.
       */
      kind: 'message'
      turnId: number
      role: 'user' | 'assistant'
      parts: ConversationPart[]
      /** The provider's output as returned, on assistant messages only. It is sent back as is to the same model of the same provider. */
      native?: NativeOutput
    }
  | {
      t: number
      kind: 'assistant'
      turnId: number
      text: string
      /** The turn was cut short: before-reply means the next utterance arrived before anything was spoken, while-speaking means it arrived mid-sentence. */
      interrupted?: 'before-reply' | 'while-speaking'
      /** The response failed part way through, for instance on an API error, and `text` holds what was spoken before that. */
      failed?: boolean
    }
  | {
      t: number
      /** The history after a compaction: the summary plus the records left raw. Startup replays from here. */
      kind: 'checkpoint'
      summary: string
      records: ConversationRecord[]
      /** Why the compaction ran and how much it removed, for observation only. */
      stats?: Record<string, unknown>
    }
  | {
      t: number
      kind: 'tool'
      turnId: number
      name: string
      /** The input as JSON, clipped. The full input is in the tool call of the message record of the same turn. */
      input: string
      /** The beginning of the result. The full result is in the tool result of the message record of the same turn. */
      result: string
      /** The length in characters of the full result, not of the clipped `result` above. */
      resultLength: number
      durationMs: number
      /** The result was returned to the model as a failure. */
      isError?: boolean
      truncated?: boolean
      /**
       * The ids of the memories included in the result, from recall. They are not
       * injected again while they are still in the raw recent history.
       */
      memoryIds?: string[]
    }

export type ConversationRecordInput = ConversationRecord extends infer R
  ? R extends ConversationRecord
    ? Omit<R, 't'>
    : never
  : never

const SUMMARY_MAX = 200

export function logFileName(date: Date): string {
  return `${localDateKey(date)}.jsonl`
}

/** Serializes the input to JSON and clips it at the limit; the full input stays in the message record. */
export function summarizeToolInput(input: unknown, max = SUMMARY_MAX): string {
  let text: string
  try {
    text = JSON.stringify(input) ?? ''
  } catch {
    text = String(input)
  }
  return clip(text, max)
}

/** Keeps only the beginning of the result; the length of the whole result is carried by resultLength. */
export function summarizeToolResult(result: string, max = SUMMARY_MAX): string {
  return clip(result, max)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** A message record must carry `parts`. A line without them comes from a different log format and is skipped as unreadable. */
const usable = (record: ConversationRecord): boolean =>
  record.kind === 'message' ? Array.isArray(record.parts) : record.kind === 'checkpoint' ? record.records.every(usable) : true

function parseRecord(line: string): ConversationRecord {
  const record = JSON.parse(line) as ConversationRecord
  if (!usable(record)) throw new Error(`conversation log: unreadable ${record.kind} record`)
  return record
}

export interface ConversationLogOptions {
  dir: string
  /** How many days of files are kept. Older daily files are removed when the date changes. */
  retentionDays: () => number
  now?: () => Date
  onError?: (stage: 'append' | 'prune' | 'read', err: unknown) => void
}

export class ConversationLog {
  private currentFile: string | null = null

  constructor(private readonly options: ConversationLogOptions) {}

  /** Appends the record and returns it with its timestamp, which is what the history applies unchanged. */
  append(record: ConversationRecordInput): ConversationRecord {
    const now = this.options.now?.() ?? new Date()
    const full = { t: now.getTime(), ...record } as ConversationRecord
    const file = path.join(this.options.dir, logFileName(now))
    try {
      if (file !== this.currentFile) {
        fs.mkdirSync(this.options.dir, { recursive: true })
        this.currentFile = file
        this.prune(now)
      }
      // The log holds everything said and every tool result, mail bodies included, so only the user may read it.
      fs.appendFileSync(file, JSON.stringify(full) + '\n', { mode: 0o600 })
    } catch (err) {
      this.options.onError?.('append', err)
    }
    return full
  }

  /** Reads the records of the last `days` days, today included, oldest first. */
  readRecent(days: number): ConversationRecord[] {
    const now = this.options.now?.() ?? new Date()
    const out: ConversationRecord[] = []
    for (let back = days - 1; back >= 0; back--) {
      out.push(...this.readDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)))
    }
    return out
  }

  /**
   * Reads that day's records oldest first, returning nothing when the file does not exist. A file that
   * exists but cannot be read throws, since an empty day would drop that day from the history. Unreadable
   * lines are skipped and reported to onError once per file.
   */
  readDay(date: Date): ConversationRecord[] {
    const file = path.join(this.options.dir, logFileName(date))
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(errorText('conversation.logUnreadable', { reason: (err as Error).message }), { cause: err })
    }
    const out: ConversationRecord[] = []
    let skipped = 0
    let firstError: unknown
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(parseRecord(line))
      } catch (err) {
        if (skipped++ === 0) firstError = err
      }
    }
    if (skipped > 0) {
      this.options.onError?.('read', new Error(`${path.basename(file)}: skipped ${skipped} unreadable line(s)`, { cause: firstError }))
    }
    return out
  }

  /** Removes the files of days past the retention period, once when the date changes. */
  private prune(today: Date): void {
    try {
      const retention = this.options.retentionDays()
      if (!Number.isInteger(retention) || retention < 1) {
        throw new Error(`invalid conversation log retention: ${retention}`)
      }
      for (const name of expiredDatedFiles(fs.readdirSync(this.options.dir), today, retention, 'jsonl')) {
        fs.rmSync(path.join(this.options.dir, name), { force: true })
      }
    } catch (err) {
      this.options.onError?.('prune', err)
    }
  }
}
