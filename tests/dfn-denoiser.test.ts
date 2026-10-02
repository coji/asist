import { describe, expect, it, vi } from 'vitest'
import { DfnDenoiser, MAX_IN_FLIGHT } from '../src/renderer/src/voice/DfnDenoiser'
import type { DfnRequest, DfnResponse } from '../src/renderer/src/voice/dfn-worker'

class FakeWorker {
  onmessage: ((event: MessageEvent<DfnResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: DfnRequest[] = []
  terminated = false

  postMessage(message: DfnRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  message(message: DfnResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<DfnResponse>)
  }
}

const asWorker = (worker: FakeWorker): Worker => worker as unknown as Worker

const infers = (worker: FakeWorker): Extract<DfnRequest, { type: 'infer' }>[] =>
  worker.posted.filter((m): m is Extract<DfnRequest, { type: 'infer' }> => m.type === 'infer')

async function readyDenoiser(): Promise<{
  dfn: DfnDenoiser
  worker: FakeWorker
  outputs: Float32Array[]
}> {
  const worker = new FakeWorker()
  const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker) })
  const outputs: Float32Array[] = []
  dfn.onOutput = (chunk) => outputs.push(chunk)
  const init = dfn.init()
  worker.message({ type: 'ready' })
  await init
  return { dfn, worker, outputs }
}

describe('DfnDenoiser', () => {
  it('groups frames into 512-sample chunks for the worker and outputs the answers in order', async () => {
    const { dfn, worker, outputs } = await readyDenoiser()
    expect(dfn.ready).toBe(true)

    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(0)
    // 640 samples make one chunk of 512 with 128 samples left over.
    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(1)
    expect(infers(worker)[0].chunk.length).toBe(512)
    // Nothing is output until the worker answers.
    expect(outputs).toHaveLength(0)

    const enhanced = new Float32Array(512).fill(0.5)
    worker.message({ type: 'enhanced', id: infers(worker)[0].id, chunk: enhanced })
    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBeCloseTo(0.5)
  })

  it('sends all of a delivery that fills more chunks than may wait unanswered to the worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs } = await readyDenoiser()
      // The native helper's longest delivery, 400 ms at 48 kHz.
      dfn.push(new Float32Array(19_200).fill(0.1))
      expect(dfn.ready).toBe(true)
      expect(infers(worker)).toHaveLength(37)
      for (const { id, chunk } of infers(worker)) worker.message({ type: 'enhanced', id, chunk: chunk.map(() => 0.05) })
      expect(outputs.map((chunk) => chunk[0])).toEqual(Array(37).fill(Math.fround(0.05)))
    } finally {
      warn.mockRestore()
    }
  })

  it('says which chunk closes what each frame completed', async () => {
    const { dfn, worker } = await readyDenoiser()
    const ends: boolean[] = []
    dfn.onOutput = (_chunk, endsFrame) => ends.push(endsFrame)
    // 4,800 samples make nine chunks and leave 192 for the next frame; the next 4,800 and 3,000 make nine and six.
    dfn.push(new Float32Array(4_800))
    dfn.push(new Float32Array(4_800))
    dfn.push(new Float32Array(3_000))
    for (const { id, chunk } of infers(worker)) worker.message({ type: 'enhanced', id, chunk })
    expect(ends).toEqual([
      ...Array(8).fill(false), true, ...Array(8).fill(false), true, ...Array(5).fill(false), true
    ])
  })

  it('passes audio through before the worker is ready, so loading never stops the audio', () => {
    const worker = new FakeWorker()
    const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker) })
    const outputs: Float32Array[] = []
    dfn.onOutput = (chunk) => outputs.push(chunk)
    // The worker has not reported ready, so init is still pending.
    void dfn.init()

    const frame = new Float32Array(512).fill(0.25)
    dfn.push(frame)
    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBeCloseTo(0.25)
    expect(infers(worker)).toHaveLength(0)
  })

  it('passes audio through in an environment that cannot create a Worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dfn = new DfnDenoiser({
        workerFactory: () => {
          throw new Error('no Worker in this environment')
        }
      })
      const outputs: Float32Array[] = []
      dfn.onOutput = (chunk) => outputs.push(chunk)
      await dfn.init()
      expect(dfn.ready).toBe(false)
      dfn.push(new Float32Array(1024))
      expect(outputs).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to passthrough when the worker reports an error, without stopping the audio', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs } = await readyDenoiser()
      dfn.push(new Float32Array(512).fill(0.05))
      worker.message({ type: 'error', message: 'inference failed' })
      expect(dfn.ready).toBe(false)
      expect(worker.terminated).toBe(true)
      dfn.push(new Float32Array(512).fill(0.1))
      // The chunk the worker failed on goes on as it was sent, ahead of the next.
      expect(outputs.map((chunk) => chunk[0])).toEqual([0.05, 0.1].map(Math.fround))
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to passthrough when the answers stall, and ignores the answers that arrive late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs } = await readyDenoiser()
      // Push chunks up to the limit without answering any of them.
      for (let i = 0; i < MAX_IN_FLIGHT; i++) dfn.push(new Float32Array(512))
      expect(infers(worker)).toHaveLength(MAX_IN_FLIGHT)
      expect(outputs).toHaveLength(0)
      // The next chunk crosses the limit and falls back to passthrough, after the chunks in flight.
      dfn.push(new Float32Array(512).fill(0.3))
      expect(dfn.ready).toBe(false)
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 1)
      expect(outputs.at(-1)![0]).toBeCloseTo(0.3)
      // A late answer for a stalled chunk must not join the output, because that would break the order.
      worker.message({ type: 'enhanced', id: infers(worker)[0].id, chunk: new Float32Array(512) })
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 1)
    } finally {
      warn.mockRestore()
    }
  })

  it('drops the buffered samples and resets the state of the worker', async () => {
    const { dfn, worker } = await readyDenoiser()
    dfn.push(new Float32Array(320))
    dfn.reset()
    expect(worker.posted.some((m) => m.type === 'reset')).toBe(true)
    // After a reset the chunking starts over, so the 320 leftover samples are not carried across.
    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(0)
  })

  it('terminates the worker on dispose and creates a new one on the next init', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const factory = vi.fn(() => asWorker(workers[factory.mock.calls.length - 1]))
    const dfn = new DfnDenoiser({ workerFactory: factory })
    const first = dfn.init()
    workers[0].message({ type: 'ready' })
    await first
    dfn.dispose()
    expect(workers[0].terminated).toBe(true)
    expect(dfn.ready).toBe(false)
    const second = dfn.init()
    workers[1].message({ type: 'ready' })
    await second
    expect(dfn.ready).toBe(true)
  })
})

/** A denoiser whose fake worker is ready, on a clock the test moves. */
async function denoiserOnClock(): Promise<{
  dfn: DfnDenoiser
  worker: FakeWorker
  outputs: number[]
  clock: { now: number }
}> {
  const clock = { now: 1000 }
  const worker = new FakeWorker()
  const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker), now: () => clock.now })
  const outputs: number[] = []
  dfn.onOutput = (chunk) => outputs.push(chunk[0])
  const init = dfn.init()
  worker.message({ type: 'ready' })
  await init
  return { dfn, worker, outputs, clock }
}

/** Answers the oldest chunk the fake worker has not answered yet, as a worker does, with its audio unchanged. */
function answerNext(worker: FakeWorker, answered: { count: number }): void {
  const next = infers(worker)[answered.count]
  if (!next) return
  answered.count++
  worker.message({ type: 'enhanced', id: next.id, chunk: next.chunk })
}

describe('DfnDenoiser recovery from a stall', () => {
  it('goes back to a worker that has answered two seconds after it fell behind, resetting it first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs, clock } = await denoiserOnClock()
      dfn.push(new Float32Array(512).fill(0.1))
      answerNext(worker, { count: 0 })
      for (let i = 0; i <= MAX_IN_FLIGHT; i++) dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(false)
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 2)
      // Until two seconds have passed the denoiser stays in passthrough.
      clock.now += 1000
      dfn.push(new Float32Array(512).fill(0.2))
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 3)
      expect(infers(worker)).toHaveLength(MAX_IN_FLIGHT + 1)
      // The first chunk after two seconds resets the worker and goes through it again.
      clock.now += 1500
      const resets = worker.posted.filter((m) => m.type === 'reset').length
      dfn.push(new Float32Array(512).fill(0.4))
      expect(dfn.ready).toBe(true)
      expect(worker.posted.filter((m) => m.type === 'reset').length).toBe(resets + 1)
      expect(infers(worker)).toHaveLength(MAX_IN_FLIGHT + 2)
      // Nothing is output until the answer arrives.
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 3)
      worker.message({ type: 'enhanced', id: infers(worker).at(-1)!.id, chunk: new Float32Array(512).fill(0.9) })
      expect(outputs).toHaveLength(MAX_IN_FLIGHT + 4)
      expect(outputs.at(-1)).toBeCloseTo(0.9)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('goes back to the worker on reset even while it is in passthrough', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker } = await readyDenoiser()
      for (let i = 0; i <= MAX_IN_FLIGHT; i++) dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(false)
      dfn.reset()
      expect(dfn.ready).toBe(true)
      dfn.push(new Float32Array(512))
      expect(infers(worker)).toHaveLength(MAX_IN_FLIGHT + 1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('DfnDenoiser with a worker that falls behind', () => {
  it('loses none of the audio, however often it goes back to a worker that keeps falling behind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs, clock } = await denoiserOnClock()
      const answered = { count: 0 }
      // Ten seconds of 512-sample chunks at 48 kHz, each marked with its number, against a worker that answers
      // two chunks in the time three arrive.
      const chunks = 940
      for (let i = 1; i <= chunks; i++) {
        dfn.push(new Float32Array(512).fill(i))
        if (i % 3 !== 0) answerNext(worker, answered)
        clock.now += 512 / 48
      }
      // The worker catches up at the end.
      while (answered.count < infers(worker).length) answerNext(worker, answered)

      expect(outputs).toEqual(Array.from({ length: chunks }, (_, i) => i + 1))
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('leaves a worker that has answered nothing since it was put to use alone until the microphone starts again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs, clock } = await denoiserOnClock()
      let pushed = 0
      const push = (): void => {
        dfn.push(new Float32Array(512).fill(++pushed))
        clock.now += 512 / 48
      }
      while (dfn.ready) push()
      const sent = infers(worker).length
      // Ten more seconds, and not one answer.
      for (let i = 0; i < 940; i++) push()

      expect(infers(worker)).toHaveLength(sent)
      expect(outputs).toEqual(Array.from({ length: pushed }, (_, i) => i + 1))
      // The microphone starts again, and the worker is used again.
      dfn.reset()
      push()
      expect(infers(worker)).toHaveLength(sent + 1)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })
})

describe('DfnDenoiser stale answers after recovery', () => {
  it('keeps the worker when the answer for a chunk sent before the fallback arrives after recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs, clock } = await denoiserOnClock()
      dfn.push(new Float32Array(512))
      answerNext(worker, { count: 0 })
      for (let i = 0; i <= MAX_IN_FLIGHT; i++) dfn.push(new Float32Array(512))
      clock.now += 2500
      // The denoiser recovers here and sends this chunk.
      dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(true)
      // The answer for a chunk sent before the fallback arrives late.
      worker.message({ type: 'enhanced', id: infers(worker)[1].id, chunk: new Float32Array(512) })
      expect(dfn.ready).toBe(true)
      expect(worker.terminated).toBe(false)
      worker.message({ type: 'enhanced', id: infers(worker).at(-1)!.id, chunk: new Float32Array(512).fill(0.7) })
      expect(outputs.at(-1)).toBeCloseTo(0.7)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })
})
