import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pauseAfter } from '../src/renderer/src/voice/sentence-pause'

/**
 * Playback of PCM that arrives in pieces: the stream from a live model, and a segment a speech engine
 * returns while it is still synthesizing. Chunks are scheduled back to back and dropped on an interruption.
 */

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  startedAt: number | null = null
  readonly stop = vi.fn()
  start(at: number): void {
    this.startedAt = at
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state = 'running'
  currentTime = 0
  readonly sampleRate = 48_000
  readonly destination = {}
  readonly sources: FakeSource[] = []
  readonly resume = vi.fn(async () => undefined)
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createAnalyser(): AnalyserNode {
    return { fftSize: 0, connect: vi.fn(), getByteTimeDomainData: vi.fn() } as unknown as AnalyserNode
  }
  createGain(): GainNode {
    return { connect: vi.fn(), gain: { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() } } as unknown as GainNode
  }
  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return { stream: {} } as MediaStreamAudioDestinationNode
  }
  createBuffer(_channels: number, length: number, rate: number): AudioBuffer {
    const data = new Float32Array(length)
    return { duration: length / rate, getChannelData: () => data } as unknown as AudioBuffer
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
  vi.stubGlobal('window', { speechSynthesis: undefined })
  FakeAudioContext.instances = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SpeechPlayer.streamPush', () => {
  it('schedules the first chunk slightly ahead and each later one at the end of the previous, and reports start and stop', async () => {
    const { SpeechPlayer } = await import('../src/renderer/src/voice/SpeechPlayer')
    const player = new SpeechPlayer()
    const context = FakeAudioContext.instances.at(-1)!
    const started = vi.fn()
    const idle = vi.fn()
    player.events.on('streamstart', started)
    player.events.on('streamidle', idle)
    player.streamPush(new Float32Array(2400), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    player.streamPush(new Float32Array(2400), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sources.map((s) => s.startedAt)).toEqual([0.12, 0.22])
    expect(player.isStreaming).toBe(true)
    expect(started).toHaveBeenCalledOnce()
    expect(player.level()).toBeGreaterThanOrEqual(0)
    // Once everything scheduled has played and no further chunk arrives, playback counts as stopped.
    context.currentTime = 0.4
    await vi.advanceTimersByTimeAsync(1000)
    expect(idle).toHaveBeenCalledOnce()
    expect(player.isStreaming).toBe(false)
  })

  it('stops and drops every scheduled chunk on an interruption', async () => {
    const { SpeechPlayer } = await import('../src/renderer/src/voice/SpeechPlayer')
    const player = new SpeechPlayer()
    const context = FakeAudioContext.instances.at(-1)!
    const idle = vi.fn()
    player.events.on('streamidle', idle)
    player.streamPush(new Float32Array(2400), 24_000)
    player.streamPush(new Float32Array(2400), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    player.streamClear()
    expect(context.sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true)
    expect(idle).toHaveBeenCalledOnce()
    expect(player.isStreaming).toBe(false)
    // A chunk that arrives after the clear is scheduled slightly ahead again.
    player.streamPush(new Float32Array(240), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sources.at(-1)!.startedAt).toBe(0.12)
  })
})

describe('SpeechPlayer.streamPush while the output starts', () => {
  it('plays the chunks in the order they arrived when a chunk arrives while the <audio> element is still starting', async () => {
    // HTMLMediaElement.play() sets paused to false at once and settles its promise in a later task, so
    // a chunk that arrives in between sees an element that is no longer paused.
    let started!: () => void
    class StartingAudio extends FakeAudio {
      override paused = true
      override readonly play = vi.fn(() => {
        this.paused = false
        return new Promise<void>((resolve) => (started = resolve))
      })
    }
    vi.stubGlobal('Audio', StartingAudio)
    const { SpeechPlayer } = await import('../src/renderer/src/voice/SpeechPlayer')
    const player = new SpeechPlayer()
    const context = FakeAudioContext.instances.at(-1)!
    player.streamPush(new Float32Array(2400), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    player.streamPush(new Float32Array(4800), 24_000)
    await vi.advanceTimersByTimeAsync(0)
    started()
    await vi.advanceTimersByTimeAsync(0)
    const scheduled = context.sources.map((source) => [source.buffer?.duration, source.startedAt])
    expect(scheduled).toEqual([
      [0.1, 0.12],
      [0.2, 0.22]
    ])
  })
})

describe('SpeechPlayer with a streamed segment', () => {
  const RATE = 24_000
  const piece = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * RATE))
  const streamed = (turnId: number, index: number, text = 'こんにちは。') =>
    ({ turnId, index, text, audio: null, phonemes: null, stream: { sampleRate: RATE } })
  async function harness() {
    const { SpeechPlayer } = await import('../src/renderer/src/voice/SpeechPlayer')
    const player = new SpeechPlayer()
    const context = FakeAudioContext.instances.at(-1)!
    const started: string[] = []
    const idle = vi.fn()
    player.events.on('segmentstart', ({ segment }) => started.push(segment.text))
    player.events.on('idle', idle)
    player.beginTurn(1)
    return { player, context, started, idle }
  }
  /** Ends every source that has been scheduled, in order, as the audio hardware would. */
  const playOut = (context: FakeAudioContext): void => {
    for (const source of [...context.sources]) {
      const ended = source.onended
      source.onended = null
      ended?.()
    }
  }

  it('waits for enough audio before it starts, so a short first piece does not run dry before the second arrives', async () => {
    const { player, context, started } = await harness()
    player.enqueue(streamed(1, 0))
    player.pushSegmentAudio(1, 0, piece(0.1), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sources).toHaveLength(0)
    expect(started).toEqual([])
    player.pushSegmentAudio(1, 0, piece(0.4), false)
    expect(context.sources.map((s) => s.startedAt)).toEqual([0, 0.1])
    expect(started).toEqual(['こんにちは。'])
  })

  it('starts a segment shorter than the start buffer once it is complete', async () => {
    const { player, context, started } = await harness()
    player.enqueue(streamed(1, 0, 'はい。'))
    player.pushSegmentAudio(1, 0, piece(0.2), false)
    player.pushSegmentAudio(1, 0, piece(0), true)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sources).toHaveLength(1)
    expect(started).toEqual(['はい。'])
  })

  it('collects the audio of the next sentence while the current one plays, and plays it when its turn comes', async () => {
    const { player, context, started, idle } = await harness()
    player.enqueue(streamed(1, 0, '一文目。'))
    player.pushSegmentAudio(1, 0, piece(0.5), true)
    await vi.advanceTimersByTimeAsync(0)
    player.enqueue(streamed(1, 1, '二文目。'))
    player.pushSegmentAudio(1, 1, piece(0.5), false)
    player.pushSegmentAudio(1, 1, piece(0.5), true)
    expect(context.sources).toHaveLength(1)
    expect(started).toEqual(['一文目。'])

    playOut(context)
    await vi.advanceTimersByTimeAsync(pauseAfter('一文目。'))
    expect(context.sources).toHaveLength(3)
    expect(started).toEqual(['一文目。', '二文目。'])
    expect(idle).not.toHaveBeenCalled()
    playOut(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(idle).toHaveBeenCalledOnce()
  })

  it('keeps playing pieces that arrive after playback started, and finishes only after the last one', async () => {
    const { player, context, idle } = await harness()
    player.enqueue(streamed(1, 0))
    player.pushSegmentAudio(1, 0, piece(0.5), false)
    await vi.advanceTimersByTimeAsync(0)
    playOut(context)
    await vi.advanceTimersByTimeAsync(0)
    // The scheduled audio ran out, but the sentence is not complete.
    expect(idle).not.toHaveBeenCalled()
    expect(player.isPlaying).toBe(true)
    context.currentTime = 0.7
    player.pushSegmentAudio(1, 0, piece(0.5), true)
    expect(context.sources.at(-1)!.startedAt).toBe(0.7)
    playOut(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(idle).toHaveBeenCalledOnce()
  })

  it('stops the audio on an interruption and ignores the pieces that still arrive for the dropped sentence', async () => {
    const { player, context, idle } = await harness()
    player.enqueue(streamed(1, 0))
    player.pushSegmentAudio(1, 0, piece(0.5), false)
    await vi.advanceTimersByTimeAsync(0)
    player.interrupt()
    expect(context.sources[0].stop).toHaveBeenCalledOnce()
    expect(idle).toHaveBeenCalledOnce()
    player.pushSegmentAudio(1, 0, piece(0.5), true)
    expect(context.sources).toHaveLength(1)
    expect(player.isPlaying).toBe(false)
  })

  it('moves on when a sentence never completes, so a lost end cannot stall the queue', async () => {
    const { player, context, started } = await harness()
    player.enqueue(streamed(1, 0, '途切れる文。'))
    player.enqueue({ turnId: 1, index: 1, text: '次の文。', audio: null, phonemes: null })
    player.pushSegmentAudio(1, 0, piece(0.5), false)
    await vi.advanceTimersByTimeAsync(0)
    playOut(context)
    expect(player.karaoke()?.text).toBe('途切れる文。')
    await vi.advanceTimersByTimeAsync(8_600 + pauseAfter('途切れる文。'))
    expect(started).toEqual(['途切れる文。'])
    expect(player.karaoke()?.text).toBe('次の文。')
  })

  it('reports the real length for the karaoke once the sentence is complete, and an estimate until then', async () => {
    const { player } = await harness()
    vi.spyOn(performance, 'now').mockReturnValue(1_000)
    player.enqueue(streamed(1, 0, '十文字の文をここに書く'))
    player.pushSegmentAudio(1, 0, piece(0.5), false)
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(performance.now).mockReturnValue(1_500)
    const estimated = player.karaoke()!.ratio
    player.pushSegmentAudio(1, 0, piece(0.5), true)
    // One second of audio arrived in total, of which half a second has played.
    expect(player.karaoke()!.ratio).toBeCloseTo(0.5)
    expect(estimated).toBeLessThan(0.5)
  })

  it('estimates a sentence written in letters from a speaking rate, not from the rate of Japanese', async () => {
    const { SegmentStream } = await import('../src/renderer/src/voice/segment-stream')
    // Eleven characters each, one read as eleven syllables and the other as two words.
    expect(new SegmentStream(RATE, '十文字の文をここに書く').durationMs).toBe(11 * 160)
    expect(new SegmentStream(RATE, 'eleven here').durationMs).toBe(11 * 67)
  })
})
