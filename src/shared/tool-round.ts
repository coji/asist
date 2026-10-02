import type { ConversationMessage, ConversationPart } from './conversation'
import { promptText, type ConversationLocale, type PromptText } from './conversation-locale'
import { ToolCallOrder } from './tool-call-order'
import type { ToolExecution, ToolExecutionTask } from './tool-registry'

/**
 * Tool execution for one round. A tool starts as soon as its call is complete and ToolCallOrder lets
 * it, and results keep the order of the calls. On abort, tools that have not started get a synthesized
 * "interrupted" result, because a tool call without a result makes the next request invalid.
 */

export interface ToolUseCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolRoundResult {
  call: ToolUseCall
  execution: ToolExecution
}

export interface ToolRoundOptions {
  execute: (call: ToolUseCall, signal: AbortSignal) => ToolExecutionTask
  isParallel: (name: string) => boolean
  signal: AbortSignal
  /** The language the result is read in, because the model reads the synthesized "interrupted" result. */
  locale: ConversationLocale
  onStart?: (call: ToolUseCall) => void
  /** Called for every tool that started, an aborted round included, since the tool ran however it ended. */
  onFinish?: (result: ToolRoundResult) => void
}

export function interruptedExecution(locale: ConversationLocale, name: string): ToolExecution {
  const content = promptText(locale, {
    ja: `${name} はラウンドの終了により開始前に中断された。`,
    en: `${name} was interrupted before it started, because the round ended.`
  })
  return { content, isError: true, durationMs: 0, resultLength: content.length, truncated: false }
}

export class ToolRoundExecutor {
  private readonly entries: Array<{ call: ToolUseCall; task: Promise<ToolRoundResult>; completion: Promise<void> }> = []
  private readonly order = new ToolCallOrder()
  private readonly controller = new AbortController()
  readonly signal: AbortSignal

  constructor(private readonly options: ToolRoundOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal])
  }

  get size(): number {
    return this.entries.length
  }

  /** Starts the tool as soon as the order allows. */
  submit(call: ToolUseCall): Promise<ToolRoundResult> {
    const invocation = this.order.run(this.options.isParallel(call.name), () => {
      if (this.signal.aborted) return null
      this.options.onStart?.(call)
      return this.options.execute(call, this.signal)
    })
    const completion = invocation.then(async (started) => { await started?.work.completion })
    const task = invocation.then(async (started): Promise<ToolRoundResult> => {
      if (!started) return { call, execution: interruptedExecution(this.options.locale, call.name) }
      const result = { call, execution: await started.work }
      this.options.onFinish?.(result)
      return result
    })
    this.entries.push({ call, task, completion })
    return task
  }

  /** Resolves with every result, in submission order. */
  settle(): Promise<ToolRoundResult[]> {
    return Promise.all(this.entries.map((entry) => entry.task))
  }

  /** Stops tools that have not started and waits for running ones to clean up. It does not abort the parent turn's speech. */
  async close(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled(this.entries.flatMap((entry) => [entry.task, entry.completion]))
  }
}

const LAST_ROUND: PromptText = {
  ja: '[注: ツールを使えるのはここまで。次の応答ではツールを呼ばず、ここまでの結果で結論を短く話して終えること。この注記には言及しない]',
  en: '[Note: this is the last round with tools. Call no tool in your next reply; state the conclusion briefly from what you have and finish. Never mention this note.]'
}

/** Tells the model, one round before the limit, that the next response must finish without tools. */
export const lastRoundNote = (locale: ConversationLocale): string => promptText(locale, LAST_ROUND)

/**
 * Builds the next round's user message from the tool results, in call order. One round before the limit
 * it appends the last-round note, except after a response in which a provider-side tool (web search)
 * has not returned yet: text next to the results makes the API treat that search as abandoned and
 * reject the request.
 */
export function buildToolResultsMessage(
  results: readonly ToolRoundResult[],
  round: { index: number; maxRounds: number; allowNote?: boolean; locale: ConversationLocale }
): ConversationMessage {
  const parts: ConversationPart[] = results.map(({ call, execution }) => ({
    type: 'tool_result',
    callId: call.id,
    name: call.name,
    content: execution.content,
    ...(execution.isError ? { isError: true } : {})
  }))
  if (round.index === round.maxRounds - 2 && round.allowNote !== false) parts.push({ type: 'text', text: lastRoundNote(round.locale) })
  return { role: 'user', parts }
}
