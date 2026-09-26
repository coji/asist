import { errorText } from '@shared/i18n/error-text'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

type MediaDevicesForVerification = Pick<MediaDevices, 'getUserMedia'>

/**
 * Checks not only the OS permission but that Chromium can actually open an audio stream once. The
 * verification stream always stops every track, whether the check succeeds or fails.
 */
export async function verifyMicrophoneCapture(
  mediaDevices: MediaDevicesForVerification | undefined = navigator.mediaDevices
): Promise<void> {
  if (!mediaDevices?.getUserMedia) {
    throw new Error(errorText('voice.mic.unsupported'))
  }

  let stream: MediaStream | null = null
  try {
    stream = await mediaDevices.getUserMedia({ audio: true })
    if (stream.getAudioTracks().length === 0) {
      throw new Error(errorText('voice.mic.noAudioTrack'))
    }
  } finally {
    // One failing stop must not leave the remaining tracks held.
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        // This is cleanup of the verification stream, so it must not overwrite the original result.
      }
    }
  }
}

export function microphoneCaptureErrorMessage(error: unknown): string {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name)
      : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return translate(osMessageKey('setup.mic.errors.notAllowed', platformCapabilities().os))
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return translate('setup.mic.errors.notFound')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return translate('setup.mic.errors.notReadable')
  }
  const detail = displayError(error)
  return detail ? translate('setup.mic.errors.captureFailedDetail', { detail }) : translate('setup.mic.errors.captureFailed')
}
