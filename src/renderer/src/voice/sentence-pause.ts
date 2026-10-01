/**
 * The pause before the next piece of an answer, by how the piece before it ends. Every engine leaves only
 * about 0.1 s of silence between two pieces: the shaper keeps 100 ms after the voice of a local engine and
 * little before it, and the HTTP engines are asked for 0.1 s after a sentence and none before it. That is
 * short at the end of a sentence, and the pieces split at a comma of a long Japanese sentence need a breath
 * as well. With these added, a sentence is followed by about 0.55 s of silence and a comma by about 0.15 s.
 * Listened to on 2026-10-01 with Irodori-TTS: 0.35 s after a sentence still ran the sentences together.
 */
const SENTENCE_PAUSE_MS = 450
const CLAUSE_PAUSE_MS = 50

/** A closing mark that can follow the punctuation that ends a piece. */
const CLOSING = /[\s」』）)\]】"'”’]+$/u
/** The marks a piece that ends inside a sentence ends with. */
const CLAUSE_END = /[、，,;；:：]$/u

/** The pause in milliseconds to leave after a piece of an answer that reads `text`. */
export function pauseAfter(text: string): number {
  // A piece ends at a sentence's end, at a line break or at the end of the reply unless it was cut at a comma.
  return CLAUSE_END.test(text.replace(CLOSING, '')) ? CLAUSE_PAUSE_MS : SENTENCE_PAUSE_MS
}
