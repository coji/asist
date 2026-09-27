import { asrRecommendationSize } from '@shared/asr-models'
import type { SetupStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import type { SpeechRuntime } from '@shared/platform'

/**
 * Why the recommended speech recognition model suits this machine, from the memory the main process
 * reports: the Mac's own on mlx, the GPU's on cuda, each runtime with its own two models.
 */
export function asrRecommendationReason(t: Translate, runtime: SpeechRuntime, asr: NonNullable<SetupStatus['asr']>): string {
  return t(`speechRecognition.recommendation.${runtime}.${asrRecommendationSize(runtime, asr.totalMemoryGb)}`, { memoryGb: asr.totalMemoryGb })
}
