import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAudio } from '@shared/ipc'
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
      liveStart: vi.fn(async () => ({ ok: true, run: 1 })),
      liveStop: vi.fn(async () => {}),
      livePush: vi.fn(async () => {}),
      liveActivity: vi.fn(async () => {}),
      onLiveAudio: vi.fn(() => vi.fn()),
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

describe('LiveVoice and the voice of the live engine', () => {
  it("hands on only the voice of the run it started, even when the stopped run's voice arrives after main has answered the next start", async () => {
    const listeners = new Set<(audio: LiveAudio) => void>()
    let runs = 0
    Object.assign(window.api, {
      liveStart: async () => ({ ok: true, run: ++runs }),
      onLiveAudio: (listener: (audio: LiveAudio) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
    const { voice } = liveVoice()
    const heard: number[] = []
    voice.events.on('audio', (samples) => heard.push(samples.length))
    const send = (run: number, length: number): void => {
      for (const listener of [...listeners]) listener({ run, samples: new Float32Array(length) })
    }

    await voice.enable()
    send(1, 1)
    await voice.recover()
    // The stopped run's voice, sent before main handled the stop, comes in after the answer to the next start.
    send(1, 2)
    send(2, 3)
    expect(heard).toEqual([1, 3])
    voice.disable()
  })
})
