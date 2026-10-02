import { credentialState, keyReadable, type AizuchiClassifierStatus, type AppSettings, type AppStatus, type EmbeddingStatus, type VapStatus } from '@shared/ipc'
import type { LlmProvider } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import { conversationFeatures } from '@shared/conversation-locale'
import { modelsInUse } from '@shared/settings'
import type { PlatformCapabilities } from '@shared/platform'
import { cascadeListeningReady, speechReadiness, type StatusRead } from './context'

/**
 * Something the settings turn on that cannot work yet, or whose state main failed to report. The overview
 * lists these with the step that fixes each, or the reason the check failed, and the list on the left
 * counts them; a feature left off is never one of them.
 */
export type Pending =
  | { kind: 'recognition' }
  | { kind: 'browserWhisper' }
  | { kind: 'speech'; reason: 'missing' | 'cannotRun' }
  | { kind: 'aizuchi' }
  | { kind: 'turnTaking' }
  | { kind: 'semanticSearch' }
  | { kind: 'agent' }
  | { kind: 'key'; provider: LlmProvider; state: 'missing' | 'unreadable' }

/**
 * The providers whose key the conversation needs now, as main checks them: those of the models in use
 * under every engine, and the provider of a live engine besides.
 */
export function keyProviders(settings: AppSettings): LlmProvider[] {
  const live = isLiveEngine(settings.voiceEngine) ? [LIVE_ENGINE_INFO[settings.voiceEngine].provider] : []
  return [...new Set([...live, ...modelsInUse(settings).map(({ model }) => model.provider)])]
}

/** Whether a state main reported shows its item missing, or main failed to report it. Not read yet, it shows nothing. */
function missing<T>(read: StatusRead<T>, installed: (status: T) => boolean): boolean {
  return read !== null && ('error' in read || !installed(read.read))
}

/**
 * What is turned on and not ready, as far as the statuses read so far tell. A status not read yet adds
 * nothing, and one main failed to report counts, since what it is about may not work either.
 */
export function pendingItems(input: {
  settings: AppSettings
  status: AppStatus | null
  vap: StatusRead<VapStatus>
  embedding: StatusRead<EmbeddingStatus>
  aizuchiClassifier: StatusRead<AizuchiClassifierStatus>
  localSpeech: PlatformCapabilities['localSpeech']
}): Pending[] {
  const { settings, status, vap, embedding, aizuchiClassifier, localSpeech } = input
  const pending: Pending[] = []
  // A live engine listens, answers and speaks by itself, so nothing of the cascade engine is in use.
  if (!isLiveEngine(settings.voiceEngine)) {
    const features = conversationFeatures(settings.conversationLocale)
    // The microphone listens through Whisper in the browser when the local model is not ready, so only
    // having neither keeps the conversation from hearing anything.
    if (cascadeListeningReady(settings, status, localSpeech) === false) pending.push({ kind: localSpeech.backend === null ? 'browserWhisper' : 'recognition' })
    const speech = speechReadiness(settings.ttsEngine, status, localSpeech)
    if (speech === 'missing' || speech === 'cannotRun') pending.push({ kind: 'speech', reason: speech })
    if (features.aizuchi && settings.aizuchi && missing(aizuchiClassifier, (read) => read.runtimeInstalled && read.modelInstalled)) pending.push({ kind: 'aizuchi' })
    if (features.maai && settings.vapEnabled && missing(vap, (read) => read.runtimeInstalled && read.modelsInstalled)) pending.push({ kind: 'turnTaking' })
  }
  if (settings.memoryEmbeddingEnabled && missing(embedding, (read) => read.runtimeInstalled && read.modelInstalled)) pending.push({ kind: 'semanticSearch' })
  if (status !== null && status.agent !== 'found') pending.push({ kind: 'agent' })
  if (status !== null) {
    for (const provider of keyProviders(settings)) {
      const state = credentialState(status, settings.openaiAuth, provider)
      if (!keyReadable(state)) pending.push({ kind: 'key', provider, state: state === 'unreadable' ? 'unreadable' : 'missing' })
    }
  }
  return pending
}
