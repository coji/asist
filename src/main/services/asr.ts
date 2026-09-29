import {
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
import { LOCAL_SPEECH_UNAVAILABLE_TEXT, type LocalSpeechUnavailable } from '@shared/platform'
import { t } from './i18n'
import { platformCapabilities } from './platform'
import { getSettings } from './settings'
import * as local from './llama-asr'

/** The model the setting stands for on this machine, or why this machine cannot run one. */
type Resolution =
  | { model: ResolvedAsrModel; spec: AsrModelSpec; recommendation: AsrHardwareRecommendation }
  | { model: null; reason: LocalSpeechUnavailable }

function resolve(selected: AsrModel = getSettings().asrModel): Resolution {
  const { localSpeech } = platformCapabilities()
  if (localSpeech.backend === null) return { model: null, reason: localSpeech.reason }
  const recommendation = recommendAsrModel(localSpeech.backend, localSpeech.memoryGb)
  const model = resolveAsrModel(selected, recommendation)
  return { model, spec: asrModelSpec(model), recommendation }
}

/** The model to transcribe with; on a machine that cannot run it the reason is thrown for the user. */
function modelOrThrow(): AsrModelSpec {
  const resolution = resolve()
  if (resolution.model === null) throw new Error(errorText(LOCAL_SPEECH_UNAVAILABLE_TEXT[resolution.reason]))
  return resolution.spec
}

/** The selected model, or null where there is none to start. */
function startable(): AsrModelSpec | null {
  const resolution = resolve()
  return resolution.model === null ? null : resolution.spec
}

export async function installationStatus(selected: AsrModel = getSettings().asrModel): Promise<SetupStatus['asr']> {
  const resolution = resolve(selected)
  if (resolution.model === null) return null
  const { model, spec, recommendation } = resolution
  const installed = local.installationStatus(spec)
  return {
    selectedModel: selected,
    resolvedModel: model,
    recommendedModel: recommendation.recommendedModel,
    label: spec.label,
    totalMemoryGb: recommendation.totalMemoryGb,
    ...installed,
    downloadGb: asrDownloadGb(spec, installed.modelInstalled),
    ready: await local.available(spec)
  }
}

/** Whether the selected model is installed, so that the server can be started at all. */
export function installed(): boolean {
  const spec = startable()
  return spec !== null && local.installationStatus(spec).modelInstalled
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
  if (resolution.model === null) return { ok: false, message: t(LOCAL_SPEECH_UNAVAILABLE_TEXT[resolution.reason]) }
  return local.prepare(resolution.spec, onProgress)
}

export const cancelPreparation = local.cancelPreparation
