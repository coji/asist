import {
  asrModelLabel,
  isAsrModel,
  recommendAsrModel,
  resolveAsrModel,
  type AsrHardwareRecommendation,
  type AsrModel,
  type ResolvedAsrModel
} from '@shared/asr-models'
import type { SetupProgress, SetupStatus } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { SPEECH_RUNTIME_UNAVAILABLE_TEXT, type SpeechRuntimeUnavailable } from '@shared/platform'
import { t } from './i18n'
import { platformCapabilities } from './platform'
import { getSettings } from './settings'
import * as mlx from './mlx-asr'

type Resolution =
  | { model: ResolvedAsrModel; recommendation: AsrHardwareRecommendation }
  | { model: null; reason: SpeechRuntimeUnavailable }

/** The model the setting stands for on this machine, or why this machine has no runtime to run one. */
function resolve(selected: AsrModel = getSettings().asrModel): Resolution {
  const runtime = platformCapabilities().speechRuntime
  if (runtime.kind === null) return { model: null, reason: runtime.reason }
  const recommendation = recommendAsrModel(runtime.memoryGb)
  return { model: resolveAsrModel(selected, recommendation), recommendation }
}

/** The model to transcribe with; on a machine without a runtime the reason is thrown for the user. */
function modelOrThrow(): ResolvedAsrModel {
  const resolution = resolve()
  if (resolution.model === null) throw new Error(errorText(SPEECH_RUNTIME_UNAVAILABLE_TEXT[resolution.reason]))
  return resolution.model
}

export async function installationStatus(selected: AsrModel = getSettings().asrModel): Promise<SetupStatus['asr']> {
  const resolution = resolve(selected)
  if (resolution.model === null) return null
  const { model, recommendation } = resolution
  return {
    selectedModel: selected,
    resolvedModel: model,
    recommendedModel: recommendation.recommendedModel,
    label: asrModelLabel(model),
    totalMemoryGb: recommendation.totalMemoryGb,
    ...mlx.installationStatus(model),
    ready: await mlx.available(model)
  }
}

export async function available(): Promise<boolean> {
  const { model } = resolve()
  return model !== null && (await mlx.available(model))
}

export async function ensureServer(): Promise<boolean> {
  const { model } = resolve()
  return model !== null && (await mlx.ensureServer(model))
}

export async function revive(): Promise<boolean> {
  const { model } = resolve()
  if (model === null) return false
  return (await mlx.available(model)) || mlx.ensureServer(model)
}

export async function transcribe(samples: Float32Array, requestId?: string): Promise<string> {
  return mlx.transcribe(modelOrThrow(), samples, requestId)
}

export async function transcribePartial(samples: Float32Array): Promise<string> {
  return mlx.transcribePartial(modelOrThrow(), samples)
}

export const cancelTranscription = mlx.cancelTranscription

export function switchModel(): Promise<boolean> {
  mlx.stop()
  return ensureServer()
}

export async function prepareModel(
  selected: AsrModel,
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (!isAsrModel(selected)) return { ok: false, message: t('speechRecognition.errors.unknownModel') }
  const resolution = resolve(selected)
  if (resolution.model === null) return { ok: false, message: t(SPEECH_RUNTIME_UNAVAILABLE_TEXT[resolution.reason]) }
  return mlx.prepare(resolution.model, onProgress)
}

export const cancelPreparation = mlx.cancelPreparation
