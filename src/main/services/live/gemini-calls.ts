import type { TurnEvent } from '@shared/ipc'
import { errMessage } from '@shared/api-errors'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { memoryIdsInToolResult } from '@shared/memory-injection'
import { ToolCallOrder } from '@shared/tool-call-order'
import type { ToolExecution, ToolExecutionTask } from '@shared/tool-registry'
import { conversationLocale } from '../conversation-locale'
import type { GeminiFunctionCall, GeminiLiveDeps, GeminiSession } from './gemini-live'

/**
 * The function calls of Gemini Live. Each one runs through the tool registry in the main process, so the
 * approval gate for writes keeps working, waits for its turn in one order, and has its result sent back
 * to the session it came from. A call Gemini cancels, or whose session ends, is aborted and answered to
 * no one.
 */

export interface GeminiCallsDeps extends Pick<GeminiLiveDeps, 'executeTool' | 'isParallel' | 'recordTool' | 'emitTurn'> {
  /** The session a result goes to, which is none while one is still opening or after it closed. */
  session: () => GeminiSession | null
  /** Marks the conversation as still going, which pushes back the idle close. */
  touch: () => void
  /** The memories a result has shown the session. */
  memoriesSent: (ids: readonly string[]) => void
}

/** Tells Gemini what came of a call it cancelled after the user had approved it. */
const CANCELLED_AFTER_APPROVAL: PromptText = {
  ja: `{notice} 取り消した呼び出しは、ユーザーが承認したあとだったので実行が始まっている: {result}`,
  en: `{notice} The call you cancelled had already been approved by the user, so it has started: {result}`
}

/** The result of a call whose tool failed instead of answering. It still goes back to the model, because Gemini waits for one. */
function failedExecution(err: unknown): ToolExecution {
  const content = errMessage(err)
  return { content, isError: true, durationMs: 0, resultLength: content.length, truncated: false }
}

export class GeminiCalls {
  /** The calls that still owe the model a result, waiting for their turn or running, by the id Gemini gave them. */
  private readonly running = new Map<string, AbortController>()
  /**
   * One order for all of the engine's calls rather than one per message, because a NON_BLOCKING call can
   * arrive while an earlier one still waits for approval.
   */
  private readonly order = new ToolCallOrder()

  constructor(private readonly deps: GeminiCallsDeps) {}

  /** Whether a call still runs, such as one waiting for approval, which gives no sign of life until it ends. */
  get working(): boolean {
    return this.running.size > 0
  }

  /** A call belongs to the exchange it arrived in, and it starts when the order lets it. */
  submit(call: GeminiFunctionCall, turnId: number): void {
    const id = call.id ?? ''
    const name = call.name ?? ''
    const emit = (event: TurnEvent): void => this.deps.emitTurn(event)
    const controller = new AbortController()
    this.running.set(id, controller)
    this.deps.touch()
    void this.order
      .run(this.deps.isParallel(name), () => {
        if (controller.signal.aborted) return null
        emit({ type: 'tool', turnId, name, status: 'start' })
        try {
          return this.deps.executeTool(name, call.args ?? {}, { turnId, signal: controller.signal, emit })
        } catch (err) {
          // executeClientTool reads the conversation language and the tool registry before it returns its
          // task, and either can throw, for instance on settings that cannot be read.
          return Object.assign(Promise.resolve(failedExecution(err)), { completion: Promise.resolve(), operationStarted: () => {} })
        }
      })
      .then((started) => (started ? this.answer(call, turnId, controller, started.work) : undefined))
      .catch((err: unknown) => console.error('gemini-live function call failed:', errMessage(err)))
      .finally(() => {
        if (this.running.get(id) === controller) this.running.delete(id)
      })
  }

  /** Gemini cancelled the calls. */
  cancel(ids: readonly string[]): void {
    for (const id of ids) {
      this.running.get(id)?.abort()
      this.running.delete(id)
    }
  }

  /**
   * The session that owed the calls their results is gone. Gemini offers no resumption handle while a
   * call runs, so no later session knows their ids.
   */
  abortAll(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  /** Sends the result to the model, unless Gemini cancelled the call or the session closed meanwhile. */
  private async answer(call: GeminiFunctionCall, turnId: number, controller: AbortController, task: ToolExecutionTask): Promise<void> {
    let execution: ToolExecution
    try {
      execution = await task
    } catch (err) {
      execution = failedExecution(err)
    }
    const id = call.id ?? ''
    const name = call.name ?? ''
    if (controller.signal.aborted) {
      // Gemini dropped the call, but an operation the user approved goes on, so what is known of it is
      // recorded and told to Gemini as context: it has no call left to answer.
      if (execution.unfinished) {
        this.deps.recordTool(turnId, name, call.args ?? {}, execution)
        const locale = conversationLocale()
        const text = fillPrompt(promptText(locale, CANCELLED_AFTER_APPROVAL), { notice: marker(locale, 'systemNotice'), result: execution.content })
        this.deps.session()?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false })
      }
      return
    }
    this.deps.emitTurn({ type: 'tool', turnId, name, status: execution.isError ? 'error' : 'done' })
    this.deps.recordTool(turnId, name, call.args ?? {}, execution)
    this.deps.touch()
    const session = this.deps.session()
    if (!session) return
    session.sendToolResponse({
      functionResponses: [
        {
          id,
          name,
          response: execution.isError ? { error: execution.content } : { result: execution.content },
          scheduling: 'WHEN_IDLE'
        }
      ]
    })
    this.deps.memoriesSent(memoryIdsInToolResult(name, execution))
  }
}
