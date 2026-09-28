import {
  ASR_MODEL_NAMES,
  asrDownloadGb,
  asrModelSpec,
  isAsrModel,
  recommendAsrModel,
  resolveAsrModel,
  type AsrHardwareRecommendation,
  type AsrModel,
  type AsrModelSpec,
  type ResolvedAsrModel
} from '@shared/asr-models'
import type { SetupProgress, SetupStatus } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { SPEECH_RUNTIME_UNAVAILABLE_TEXT, type SpeechRuntime, type SpeechRuntimeUnavailable } from '@shared/platform'
import { t } from './i18n'
import { platformCapabilities } from './platform'
import { getSettings } from './settings'
import * as local from './local-asr'

/**
 * The model the setting stands for on this machine, with the runtime's build of it, which is null when
 * the runtime does not offer that model; or why this machine has no runtime to run one.
 */
type Resolution =
  | { runtime: SpeechRuntime; model: ResolvedAsrModel; spec: AsrModelSpec | null; recommendation: AsrHardwareRecommendation }
  | { model: null; reason: SpeechRuntimeUnavailable }

function resolve(selected: AsrModel = getSettings().asrModel): Resolution {
  const runtime = platformCapabilities().speechRuntime
  if (runtime.kind === null) return { model: null, reason: runtime.reason }
  const recommendation = recommendAsrModel(runtime.kind, runtime.memoryGb)
  const model = resolveAsrModel(selected, recommendation)
  return { runtime: runtime.kind, model, spec: asrModelSpec(runtime.kind, model), recommendation }
}

/** The model to transcribe with; on a machine that cannot run it the reason is thrown for the user. */
function modelOrThrow(): AsrModelSpec {
  const resolution = resolve()
  if (resolution.model === null) throw new Error(errorText(SPEECH_RUNTIME_UNAVAILABLE_TEXT[resolution.reason]))
  if (resolution.spec === null) throw new Error(errorText('speechRecognition.errors.unknownModel'))
  return resolution.spec
}

/** The runtime's build of the selected model, or null where there is none to start. */
function startable(): AsrModelSpec | null {
  const resolution = resolve()
  return resolution.model === null ? null : resolution.spec
}

export async function installationStatus(selected: AsrModel = getSettings().asrModel): Promise<SetupStatus['asr']> {
  const resolution = resolve(selected)
  if (resolution.model === null) return null
  const { runtime, model, spec, recommendation } = resolution
  const installed = local.installationStatus(spec)
  return {
    selectedModel: selected,
    resolvedModel: model,
    recommendedModel: recommendation.recommendedModel,
    label: spec === null ? ASR_MODEL_NAMES[model] : spec.label,
    totalMemoryGb: recommendation.totalMemoryGb,
    ...installed,
    downloadGb: asrDownloadGb(runtime, spec, installed),
    ready: spec !== null && (await local.available(spec))
  }
}

/** Whether the selected model and its runtime are installed, so that the server can be started at all. */
export function installed(): boolean {
  const spec = startable()
  if (spec === null) return false
  const { runtimeInstalled, modelInstalled } = local.installationStatus(spec)
  return runtimeInstalled && modelInstalled
}

export async function available(): Promise<boolean> {
  const spec = startable()
  return spec !== null && (await local.available(spec))
}

export async function ensureServer(): Promise<boolean> {
  const spec = startable()
  return spec !== null && (await local.ensureServer(spec))
}

export async function revive(): Promise<boolean> {
  const spec = startable()
  if (spec === null) return false
  return (await local.available(spec)) || local.ensureServer(spec)
}

export async function transcribe(samples: Float32Array, requestId?: string): Promise<string> {
  return local.transcribe(modelOrThrow(), samples, requestId)
}

export async function transcribePartial(samples: Float32Array): Promise<string> {
  return local.transcribePartial(modelOrThrow(), samples)
}

export const cancelTranscription = local.cancelTranscription

export function switchModel(): Promise<boolean> {
  local.stop()
  return ensureServer()
}

export async function prepareModel(
  selected: AsrModel,
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (!isAsrModel(selected)) return { ok: false, message: t('speechRecognition.errors.unknownModel') }
  const resolution = resolve(selected)
  if (resolution.model === null) return { ok: false, message: t(SPEECH_RUNTIME_UNAVAILABLE_TEXT[resolution.reason]) }
  if (resolution.spec === null) return { ok: false, message: t('speechRecognition.errors.unknownModel') }
  return local.prepare(resolution.spec, onProgress)
}

export const cancelPreparation = local.cancelPreparation
