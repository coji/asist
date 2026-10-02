import { conversationFeatures, type ConversationLocale } from './conversation-locale'

/** Set phrases Whisper often produces out of silence or noise. They were collected from Japanese recognition. */
const HALLUCINATION_PATTERNS = [
  /^ご視聴ありがとうございました/,
  /^ご清聴ありがとうございました/,
  /^チャンネル登録/,
  /^お疲れ様でした[。.]?$/,
  /^ありがとうございました[。.]?$/,
  /^字幕/,
  /^[(（[【].*[)）\]】]$/
]

/**
 * A character that carries content. It is written as a Unicode property so that Devanagari and
 * Hangul count as much as Latin letters and kana do, and a transcript of nothing but punctuation or
 * symbols is still refused.
 */
const CONTENT_CHAR = /[\p{L}\p{N}]/u

/**
 * Whether a transcript is worth starting a turn on. The minimum length and the ceiling on repeating
 * one character hold in any language; the set phrases above are Japanese and apply only there, where
 * everywhere else the Silero VAD verdict is what keeps noise out. A single character is refused even
 * in Korean, where 네 is a whole word, because the recognizer writes the sentence-ending punctuation
 * that takes such an answer over the minimum.
 */
export function isMeaningfulTranscript(text: string, locale: ConversationLocale): boolean {
  const trimmed = text.trim()
  // Counted in code points: a string's length counts a kanji outside the Basic Multilingual Plane, such as
  // `𠮷`, twice.
  const chars = [...trimmed]
  if (chars.length < 2) return false
  if (!CONTENT_CHAR.test(trimmed)) return false
  const counts = new Map<string, number>()
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1)
  if (Math.max(...counts.values()) / chars.length > 0.6) return false
  if (!conversationFeatures(locale).hallucinationList) return true
  return !HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed))
}
