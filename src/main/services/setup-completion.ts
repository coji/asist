import type { AppSettings, CompleteSetupRequest } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { osMessageKey } from '@shared/i18n/os-message'
import { getSettings, saveSettings } from './settings'
import { configuredModels, validateConfiguration } from './llm'
import { platformCapabilities } from './platform'
import * as asr from './asr'
import * as tts from './tts'

/**
 * Initial setup has a single commit point. UI snapshots may enable the button,
 * but only these fresh checks are allowed to persist onboardingVersion=1.
 */
export async function completeSetup(request: unknown): Promise<AppSettings> {
  const input = request as Partial<CompleteSetupRequest> | null
  const voiceMode = input?.voiceMode
  if (voiceMode !== 'server' && voiceMode !== 'local' && voiceMode !== 'text') {
    throw new Error(errorText('setup.completion.listeningNotChosen'))
  }
  if (voiceMode !== 'text' && input?.microphoneVerified !== true) {
    throw new Error(errorText('setup.completion.micNotChecked'))
  }
  if (voiceMode === 'local' && input?.localAsrVerified !== true) {
    throw new Error(errorText('setup.completion.localAsrNotReady'))
  }

  const settings = getSettings()
  if (settings.safetyNoticeVersion < 1) {
    throw new Error(errorText('setup.completion.safetyNotAcknowledged'))
  }
  if (settings.ttsEngine === 'system' && input?.systemTtsVerified !== true) {
    throw new Error(errorText(osMessageKey('setup.completion.systemTtsUnavailable', platformCapabilities().os)))
  }

  // The snapshot the screen is showing is not trusted here: the current keys and both models are checked
  // again against the real API. Any provider is acceptable, and this fails when the key for the provider
  // of a selected model is missing.
  await validateConfiguration(configuredModels(settings))

  if (voiceMode === 'server') {
    const serverReady = (await asr.available()) || (await asr.ensureServer())
    if (!serverReady) throw new Error(errorText('setup.completion.asrUnavailable'))
  }

  if (settings.ttsEngine !== 'none') {
    await tts.ensureEngine()
    if (!(await tts.available())) {
      throw new Error(errorText('setup.completion.ttsUnavailable', { engine: tts.engineLabel() }))
    }
  }

  // The completion version reaches the atomic settings write only after every check above has passed.
  return saveSettings({
    onboardingVersion: 1,
    localAsrEnabled: voiceMode === 'local',
    micAutoStart: voiceMode === 'text' ? false : input?.micAutoStart === true
  })
}
