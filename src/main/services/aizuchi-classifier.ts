import type { AizuchiClassifierStatus, AppSettings, SetupProgress } from '@shared/ipc'
import { conversationFeatures } from '@shared/conversation-locale'
import { isLiveEngine } from '@shared/voice-engine'
import {
  AIZUCHI_MODEL,
  normalizeForClassifier,
  parseAizuchiWorkerLine,
  type AizuchiClassification
} from '@shared/aizuchi-classifier'
import { OnnxWorker } from './onnx-worker'

/**
 * The aizuchi classifier worker (resources/aizuchi_worker.py, a fine-tune of ModernBERT-ja 70m as ONNX
 * int8), which onnx-worker.ts runs in the environment it shares with the memory embedding. An aizuchi at
 * the head of a turn plays only while this worker runs; there is no rule-based fallback on the text.
 *
 * One sentence is classified per partial recognition update, in 1.7 ms. Requests go one at a time and the
 * renderer keeps only the newest input.
 */

const worker = new OnnxWorker<AizuchiClassification>({
  name: 'aizuchi-classifier',
  script: 'aizuchi_worker.py',
  modelsDir: 'aizuchi-classifier/models',
  files: [AIZUCHI_MODEL.model, AIZUCHI_MODEL.tokenizer],
  modelLabel: AIZUCHI_MODEL.label,
  feature: 'settingsModels.features.backchannelClassifier',
  read: (line) => {
    const message = parseAizuchiWorkerLine(line)
    if (message?.type === 'ready') return { type: 'ready', refusal: null }
    if (message?.type === 'result') {
      return { type: 'result', id: message.id, answer: { cls: message.cls, prob: message.prob, complete: message.complete } }
    }
    return message
  },
  requestTimeoutMs: 5_000
})

export function modelInstalled(): boolean {
  return worker.modelInstalled()
}

/**
 * Whether the worker should stay resident: aizuchi are on, the conversation is held in a language
 * that has them, and the voice engine is not a live one, which makes its own aizuchi and sends no
 * partial recognition here.
 */
export function wanted(settings: AppSettings): boolean {
  return (
    settings.aizuchi &&
    conversationFeatures(settings.conversationLocale).aizuchi &&
    !isLiveEngine(settings.voiceEngine)
  )
}

export function running(): boolean {
  return worker.running()
}

export function status(): AizuchiClassifierStatus {
  return worker.status()
}

/** Starts the worker, returning true at once when it already runs and false when the runtime or the model is missing. */
export function ensureStarted(): Promise<boolean> {
  return worker.ensureStarted()
}

/**
 * Classifies one sentence. Normalization, which drops punctuation and whitespace, happens here, and an
 * input that becomes empty throws. It also throws when the worker is not running, and the caller then
 * plays no aizuchi.
 */
export function classify(input: { prev: string; text: string }): Promise<AizuchiClassification> {
  const text = normalizeForClassifier(input.text)
  const prev = normalizeForClassifier(input.prev)
  if (!text) return Promise.reject(new Error('the utterance to classify is empty'))
  return worker.request({ prev, text })
}

export function stop(): void {
  worker.stop()
}

export function cancelPreparation(): boolean {
  return worker.cancelPreparation()
}

export function prepare(onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
  return worker.prepare(onProgress)
}
