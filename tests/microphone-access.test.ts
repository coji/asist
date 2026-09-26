import { describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import {
  microphoneCaptureErrorMessage,
  verifyMicrophoneCapture
} from '@/voice/microphone-access'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

vi.mock('@/platform', () => import('./helpers/platform'))

const t = createTranslator('ja-JP')

function mediaStream(
  audioTracks: Array<{ stop: () => void }>,
  allTracks: Array<{ stop: () => void }> = audioTracks
): MediaStream {
  return {
    getAudioTracks: () => audioTracks,
    getTracks: () => allTracks
  } as unknown as MediaStream
}

function mediaDevices(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>): MediaDevices {
  return { getUserMedia } as unknown as MediaDevices
}

describe('verifyMicrophoneCapture', () => {
  it('requests audio:true for real and stops every track once it succeeds', async () => {
    const audio = { stop: vi.fn() }
    const video = { stop: vi.fn() }
    const getUserMedia = vi.fn(async () => mediaStream([audio], [audio, video]))

    await verifyMicrophoneCapture(mediaDevices(getUserMedia))

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(audio.stop).toHaveBeenCalledOnce()
    expect(video.stop).toHaveBeenCalledOnce()
  })

  it('rejects a stream without an audio track and still stops every track', async () => {
    const track = { stop: vi.fn() }
    const result = verifyMicrophoneCapture(
      mediaDevices(async () => mediaStream([], [track]))
    )

    await expect(result).rejects.toThrow(errorText('voice.mic.noAudioTrack'))
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('stops the remaining tracks even when one stop throws', async () => {
    const first = { stop: vi.fn(() => { throw new Error('stop failed') }) }
    const second = { stop: vi.fn() }

    await verifyMicrophoneCapture(
      mediaDevices(async () => mediaStream([first], [first, second]))
    )

    expect(first.stop).toHaveBeenCalledOnce()
    expect(second.stop).toHaveBeenCalledOnce()
  })

  it('turns each browser failure reason into its own message for the user', () => {
    setCapabilities(MACOS)
    expect(microphoneCaptureErrorMessage({ name: 'NotAllowedError' })).toBe(t('setup.mic.errors.notAllowed.macos'))
    expect(microphoneCaptureErrorMessage({ name: 'NotFoundError' })).toBe(t('setup.mic.errors.notFound'))
    expect(microphoneCaptureErrorMessage({ name: 'NotReadableError' })).toBe(t('setup.mic.errors.notReadable'))
    expect(microphoneCaptureErrorMessage(new Error('boom'))).toBe(t('setup.mic.errors.captureFailedDetail', { detail: 'boom' }))
  })

  it('sends the user to the settings app of the OS the microphone was refused on', () => {
    setCapabilities(WINDOWS)
    expect(microphoneCaptureErrorMessage({ name: 'NotAllowedError' })).toBe(t('setup.mic.errors.notAllowed.windows'))
    setCapabilities(MACOS)
    expect(microphoneCaptureErrorMessage({ name: 'NotAllowedError' })).toBe(t('setup.mic.errors.notAllowed.macos'))
  })
})
