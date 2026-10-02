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
  lastNodAt: number
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

/** A pause inside a sentence: the EoT is low, so MaAI extends the wait past the fixed hangover. */
const midSentence: VapState = {
  t: 0, pNowUser: 0.9, pNowAssistant: 0.1, pFutureUser: 0.9, pFutureAssistant: 0.1,
  eotUser: 0.1, bcDetUser: 0, bcReact: 0, bcEmo: 0, nodShort: 0, nodLong: 0, inferMs: 1,
  turnLagMs: 0, backchannelLagMs: 0
}

describe('MaAI that starts taking part while the microphone is on', () => {
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

describe('MaAI estimates from a worker that has fallen behind the audio', () => {
  /**
   * Turns the microphone on with MaAI and returns a way to speak while the worker sends the given estimate, and a
   * way to have the worker send it once.
   */
  async function listeningWithMaai(estimate: VapState): Promise<{
    controller: InstanceType<typeof VoiceController>
    speak: (frames: number, level: number) => void
    send: () => void
  }> {
    const listeners: Array<(state: VapState) => void> = []
    vi.mocked(window.api.onVapState).mockImplementation((listener: (state: VapState) => void) => {
      listeners.push(listener)
      return vi.fn()
    })
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.partialIntervalMs = 0
    controller.vapEnabled = true
    controller.conversationLocale = 'ja-JP'
    internals(controller).microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    await controller.enable()
    const vad = internals(controller).vad as { push(frame: Float32Array): void }
    const send = (): void => {
      for (const listener of listeners) listener(estimate)
    }
    const speak = (frames: number, level: number): void => {
      for (let i = 0; i < frames; i++) {
        send()
        vad.push(new Float32Array(320).fill(level))
      }
    }
    return { controller, speak, send }
  }

  /** The aizuchi the controller plays in a pause inside a long utterance whose text shows no clause boundary. */
  async function aizuchiFrom(estimate: VapState): Promise<BackchannelDecision[]> {
    const { controller, send } = await listeningWithMaai(estimate)
    const vad = internals(controller).vad
    send()
    pausedMidSentence(controller)
    internals(controller).lastPartial = '昨日の夜に資料を'
    const fired: BackchannelDecision[] = []
    controller.events.on('backchannel', (decision) => fired.push(decision))
    internals(controller).maybeBackchannel()
    internals(controller).vad = vad
    controller.disable()
    return fired
  }

  it('plays the aizuchi model\'s aizuchi only while that model keeps up with the audio', async () => {
    const wantsAizuchi: VapState = { ...midSentence, bcEmo: 1, bcReact: 1 }

    expect(await aizuchiFrom({ ...wantsAizuchi, backchannelLagMs: 0 })).toHaveLength(1)
    expect(await aizuchiFrom({ ...wantsAizuchi, backchannelLagMs: 3_000 })).toEqual([])
  })

  it('nods on the nod model\'s values only while that model keeps up with the audio', async () => {
    const nods = async (backchannelLagMs: number): Promise<string[]> => {
      const { controller, send } = await listeningWithMaai({ ...midSentence, nodLong: 1, nodShort: 1, backchannelLagMs })
      const vad = internals(controller).vad
      // The user is speaking, and the last nod was long enough ago.
      internals(controller).vad = { speechConfirmed: true, isSpeaking: true }
      internals(controller).lastNodAt = -60_000
      const nodded: string[] = []
      controller.events.on('nod', (kind) => nodded.push(kind))
      send()
      internals(controller).vad = vad
      controller.disable()
      return nodded
    }

    expect(await nods(0)).toHaveLength(1)
    expect(await nods(3_000)).toEqual([])
  })

  it('leaves the end of speech to the fixed hangover while the estimates describe audio seconds old', async () => {
    // The worker answers every frame on time, but about audio that reached it three seconds earlier.
    const { controller, speak } = await listeningWithMaai({ ...midSentence, turnLagMs: 3_000, backchannelLagMs: 3_000 })
    const ends: number[] = []
    controller.events.on('speechend', ({ vadMs }) => ends.push(vadMs))

    // A second of speech and a 500 ms pause, which the fixed hangover ends.
    speak(50, 0.1)
    speak(25, 0)

    expect(ends).toHaveLength(1)
    controller.disable()
  })

  it('lets the turn-taking values move the end of speech while only the aizuchi and nod model is behind', async () => {
    const { controller, speak } = await listeningWithMaai({ ...midSentence, turnLagMs: 0, backchannelLagMs: 3_000 })
    const ends: number[] = []
    controller.events.on('speechend', ({ vadMs }) => ends.push(vadMs))

    speak(50, 0.1)
    speak(25, 0)

    expect(ends).toEqual([])
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

describe('MaAI that falls behind the audio', () => {
  /** How fast a worker gets through its frames, as a multiple of real time, for a stretch of wall time. */
  interface Stretch {
    ms: number
    speed: number
  }

  let clock = 0

  beforeEach(() => {
    clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    return () => vi.mocked(performance.now).mockRestore()
  })

  /**
   * Turns the microphone on with MaAI, and returns a stand-in for vap_worker.py. While it works, it is handed an 80 ms
   * frame of audio every 80 ms of the clock, gets through them at the speed of each stretch, and sends an estimate for
   * each frame it finishes with how much newer audio had reached it by then: the model the load holds back reports
   * that lag, and the other none. Stopped, it neither takes audio nor sends anything; started again, it begins with
   * the frames it is given still waiting, as one that sent ready before its warm-up was through did.
   */
  async function listeningWithWorker(heldBack: 'turn' | 'backchannel' = 'turn'): Promise<{
    controller: InstanceType<typeof VoiceController>
    said: ReturnType<typeof vi.fn>
    work: (...stretches: Stretch[]) => void
    stop: (ms: number) => void
    restart: (waitingFrames: number) => void
  }> {
    const listeners: Array<(state: VapState) => void> = []
    vi.mocked(window.api.onVapState).mockImplementation((listener: (state: VapState) => void) => {
      listeners.push(listener)
      return vi.fn()
    })
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.partialIntervalMs = 0
    controller.vapEnabled = true
    controller.conversationLocale = 'ja-JP'
    internals(controller).microphone.mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    const said = vi.fn()
    controller.events.on('maaiBehind', said)
    await controller.enable()
    let received = 0
    let done = 0
    const work = (...stretches: Stretch[]): void => {
      for (const { ms, speed } of stretches) {
        for (let elapsed = 0; elapsed < ms; elapsed += 10) {
          clock += 10
          received += 10 / 80
          const before = Math.floor(done)
          done = Math.min(received, done + (speed * 10) / 80)
          for (let frame = before + 1; frame <= Math.floor(done); frame++) {
            const lagMs = Math.round((Math.floor(received) - frame) * 80)
            const estimate = {
              ...midSentence,
              turnLagMs: heldBack === 'turn' ? lagMs : 0,
              backchannelLagMs: heldBack === 'backchannel' ? lagMs : 0
            }
            for (const listener of listeners) listener(estimate)
          }
        }
      }
    }
    const stop = (ms: number): void => {
      clock += ms
    }
    const restart = (waitingFrames: number): void => {
      received = waitingFrames
      done = 0
    }
    return { controller, said, work, stop, restart }
  }

  /** A worker that takes the given milliseconds for a frame. */
  const atFrameMs = (frameMs: number, ms: number): Stretch => ({ ms, speed: 80 / frameMs })
  /** A worker at 42 ms a frame, the median on an Apple M5 at a load average of 11 to 15. */
  const keepingUp = (ms: number): Stretch => atFrameMs(42, ms)
  /** A worker on a loaded Mac, which got through 248 frames in 30 s of audio, two thirds of real time. */
  const loaded = (ms: number): Stretch => ({ ms, speed: 248 / 375 })
  const stalled = (ms: number): Stretch => ({ ms, speed: 0 })

  it('says once that MaAI fell behind when the load holds it back, and once again after the microphone is turned on again', async () => {
    const { controller, said, work } = await listeningWithWorker()

    work(keepingUp(2_000), loaded(15_000))
    expect(said).toHaveBeenCalledOnce()

    // The load lifts, the worker catches up, and the load comes back while the microphone stays on.
    work(keepingUp(10_000), loaded(15_000))
    expect(said).toHaveBeenCalledOnce()

    controller.disable()
    await controller.enable()
    work(loaded(15_000))
    expect(said).toHaveBeenCalledTimes(2)
    controller.disable()
  })

  it('says nothing when the worker stalls and catches up, however slowly it catches up', async () => {
    // The Apple M5 under load, and the Core i9-9900K's median, 90th percentile and longest time a frame.
    for (const frameMs of [42, 59.8, 63.8, 66.7]) {
      const { controller, said, work } = await listeningWithWorker()

      work(atFrameMs(frameMs, 2_000), stalled(2_000), atFrameMs(frameMs, 30_000), stalled(4_000), atFrameMs(frameMs, 30_000))

      expect(said).not.toHaveBeenCalled()
      controller.disable()
    }
  })

  it('says nothing when the worker stops sending estimates, which main logs', async () => {
    const { controller, said, work } = await listeningWithWorker()

    work(keepingUp(2_000), stalled(30_000))

    expect(said).not.toHaveBeenCalled()
    controller.disable()
  })

  it('counts afresh when the estimates come back after a gap, from a worker that starts behind', async () => {
    const away = {
      setting: (controller: InstanceType<typeof VoiceController>, on: boolean) => (controller.vapEnabled = on),
      language: (controller: InstanceType<typeof VoiceController>, on: boolean) =>
        (controller.conversationLocale = on ? 'ja-JP' : 'en-US'),
      // The watchdog in main starts a worker that ended again, which the renderer does not see.
      restart: () => {}
    }
    for (const turn of Object.values(away)) {
      const { controller, said, work, stop, restart } = await listeningWithWorker()
      // The worker falls behind under load, without being behind long enough to be told.
      work(keepingUp(2_000), loaded(4_000))
      turn(controller, false)
      stop(3_000)
      turn(controller, true)
      // The new worker starts 720 ms behind, falls behind for a moment, and catches up.
      restart(9)
      work(loaded(1_500), keepingUp(10_000))

      expect(said).not.toHaveBeenCalled()
      controller.disable()
    }
  })

  it('counts afresh with each run of the microphone', async () => {
    const { controller, said, work } = await listeningWithWorker()
    work(keepingUp(2_000))

    // The load holds the worker back throughout, while the microphone is turned off and on every 1.5 s.
    for (let run = 0; run < 6; run++) {
      work(loaded(1_500))
      controller.disable()
      await controller.enable()
    }

    expect(said).not.toHaveBeenCalled()
    controller.disable()
  })

  it('says nothing while the microphone is off or MaAI takes no part, whatever the estimates say', async () => {
    const away = {
      microphone: (controller: InstanceType<typeof VoiceController>) => controller.disable(),
      setting: (controller: InstanceType<typeof VoiceController>) => (controller.vapEnabled = false),
      language: (controller: InstanceType<typeof VoiceController>) => (controller.conversationLocale = 'en-US')
    }
    for (const leave of Object.values(away)) {
      const { controller, said, work } = await listeningWithWorker()
      work(keepingUp(2_000))

      leave(controller)
      work(loaded(15_000))

      expect(said).not.toHaveBeenCalled()
      controller.disable()
    }
  })

  it('judges the turn-taking model alone, which decides the end of speech', async () => {
    const heard = async (heldBack: 'turn' | 'backchannel'): Promise<number> => {
      const { controller, said, work } = await listeningWithWorker(heldBack)
      work(keepingUp(2_000), loaded(15_000))
      controller.disable()
      return said.mock.calls.length
    }

    expect(await heard('turn')).toBe(1)
    expect(await heard('backchannel')).toBe(0)
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
