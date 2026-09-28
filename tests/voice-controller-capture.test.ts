import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechSegment } from '@shared/ipc'
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
  captureIsBackchannel: boolean
  captureStartedAt: number
  vad: { push(frame: Float32Array): void; isSpeaking: boolean }
  recognition: { transcribe: (audio: Float32Array) => Promise<string> }
}

let VoiceController: typeof import('@/voice/VoiceController').VoiceController
let speechPlayer: Player
let playing = false

beforeAll(async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  ;({ VoiceController } = await import('@/voice/VoiceController'))
  ;({ speechPlayer } = await import('@/voice/SpeechPlayer'))
  Object.defineProperty(speechPlayer, 'isPlaying', { get: () => playing, configurable: true })
  Object.defineProperty(speechPlayer, 'isPlayingClip', { get: () => false, configurable: true })
})

beforeEach(() => {
  playing = false
  vi.restoreAllMocks()
  vi.stubGlobal('window', {
    api: {
      transcribe: vi.fn(async () => ''),
      transcribeCancel: vi.fn(async () => true),
      transcribePartial: vi.fn(async () => ''),
      getStatus: vi.fn(async () => ({ asr: true }))
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
    feed(controller, 5, loud)
    internals(controller).captureIsBackchannel = true
    feed(controller, 20, loud)
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
