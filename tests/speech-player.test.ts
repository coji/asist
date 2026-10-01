import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pauseAfter } from '../src/renderer/src/voice/sentence-pause'

class FakeSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []

  readonly state = 'running'
  readonly currentTime = 0
  readonly destination = {}
  readonly decodeResolvers: Array<(buffer: AudioBuffer) => void> = []
  readonly sources: FakeSource[] = []
  readonly resume = vi.fn(async () => undefined)
  readonly decodeAudioData = vi.fn(
    () =>
      new Promise<AudioBuffer>((resolve) => {
        this.decodeResolvers.push(resolve)
      })
  )

  constructor() {
    FakeAudioContext.instances.push(this)
  }

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
        value: 1,
        cancelScheduledValues: vi.fn(),
        setTargetAtTime: vi.fn()
      }
    } as unknown as GainNode
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return { stream: {} } as MediaStreamAudioDestinationNode
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource()
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

class FakeAudio {
  srcObject: unknown = null
  autoplay = false
  paused = false
  readonly play = vi.fn(async () => undefined)
}

class FakeUtterance {
  readonly text: string
  lang = ''
  rate = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

type SpeechPlayer = InstanceType<typeof import('../src/renderer/src/voice/SpeechPlayer').SpeechPlayer>

interface Harness {
  player: SpeechPlayer
  context: FakeAudioContext
  utterances: FakeUtterance[]
  synthesis: {
    speak: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    paused: boolean
    speaking: boolean
    pending: boolean
  }
}

function segment(turnId: number, index: number, text: string, audio: string | null = null) {
  return { turnId, index, text, audio, phonemes: null }
}

async function createHarness(): Promise<Harness> {
  const utterances: FakeUtterance[] = []
  const synthesis = {
    speak: vi.fn((utterance: FakeUtterance) => utterances.push(utterance)),
    cancel: vi.fn(),
    resume: vi.fn(),
    paused: false,
    speaking: false,
    pending: false
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', synthesis)
  vi.stubGlobal('window', { speechSynthesis: synthesis })

  const { SpeechPlayer } = await import('../src/renderer/src/voice/SpeechPlayer')
  const player = new SpeechPlayer()
  const context = FakeAudioContext.instances.at(-1)!
  return { player, context, utterances, synthesis }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeAudioContext.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SpeechPlayer.discardBody drops only the body of the previous turn when new input arrives', () => {
  it('leaves a playing aizuchi alone and drops only the body waiting in the queue', async () => {
    const { player, context } = await createHarness()
    player.beginTurn(1)
    player.playClip('eA==', 'なるほど', { role: 'aizuchi' })
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    player.enqueue(segment(1, 0, 'old body', 'eA=='))
    expect(player.isPlayingClip).toBe(true)

    player.discardBody()

    expect(context.sources[0].stop).not.toHaveBeenCalled()
    expect(player.isPlaying).toBe(true)
    context.sources[0].onended?.()
    await flushMicrotasks()
    // The discarded body is never played.
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(player.isPlaying).toBe(false)
  })

  it('stops the body that is playing and continues with the aizuchi that is left', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))
    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'old body', 'eA=='))
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    player.playClip('eA==', 'なるほど', { role: 'aizuchi' })
    expect(player.isPlayingClip).toBe(false)

    player.discardBody()

    expect(context.sources[0].stop).toHaveBeenCalledOnce()
    context.decodeResolvers[1]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    expect(starts).toEqual(['old body', 'なるほど'])
    expect(player.bodyQueuedAfter(0)).toBe(false)
    player.interrupt()
  })

  it('does not stop an aizuchi that is still waiting to be decoded', async () => {
    const { player, context } = await createHarness()
    player.beginTurn(1)
    player.playClip('eA==', 'なるほど', { role: 'aizuchi' })
    expect(player.isPlayingClip).toBe(true)
    player.discardBody()
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].start).toHaveBeenCalledOnce()
    player.interrupt()
  })
})

describe('SpeechPlayer.dropWaiting, which withdraws a bridge that no answer follows', () => {
  it('drops the bridge waiting behind the aizuchi and goes on to the sentence after it', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))
    player.beginTurn(1)
    player.playClip('eA==', 'なるほど', { role: 'aizuchi' })
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    const bridge = player.playClip('eA==', '会議の件ですね。', { role: 'bridge' })
    player.enqueue(segment(1, 0, 'すみません、うまくいきませんでした。', 'eA=='))

    player.dropWaiting(bridge)
    context.sources[0].onended?.()
    await flushMicrotasks()
    context.decodeResolvers[1]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()

    expect(starts).toEqual(['なるほど', 'すみません、うまくいきませんでした。'])
    player.interrupt()
  })
})

describe('SpeechPlayer.bodyQueuedAfter, which tells whether the bridge came too late', () => {
  it('does not count the filler played while a tool runs as the answer', async () => {
    const { player } = await createHarness()
    const speechEnd = performance.now() - 1
    player.beginTurn(1)
    player.enqueue(segment(1, 998, '少々お待ちください。'))
    expect(player.bodyQueuedAfter(speechEnd)).toBe(false)
    player.enqueue(segment(1, 0, '明日は晴れです。'))
    expect(player.bodyQueuedAfter(speechEnd)).toBe(true)
    player.interrupt()
  })
})

describe('SpeechPlayer.playClip replacing one preview with another', () => {
  it('stops the previous sample and plays the new one when a second preview starts mid-playback', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))
    player.playClip('eA==', 'A', { role: 'preview' })
    context.decodeResolvers[0]({ duration: 4 } as AudioBuffer)
    await flushMicrotasks()
    expect(starts).toEqual(['A'])

    player.playClip('eA==', 'B', { role: 'preview' })
    expect(context.sources[0].stop).toHaveBeenCalledOnce()
    context.decodeResolvers[1]({ duration: 4 } as AudioBuffer)
    await flushMicrotasks()
    expect(starts).toEqual(['A', 'B'])
    player.interrupt()
  })

  it('lets a playing aizuchi finish and drops only the older waiting preview', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))
    player.playClip('eA==', 'なるほど', { role: 'aizuchi' })
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()
    player.playClip('eA==', 'A', { role: 'preview' })
    player.playClip('eA==', 'B', { role: 'preview' })
    expect(context.sources[0].stop).not.toHaveBeenCalled()
    context.sources[0].onended?.()
    await flushMicrotasks()
    context.decodeResolvers[1]({ duration: 4 } as AudioBuffer)
    await flushMicrotasks()
    expect(starts).toEqual(['なるほど', 'B'])
    player.interrupt()
  })
})

describe('SpeechPlayer generations and queue ordering', () => {
  it('does not start decoded audio from an interrupted generation', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'obsolete', 'eA=='))
    expect(context.decodeResolvers).toHaveLength(1)

    player.interrupt()
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()

    expect(context.sources).toHaveLength(0)
    expect(starts).toEqual([])
    expect(player.isPlaying).toBe(false)
  })

  it('emits segmentstart only when synthesized audio actually starts', async () => {
    const { player, context } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'actual', 'eA=='))
    expect(starts).toEqual([])

    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()

    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].start).toHaveBeenCalledOnce()
    expect(starts).toEqual(['actual'])
    player.interrupt()
  })

  it('waits for the Web Speech start event before reporting actual playback', async () => {
    const { player, utterances } = await createHarness()
    const starts: string[] = []
    player.events.on('segmentstart', (value) => starts.push(value.segment.text))

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'system voice'))
    expect(starts).toEqual([])

    utterances[0].onstart?.()
    expect(starts).toEqual(['system voice'])
    player.interrupt()
  })

  it('falls back when synthesized audio decoding times out', async () => {
    vi.useFakeTimers()
    const { player, synthesis } = await createHarness()

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'decode timeout', 'eA=='))
    await vi.advanceTimersByTimeAsync(15_000)

    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'decode timeout'
    ])
    player.interrupt()
  })

  it('reports the turn it stopped when a barge-in interrupts the reply', async () => {
    const { player, context } = await createHarness()
    const idle: number[] = []
    player.events.on('idle', ({ turnId }) => idle.push(turnId))
    player.beginTurn(4)
    player.playClip('eA==', 'はい。', { role: 'aizuchi' })
    player.enqueue(segment(4, 0, '明日は晴れです。', 'eA=='))
    // Only the clip sounds at first, so no reply is being read yet.
    expect(player.readingTurn).toBe(-1)
    context.decodeResolvers[0]({ duration: 0.3 } as AudioBuffer)
    await flushMicrotasks()
    context.sources[0].onended?.()
    await flushMicrotasks()
    context.decodeResolvers[1]({ duration: 2 } as AudioBuffer)
    await flushMicrotasks()
    expect(player.readingTurn).toBe(4)

    player.interrupt()

    expect(idle).toEqual([4])
    expect(player.readingTurn).toBe(-1)
  })

  it('does not read a listening aizuchi aloud through the system voice when its audio fails, and moves on', async () => {
    vi.useFakeTimers()
    const { player, synthesis } = await createHarness()
    const idle = vi.fn()
    player.events.on('idle', idle)

    player.playClip('eA==', 'うん', { role: 'listening', volume: 0.4 })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(synthesis.speak).not.toHaveBeenCalled()
    expect(idle).toHaveBeenCalledOnce()
    expect(player.isPlaying).toBe(false)
  })

  it('advances the queue when AudioBufferSource onended is lost', async () => {
    vi.useFakeTimers()
    const { player, context, synthesis } = await createHarness()

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'synthesized', 'eA=='))
    player.enqueue(segment(1, 1, 'next fallback'))
    context.decodeResolvers[0]({ duration: 1 } as AudioBuffer)
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(8_000 + pauseAfter('synthesized'))
    expect(context.sources[0].stop).toHaveBeenCalledOnce()
    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'next fallback'
    ])
    player.interrupt()
  })

  it('forces a hung decode to fallback during sleep/wake recovery', async () => {
    const { player, synthesis } = await createHarness()

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'recover me', 'eA=='))
    player.recover()
    await flushMicrotasks()

    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual(['recover me'])
    player.interrupt()
  })

  it('ignores a stale Web Speech callback instead of consuming the new queue', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'old current'))
    player.enqueue(segment(1, 1, 'old queued'))
    const staleFinish = utterances[0].onend!

    player.interrupt()
    player.beginTurn(2)
    player.enqueue(segment(2, 0, 'new current'))
    player.enqueue(segment(2, 1, 'new queued'))

    staleFinish()
    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'old current',
      'new current'
    ])

    utterances[1].onend?.()
    await vi.advanceTimersByTimeAsync(pauseAfter('new current'))
    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'old current',
      'new current',
      'new queued'
    ])
    player.interrupt()
  })

  it('speaks through the system voice in the conversation language, and estimates the progress by script', async () => {
    vi.useFakeTimers()
    const { useSettingsStore } = await import('@/state/stores')
    const { player, utterances } = await createHarness()
    const durations: number[] = []
    player.events.on('segmentstart', (value) => durations.push(value.durationMs))

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'あいうえお'))
    utterances[0].onstart?.()
    expect(utterances[0].lang).toBe('ja-JP')
    expect(durations).toEqual([5 * 140])

    useSettingsStore.setState({ settings: { conversationLocale: 'es-419' } as never })
    try {
      utterances[0].onend?.()
      player.enqueue(segment(1, 1, 'Hola.'))
      await vi.advanceTimersByTimeAsync(pauseAfter('あいうえお'))
      utterances[1].onstart?.()
      // Latin America has no voice of its own on macOS, so the tag names Mexico.
      expect(utterances[1].lang).toBe('es-MX')
      expect(durations).toEqual([5 * 140, 5 * 67])
    } finally {
      useSettingsStore.setState({ settings: null })
    }
    player.interrupt()
  })

  it('appends a system interject after current and already queued playback', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()

    player.beginTurn(1)
    player.enqueue(segment(1, 0, 'current'))
    player.enqueue(segment(1, 1, 'queued'))
    player.beginTurn(2, true)
    player.enqueue(segment(2, 0, 'system report'))

    utterances[0].onend?.()
    await vi.advanceTimersByTimeAsync(pauseAfter('current'))
    utterances[1].onend?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(synthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'current',
      'queued',
      'system report'
    ])
    player.interrupt()
  })
})

describe('the pause between the pieces of an answer', () => {
  const spoken = (synthesis: Harness['synthesis']): string[] => synthesis.speak.mock.calls.map(([utterance]) => utterance.text)

  it('waits after a sentence before the next one, and less after a comma', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()
    player.beginTurn(1)
    player.enqueue(segment(1, 0, '今日は晴れです。'))
    player.enqueue(segment(1, 1, '明日は雨が降りそうなので、'))
    player.enqueue(segment(1, 2, '傘を持っていきましょう。'))
    utterances[0].onend?.()
    await vi.advanceTimersByTimeAsync(pauseAfter('今日は晴れです。') - 1)
    expect(spoken(synthesis)).toEqual(['今日は晴れです。'])
    await vi.advanceTimersByTimeAsync(1)
    expect(spoken(synthesis)).toHaveLength(2)
    utterances[1].onend?.()
    await vi.advanceTimersByTimeAsync(pauseAfter('明日は雨が降りそうなので、'))
    expect(spoken(synthesis)).toHaveLength(3)
    expect(pauseAfter('明日は雨が降りそうなので、')).toBeLessThan(pauseAfter('今日は晴れです。'))
    player.interrupt()
  })

  it('counts the time spent waiting for the next piece towards the pause', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()
    player.beginTurn(1)
    player.enqueue(segment(1, 0, '一文目。'))
    utterances[0].onend?.()
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + pauseAfter('一文目。'))
    player.enqueue(segment(1, 1, '二文目。'))
    await vi.advanceTimersByTimeAsync(0)
    expect(spoken(synthesis)).toEqual(['一文目。', '二文目。'])
    player.interrupt()
  })

  it('adds no pause around a clip, nor between the pieces on either side of it', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()
    player.beginTurn(1)
    player.enqueue(segment(1, 0, '調べますね。'))
    player.enqueue({ ...segment(1, 998, 'ちょっと待ってくださいね。') })
    player.enqueue(segment(1, 1, '見つかりました。'))
    utterances[0].onend?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(spoken(synthesis)).toHaveLength(2)
    utterances[1].onend?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(spoken(synthesis)).toEqual(['調べますね。', 'ちょっと待ってくださいね。', '見つかりました。'])
    player.interrupt()
  })

  it('stops waiting when the answer is interrupted during the pause', async () => {
    vi.useFakeTimers()
    const { player, utterances, synthesis } = await createHarness()
    player.beginTurn(1)
    player.enqueue(segment(1, 0, '一文目。'))
    player.enqueue(segment(1, 1, '二文目。'))
    utterances[0].onend?.()
    player.interrupt()
    await vi.advanceTimersByTimeAsync(pauseAfter('一文目。'))
    expect(spoken(synthesis)).toEqual(['一文目。'])
  })
})
