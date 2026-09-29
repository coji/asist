import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { defaultRegion, pickInitialLocale } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import type { AppSettings } from '@shared/ipc'
import { SETTINGS_FORMAT, mergeSettings, parseAppSettings, parseSettingsPatch, type SettingsPatch } from '@shared/settings'
import { defaultPersona } from '@shared/persona'
import { DEFAULT_MAIL_SETTINGS } from '@shared/mail'
import { DEFAULT_DOCK_ORDER } from '@shared/dock'
import { DEFAULT_THEME } from '@shared/themes'
import { DEFAULT_LIVE_MODELS } from '@shared/voice-engine'
import { defaultModelsFor } from '@shared/llm-catalog'
import { storedContent } from '@shared/stored-format'
import { writeJsonFileAtomicSync } from './atomic-json'
import { openStoredFileSync } from './stored-file'

/** Reads and writes userData/settings.json. The file is read once and then cached for the life of the process. */

function defaultSettings(): AppSettings {
  // The first setup opens in the language of the system and offers it as the conversation language; the
  // user confirms or changes it on its first screen.
  const locale = pickInitialLocale(app.getPreferredSystemLanguages())
  return parseAppSettings({
    onboardingVersion: 0,
    safetyNoticeVersion: 0,
    uiLocale: locale,
    theme: DEFAULT_THEME,
    conversationLocale: locale,
    region: defaultRegion(locale),
    // Choosing a provider during the first setup replaces these with that provider's defaults from
    // llm-catalog, so this value is only what the screen shows before a choice has been made.
    ...defaultModelsFor('anthropic'),
    // The cascade voice engine is the default, because a live engine needs its provider's key, which only
    // the first setup or the settings screen can verify; completing the setup saves the engine it chose.
    voiceEngine: 'cascade',
    gptLive: { ...DEFAULT_LIVE_MODELS['gpt-live'] },
    geminiLive: { ...DEFAULT_LIVE_MODELS['gemini-live'] },
    // GPT-Live is billed for as long as the session is open, so it is closed after 90 seconds without
    // conversation. Speaking again reopens it with a pre-roll.
    liveIdleSeconds: 90,
    persona: defaultPersona(locale),
    conversationLogRetentionDays: 90,
    ttsEngine: 'voicevox',
    qwenTtsSize: '0.6b',
    voicevoxSpeaker: Number(process.env.VOICEVOX_SPEAKER || 1),
    aivisSpeaker: null,
    bargeIn: true,
    aizuchi: true,
    aizuchiRate: 0.85,
    listeningAizuchi: true,
    // At 350 ms a pause inside a Japanese sentence split the utterance and cost a lot of transcription
    // accuracy. At 600 ms an aizuchi still covers the wait before the reply.
    hangoverMs: 600,
    partialIntervalMs: 600,
    calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null },
    mail: DEFAULT_MAIL_SETTINGS,
    agentCwd: os.homedir(),
    agentEngine: 'codex',
    agentMode: 'readonly',
    // The system knows where these folders are, which is outside the home folder when OneDrive keeps them.
    fileRoots: (['desktop', 'downloads', 'documents'] as const).map((name) => app.getPath(name)),
    // The first launch must not raise a permission dialog or start the large ASR initialization on its own.
    micAutoStart: false,
    localAsrEnabled: false,
    nativeMic: true,
    noiseSuppression: true,
    // This pulls in a Python environment and the models, so it is enabled only after the user has run
    // the preparation on the settings screen.
    vapEnabled: false,
    // This is enabled only after the Python environment and multilingual-e5 have been prepared. The measured
    // memory usage is recorded in memory-embedding.ts.
    memoryEmbeddingEnabled: false,
    asrModel: 'auto',
    globalHotkey: true,
    dockOrder: [...DEFAULT_DOCK_ORDER]
  })
}

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json')

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  const target = settingsFile()
  let source: string
  try {
    source = fs.readFileSync(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cache = defaultSettings())
    throw new Error(errorText('settings.errors.readFailed', { file: target, message: String(error) }), { cause: error })
  }
  try {
    cache = openStoredFileSync(target, JSON.parse(source), SETTINGS_FORMAT)
  } catch (error) {
    throw new Error(errorText('settings.errors.fileInvalid', { file: target, message: String(error) }), { cause: error })
  }
  return cache
}

export function saveSettings(patch: SettingsPatch): AppSettings {
  const next = parseAppSettings(mergeSettings(getSettings(), parseSettingsPatch(patch)))
  writeJsonFileAtomicSync(settingsFile(), storedContent(SETTINGS_FORMAT, next))
  // The cache is updated only after the write succeeded, so a patch that failed to persist is not
  // treated as applied inside this process.
  cache = next
  return next
}
