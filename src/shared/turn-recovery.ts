import { hasContent, toolCallsOf, type ConversationMessage, type ConversationPart } from './conversation'
import { promptText, type ConversationLocale, type PromptText } from './conversation-locale'
import type { ToolRoundResult } from './tool-round'

/**
 * Resuming a turn after a response stopped short, and marking interrupted replies in the history.
 * - A disconnect after speech has started, or the output limit, appends the confirmed part as the
 *   assistant message and resumes with a user message that asks for the rest without repetition.
 * - An interruption keeps what was spoken, followed by a marker. The user utterance stays in the
 *   history even when the interruption came before any reply.
 * - A response that an interruption or a failure ends while its tools run keeps its tool calls with
 *   their results.
 */

const BEFORE_REPLY: PromptText = { ja: '(応答前に次の発話が来た)', en: '(the next utterance arrived before any reply)' }
const WHILE_SPEAKING: PromptText = { ja: '(ここで割り込まれた)', en: '(interrupted here)' }
const RESUME_NOTE: PromptText = {
  ja: '直前の応答が通信の乱れで途切れた。すでに話した内容を繰り返さず、残りを短く続けてください。この注記には言及しない。',
  en: 'The reply you were giving was cut off by a connection problem. Continue with what is left, briefly, without repeating what you already said. Never mention this note.'
}

/** Stands in for the assistant reply when the user interrupted before any of it was spoken. */
export const interruptedBeforeReply = (locale: ConversationLocale): string => promptText(locale, BEFORE_REPLY)
/** Follows the spoken part of a reply that the user interrupted. */
export const interruptedWhileSpeaking = (locale: ConversationLocale): string => promptText(locale, WHILE_SPEAKING)
/** Asks the model to continue after a disconnect. It is a user message because not every provider accepts assistant prefill. */
export const resumeAfterDisconnectNote = (locale: ConversationLocale): string => promptText(locale, RESUME_NOTE)

export function markInterruptedReply(locale: ConversationLocale, visibleReply: string): string {
  return visibleReply ? `${visibleReply}${interruptedWhileSpeaking(locale)}` : interruptedBeforeReply(locale)
}

/**
 * The messages appended to resume a response that stopped short: the confirmed part of the response,
 * then a user message with a result for every confirmed tool call and the note asking for the rest. A
 * tool call without a result makes the next request invalid, so a missing result throws. A response that
 * confirmed nothing, such as one whose only tool call the output limit cut off, is left out with whatever
 * provider output it carries: an assistant message without content is refused anywhere but at the end of
 * a request, and so is a reasoning item with nothing after it.
 */
export function buildResumeMessages(
  recorded: ConversationMessage,
  results: readonly ToolRoundResult[],
  note: string
): ConversationMessage[] {
  const request: ConversationMessage = { role: 'user', parts: [...answerCalls(recorded, results), { type: 'text', text: note }] }
  return hasContent(recorded) ? [recorded, request] : [request]
}

/**
 * The messages that keep the tool calls of a response the turn ended on before its round was over, such
 * as one the user cut off or one that failed: the confirmed part of the response, then a user message
 * with a result for every call in it. The tools have run, or were stopped, by then, and a model that
 * cannot read what came of them may do again what was already done. The turn's assistant record holds
 * what was said, so only a response with a tool call needs this.
 */
export function buildStoppedCallMessages(recorded: ConversationMessage, results: readonly ToolRoundResult[]): ConversationMessage[] {
  return [recorded, { role: 'user', parts: answerCalls(recorded, results) }]
}

/** A result for every tool call of the response, in its order. A call without one makes the next request invalid, so a missing result throws. */
function answerCalls(recorded: ConversationMessage, results: readonly ToolRoundResult[]): ConversationPart[] {
  const byId = new Map(results.map((r) => [r.call.id, r]))
  return toolCallsOf(recorded).map((call): ConversationPart => {
    const result = byId.get(call.id)
    if (!result) throw new Error(`tool call ${call.id} (${call.name}) has no result`)
    return {
      type: 'tool_result',
      callId: call.id,
      name: call.name,
      content: result.execution.content,
      ...(result.execution.isError ? { isError: true } : {})
    }
  })
}
