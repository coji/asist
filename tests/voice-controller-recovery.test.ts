import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
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
  state: 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'
  micGeneration: number
  captureStartedAt: number
  lastPartial: string
  overlap: { kind: string }
  recognition: {
    backend: 'server' | 'local'
    asr: FakeAsr
    transcribe(audio: Float32Array, isCurrent: () => boolean): Promise<string>
  }
  microphone: {
    mic: {
      start: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
    }
  }
  vad: {
    snapshot(maxMs?: number): Float32Array | null
    readonly isSpeaking: boolean
    reset(): void
    push(frame: Float32Array): void
  }
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
    state.microphone.mic = mic
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

  it('shares concurrent recovery, rebuilds capture only when it was on, and moves recognition up to the server', async () => {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    const state = internals(controller)
    state.recognition.asr = fakeAsr()
    state.recognition.backend = 'local'
    const mic = {
      start: vi.fn(async () => undefined),
      stop: vi.fn()
    }
    state.microphone.mic = mic

    await controller.recover()
    expect(mic.start).not.toHaveBeenCalled()

    state.state = 'listening'
    const first = controller.recover()
    const second = controller.recover()
    expect(second).toBe(first)
    await first

    expect(mic.start).toHaveBeenCalledTimes(1)
    expect(controller.current).toBe('listening')
    expect(state.recognition.backend).toBe('server')
  })

  describe('with speech captured before a rebuild still being transcribed', () => {
    /** Speaks, recovers while transcriber has the speech, and returns the events that follow, the transcript included once it is released. */
    async function speakThenRecover(
      controller: InstanceType<typeof VoiceController>,
      transcriber: ReturnType<typeof vi.fn>,
      release: () => void
    ): Promise<string[]> {
      const state = internals(controller)
      controller.nativeMicPreferred = false
      controller.partialIntervalMs = 0
      state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
      await controller.enable()
      expect(controller.current).toBe('listening')
      const events: string[] = []
      controller.events.on('speechend', () => events.push('speechend'))
      controller.events.on('utterance', ({ text }) => events.push(`utterance:${text}`))
      controller.events.on('speechdropped', () => events.push('speechdropped'))

      // One second of speech, then the hangover ends it and its transcription starts.
      for (let i = 0; i < 50; i++) state.vad.push(new Float32Array(320).fill(0.1))
      for (let i = 0; i < 20; i++) state.vad.push(new Float32Array(320))
      await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce())

      // The window comes back after more than ten seconds hidden while the transcript is on its way.
      await controller.recover()
      expect(state.microphone.mic.start).toHaveBeenCalledTimes(2)
      release()
      return events
    }

    it('turns it into an utterance when the server transcribes it', async () => {
      const controller = new VoiceController()
      let finish!: (text: string) => void
      vi.mocked(window.api.transcribe).mockImplementation(() => new Promise((resolve) => (finish = resolve)))

      const events = await speakThenRecover(controller, vi.mocked(window.api.transcribe), () => finish('明日の予定を教えて'))

      await vi.waitFor(() => expect(events).toEqual(['speechend', 'utterance:明日の予定を教えて']))
      expect(controller.current).toBe('listening')
      controller.disable()
    })

    it('turns it into an utterance when the in-browser Whisper transcribes it', async () => {
      const controller = new VoiceController()
      const state = internals(controller)
      const asr = fakeAsr()
      let finish!: (text: string) => void
      asr.transcribe.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      state.recognition.asr = asr
      controller.localFallbackEnabled = true
      vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false } as never)

      const events = await speakThenRecover(controller, asr.transcribe, () => finish('明日の予定を教えて'))

      await vi.waitFor(() => expect(events).toEqual(['speechend', 'utterance:明日の予定を教えて']))
      controller.disable()
    })
  })

  describe('with the user speaking when capture is to be rebuilt', () => {
    const loud = (): Float32Array => new Float32Array(320).fill(0.1)
    const quiet = (): Float32Array => new Float32Array(320)

    interface Speaking {
      controller: InstanceType<typeof VoiceController>
      events: string[]
      /** Delivers frames from the microphone opened last. */
      deliver: (frames: number, make: () => Float32Array) => void
      inputGone: () => void
    }

    async function speaking(): Promise<Speaking> {
      const controller = new VoiceController()
      controller.nativeMicPreferred = false
      controller.partialIntervalMs = 0
      vi.mocked(window.api.transcribe).mockResolvedValue('明日の予定を教えて')
      let onFrame!: (frame: Float32Array) => void
      let inputGone!: () => void
      internals(controller).microphone.mic = {
        start: vi.fn(async (frameHandler: (frame: Float32Array) => void, onEnded: () => void) => {
          onFrame = frameHandler
          inputGone = onEnded
        }),
        stop: vi.fn()
      }
      await controller.enable()
      const events: string[] = []
      controller.events.on('speechend', () => events.push('speechend'))
      controller.events.on('utterance', ({ text }) => events.push(`utterance:${text}`))
      controller.events.on('speechdropped', () => events.push('speechdropped'))
      const deliver = (frames: number, make: () => Float32Array): void => {
        for (let i = 0; i < frames; i++) onFrame(make())
      }
      // Half a second of 「明日の予定を教えて」 so far.
      deliver(25, loud)
      expect(controller.current).toBe('capturing')
      return { controller, events, deliver, inputGone: () => inputGone() }
    }

    it('lets the speech end before rebuilding for a window shown again', async () => {
      const { controller, events, deliver } = await speaking()
      const mic = internals(controller).microphone.mic

      const rebuilt = controller.recover()
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(mic.start).toHaveBeenCalledOnce()
      deliver(25, loud)
      deliver(20, quiet)
      await rebuilt

      expect(mic.start).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => expect(events).toEqual(['speechend', 'utterance:明日の予定を教えて']))
      controller.disable()
    })

    it('rebuilds at once when the input itself is gone, and reports the speech it cut off as dropped', async () => {
      const { controller, events, inputGone } = await speaking()

      inputGone()

      await vi.waitFor(() => expect(internals(controller).microphone.mic.start).toHaveBeenCalledTimes(2))
      expect(events).toEqual(['speechdropped'])
      await vi.waitFor(() => expect(controller.current).toBe('listening'))
      controller.disable()
    })

    it('rebuilds at once for a window shown again when the input has stopped delivering', async () => {
      const { controller, events } = await speaking()
      // The machine slept in the middle of the speech, and the input has delivered nothing since.
      const asleep = performance.now() + 60_000
      vi.spyOn(performance, 'now').mockImplementation(() => asleep)

      await controller.recover()

      expect(internals(controller).microphone.mic.start).toHaveBeenCalledTimes(2)
      expect(events).toEqual(['speechdropped'])
      vi.mocked(performance.now).mockRestore()
      controller.disable()
    })
  })

  it('does not rebuild before recognition is chosen when the microphone was turned off and on while it waited', async () => {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    const state = internals(controller)
    state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    const permissions: Array<(allowed: boolean) => void> = []
    vi.mocked(window.api.requestMicPermission).mockImplementation(
      () => new Promise((resolve) => permissions.push(resolve))
    )
    const states: string[] = []
    controller.events.on('state', (next) => states.push(next))

    const first = controller.enable()
    const recovery = controller.recover()
    controller.disable()
    const second = controller.enable()
    permissions[0](true)
    await first
    await recovery

    expect(state.microphone.mic.start).not.toHaveBeenCalled()
    expect(controller.current).toBe('loading')
    permissions[1](true)
    await second
    expect(state.microphone.mic.start).toHaveBeenCalledOnce()
    expect(states.at(-1)).toBe('listening')
    controller.disable()
  })

  it('rebuilds capture on getUserMedia once main gives up on the running native helper', async () => {
    const statusListeners: Array<(status: { running: boolean; reason?: string }) => void> = []
    Object.assign(window.api, {
      micNativeStart: vi.fn(async () => ({ ok: true, sampleRate: 48_000 })),
      micNativeStop: vi.fn(async () => {}),
      onMicNativeFrame: vi.fn(() => vi.fn()),
      onMicNativeStatus: vi.fn((listener: (status: { running: boolean; reason?: string }) => void) => {
        statusListeners.push(listener)
        return vi.fn()
      })
    })
    const controller = new VoiceController()
    controller.noiseSuppression = false
    const mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    internals(controller).microphone.mic = mic
    await controller.enable()
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()

    // Voice processing keeps reconfiguring; main has respawned the helper as far as it would and gives up.
    statusListeners.at(-1)!({ running: false, reason: 'audio configuration keeps changing' })

    await vi.waitFor(() => expect(mic.start).toHaveBeenCalledOnce())
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(controller.current).toBe('listening'))

    // The window comes back after a long time hidden, which rebuilds capture again.
    await controller.recover()
    expect(mic.start).toHaveBeenCalledTimes(2)
    expect(window.api.micNativeStart).toHaveBeenCalledOnce()

    controller.disable()
    await controller.enable()
    expect(window.api.micNativeStart).toHaveBeenCalledTimes(2)
    controller.disable()
  })

  it('reports the in-browser Whisper loading as the microphone\'s only while the microphone turns on', async () => {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    const state = internals(controller)
    const asr = fakeAsr()
    asr.init.mockImplementation(async (onProgress?: (info: { progress: number }) => void) => {
      onProgress?.({ progress: 40 })
      return 'wasm'
    })
    state.recognition.asr = asr
    state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    const microphoneLoading: number[] = []
    controller.events.on('progress', (progress) => microphoneLoading.push(progress))

    // The settings screen prepares the model while the microphone is off.
    const shown: number[] = []
    await controller.prepareLocalAsr(({ progress }) => shown.push(progress))
    expect(shown).toEqual([40])
    expect(microphoneLoading).toEqual([])

    controller.localFallbackEnabled = true
    vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false } as never)
    await controller.enable()
    expect(microphoneLoading).toEqual([40])
    controller.disable()
  })

  it('does not let an obsolete enable continue after the user turns the mic off', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    let allowPermission!: (allowed: boolean) => void
    vi.mocked(window.api.requestMicPermission).mockImplementation(
      () => new Promise((resolve) => (allowPermission = resolve))
    )

    const enabling = controller.enable()
    controller.disable()
    allowPermission(true)
    await enabling

    expect(state.microphone.mic.start).not.toHaveBeenCalled()
    expect(controller.current).toBe('off')
  })

  it('starts explicitly enabled local ASR without waiting for the server poll loop', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    const asr = fakeAsr()
    state.recognition.asr = asr
    state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    controller.localFallbackEnabled = true
    vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false } as never)

    await controller.enable()

    expect(asr.init).toHaveBeenCalledOnce()
    expect(state.microphone.mic.start).toHaveBeenCalledOnce()
    expect(controller.current).toBe('listening')
    expect(state.recognition.backend).toBe('local')
  })

  it('says at once that speech recognition is not prepared when no model is installed, instead of waiting for a server that cannot start', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    vi.mocked(window.api.getStatus).mockResolvedValue({ asr: false, asrInstalled: false } as never)
    const errors: string[] = []
    controller.events.on('error', (message) => errors.push(message))

    await controller.enable()

    expect(window.api.getStatus).toHaveBeenCalledOnce()
    expect(errors).toEqual([displayError(new Error(errorText('speechRecognition.errors.notPrepared')))])
    expect(state.microphone.mic.start).not.toHaveBeenCalled()
    expect(controller.current).toBe('off')
  })

  it('waits for a server that is still starting with its model installed, and listens through it once it answers', async () => {
    vi.useFakeTimers()
    try {
      const controller = new VoiceController()
      const state = internals(controller)
      state.microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
      vi.mocked(window.api.getStatus)
        .mockResolvedValueOnce({ asr: false, asrInstalled: true } as never)
        .mockResolvedValue({ asr: true, asrInstalled: true } as never)

      const enabling = controller.enable()
      await vi.advanceTimersByTimeAsync(1500)
      await enabling

      expect(window.api.getStatus).toHaveBeenCalledTimes(2)
      expect(state.microphone.mic.start).toHaveBeenCalledOnce()
      expect(state.recognition.backend).toBe('server')
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

    const pending = state.recognition.transcribe(new Float32Array([0.1]), () => true)
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
    state.recognition.asr = asr
    state.recognition.backend = 'local'
    state.state = 'listening'

    controller.disable()

    expect(asr.reset).toHaveBeenCalledOnce()
    expect(controller.current).toBe('off')
  })

  it('serializes final transcriptions and preserves metadata from each capture', async () => {
    const controller = new VoiceController()
    const state = internals(controller)
    state.state = 'listening'
    state.micGeneration = 1
    state.captureStartedAt = 10
    state.lastPartial = 'first partial'

    let resolveFirst!: (text: string) => void
    const first = new Promise<string>((resolve) => (resolveFirst = resolve))
    const transcribe = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce('second result')
    state.recognition.transcribe = transcribe

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
    state.micGeneration = 1
    state.captureStartedAt = 10
    const transcribe = vi.fn(async () => 'うん')
    state.recognition.transcribe = transcribe
    const events: string[] = []
    controller.events.on('speechend', () => events.push('speechend'))
    controller.events.on('utterance', () => events.push('utterance'))

    state.overlap = { kind: 'backchannel' }
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
    state.microphone.mic = mic
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
    state.micGeneration = 1
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
    state.micGeneration = 2
    state.captureStartedAt = 20
    resolvePartial('stale partial')
    await pending

    expect(partials).toEqual([])
  })
})
