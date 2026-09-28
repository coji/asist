import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { displayError } from '../src/renderer/src/display-error'

class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  audioWorklet = { addModule: vi.fn(async () => undefined) }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 0,
      connect: vi.fn(),
      getByteTimeDomainData: vi.fn()
    } as unknown as AnalyserNode
  }

  createGain(): GainNode {
    return {
      connect: vi.fn(),
      gain: {
        cancelScheduledValues: vi.fn(),
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn()
      }
    } as unknown as GainNode
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return { stream: {} } as MediaStreamAudioDestinationNode
  }
}

class FakeAudio {
  srcObject: unknown = null
  autoplay = false
}

type FakeAsr = {
  init: ReturnType<typeof vi.fn>
  transcribe: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

interface VoiceInternals {
  backend: 'server' | 'local'
  state: 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'
  captureGeneration: number
  captureStartedAt: number
  lastPartial: string
  captureIsBackchannel: boolean
  asr: FakeAsr
  mic: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
  vad: {
    snapshot(maxMs?: number): Float32Array | null
    readonly isSpeaking: boolean
    reset(): void
  }
  transcribeWithRecovery(audio: Float32Array): Promise<string>
  enqueueUtterance(samples: Float32Array, vadMs: number, vadMode: 'early' | 'extended' | 'fixed'): void
  endCapture(utterance: { samples: Float32Array; vadMs: number; mode: 'early' | 'extended' | 'fixed' } | null): void
  partialTick(): Promise<void>
}

let VoiceController: typeof import('../src/renderer/src/voice/VoiceController').VoiceController

beforeAll(async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  ;({ VoiceController } = await import('../src/renderer/src/voice/VoiceController'))
})

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      transcribe: vi.fn(),
      transcribeCancel: vi.fn(async () => true),
      transcribePartial: vi.fn(),
      getStatus: vi.fn(async () => ({ asr: true })),
      requestMicPermission: vi.fn(async () => true)
    }
  })
})

function internals(controller: InstanceType<typeof VoiceController>): VoiceInternals {
  return controller as unknown as VoiceInternals
}

function fakeAsr(): FakeAsr {
  return {
    init: vi.fn(async () => 'wasm'),
    transcribe: vi.fn(),
    reset: vi.fn()
  }
}

describe('VoiceController ASR recovery', () => {
  it('keeps the newest capture when an obsolete start completes after OFF and ON', async () => {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    const state = internals(controller)
    let finishOld!: () => void
    const oldStart = new Promise<void>((resolve) => { finishOld = resolve })
    let active = false
    const mic = {
      start: vi.fn().mockImplementationOnce(() => oldStart).mockImplementationOnce(async () => { active = true }),
      stop: vi.fn(() => { active = false })
    }
    state.mic = mic
    const oldEnable = controller.enable()
    await vi.waitFor(() => expect(mic.start).toHaveBeenCalledOnce())
    controller.disable()
    await controller.enable()
    finishOld()
    await oldEnable
    expect(active).toBe(true)
    expect(controller.current).toBe('listening')
    controller.disable()
  })

  it('finishes recovery cancelled during native startup and can recover again', async () => {
    const controller = new VoiceController()
    controller.noiseSuppression = false
    const state = internals(controller)
    state.state = 'listening'
    let oldReply!: (value: { ok: boolean; sampleRate: number }) => void
    const startNative = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { oldReply = resolve }))
      .mockResolvedValue({ ok: true, sampleRate: 48_000 })
    Object.assign(window.api, {
      micNativeStart: startNative,
      micNativeStop: vi.fn(async () => {}),
      onMicNativeFrame: vi.fn(() => vi.fn()),
      onMicNativeStatus: vi.fn(() => vi.fn())
    })
    let recovered = false
    const recovery = controller.recover().then(() => { recovered = true })
    await vi.waitFor(() => expect(startNative).toHaveBeenCalledOnce())
    controller.disable()
    await vi.waitFor(() => expect(recovered).toBe(true))
    expect(controller.current).toBe('off')
    await controller.enable()
    await controller.recover()
    expect(controller.current).toBe('listening')
    const stops = vi.mocked(window.api.micNativeStop).mock.calls.length
    oldReply({ ok: false, sampleRate: 48_000 })
    await recovery
    expect(window.api.micNativeStop).toHaveBeenCalledTimes(stops)
    controller.disable()
  })

  it('does not initialize or download local ASR by default', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))

    await expect(state.transcribeWithRecovery(new Float32Array([0.1]))).rejects.toThrow('[asist:speechRecognition.errors.serverTranscribeFailed')
    expect(controller.localFallbackEnabled).toBe(false)
    expect(asr.init).not.toHaveBeenCalled()
    expect(asr.transcribe).not.toHaveBeenCalled()
  })

  it('keeps the reason the server gave whole in its error, so the screen words it in the language shown when it is read', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.asr = fakeAsr()
    const reason = errorText('speechRecognition.errors.transcribeTimeout')
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error(`Error invoking remote method 'asr-transcribe': Error: ${reason}`))

    // The interface is in Japanese while the error is thrown, and in English when it is read.
    const thrown = await state.transcribeWithRecovery(new Float32Array([0.1])).catch((error: unknown) => error as Error)
    const en = createTranslator('en-US')
    expect(readErrorText(thrown.message, 'en-US')).toBe(
      en('speechRecognition.errors.serverTranscribeFailed', { detail: en('speechRecognition.errors.transcribeTimeout') })
    )
    expect(thrown.message).not.toContain('Error invoking remote method')
  })

  it('rescues the same server utterance through explicitly enabled local ASR', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    controller.localFallbackEnabled = true
    const audio = new Float32Array([0.1, 0.2])
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))
    asr.transcribe.mockResolvedValue('救済しました')

    await expect(state.transcribeWithRecovery(audio)).resolves.toBe('救済しました')
    expect(asr.init).toHaveBeenCalledTimes(1)
    expect(asr.transcribe).toHaveBeenCalledWith(audio, 'japanese')
    expect(state.backend).toBe('local')
  })

  it('asks the in-browser Whisper for the conversation language', async () => {
    const { useSettingsStore } = await import('@/state/stores')
    useSettingsStore.setState({ settings: { conversationLocale: 'de-DE' } as AppSettings })
    try {
      const controller = new VoiceController()
      const state = internals(controller)
      const asr = fakeAsr()
      state.asr = asr
      controller.localFallbackEnabled = true
      vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))
      asr.transcribe.mockResolvedValue('Guten Tag')

      await expect(state.transcribeWithRecovery(new Float32Array([0.1]))).resolves.toBe('Guten Tag')
      expect(asr.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 'german')
    } finally {
      useSettingsStore.setState({ settings: null })
    }
  })

  it('resets local ASR and retries one time after a local failure', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    state.backend = 'local'
    controller.localFallbackEnabled = true
    asr.transcribe.mockRejectedValueOnce(new Error('device lost')).mockResolvedValueOnce('復旧')

    await expect(state.transcribeWithRecovery(new Float32Array([0.1]))).resolves.toBe('復旧')
    expect(asr.reset).toHaveBeenCalledTimes(1)
    expect(asr.init).toHaveBeenCalledTimes(2)
    expect(asr.transcribe).toHaveBeenCalledTimes(2)
  })

  it('switches away from a stopped server and promotes it again when available', () => {
    const controller = new VoiceController()
    const state = internals(controller)

    controller.handleAsrStatus(false)
    expect(state.backend).toBe('local')
    controller.handleAsrStatus(true)
    expect(state.backend).toBe('server')
  })

  it('shares concurrent recovery and rebuilds capture only when it was on', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    state.backend = 'local'
    state.state = 'listening'
    const mic = {
      start: vi.fn(async () => undefined),
      stop: vi.fn()
    }
    state.mic = mic

    let allowPermission!: (allowed: boolean) => void
    vi.mocked(window.api.requestMicPermission).mockImplementation(
      () => new Promise((resolve) => (allowPermission = resolve))
    )

    const first = controller.recover()
    const second = controller.recover()
    expect(second).toBe(first)
    expect(mic.stop).toHaveBeenCalledTimes(1)
    expect(asr.reset).toHaveBeenCalledTimes(1)

    allowPermission(true)
    await first

    expect(mic.start).toHaveBeenCalledTimes(1)
    expect(controller.current).toBe('listening')
    expect(state.backend).toBe('server')
  })

  it('does not let an obsolete enable continue after the user turns the mic off', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    let allowPermission!: (allowed: boolean) => void
    vi.mocked(window.api.requestMicPermission).mockImplementation(
      () => new Promise((resolve) => (allowPermission = resolve))
    )

    const enabling = controller.enable()
    controller.disable()
    allowPermission(true)
    await enabling

    expect(state.mic.start).not.toHaveBeenCalled()
    expect(controller.current).toBe('off')
  })

  it('starts explicitly enabled local ASR without waiting for the server poll loop', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    state.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    controller.localFallbackEnabled = true
    vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false } as never)

    await controller.enable()

    expect(asr.init).toHaveBeenCalledOnce()
    expect(state.mic.start).toHaveBeenCalledOnce()
    expect(controller.current).toBe('listening')
    expect(state.backend).toBe('local')
  })

  it('says at once that speech recognition is not prepared when no model is installed, instead of waiting for a server that cannot start', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false, asrInstalled: false } as never)
    const errors: string[] = []
    controller.events.on('error', (message) => errors.push(message))

    await controller.enable()

    expect(window.api.getStatus).toHaveBeenCalledOnce()
    expect(errors).toEqual([displayError(new Error(errorText('speechRecognition.errors.notPrepared')))])
    expect(state.mic.start).not.toHaveBeenCalled()
    expect(controller.current).toBe('off')
  })

  it('waits for a server that is still starting with its model installed, and listens through it once it answers', async () => {
    vi.useFakeTimers()
    try {
      const controller = new VoiceController()
      const state = internals(controller)
      state.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
      vi.mocked(window.api.getStatus)
        .mockResolvedValueOnce({ asr: false, asrInstalled: true } as never)
        .mockResolvedValue({ asr: true, asrInstalled: true } as never)

      const enabling = controller.enable()
      await vi.advanceTimersByTimeAsync(1500)
      await enabling

      expect(window.api.getStatus).toHaveBeenCalledTimes(2)
      expect(state.mic.start).toHaveBeenCalledOnce()
      expect(state.backend).toBe('server')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an in-flight server transcription when the mic generation is disabled', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    let rejectTranscription!: (error: unknown) => void
    vi.mocked(window.api.transcribe).mockImplementation(
      () => new Promise((_resolve, reject) => (rejectTranscription = reject))
    )
    vi.mocked(window.api.transcribeCancel).mockImplementation(async () => {
      rejectTranscription(new DOMException('cancelled', 'AbortError'))
      return true
    })

    const pending = state.transcribeWithRecovery(new Float32Array([0.1]))
    await Promise.resolve()
    const requestId = vi.mocked(window.api.transcribe).mock.calls[0][1]
    controller.disable()

    expect(window.api.transcribeCancel).toHaveBeenCalledWith(requestId)
    await expect(pending).rejects.toThrow('[asist:speechRecognition.errors.serverTranscribeFailed')
  })

  it('resets local ASR when the mic is disabled', () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.asr = asr
    state.backend = 'local'
    state.state = 'listening'

    controller.disable()

    expect(asr.reset).toHaveBeenCalledOnce()
    expect(controller.current).toBe('off')
  })

  it('serializes final transcriptions and preserves metadata from each capture', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.state = 'listening'
    state.captureGeneration = 1
    state.captureStartedAt = 10
    state.lastPartial = 'first partial'

    let resolveFirst!: (text: string) => void
    const first = new Promise<string>((resolve) => (resolveFirst = resolve))
    const transcribe = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce('second result')
    state.transcribeWithRecovery = transcribe

    const utterances: Array<{ text: string; partialText: string; startedAt: number }> = []
    const ends: Array<{ startedAt: number; partialText: string; vadMs: number }> = []
    let resolveBoth!: () => void
    const both = new Promise<void>((resolve) => (resolveBoth = resolve))
    controller.events.on('speechend', (end) => ends.push(end))
    controller.events.on('utterance', (event) => {
      utterances.push(event)
      if (utterances.length === 2) resolveBoth()
    })

    state.enqueueUtterance(new Float32Array([0.1]), 300, 'fixed')
    await Promise.resolve()
    state.captureStartedAt = 20
    state.lastPartial = 'second partial'
    state.enqueueUtterance(new Float32Array([0.2]), 400, 'early')
    await Promise.resolve()

    expect(transcribe).toHaveBeenCalledTimes(1)
    // Speech end arrives without waiting for the transcription, carrying the partial of its own capture.
    expect(ends).toMatchObject([
      { startedAt: 10, partialText: 'first partial', vadMs: 300 },
      { startedAt: 20, partialText: 'second partial', vadMs: 400 }
    ])
    resolveFirst('first result')
    await both

    expect(utterances).toEqual([
      {
        text: 'first result',
        vadMs: 300,
        vadMode: 'fixed',
        asrMs: expect.any(Number),
        partialText: 'first partial',
        startedAt: 10,
        speechEndAt: ends[0].speechEndAt
      },
      {
        text: 'second result',
        vadMs: 400,
        vadMode: 'early',
        asrMs: expect.any(Number),
        partialText: 'second partial',
        startedAt: 20,
        speechEndAt: ends[1].speechEndAt
      }
    ])
  })

  it('sends neither a speech end nor a transcription for a capture ignored as an aizuchi during playback', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.state = 'listening'
    state.captureGeneration = 1
    state.captureStartedAt = 10
    const transcribe = vi.fn(async () => 'うん')
    state.transcribeWithRecovery = transcribe
    const events: string[] = []
    controller.events.on('speechend', () => events.push('speechend'))
    controller.events.on('utterance', () => events.push('utterance'))

    state.captureIsBackchannel = true
    state.endCapture({ samples: new Float32Array([0.1]), vadMs: 300, mode: 'fixed' })
    await Promise.resolve()
    expect(transcribe).not.toHaveBeenCalled()
    expect(events).toEqual([])

    // The next capture behaves normally.
    state.endCapture({ samples: new Float32Array([0.1]), vadMs: 300, mode: 'fixed' })
    await vi.waitFor(() => expect(events).toContain('utterance'))
    expect(events[0]).toBe('speechend')
  })

  it('builds capture again when the microphone goes away, and reports it when no microphone is left', async () => {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    const state = internals(controller)
    let deviceGone!: () => void
    const mic = {
      start: vi
        .fn()
        .mockImplementationOnce(async (_feed: unknown, onEnded: () => void) => {
          deviceGone = onEnded
        })
        .mockImplementationOnce(async () => {
          throw new DOMException('Requested device not found', 'NotFoundError')
        }),
      stop: vi.fn()
    }
    state.mic = mic
    const errors: string[] = []
    controller.events.on('error', (message) => errors.push(message))
    await controller.enable()
    expect(controller.current).toBe('listening')

    deviceGone()

    await vi.waitFor(() => expect(controller.current).toBe('off'))
    expect(mic.start).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
  })

  it('drops a partial transcription that belongs to an obsolete capture', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.captureGeneration = 1
    state.captureStartedAt = 10
    state.vad = {
      snapshot: () => new Float32Array([0.1]),
      isSpeaking: true,
      speechConfirmed: true,
      reset: vi.fn()
    }
    let resolvePartial!: (text: string) => void
    vi.mocked(window.api.transcribePartial).mockImplementation(
      () => new Promise((resolve) => (resolvePartial = resolve))
    )
    const partials: string[] = []
    controller.events.on('partial', (text) => partials.push(text))

    const pending = state.partialTick()
    state.captureGeneration = 2
    state.captureStartedAt = 20
    resolvePartial('stale partial')
    await pending

    expect(partials).toEqual([])
  })
})
