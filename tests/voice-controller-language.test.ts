import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VapState } from '@shared/ipc'
import type { BackchannelDecision } from '@shared/listening-aizuchi'

/**
 * The conversation language decides what the voice pipeline runs: the aizuchi played while the user
 * speaks, MaAI, and the list of phrases Whisper hallucinates all belong to Japanese.
 */

class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  audioWorklet = { addModule: vi.fn(async () => undefined) }

  createAnalyser(): AnalyserNode {
    return { fftSize: 0, connect: vi.fn(), getByteTimeDomainData: vi.fn() } as unknown as AnalyserNode
  }

  createGain(): GainNode {
    return {
      connect: vi.fn(),
      gain: { cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() }
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

interface VoiceInternals {
  state: 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'
  micGeneration: number
  captureStartedAt: number
  lastPartial: string
  lastBackchannelAt: number
  microphone: { mic: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } }
  vad: unknown
  recognition: { transcribe: (audio: Float32Array) => Promise<string> }
  enqueueUtterance(samples: Float32Array, vadMs: number, vadMode: 'early' | 'extended' | 'fixed'): void
  maybeBackchannel(): void
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
      requestMicPermission: vi.fn(async () => true),
      vapStart: vi.fn(async () => true),
      vapPush: vi.fn(async () => undefined),
      onVapState: vi.fn(() => vi.fn())
    }
  })
})

const internals = (controller: InstanceType<typeof VoiceController>): VoiceInternals =>
  controller as unknown as VoiceInternals

/** A capture in a mid-sentence pause after a clause ending, which is where a listening aizuchi belongs. */
function pausedMidSentence(controller: InstanceType<typeof VoiceController>): void {
  const state = internals(controller)
  state.vad = { speechConfirmed: true, isSpeaking: true, silenceDuration: 400, utteranceDuration: 4000 }
  state.lastPartial = '昨日の夜に資料を作っていたんですけど'
  // Far enough back that the ceiling on how often an aizuchi may sound does not hold this one.
  state.lastBackchannelAt = -60_000
}

describe('listening aizuchi by conversation language', () => {
  it('fires in Japanese and never in another language, whatever the setting says', () => {
    for (const locale of ['ja-JP', 'en-US'] as const) {
      const controller = new VoiceController()
      controller.listeningAizuchi = true
      controller.conversationLocale = locale
      pausedMidSentence(controller)
      const fired: BackchannelDecision[] = []
      controller.events.on('backchannel', (decision) => fired.push(decision))

      internals(controller).maybeBackchannel()

      expect(fired.length).toBe(locale === 'ja-JP' ? 1 : 0)
    }
  })
})

describe('MaAI by conversation language', () => {
  async function start(locale: 'ja-JP' | 'en-US'): Promise<void> {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.vapEnabled = true
    controller.conversationLocale = locale
    internals(controller).microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    await controller.enable()
    controller.disable()
  }

  it('starts the worker in Japanese', async () => {
    await start('ja-JP')
    expect(window.api.vapStart).toHaveBeenCalled()
    expect(window.api.onVapState).toHaveBeenCalled()
  })

  it('leaves the worker alone in another language, so the fixed hangover decides the end of an utterance', async () => {
    await start('en-US')
    expect(window.api.vapStart).not.toHaveBeenCalled()
    expect(window.api.onVapState).not.toHaveBeenCalled()
  })
})

describe('MaAI that starts taking part while the microphone is on', () => {
  /** A pause inside a sentence: the EoT is low, so MaAI extends the wait past the fixed hangover. */
  const midSentence: VapState = {
    t: 0, pNowUser: 0.9, pNowAssistant: 0.1, pFutureUser: 0.9, pFutureAssistant: 0.1,
    eotUser: 0.1, bcDetUser: 0, bcReact: 0, bcEmo: 0, nodShort: 0, nodLong: 0, inferMs: 1
  }

  async function listeningWithout(change: 'setting' | 'language'): Promise<InstanceType<typeof VoiceController>> {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.partialIntervalMs = 0
    controller.vapEnabled = change !== 'setting'
    controller.conversationLocale = change === 'language' ? 'en-US' : 'ja-JP'
    internals(controller).microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    await controller.enable()
    expect(window.api.vapStart).not.toHaveBeenCalled()
    return controller
  }

  it('lets the estimates move the end of speech once MaAI is switched on', async () => {
    const listeners: Array<(state: VapState) => void> = []
    vi.mocked(window.api.onVapState).mockImplementation((listener: (state: VapState) => void) => {
      listeners.push(listener)
      return vi.fn()
    })
    const controller = await listeningWithout('setting')
    controller.vapEnabled = true
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const ends: number[] = []
    controller.events.on('speechend', ({ vadMs }) => ends.push(vadMs))
    const vad = internals(controller).vad as { push(frame: Float32Array): void }
    const speak = (frames: number, level: number): void => {
      for (let i = 0; i < frames; i++) {
        for (const listener of listeners) listener(midSentence)
        vad.push(new Float32Array(320).fill(level))
      }
    }

    // A second of speech, a 500 ms pause in the middle of the sentence, then the rest of it.
    speak(50, 0.1)
    speak(25, 0)
    speak(50, 0.1)

    expect(ends).toEqual([])
    controller.disable()
  })

  it('starts the worker when the conversation moves to Japanese', async () => {
    const controller = await listeningWithout('language')
    controller.conversationLocale = 'ja-JP'
    expect(window.api.vapStart).toHaveBeenCalledOnce()
    expect(window.api.onVapState).toHaveBeenCalledOnce()
    controller.disable()
  })

  it('says once that the worker did not start, however often it is started again while MaAI stays on', async () => {
    window.api.vapStart = vi.fn(async () => false)
    const controller = await listeningWithout('setting')
    const said = vi.fn()
    controller.events.on('maaiUnavailable', said)
    controller.vapEnabled = true
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The conversation moves to another language and back, and the microphone is turned off and on.
    controller.conversationLocale = 'en-US'
    controller.conversationLocale = 'ja-JP'
    controller.disable()
    await controller.enable()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(window.api.vapStart).toHaveBeenCalledTimes(3)
    expect(said).toHaveBeenCalledOnce()
    controller.disable()
  })
})

describe('MaAI that does not start', () => {
  function controllerWithMaai(): InstanceType<typeof VoiceController> {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.vapEnabled = true
    controller.conversationLocale = 'ja-JP'
    internals(controller).microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    return controller
  }

  async function turnMicOnAndOff(controller: InstanceType<typeof VoiceController>): Promise<void> {
    await controller.enable()
    controller.disable()
    // The start is not awaited by enable, so its result arrives a few microtasks later.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('says so once while MaAI stays on, whether the start failed or threw, and the microphone keeps working', async () => {
    const controller = controllerWithMaai()
    const said = vi.fn()
    const errors = vi.fn()
    controller.events.on('maaiUnavailable', said)
    controller.events.on('error', errors)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.api.vapStart = vi.fn(async () => false)
    await turnMicOnAndOff(controller)
    window.api.vapStart = vi.fn(async () => {
      throw new Error('worker gone')
    })
    await turnMicOnAndOff(controller)
    quiet.mockRestore()
    expect(said).toHaveBeenCalledOnce()
    expect(errors).not.toHaveBeenCalled()
  })

  it('says so again after MaAI is turned off and on', async () => {
    const controller = controllerWithMaai()
    const said = vi.fn()
    controller.events.on('maaiUnavailable', said)
    window.api.vapStart = vi.fn(async () => false)
    await turnMicOnAndOff(controller)
    controller.vapEnabled = false
    controller.vapEnabled = true
    await turnMicOnAndOff(controller)
    expect(said).toHaveBeenCalledTimes(2)
  })

  it('says nothing when MaAI was turned off before the start answered', async () => {
    const controller = controllerWithMaai()
    const said = vi.fn()
    controller.events.on('maaiUnavailable', said)
    let answer: (started: boolean) => void = () => {}
    window.api.vapStart = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    await controller.enable()
    controller.vapEnabled = false
    answer(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.disable()
    expect(said).not.toHaveBeenCalled()
  })

  it('says nothing when MaAI started', async () => {
    const controller = controllerWithMaai()
    const said = vi.fn()
    controller.events.on('maaiUnavailable', said)
    await turnMicOnAndOff(controller)
    expect(said).not.toHaveBeenCalled()
  })
})

describe('the list of Whisper hallucinations by conversation language', () => {
  async function transcribe(locale: 'ja-JP' | 'en-US', text: string): Promise<string[]> {
    const controller = new VoiceController()
    const state = internals(controller)
    controller.conversationLocale = locale
    state.state = 'listening'
    state.micGeneration = 1
    state.recognition.transcribe = vi.fn(async () => text)
    const utterances: string[] = []
    controller.events.on('utterance', (event) => utterances.push(event.text))
    state.enqueueUtterance(new Float32Array([0.1]), 300, 'fixed')
    await vi.waitFor(() => expect(state.recognition.transcribe).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    return utterances
  }

  it('drops the Japanese set phrase in Japanese and starts a turn on it in another language', async () => {
    expect(await transcribe('ja-JP', 'ご視聴ありがとうございました')).toEqual([])
    expect(await transcribe('en-US', 'ご視聴ありがとうございました')).toEqual(['ご視聴ありがとうございました'])
  })
})
