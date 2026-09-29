import { asrRecommendationSize } from '@shared/asr-models'
import type { SetupStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import type { SpeechBackend } from '@shared/platform'

/**
 * Why the recommended speech recognition model suits this machine, from the memory the main process
 * reports: the Mac's own on metal, the GPU's on vulkan.
 */
export function asrRecommendationReason(t: Translate, backend: SpeechBackend, asr: NonNullable<SetupStatus['asr']>): string {
  return t(`speechRecognition.recommendation.${backend}.${asrRecommendationSize(backend, asr.totalMemoryGb)}`, { memoryGb: asr.totalMemoryGb })
}
