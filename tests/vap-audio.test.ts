import { describe, expect, it, vi } from 'vitest'
import { StreamResampler } from '@shared/pcm'
import { DfnDenoiser } from '../src/renderer/src/voice/DfnDenoiser'
import type { DfnRequest, DfnResponse } from '../src/renderer/src/voice/dfn-worker'
import { VapAudio } from '../src/renderer/src/voice/VapAudio'

const samples = (length: number, value: number): Float32Array => new Float32Array(length).fill(value)

/** Within one of MaAI's 80 ms frames, the played audio is what played while the microphone heard its frame. */
const FRAME_MS = 80
const FRAME_SAMPLES = 1_280

/** Things that happen at given times, run in time order, in milliseconds from the microphone's first audio. */
class Timeline {
  now = 0
  private events: Array<{ at: number; order: number; run: () => void }> = []
  private order = 0

  at(at: number, run: () => void): void {
    const event = { at, order: this.order++, run }
    let index = this.events.length
    while (index > 0 && this.events[index - 1].at > at) index--
    this.events.splice(index, 0, event)
  }

  run(): void {
    for (let event = this.events.shift(); event; event = this.events.shift()) {
      this.now = event.at
      event.run()
    }
  }
}

/** A DeepFilterNet worker that answers each chunk with its audio unchanged, 0.6 ms after the one before. */
class PassingWorker {
  onmessage: ((event: MessageEvent<DfnResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  private answeredAt = 0

  constructor(private readonly timeline: Timeline) {}

  postMessage(message: DfnRequest): void {
    if (message.type === 'init') this.answer({ type: 'ready' })
    if (message.type !== 'infer') return
    this.answeredAt = Math.max(this.timeline.now, this.answeredAt) + 0.6
    this.timeline.at(this.answeredAt, () => this.answer({ type: 'enhanced', id: message.id, chunk: message.chunk }))
  }

  terminate(): void {}

  private answer(message: DfnResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<DfnResponse>)
  }
}

/** How the microphone hands its audio over. */
type Microphone =
  /** getUserMedia's worklet posts 1024 samples at 48 kHz, 5 ms after the last of them. */
  | { source: 'getUserMedia' }
  /** The native helper hands over deliveryMs at 48 kHz, 15 ms after the last of it, through DeepFilterNet or not. */
  | { source: 'helper'; deliveryMs: number; noiseSuppression: boolean }

interface Scene {
  microphone: Microphone
  /** How long the reply has been playing when the microphone hears its first audio. */
  leadMs: number
  /** How much later than the rest a delivery arrives, by its index from 0. */
  lateMs?: Record<number, number>
  /** A stretch of microphone audio that never arrives, as while main starts the helper again. */
  lost?: { fromMs: number; toMs: number }
  /**
   * Times the renderer is busy. What arrives meanwhile is handled when it is free again, source by source, and the
   * microphone's first, as Electron 43.7.7 was measured to do now and then after a stall of 150 to 240 ms.
   */
  stalls?: Array<{ fromMs: number; toMs: number }>
}

interface Played {
  /** The microphone samples heard in the window and sent to MaAI. */
  paired: number
  /** How many of the played samples paired with them were silent. */
  silent: number
  /** The largest distance between when a microphone sample was heard and when the played sample paired with it played. */
  worstMs: number
  /** Where the played audio paired with them skips or repeats instead of going on one sample at a time. */
  breaks: number
  /** The most microphone audio still waiting for MaAI when the next delivery arrived. */
  mostWaiting: number
}

/**
 * Plays a ramp of the time each sample plays at through the output tap's 128-sample render quanta at 48 kHz, from
 * leadMs before the microphone's first audio, as a reply that plays while the microphone starts, and hands the
 * microphone's audio, every sample carrying the time it was heard and each delivery up to 3 ms early or late, to
 * VapAudio as MicInput does. Both ramps are shifted so that no sample is 0. Returns what MaAI got for the microphone
 * audio heard between fromMs and toMs.
 */
async function play(scene: Scene, fromMs: number, toMs: number): Promise<Played> {
  const timeline = new Timeline()
  const result: Played = { paired: 0, silent: 0, worstMs: 0, breaks: 0, mostWaiting: 0 }
  let delivered = 0
  let sent = 0
  let previous: number | null = null
  const audio = new VapAudio((user, assistant) => {
    sent += user.length
    for (let i = 0; i < user.length; i++) {
      const heardMs = (user[i] - 10) * 1000
      if (heardMs < fromMs || heardMs >= toMs) continue
      result.paired++
      if (assistant[i] === 0) result.silent++
      else result.worstMs = Math.max(result.worstMs, Math.abs(assistant[i] - user[i]) * 1000)
      if (previous !== null && Math.abs(assistant[i] - previous - 1 / 16_000) > 1e-5) result.breaks++
      previous = assistant[i]
    }
  })
  const resampler = new StreamResampler(48_000, 16_000)
  const deliver = (chunk: Float32Array, deliveryEnds: boolean): void => {
    const frame = resampler.process(chunk)
    if (frame.length === 0) return
    delivered += frame.length
    audio.pushUser(frame, deliveryEnds)
  }
  let pass = (frame: Float32Array): void => deliver(frame, true)
  const microphone = scene.microphone
  if (microphone.source === 'helper' && microphone.noiseSuppression) {
    const dfn = new DfnDenoiser({ workerFactory: () => new PassingWorker(timeline) as unknown as Worker })
    await dfn.init()
    dfn.onOutput = deliver
    pass = (frame) => dfn.push(frame)
  }
  const handOver = (frame: Float32Array): void => {
    result.mostWaiting = Math.max(result.mostWaiting, delivered - sent)
    pass(frame)
  }

  const handled = (arrives: number, after: number): number => {
    const stall = scene.stalls?.find(({ fromMs, toMs }) => arrives >= fromMs && arrives < toMs)
    return stall ? stall.toMs + after : arrives
  }
  const endMs = toMs + 1_000
  const tapMs = 128 / 48
  for (let tap = 0; -scene.leadMs + (tap + 1) * tapMs < endMs; tap++) {
    const quantum = Float32Array.from({ length: 128 }, (_, k) => 10 + (-scene.leadMs + ((tap * 128 + k) / 48)) / 1000)
    timeline.at(handled(-scene.leadMs + (tap + 1) * tapMs, 0.001), () => audio.pushAssistant(quantum, 48_000))
  }
  const deliveryMs = microphone.source === 'helper' ? microphone.deliveryMs : 1024 / 48
  const latencyMs = microphone.source === 'helper' ? 15 : 5
  const length = Math.round(deliveryMs * 48)
  const jitterMs = [0, 3, -3, 2, -2, 1]
  for (let d = 0; (d + 1) * deliveryMs < endMs; d++) {
    const heardFrom = d * deliveryMs
    if (scene.lost && heardFrom >= scene.lost.fromMs && heardFrom < scene.lost.toMs) continue
    const frame = Float32Array.from({ length }, (_, k) => 10 + (d * length + k) / 48_000)
    const arrives = (d + 1) * deliveryMs + latencyMs + jitterMs[d % jitterMs.length] + (scene.lateMs?.[d] ?? 0)
    timeline.at(handled(arrives, 0), () => handOver(frame))
  }
  timeline.run()
  return result
}

const SECOND = 16_000

describe('VapAudio', () => {
  it('packs uneven deliveries into 80 ms frames in order and fills the part with no played audio with silence', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(700, 0.5), 16_000)
    audio.pushUser(samples(600, 1), true)
    audio.pushUser(samples(1960, 2), true)

    const [firstUser, firstAssistant] = emit.mock.calls[0]
    expect([...firstUser]).toEqual([...samples(600, 1), ...samples(680, 2)])
    expect([...firstAssistant]).toEqual([...samples(700, 0.5), ...samples(580, 0)])
    expect([...emit.mock.calls[1][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[1][1]]).toEqual([...samples(1280, 0)])
  })

  describe('pairs the first two seconds with what played at the time while a reply plays from before the microphone started', () => {
    const helperSizes = [100, 150, 200, 250, 300, 350, 400]
    const scenes: Array<[string, Microphone]> = [
      ...helperSizes.map((deliveryMs): [string, Microphone] => [
        `the native helper's ${deliveryMs} ms through DeepFilterNet`,
        { source: 'helper', deliveryMs, noiseSuppression: true }
      ]),
      ['the native helper\'s 100 ms without DeepFilterNet', { source: 'helper', deliveryMs: 100, noiseSuppression: false }],
      ['the native helper\'s 10 ms through DeepFilterNet, as on Windows', { source: 'helper', deliveryMs: 10, noiseSuppression: true }],
      ['getUserMedia\'s 21 ms', { source: 'getUserMedia' }]
    ]
    for (const leadMs of [200, 1_000]) {
      it.each(scenes)(`from ${leadMs} ms before, with %s`, async (_name, microphone) => {
        const { paired, silent, worstMs } = await play({ microphone, leadMs }, 0, 2_000)
        expect(paired).toBe(2 * SECOND)
        expect(silent).toBe(0)
        expect(worstMs).toBeLessThan(FRAME_MS)
      })
    }
  })

  it.each<[string, Microphone]>([
    ['the native helper\'s 100 ms through DeepFilterNet', { source: 'helper', deliveryMs: 100, noiseSuppression: true }],
    ['the native helper\'s 300 ms through DeepFilterNet', { source: 'helper', deliveryMs: 300, noiseSuppression: true }],
    ['getUserMedia\'s 21 ms', { source: 'getUserMedia' }]
  ])('hands MaAI each frame by the end of the delivery that completes it, from the first delivery on, with %s', async (_name, microphone) => {
    const { paired, mostWaiting } = await play({ microphone, leadMs: 1_000 }, 0, 2_000)
    expect(paired).toBe(2 * SECOND)
    expect(mostWaiting).toBeLessThan(FRAME_SAMPLES)
  })

  it.each([100, 125])('lines the played audio up again for good within a stretch when the first of %i ms deliveries arrived late', async (deliveryMs) => {
    const microphone: Microphone = { source: 'helper', deliveryMs, noiseSuppression: true }
    const { paired, silent, worstMs, breaks } = await play({ microphone, leadMs: 200, lateMs: { 0: 100 } }, 1_000, 3_000)
    expect(paired).toBe(2 * SECOND)
    expect(silent).toBe(0)
    expect(breaks).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it('pairs the microphone with what played at the time as soon as it delivers again after a second of lost audio', async () => {
    const microphone: Microphone = { source: 'helper', deliveryMs: 100, noiseSuppression: true }
    const { paired, silent, worstMs } = await play({ microphone, leadMs: 1_000, lost: { fromMs: 2_000, toMs: 3_000 } }, 3_000, 5_000)
    expect(paired).toBe(2 * SECOND)
    expect(silent).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it.each<[string, number, Microphone]>([
    ['the native helper\'s 100 ms without DeepFilterNet', 2_000, { source: 'helper', deliveryMs: 100, noiseSuppression: false }],
    ['the native helper\'s 100 ms without DeepFilterNet', 2_250, { source: 'helper', deliveryMs: 100, noiseSuppression: false }],
    ['getUserMedia\'s 21 ms', 2_000, { source: 'getUserMedia' }],
    ['getUserMedia\'s 21 ms', 2_250, { source: 'getUserMedia' }]
  ])('moves no played audio after the renderer handled the microphone before the tap, with %s and a stall at %i ms', async (_name, stallMs, microphone) => {
    // The renderer is busy for 50 ms. The frames sent right then may lack played audio, and nothing after them may.
    const stalls = [{ fromMs: stallMs, toMs: stallMs + 50 }]
    const { paired, silent, breaks } = await play({ microphone, leadMs: 1_000, stalls }, stallMs + 125, stallMs + 3_000)
    expect(paired).toBe(2.875 * SECOND)
    expect({ silent, breaks }).toEqual({ silent: 0, breaks: 0 })
  })

  it.each([
    ['through DeepFilterNet', true],
    ['without DeepFilterNet', false]
  ])('keeps the played audio whole when one of the native helper\'s 400 ms deliveries comes 30 ms late every 3.2 s, %s', async (_name, noiseSuppression) => {
    const microphone: Microphone = { source: 'helper', deliveryMs: 400, noiseSuppression }
    const lateMs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [5 + 8 * i, 30]))
    const { paired, silent, breaks, worstMs } = await play({ microphone, leadMs: 1_000, lateMs }, 1_000, 16_000)
    expect(paired).toBe(15 * SECOND)
    expect({ silent, breaks }).toEqual({ silent: 0, breaks: 0 })
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it.each<[string, Microphone]>([
    ['the native helper\'s 100 ms through DeepFilterNet', { source: 'helper', deliveryMs: 100, noiseSuppression: true }],
    ['the native helper\'s 300 ms through DeepFilterNet', { source: 'helper', deliveryMs: 300, noiseSuppression: true }],
    ['the native helper\'s 100 ms without DeepFilterNet', { source: 'helper', deliveryMs: 100, noiseSuppression: false }],
    ['getUserMedia\'s 21 ms', { source: 'getUserMedia' }]
  ])('passes the played audio on without gaps or padding once the microphone runs, with %s', async (_name, microphone) => {
    const { paired, breaks } = await play({ microphone, leadMs: 1_000 }, 1_000, 9_000)
    expect(paired).toBe(8 * SECOND)
    expect(breaks).toBe(0)
  })

  it('does not mix in unsent audio or a resampling remainder from before the microphone stopped', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1, 1), 48_000)
    audio.pushUser(samples(500, 1), true)
    audio.reset()
    audio.pushAssistant(samples(3841, 0.5), 48_000)
    audio.pushUser(samples(1280, 2), true)
    expect([...emit.mock.calls[0][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 0.5)])
  })
})
