import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MicInput } from '@/voice/MicInput'

/** The microphone shared by the voice pipeline and the live engines: the native helper first, getUserMedia when it cannot start. */

interface Internals {
  mic: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
}

let nativeFrame: ((frame: Float32Array) => void) | null = null

beforeEach(() => {
  nativeFrame = null
  vi.stubGlobal('window', { api: {
    micNativeStart: vi.fn(async () => ({ ok: true, sampleRate: 48_000 })),
    micNativeStop: vi.fn(async () => {}),
    onMicNativeFrame: vi.fn((callback: (frame: Float32Array) => void) => {
      nativeFrame = callback
      return vi.fn()
    }),
    onMicNativeStatus: vi.fn(() => vi.fn())
  } })
})

function input(): { microphone: MicInput; mic: Internals['mic'] } {
  const microphone = new MicInput()
  const mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
  ;(microphone as unknown as Internals).mic = mic
  return { microphone, mic }
}

describe('MicInput', () => {
  it('delivers the native helper\'s 48 kHz audio at 16 kHz and leaves getUserMedia closed', async () => {
    const { microphone, mic } = input()
    const frames: Float32Array[] = []
    await microphone.start({ native: true, noiseSuppression: false }, (frame) => frames.push(frame), () => {})

    nativeFrame!(new Float32Array(4800))

    expect(microphone.native).toBe(true)
    expect(mic.start).not.toHaveBeenCalled()
    expect(frames.reduce((sum, frame) => sum + frame.length, 0)).toBe(1600)
    microphone.stop()
    expect(microphone.native).toBe(false)
  })

  it('opens getUserMedia when the helper cannot start', async () => {
    vi.mocked(window.api.micNativeStart).mockResolvedValueOnce({ ok: false, sampleRate: 48_000 })
    const { microphone, mic } = input()
    await microphone.start({ native: true, noiseSuppression: false }, () => {}, () => {})

    expect(microphone.native).toBe(false)
    expect(mic.start).toHaveBeenCalledOnce()
  })

  it('opens nothing when it is stopped while the helper is still starting', async () => {
    let reply!: (value: { ok: boolean; sampleRate: number }) => void
    vi.mocked(window.api.micNativeStart).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }))
    const { microphone, mic } = input()
    const starting = microphone.start({ native: true, noiseSuppression: false }, () => {}, () => {})
    await vi.waitFor(() => expect(window.api.micNativeStart).toHaveBeenCalledOnce())

    microphone.stop()
    reply({ ok: false, sampleRate: 48_000 })
    await starting

    expect(mic.start).not.toHaveBeenCalled()
    expect(microphone.native).toBe(false)
  })

  it('opens getUserMedia once main has given up on the running helper, until the input is stopped', async () => {
    let reportStatus: ((status: { running: boolean; reason?: string }) => void) | null = null
    vi.mocked(window.api.onMicNativeStatus).mockImplementation((listener) => {
      reportStatus = listener
      return vi.fn()
    })
    const { microphone, mic } = input()
    const lost = vi.fn()
    const options = { native: true, noiseSuppression: false }
    await microphone.start(options, () => {}, lost)

    reportStatus!({ running: false, reason: 'audio configuration keeps changing' })
    expect(lost).toHaveBeenCalledOnce()
    // The owner builds capture again on the lost source.
    await microphone.start(options, () => {}, lost)

    expect(window.api.micNativeStart).toHaveBeenCalledOnce()
    expect(mic.start).toHaveBeenCalledOnce()
    expect(microphone.native).toBe(false)

    microphone.stop()
    await microphone.start(options, () => {}, lost)
    expect(window.api.micNativeStart).toHaveBeenCalledTimes(2)
    expect(microphone.native).toBe(true)
    microphone.stop()
  })

  it('goes straight to getUserMedia when the native helper is not wanted', async () => {
    const { microphone, mic } = input()
    await microphone.start({ native: false, noiseSuppression: true }, () => {}, () => {})

    expect(window.api.micNativeStart).not.toHaveBeenCalled()
    expect(mic.start).toHaveBeenCalledOnce()
  })
})
