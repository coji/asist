import type { SetupStatus } from '@shared/ipc'
import type { Translate } from '@shared/i18n'

/** Why the recommended speech recognition model suits this Mac, from the facts the main process reports. */
export function asrRecommendationReason(t: Translate, asr: NonNullable<SetupStatus['asr']>): string {
  return asr.recommendedModel === 'qwen3-asr-1.7b'
    ? t('speechRecognition.recommendation.enoughMemory', { memoryGb: asr.totalMemoryGb })
    : t('speechRecognition.recommendation.limitedMemory', { memoryGb: asr.totalMemoryGb })
}
