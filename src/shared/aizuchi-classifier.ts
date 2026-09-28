import type { AizuchiCategory } from './ipc'

/**
 * The aizuchi classifier, together with the stdout protocol of its worker (resources/aizuchi_worker.py).
 * The model is sbintuitions/modernbert-ja-70m fine-tuned on synthetic data
 * (20 situations x 13 classes) and exported as int8 ONNX. Its input is the previous assistant
 * utterance, `[SEP]`, and the user's partial transcript; punctuation and whitespace are dropped as
 * they were during training, because ASR punctuates inconsistently and the training data was skewed
 * (only `check` carried "?" often). Its output is a probability per class plus the probability that
 * the utterance is finished. Measured on 2026-09-20 on an M5 with one CPU thread: 1.7 ms per
 * sentence, macro-F1 0.91 on three unseen situations and 0.80 on sentences truncated at 75%.
 */

export interface AizuchiModelFile {
  repo: string
  revision: string
  file: string
  sha256: string
  bytes: number
}

export const AIZUCHI_CLASSES = [
  'none',
  'flow',
  'ack',
  'work',
  'think',
  'check',
  'understand',
  'agree',
  'empathy',
  'cheer',
  'surprise',
  'correct',
  'hold'
] as const

export type AizuchiClass = (typeof AIZUCHI_CLASSES)[number]

const REPO = 'sakasegawa/asist-aizuchi-ja'
const REVISION = 'ff35d53a8224a4937e34e606299091c79b2d432e'

export const AIZUCHI_MODEL = {
  label: 'ModernBERT-ja 70m',
  model: {
    repo: REPO,
    revision: REVISION,
    file: 'aizuchi.int8.onnx',
    sha256: 'da61e4c795c6cdee647b61f08c68be5307df8a1d33866dc6886fa8ec5a07fc31',
    bytes: 70_576_833
  },
  tokenizer: {
    repo: REPO,
    revision: REVISION,
    file: 'tokenizer.json',
    sha256: '0a94ac9a0a02c067bdef25b72ae9f4ee33f48f552e55988d444f6d25eeb1d062',
    bytes: 6_724_873
  }
} as const satisfies { label: string; model: AizuchiModelFile; tokenizer: AizuchiModelFile }

/** Applies the same normalization as training: NFKC, then punctuation, whitespace and brackets removed. */
export function normalizeForClassifier(text: string): string {
  return text.normalize('NFKC').replace(/[\s、。,.?？!！…・「」『』()（）]/g, '')
}

export const AIZUCHI_PROTOCOL_PREFIX = 'ASIST_JSON:'

export interface AizuchiClassification {
  cls: AizuchiClass
  /** The highest class probability. It is not calibrated, so thresholds come from the distribution seen in production. */
  prob: number
  /** The probability that the user has finished the sentence rather than left it hanging. */
  complete: number
}

export type AizuchiWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: string; cls: AizuchiClass; prob: number; complete: number }
  | { type: 'error'; id: string; error: string }
  | { type: 'fatal'; error: string }

function isClass(value: unknown): value is AizuchiClass {
  return typeof value === 'string' && (AIZUCHI_CLASSES as readonly string[]).includes(value)
}

/** Parses one protocol line. A line without the prefix, with invalid JSON or with an unknown type gives null. */
export function parseAizuchiWorkerLine(line: string): AizuchiWorkerMessage | null {
  if (!line.startsWith(AIZUCHI_PROTOCOL_PREFIX)) return null
  let payload: unknown
  try {
    payload = JSON.parse(line.slice(AIZUCHI_PROTOCOL_PREFIX.length))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  const message = payload as Record<string, unknown>
  switch (message.type) {
    case 'ready':
      return { type: 'ready' }
    case 'result':
      if (typeof message.id !== 'string' || !isClass(message.cls)) return null
      if (typeof message.prob !== 'number' || typeof message.complete !== 'number') return null
      return { type: 'result', id: message.id, cls: message.cls, prob: message.prob, complete: message.complete }
    case 'error':
      if (typeof message.id !== 'string' || typeof message.error !== 'string') return null
      return { type: 'error', id: message.id, error: message.error }
    case 'fatal':
      return typeof message.error === 'string' ? { type: 'fatal', error: message.error } : null
    default:
      return null
  }
}

/** Below this probability nothing is played, because a wrong aizuchi is worse than silence. */
export const AIZUCHI_MIN_PROB = 0.5

/**
 * Maps a class to the aizuchi category to play. `none` covers greetings and fragments and plays
 * nothing, and `hold` means the user has not finished, so it feeds the hangover extension in
 * VadSegmenter instead of an aizuchi at the head of the turn.
 */
export function categoryOfClassification(
  classification: AizuchiClassification | null
): AizuchiCategory | null {
  if (!classification || classification.prob < AIZUCHI_MIN_PROB) return null
  switch (classification.cls) {
    case 'none':
    case 'hold':
      return null
    default:
      return classification.cls
  }
}

/**
 * Whether a bridge phrase such as "〜の件ですね。" may follow the aizuchi. It does not fit a plain
 * reply, a correction, a greeting or an unfinished sentence.
 */
export function bridgeAllowed(cls: AizuchiClass): boolean {
  return !['none', 'flow', 'hold', 'correct'].includes(cls)
}

/**
 * A new class replaces the current one only when it leads by at least this much, because a class that
 * flips on every partial transcript makes the prepared aizuchi jump around.
 */
export const SWITCH_MARGIN = 0.15

export function nextClassification(
  current: AizuchiClassification | null,
  incoming: AizuchiClassification
): AizuchiClassification {
  if (!current || current.cls === incoming.cls) return incoming
  if (incoming.prob >= current.prob + SWITCH_MARGIN || incoming.prob >= 0.9) return incoming
  // The class stays, but `complete` always comes from the latest partial transcript.
  return { ...current, complete: incoming.complete }
}
