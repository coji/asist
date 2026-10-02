import { describe, expect, it, vi } from 'vitest'
import type { SpeechSegment } from '@shared/ipc'
import { SynthQueue, type SynthesizedSentence } from '../src/main/services/brain/synth-queue'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

function makeQueue(opts?: {
  synthesize?: (text: string, signal: AbortSignal) => Promise<SynthesizedSentence>
  take?: (waiting: readonly string[]) => { text: string; count: number }
  controller?: AbortController
  onFirstSynth?: (ms: number) => void
}): {
  queue: SynthQueue
  segments: SpeechSegment[]
  audio: Array<[number, number[], boolean]>
  failures: string[]
  controller: AbortController
} {
  const controller = opts?.controller ?? new AbortController()
  const segments: SpeechSegment[] = []
  const audio: Array<[number, number[], boolean]> = []
  const failures: string[] = []
  const queue = new SynthQueue({
    turnId: 7,
    signal: controller.signal,
    synthesize: opts?.synthesize ?? (async (text) => ({ kind: 'whole', audio: `wav:${text}`, phonemes: null })),
    take: opts?.take,
    emitSegment: (s) => segments.push(s),
    emitAudio: (index, samples, last) => audio.push([index, [...samples], last]),
    onFirstSynth: opts?.onFirstSynth,
    onFailure: (err) => failures.push((err as Error).message)
  })
  return { queue, segments, audio, failures, controller }
}

const streamed = (pieces: AsyncIterable<Float32Array>): SynthesizedSentence => ({ kind: 'stream', sampleRate: 24_000, pieces })

describe('SynthQueue', () => {
  it('synthesizes the sentences in order and emits each one as a segment carrying its index', async () => {
    const { queue, segments } = makeQueue()
    queue.push('一文目。')
    queue.push('二文目。')
    await queue.drain()
    expect(segments.map((s) => [s.index, s.text, s.audio])).toEqual([
      [0, '一文目。', 'wav:一文目。'],
      [1, '二文目。', 'wav:二文目。']
    ])
    expect(segments.every((s) => s.turnId === 7)).toBe(true)
  })

  it('calls onFirstSynth for the first sentence only, which is what measures ttsMs', async () => {
    const onFirstSynth = vi.fn()
    const { queue } = makeQueue({ onFirstSynth })
    queue.push('a')
    queue.push('b')
    await queue.drain()
    expect(onFirstSynth).toHaveBeenCalledOnce()
  })

  it('drops the rest of the queue once the turn is aborted', async () => {
    const controller = new AbortController()
    let synthCount = 0
    const { queue, segments } = makeQueue({
      controller,
      synthesize: async (text) => {
        synthCount++
        // A barge-in arrives while the first sentence is being synthesized.
        if (synthCount === 1) controller.abort()
        return { kind: 'whole', audio: `wav:${text}`, phonemes: null }
      }
    })
    queue.push('a')
    queue.push('b')
    queue.push('c')
    await flush()
    expect(segments).toHaveLength(0)
    expect(synthCount).toBe(1)
  })

  it('moves on to the next sentence when one fails to synthesize, and reports the failure', async () => {
    let calls = 0
    const { queue, segments, failures } = makeQueue({
      synthesize: async (text) => {
        calls++
        if (calls === 1) throw new Error('tts down')
        return { kind: 'whole', audio: `wav:${text}`, phonemes: null }
      }
    })
    queue.push('失敗する文')
    queue.push('成功する文')
    await queue.drain()
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('成功する文')
    expect(failures).toEqual(['tts down'])
  })

  // An engine that cannot read the language of the conversation fails on every sentence of the turn,
  // and the user needs to be told that once, not once per sentence.
  it('reports only the first failure of the turn', async () => {
    const { queue, segments, failures } = makeQueue({
      synthesize: async () => {
        throw new Error('cannot speak English')
      }
    })
    queue.push('one')
    queue.push('two')
    queue.push('three')
    await queue.drain()
    expect(segments).toHaveLength(0)
    expect(failures).toEqual(['cannot speak English'])
  })

  it('drain waits for every synthesis to finish', async () => {
    const { queue, segments } = makeQueue({
      synthesize: async (text) => {
        await new Promise((r) => setTimeout(r, 20))
        return { kind: 'whole', audio: `wav:${text}`, phonemes: null }
      }
    })
    queue.push('a')
    queue.push('b')
    await queue.drain()
    expect(segments).toHaveLength(2)
  })

  it('emits a streamed sentence as a segment followed by its pieces in order, and closes it before the next sentence starts', async () => {
    const { queue, segments, audio } = makeQueue({
      synthesize: async (text) =>
        text === 'streamed'
          ? streamed((async function* () {
              yield new Float32Array([1, 2])
              yield new Float32Array([3])
            })())
          : { kind: 'whole', audio: 'wav', phonemes: null }
    })
    queue.push('streamed')
    queue.push('whole')
    await queue.drain()
    expect(segments.map((s) => [s.index, s.audio, s.stream])).toEqual([
      [0, null, { sampleRate: 24_000 }],
      [1, 'wav', undefined]
    ])
    expect(audio).toEqual([[0, [1, 2], false], [0, [3], false], [0, [], true]])
  })

  it('closes a streamed segment that fails midway, so the player does not wait for more, and continues with the next sentence', async () => {
    const { queue, segments, audio } = makeQueue({
      synthesize: async (text) =>
        text === 'breaks'
          ? streamed((async function* () {
              yield new Float32Array([1])
              throw new Error('worker died')
            })())
          : { kind: 'whole', audio: 'wav', phonemes: null }
    })
    queue.push('breaks')
    queue.push('next')
    await queue.drain()
    expect(audio).toEqual([[0, [1], false], [0, [], true]])
    expect(segments.map((s) => s.text)).toEqual(['breaks', 'next'])
  })

  it('ends a streamed sentence the engine stopped because the user chose another one without reporting a failure, and reads on', async () => {
    const { queue, segments, audio, failures } = makeQueue({
      synthesize: async (text) =>
        text === 'cut'
          ? streamed((async function* () {
              yield new Float32Array([1])
              throw new DOMException('stopped', 'AbortError')
            })())
          : { kind: 'whole', audio: 'wav', phonemes: null }
    })
    queue.push('cut')
    queue.push('next')
    await queue.drain()
    expect(audio).toEqual([[0, [1], false], [0, [], true]])
    expect(segments.map((s) => s.text)).toEqual(['cut', 'next'])
    expect(failures).toEqual([])
  })

  it('stops forwarding pieces and closes the segment when the turn is aborted during a streamed sentence', async () => {
    const controller = new AbortController()
    const { queue, audio } = makeQueue({
      controller,
      synthesize: async () =>
        streamed((async function* () {
          yield new Float32Array([1])
          controller.abort()
          yield new Float32Array([2])
        })())
    })
    queue.push('a')
    queue.push('b')
    await flush()
    expect(audio).toEqual([[0, [1], false], [0, [], true]])
  })

  it('reads in one request the sentences that waited while the one before was synthesized, when take joins them', async () => {
    let release: () => void = () => {}
    const requests: string[] = []
    const { queue, segments } = makeQueue({
      take: (waiting) => ({ text: waiting.join(''), count: waiting.length }),
      synthesize: async (text) => {
        requests.push(text)
        if (requests.length === 1) await new Promise<void>((resolve) => { release = resolve })
        return { kind: 'whole', audio: `wav:${text}`, phonemes: null }
      }
    })
    queue.push('一文目。')
    await flush()
    queue.push('二文目。')
    queue.push('三文目。')
    release()
    await queue.drain()
    expect(requests).toEqual(['一文目。', '二文目。三文目。'])
    expect(segments.map((s) => [s.index, s.text])).toEqual([[0, '一文目。'], [1, '二文目。三文目。']])
  })
})
