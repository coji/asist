import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveVoice } from '@/voice/LiveVoice'

/** The microphone of the live engine: the native helper first, getUserMedia when it cannot start or main gave up on it. */

interface Internals {
  microphone: { mic: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } }
}

type Status = { running: boolean; reason?: string }
let reportStatus: ((status: Status) => void) | null = null

beforeEach(() => {
  reportStatus = null
  vi.stubGlobal('window', {
    api: {
      requestMicPermission: vi.fn(async () => true),
      liveStart: vi.fn(async () => ({ ok: true })),
      liveStop: vi.fn(async () => {}),
      livePush: vi.fn(async () => {}),
      liveActivity: vi.fn(async () => {}),
      micNativeStart: vi.fn(async () => ({ ok: true, sampleRate: 48_000 })),
      micNativeStop: vi.fn(async () => {}),
      onMicNativeFrame: vi.fn(() => vi.fn()),
      onMicNativeStatus: vi.fn((listener: (status: Status) => void) => {
        reportStatus = listener
        return vi.fn()
      })
    }
  })
})

function liveVoice(): { voice: LiveVoice; mic: Internals['microphone']['mic'] } {
  const voice = new LiveVoice()
  voice.noiseSuppression = false
  const mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
  ;(voice as unknown as Internals).microphone.mic = mic
  return { voice, mic }
}

describe('LiveVoice after main gave up on the running native helper', () => {
  it('rebuilds on getUserMedia until the user turns the microphone off, and tries the helper again after that', async () => {
    const { voice, mic } = liveVoice()
    await voice.enable()
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()

    // Voice processing keeps reconfiguring; main has respawned the helper as far as it would and gives up.
    reportStatus!({ running: false, reason: 'audio configuration keeps changing' })
    await vi.waitFor(() => expect(mic.start).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(voice.current).toBe('on'))
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()

    // The window comes back after a long time hidden, which rebuilds capture again.
    await voice.recover()
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()
    expect(mic.start).toHaveBeenCalledTimes(2)

    voice.disable()
    await voice.enable()
    expect(window.api.micNativeStart).toHaveBeenCalledTimes(2)
    voice.disable()
  })
})
