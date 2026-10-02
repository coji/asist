import { SegmentAssembler } from '@shared/segmenter'
import { conversationLocale } from '../conversation-locale'
import { conversationOwner, currentSpeechRoute, emit, history, record, turnScheduler } from './session'

/**
 * Speaks a prepared sentence without going through the LLM. It goes to the session's speech route.
 * On an engine where the model itself decides what to say (Gemini Live) the model reads the sentence
 * and records it from its own output transcript. Nothing starts while a user turn is in progress. The
 * sentence reaches the screen as the text of its turn, as a reply does, and is written to the
 * conversation log as an assistant utterance.
 */
export async function interject(text: string): Promise<void> {
  const owner = conversationOwner()
  if (owner) {
    await owner.say(text)
    return
  }
  const route = currentSpeechRoute()
  const handle = turnScheduler.startIfIdle(async ({ turnId, signal }) => {
    // A user turn that replaced this one before it began has nothing of it to close.
    if (signal.aborted) return
    emit({ type: 'started', turnId, origin: 'interject' })
    history.ensureLoaded()
    emit({ type: 'delta', turnId, text })
    const locale = conversationLocale()
    const synth = route.open({ turnId, signal, emit, locale })
    const assembler = new SegmentAssembler(locale)
    for (const s of assembler.push(text + '\n').sentences) synth.push(s)
    for (const s of assembler.flush()) synth.push(s)
    await synth.drain()
    // A newer turn that took over meanwhile leaves unknown how much of the sentence was heard, so it is
    // not recorded.
    if (!signal.aborted) record({ kind: 'assistant', turnId, text })
    emit({ type: 'done', turnId, fullText: text })
  })
  if (!handle) return
  await handle.completion
}
