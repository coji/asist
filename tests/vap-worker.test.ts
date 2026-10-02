import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import type { VapState } from '@shared/ipc'
import { parseVapWorkerLine, type VapWorkerMessage } from '@shared/vap-protocol'

/**
 * Runs resources/vap_worker.py itself, with stand-ins for MaAI and torch (tests/fixtures/vap-worker) whose values say
 * which frame they were made from. It needs a Python with numpy: ASIST_VAP_PYTHON when it is set, as the app takes
 * it, or else python3 or python on the PATH. On a developer's machine without one the tests are skipped, as running
 * the app from source needs no Python; CI gives its test jobs one, and there a missing one fails them.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const WORKER = path.join(ROOT, 'resources', 'vap_worker.py')
const STAND_INS = path.join(ROOT, 'tests', 'fixtures', 'vap-worker')
const FRAME_SAMPLES = 1_280

function pythonWithNumpy(): string | null {
  const configured = process.env.ASIST_VAP_PYTHON?.trim()
  const candidates = configured ? [configured] : ['python3', 'python']
  const hasNumpy = (candidate: string): boolean =>
    spawnSync(candidate, ['-c', 'import numpy'], { stdio: 'ignore', windowsHide: true }).status === 0
  return candidates.find(hasNumpy) ?? null
}

const python = pythonWithNumpy()
const pythonRequired = process.env.CI === 'true'

interface Worker {
  messages: VapWorkerMessage[]
  /** Whether the messages came to meet the condition before the worker ended. */
  until: (done: (messages: VapWorkerMessage[]) => boolean) => Promise<boolean>
  write: (user: Float32Array, assistant: Float32Array) => void
  exited: Promise<number | null>
}

let running: ChildProcessWithoutNullStreams | null = null
let modelsDir: string | null = null

afterEach(() => {
  running?.kill()
  running = null
  if (modelsDir) rmSync(modelsDir, { recursive: true, force: true })
  modelsDir = null
})

/** Starts the worker as vap.ts does, on empty model files, with the stand-ins first on the import path. */
function startWorker(env: Record<string, string>): Worker {
  if (python === null) throw new Error('no Python with numpy: set ASIST_VAP_PYTHON, or put python3 with numpy on the PATH')
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-vap-worker-'))
  modelsDir = dir
  const model = (name: string): string => {
    const file = path.join(dir, name)
    writeFileSync(file, '')
    return file
  }
  const args = [
    WORKER,
    '--vap-model', model('vap.pt'),
    '--vap-frame-rate', '12.5',
    '--vap-context', '20',
    '--bc-det-model', model('bc_det.pt'),
    '--mimi-onnx', model('mimi.onnx'),
    '--mimi-meta', model('mimi.json'),
    '--bc-model', model('bc.pt'),
    '--nod-model', model('nod.pt'),
    '--aux-frame-rate', '10',
    '--aux-context', '5',
    '--cpc', model('cpc.pt')
  ]
  const child = spawn(python, args, {
    env: { ...process.env, PYTHONPATH: STAND_INS, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', ...env },
    windowsHide: true
  })
  running = child
  const messages: VapWorkerMessage[] = []
  const waiters: Array<() => void> = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = parseVapWorkerLine(line)
    if (!message) return
    messages.push(message)
    for (const waiter of waiters) waiter()
  })
  child.stderr.resume()
  // close comes after the last line of the output has been read, where exit can come before it.
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  return {
    messages,
    exited,
    until: (done) =>
      new Promise<boolean>((resolve) => {
        const check = (): void => {
          if (done(messages)) resolve(true)
        }
        waiters.push(check)
        void exited.then(() => resolve(done(messages)))
        check()
      }),
    write: (user, assistant) => {
      const interleaved = new Float32Array(user.length * 2)
      for (let i = 0; i < user.length; i++) {
        interleaved[i * 2] = user[i]
        interleaved[i * 2 + 1] = assistant[i]
      }
      child.stdin.write(Buffer.from(interleaved.buffer))
    }
  }
}

const states = (messages: VapWorkerMessage[]): VapState[] =>
  messages.flatMap((message) => (message.type === 'state' ? [message.state] : []))

describe.runIf(python !== null || pythonRequired)('the MaAI worker, vap_worker.py', () => {
  it('dates each estimate of a burst by the frames that reached each model after the one its values were made from', { timeout: 30_000 }, async () => {
    // The first result waits until the whole burst has arrived, so that every value is dated against all of it.
    const worker = startWorker({ FAKE_MAAI_FIRST_FRAME_SEC: '0.5' })
    expect(await worker.until((messages) => messages.some((message) => message.type === 'ready'))).toBe(true)

    // Ten 80 ms frames at once. Each user frame holds its number in thousandths, and the assistant's channel holds
    // the time of each sample in seconds.
    const frames = 10
    const user = Float32Array.from({ length: frames * FRAME_SAMPLES }, (_, i) => (Math.floor(i / FRAME_SAMPLES) + 1) / 1000)
    const assistant = Float32Array.from({ length: frames * FRAME_SAMPLES }, (_, i) => (i + 1) / 16_000)
    worker.write(user, assistant)
    // The stand-in reports the warm-up's silence as values of 0 for the user.
    const fromBurst = (messages: VapWorkerMessage[]): VapState[] => states(messages).filter((state) => state.pNowUser > 0)
    expect(await worker.until((messages) => fromBurst(messages).length === frames)).toBe(true)

    const estimates = fromBurst(worker.messages)
    // The user's values of each estimate come from the frame whose number they hold, frames - n frames before the
    // newest; the aizuchi and nod values come from the 100 ms frame whose end time they hold, of the eight that 800 ms
    // of audio make.
    const frameOf = estimates.map((state) => Math.round(state.pNowUser * 1000))
    expect(frameOf).toEqual(Array.from({ length: frames }, (_, i) => i + 1))
    for (const state of estimates) {
      expect(state.turnLagMs).toBe((frames - Math.round(state.pNowUser * 1000)) * 80)
      if (state.bcReact > 0) expect(state.backchannelLagMs).toBe((8 - Math.round(state.bcReact * 10)) * 100)
      // Before the aizuchi and nod model has made values from any of the audio, its zeros are older than all of it.
      else expect(state.backchannelLagMs).toBeGreaterThanOrEqual(800)
    }
    running!.stdin.end()
    expect(await worker.exited).toBe(0)
  })

  it('stops with a fatal error when the warm-up result carries no frame number', { timeout: 30_000 }, async () => {
    const worker = startWorker({ FAKE_MAAI_UNNUMBERED: '1' })
    await worker.until((messages) => messages.length > 0)
    expect(worker.messages.map((message) => message.type)).toEqual(['fatal'])
    expect(await worker.exited).not.toBe(0)
  })
})
