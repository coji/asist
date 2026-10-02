import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechSegment, VapState } from '@shared/ipc'
import type { SpeechEnd, VoiceState } from '@/voice/VoiceController'

/**
 * The capture lifecycle, driven through the real VAD with 20 ms frames: how a capture ends, how
 * playback that overlaps a capture is handled, and what every speech end is followed by.
 */

class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  state = 'running'
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
  paused = false
}

type Controller = InstanceType<typeof import('@/voice/VoiceController').VoiceController>
type Player = typeof import('@/voice/SpeechPlayer').speechPlayer

interface Internals {
  state: VoiceState
  lastPartial: string
  lastBackchannelAt: number
  overlap: { kind: string }
  captureStartedAt: number
  vapState: VapState | null
  vapStateAt: number
  vad: {
    push(frame: Float32Array): void
    isSpeaking: boolean
    speechProbProvider: (() => number | null) | null
  }
  recognition: { transcribe: (audio: Float32Array) => Promise<string> }
  microphone: { mic: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } }
}

let VoiceController: typeof import('@/voice/VoiceController').VoiceController
let speechPlayer: Player
let playing = false
/** Whether what plays is a single clip, an aizuchi or a bridge, rather than the reply's body. */
let playingClip = false

beforeAll(async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  ;({ VoiceController } = await import('@/voice/VoiceController'))
  ;({ speechPlayer } = await import('@/voice/SpeechPlayer'))
  Object.defineProperty(speechPlayer, 'isPlaying', { get: () => playing, configurable: true })
  Object.defineProperty(speechPlayer, 'isPlayingClip', { get: () => playing && playingClip, configurable: true })
})

beforeEach(() => {
  playing = false
  playingClip = false
  vi.restoreAllMocks()
  vi.stubGlobal('window', {
    api: {
      transcribe: vi.fn(async () => ''),
      transcribeCancel: vi.fn(async () => true),
      transcribePartial: vi.fn(async () => ''),
      getStatus: vi.fn(async () => ({ asr: true })),
      vapStart: vi.fn(async () => true),
      vapPush: vi.fn(async () => undefined),
      onVapState: vi.fn(() => vi.fn())
    }
  })
})

const FRAME = 320
const loud = (): Float32Array => new Float32Array(FRAME).fill(0.1)
const quiet = (): Float32Array => new Float32Array(FRAME)
const internals = (c: Controller): Internals => c as unknown as Internals

function listening(): Controller {
  const controller = new VoiceController()
  controller.partialIntervalMs = 0
  internals(controller).state = 'listening'
  return controller
}

function feed(controller: Controller, frames: number, make: () => Float32Array, each?: () => void): void {
  for (let i = 0; i < frames; i++) {
    internals(controller).vad.push(make())
    each?.()
  }
}

function startPlaying(segment: SpeechSegment): void {
  playing = true
  playingClip = segment.index === -1
  speechPlayer.events.emit('segmentstart', { segment, durationMs: 1000 })
}

const reply: SpeechSegment = { turnId: 1, index: 0, text: '明日の天気は晴れです。', audio: 'x', phonemes: null }

describe('VoiceController state when a capture ends without an utterance', () => {
  it('returns to listening after the VAD throws a cough away, so the next capture announces itself', () => {
    const controller = listening()
    const states: VoiceState[] = []
    controller.events.on('state', (state) => states.push(state))

    // 100 ms of sound is too little voice for an utterance.
    feed(controller, 5, loud)
    feed(controller, 30, quiet)
    expect(controller.current).toBe('listening')

    states.length = 0
    feed(controller, 3, loud)
    expect(states).toEqual(['capturing'])
  })

  it('returns to listening after a capture that was let pass as the user\'s aizuchi', () => {
    const controller = listening()
    const ends: SpeechEnd[] = []
    controller.events.on('speechend', (end) => ends.push(end))
    feed(controller, 25, loud)
    internals(controller).overlap = { kind: 'backchannel' }
    feed(controller, 30, quiet)

    expect(ends).toEqual([])
    expect(controller.current).toBe('listening')
  })
})

describe('VoiceController with barge-in off', () => {
  it('keeps the utterance in progress when its own listening aizuchi starts playing', async () => {
    const controller = listening()
    controller.bargeIn = false
    controller.listeningAizuchi = true
    controller.conversationLocale = 'ja-JP'
    const ends: SpeechEnd[] = []
    controller.events.on('speechend', (end) => ends.push(end))
    let aizuchiFired = false
    controller.events.on('backchannel', () => (aizuchiFired = true))

    // Three seconds of speech whose partial transcript ends on a clause boundary.
    feed(controller, 150, loud)
    internals(controller).lastPartial = '昨日の夜に資料を作っていたんですけど'
    internals(controller).lastBackchannelAt = -60_000
    // The listening aizuchi fires in the pause, and the quiet "うん" starts sounding.
    let clipStarted = false
    feed(controller, 14, quiet, () => {
      if (!aizuchiFired || clipStarted) return
      clipStarted = true
      startPlaying({ turnId: -1, index: -1, text: 'うん', audio: 'x', phonemes: null, clip: 'listening' })
    })
    expect(clipStarted).toBe(true)
    // The user carries on at once, over the clip and after it.
    feed(controller, 20, loud)
    playing = false
    speechPlayer.events.emit('idle', { turnId: -1 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    feed(controller, 50, loud)
    feed(controller, 30, quiet)

    expect(ends).toHaveLength(1)
    // The utterance still holds the three seconds spoken before the aizuchi.
    expect(ends[0].utteranceMs).toBeGreaterThan(3500)
  })

  it('does not let a voice that starts over a listening aizuchi stop the playback', () => {
    const controller = listening()
    controller.bargeIn = false
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})
    let bargein = false
    controller.events.on('bargein', () => (bargein = true))

    // The listening aizuchi leaves the VAD open, so the user's next sentence is heard over it.
    startPlaying({ turnId: -1, index: -1, text: 'うん', audio: 'x', phonemes: null, clip: 'listening' })
    feed(controller, 60, loud)
    expect(controller.current).toBe('capturing')

    expect(bargein).toBe(false)
    expect(interrupt).not.toHaveBeenCalled()
  })
})

describe('VoiceController when the reply starts while the user is already speaking', () => {
  it('ducks the reply and stops it once the voice holds, announcing the barge-in while the reply still plays', () => {
    const controller = listening()
    controller.bargeIn = true
    const order: string[] = []
    const duck = vi.spyOn(speechPlayer, 'duck').mockImplementation(() => {})
    vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => order.push('interrupt'))
    controller.events.on('bargein', () => order.push('bargein'))

    feed(controller, 10, loud)
    startPlaying(reply)
    expect(duck).toHaveBeenCalled()
    feed(controller, 50, loud)

    expect(order).toEqual(['bargein', 'interrupt'])
  })

  it('treats the start of its own listening aizuchi as no overlap', () => {
    const controller = listening()
    controller.bargeIn = true
    const duck = vi.spyOn(speechPlayer, 'duck').mockImplementation(() => {})
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})

    feed(controller, 10, loud)
    startPlaying({ turnId: -1, index: -1, text: 'うん', audio: 'x', phonemes: null, clip: 'listening' })
    feed(controller, 60, loud)

    expect(duck).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })
})

describe('VoiceController with a voice over the reply that MaAI reads as an aizuchi', () => {
  /** bc_det reads the voice as an aizuchi; the EoT sits between its thresholds, so the fixed hangover applies. */
  const aizuchi: VapState = {
    t: 0, pNowUser: 0.5, pNowAssistant: 0.5, pFutureUser: 0.5, pFutureAssistant: 0.5,
    eotUser: 0.5, bcDetUser: 0.9, bcReact: 0, bcEmo: 0, nodShort: 0, nodLong: 0, inferMs: 1,
    turnLagMs: 0, backchannelLagMs: 0
  }

  function withMaai(): { controller: Controller; ends: SpeechEnd[]; utterances: string[]; letPass: () => number } {
    const controller = listening()
    controller.bargeIn = true
    controller.listeningAizuchi = false
    controller.conversationLocale = 'ja-JP'
    controller.vapEnabled = true
    internals(controller).recognition.transcribe = vi.fn(async () => 'はい、じゃあ明日の予定を入れて')
    vi.spyOn(speechPlayer, 'duck').mockImplementation(() => {})
    vi.spyOn(speechPlayer, 'unduck').mockImplementation(() => {})
    vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})
    let passed = 0
    controller.events.on('userBackchannel', () => passed++)
    const ends: SpeechEnd[] = []
    controller.events.on('speechend', (end) => ends.push(end))
    const utterances: string[] = []
    controller.events.on('utterance', ({ text }) => utterances.push(text))
    return { controller, ends, utterances, letPass: () => passed }
  }

  const estimate = (controller: Controller) => (): void => {
    internals(controller).vapState = aizuchi
    internals(controller).vapStateAt = performance.now()
  }

  function endReply(): void {
    playing = false
    speechPlayer.events.emit('idle', { turnId: 1 })
  }

  it('transcribes the voice when it carries on past the end of the reply', async () => {
    const { controller, ends, utterances, letPass } = withMaai()
    startPlaying({ ...reply, text: 'どうしますか?' })
    feed(controller, 10, loud, estimate(controller))
    expect(letPass()).toBe(1)

    // The reply ends 200 ms into the voice, and the request goes on for two more seconds.
    endReply()
    feed(controller, 100, loud, estimate(controller))
    feed(controller, 30, quiet, estimate(controller))
    await vi.waitFor(() => expect(utterances).toEqual(['はい、じゃあ明日の予定を入れて']))

    expect(ends).toHaveLength(1)
    expect(speechPlayer.interrupt).not.toHaveBeenCalled()
  })

  it('discards a lone aizuchi that ends with the reply', async () => {
    const { controller, ends, letPass } = withMaai()
    startPlaying({ ...reply, text: 'どうしますか?' })
    // A 「はい」 long enough for the VAD to keep, over the last 400 ms of the reply and a little past it.
    feed(controller, 20, loud, estimate(controller))
    expect(letPass()).toBe(1)

    endReply()
    feed(controller, 5, loud, estimate(controller))
    feed(controller, 30, quiet, estimate(controller))
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(controller.current).toBe('listening')
    expect(ends).toEqual([])
    expect(internals(controller).recognition.transcribe).not.toHaveBeenCalled()
  })

  it('transcribes an answer that begins as an aizuchi over the last word of the reply', async () => {
    const { controller, ends, utterances } = withMaai()
    startPlaying({ ...reply, text: 'どうしますか?' })
    // 「うん」 over the last 300 ms of the reply, and 「そうして」 straight after it, 700 ms in all.
    feed(controller, 15, loud, estimate(controller))
    endReply()
    feed(controller, 20, loud, estimate(controller))
    feed(controller, 30, quiet, estimate(controller))

    await vi.waitFor(() => expect(utterances).toHaveLength(1))
    expect(ends).toHaveLength(1)
  })

  it('does not take a listening aizuchi that plays after the reply for the reply', () => {
    const { controller } = withMaai()
    let bargeins = 0
    controller.events.on('bargein', () => bargeins++)
    startPlaying({ ...reply, text: 'どうしますか?' })
    feed(controller, 10, loud, estimate(controller))

    // The reply ends, the user pauses, and a listening aizuchi plays as they carry on, by which time
    // MaAI's estimate has gone stale.
    endReply()
    feed(controller, 10, quiet, estimate(controller))
    internals(controller).vapState = null
    startPlaying({ turnId: -1, index: -1, text: 'うん', audio: 'x', phonemes: null, clip: 'listening' })
    feed(controller, 30, loud)

    expect(bargeins).toBe(0)
    expect(speechPlayer.interrupt).not.toHaveBeenCalled()
  })
})

describe('VoiceController with a noise that opens a capture over the reply', () => {
  it('reads the reply on at full volume through a noise that never turns into speech', () => {
    const controller = listening()
    controller.bargeIn = true
    let volume = 'full'
    vi.spyOn(speechPlayer, 'duck').mockImplementation(() => (volume = 'down'))
    vi.spyOn(speechPlayer, 'unduck').mockImplementation(() => (volume = 'full'))
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})
    internals(controller).vad.speechProbProvider = () => 0

    startPlaying(reply)
    feed(controller, 60, loud)

    expect(interrupt).not.toHaveBeenCalled()
    expect(volume).toBe('full')
  })

  it('brings the volume back up when a moment of voice in the noise comes to nothing', () => {
    const controller = listening()
    controller.bargeIn = true
    controller.listeningAizuchi = false
    let volume = 'full'
    vi.spyOn(speechPlayer, 'duck').mockImplementation(() => (volume = 'down'))
    vi.spyOn(speechPlayer, 'unduck').mockImplementation(() => (volume = 'full'))
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})
    let prob = 0
    internals(controller).vad.speechProbProvider = () => prob

    startPlaying(reply)
    // Typing over the reply, with a single frame of a cough among it, and then three more seconds of typing.
    feed(controller, 20, loud)
    prob = 0.95
    feed(controller, 1, loud)
    prob = 0
    feed(controller, 150, loud)

    expect(interrupt).not.toHaveBeenCalled()
    expect(volume).toBe('full')
  })

  it('stops the reply for a voice that follows the noise inside the same capture', () => {
    const controller = listening()
    controller.bargeIn = true
    controller.listeningAizuchi = false
    vi.spyOn(speechPlayer, 'duck').mockImplementation(() => {})
    vi.spyOn(speechPlayer, 'unduck').mockImplementation(() => {})
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})
    let bargeins = 0
    controller.events.on('bargein', () => bargeins++)
    let prob = 0
    internals(controller).vad.speechProbProvider = () => prob

    startPlaying(reply)
    // 300 ms of typing, which Silero does not take for a voice, and then 「ちょっと止めて」 before the
    // capture closes.
    feed(controller, 15, loud)
    prob = 0.95
    feed(controller, 75, loud)

    expect(bargeins).toBe(1)
    expect(interrupt).toHaveBeenCalledOnce()
  })
})

describe('VoiceController when the input falls back from the native helper during a reply', () => {
  it('does not take the echo through getUserMedia for a barge-in', async () => {
    type Status = { running: boolean; reason?: string }
    let reportStatus!: (status: Status) => void
    Object.assign(window.api, {
      requestMicPermission: vi.fn(async () => true),
      micNativeStart: vi.fn(async () => ({ ok: true, sampleRate: 48_000 })),
      micNativeStop: vi.fn(async () => {}),
      onMicNativeFrame: vi.fn(() => vi.fn()),
      onMicNativeStatus: vi.fn((listener: (status: Status) => void) => {
        reportStatus = listener
        return vi.fn()
      })
    })
    const controller = new VoiceController()
    controller.partialIntervalMs = 0
    controller.noiseSuppression = false
    controller.bargeIn = true
    const mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    internals(controller).microphone.mic = mic
    await controller.enable()
    vi.spyOn(speechPlayer, 'duck').mockImplementation(() => {})
    vi.spyOn(speechPlayer, 'unduck').mockImplementation(() => {})
    const interrupt = vi.spyOn(speechPlayer, 'interrupt').mockImplementation(() => {})

    startPlaying(reply)
    reportStatus({ running: false, reason: 'audio configuration keeps changing' })
    await vi.waitFor(() => expect(mic.start).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(controller.current).toBe('listening'))
    // The reply's echo that Chromium's echo canceller lets through: above the room's noise, well below a voice.
    feed(controller, 30, () => new Float32Array(FRAME).fill(0.05))

    expect(interrupt).not.toHaveBeenCalled()
    controller.disable()
  })
})

describe('VoiceController after a speech end', () => {
  function transcribing(transcribe: () => Promise<string>): { controller: Controller; events: string[] } {
    const controller = listening()
    internals(controller).recognition.transcribe = vi.fn(transcribe)
    const events: string[] = []
    controller.events.on('speechend', ({ startedAt }) => events.push(`speechend:${startedAt}`))
    controller.events.on('utterance', ({ startedAt }) => events.push(`utterance:${startedAt}`))
    controller.events.on('speechdropped', ({ startedAt }) => events.push(`speechdropped:${startedAt}`))
    // One second of speech, then the hangover ends it.
    feed(controller, 50, loud)
    feed(controller, 20, quiet)
    return { controller, events }
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('reports the speech as dropped when its transcription fails', async () => {
    const { controller, events } = transcribing(async () => {
      throw new Error('server error')
    })
    const errors: string[] = []
    controller.events.on('error', (message) => errors.push(message))
    await settle()
    const startedAt = internals(controller).captureStartedAt
    expect(events).toEqual([`speechend:${startedAt}`, `speechdropped:${startedAt}`])
    expect(errors).toHaveLength(1)
    expect(controller.current).toBe('listening')
  })

  it('reports the speech as dropped when its transcript means nothing', async () => {
    const { controller, events } = transcribing(async () => 'ご視聴ありがとうございました')
    await settle()
    const startedAt = internals(controller).captureStartedAt
    expect(events).toEqual([`speechend:${startedAt}`, `speechdropped:${startedAt}`])
  })

  it('reports the speech as dropped at once when the microphone stops before its transcript arrives', async () => {
    let finish!: (text: string) => void
    const { controller, events } = transcribing(() => new Promise((resolve) => (finish = resolve)))
    await settle()
    const startedAt = internals(controller).captureStartedAt
    controller.disable()
    expect(events).toEqual([`speechend:${startedAt}`, `speechdropped:${startedAt}`])
    finish('明日の天気を教えて')
    await settle()
    expect(events).toHaveLength(2)
  })

  it('follows a transcribed speech with its utterance alone', async () => {
    const { controller, events } = transcribing(async () => '明日の天気を教えて')
    await settle()
    const startedAt = internals(controller).captureStartedAt
    expect(events).toEqual([`speechend:${startedAt}`, `utterance:${startedAt}`])
    expect(controller.current).toBe('listening')
  })
})
