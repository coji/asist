import { systemPreferences } from 'electron'
import type { OsFamily } from '@shared/platform'

/** How the OS lets the app use the microphone, and the page of its settings where the user changes that. */
export interface MicrophonePermission {
  /** Whether the app may record, asking the user first where the OS lets an app ask. */
  request: () => Promise<boolean>
  settingsUrl: string
}

const PERMISSIONS: Record<OsFamily, MicrophonePermission> = {
  macos: {
    request: async () =>
      systemPreferences.getMediaAccessStatus('microphone') === 'granted' || systemPreferences.askForMediaAccess('microphone'),
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  },
  // Windows offers a desktop app no prompt of its own: the switch that lets desktop apps use the
  // microphone decides. Only a refusal the status states is final; 'not-determined' and 'unknown' say
  // nothing either way, so the capture the renderer opens next decides.
  windows: {
    request: async () => !['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone')),
    settingsUrl: 'ms-settings:privacy-microphone'
  }
}

export const microphonePermission = (os: OsFamily): MicrophonePermission => PERMISSIONS[os]
