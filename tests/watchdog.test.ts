import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MODEL } from '@shared/memory-embedding'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  settings: {
    aizuchi: true, vapEnabled: true, conversationLocale: 'ja-JP', voiceEngine: 'cascade', uiLocale: 'en-US',
    asrModel: 'qwen3-asr-1.7b', ttsEngine: 'qwen3tts', qwenTtsSize: '0.6b'
  },
  startEmbedding: vi.fn(async () => false),
  ttsAnswered: vi.fn(),
  ttsUp: true,
  ttsStarting: false,
  asrAvailable: async () => true,
  asrRevive: async (): Promise<boolean> => true,
  ensureEngine: vi.fn(async () => {})
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => '/unused', on: vi.fn()
} }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/asr', () => ({ available: () => mocks.asrAvailable(), revive: () => mocks.asrRevive() }))
vi.mock('../src/main/services/tts', () => ({ available: async () => mocks.ttsUp, engineStarting: () => mocks.ttsStarting, ensureEngine: () => mocks.ensureEngine() }))
vi.mock('../src/main/services/aizuchi', () => ({ ttsAnswered: mocks.ttsAnswered }))
vi.mock('../src/main/services/memory', () => ({ startEmbeddingIfEnabled: mocks.startEmbedding }))

function fakeChild(script: string) {
  const input: Array<{ id: string }> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, killed: false, kill: vi.fn(), input, script
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => input.push(JSON.parse(String(data))))
  return child
}
type Child = ReturnType<typeof fakeChild>
let children: Child[] = []
const classifierChildren = (): Child[] => children.filter((child) => child.script.endsWith('aizuchi_worker.py'))
const vapChildren = (): Child[] => children.filter((child) => child.script.endsWith('vap_worker.py'))
let watchdog: typeof import('../src/main/services/watchdog')
let classifier: typeof import('../src/main/services/aizuchi-classifier')
let embedding: typeof import('../src/main/services/embedding')
let vap: typeof import('../src/main/services/vap')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ASIST_EMBEDDING_PYTHON', '/unused/python')
  vi.stubEnv('ASIST_VAP_PYTHON', '/unused/python')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  mocks.settings.aizuchi = true
  mocks.settings.vapEnabled = true
  mocks.startEmbedding.mockClear()
  mocks.ttsAnswered.mockClear()
  mocks.ttsUp = true
  mocks.ttsStarting = false
  mocks.asrAvailable = async () => true
  mocks.asrRevive = async () => true
  mocks.ensureEngine.mockReset().mockResolvedValue(undefined)
  Object.assign(mocks.settings, { asrModel: 'qwen3-asr-1.7b', ttsEngine: 'qwen3tts', qwenTtsSize: '0.6b' })
  children = []
  mocks.spawn.mockReset().mockImplementation((_python: string, args: string[]) => {
    const child = fakeChild(args[0])
    children.push(child)
    return child
  })
  watchdog = await import('../src/main/services/watchdog')
  classifier = await import('../src/main/services/aizuchi-classifier')
  embedding = await import('../src/main/services/embedding')
  vap = await import('../src/main/services/vap')
})
afterEach(() => {
  classifier.stop()
  embedding.stop()
  vap.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const child of children) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
})

const VAP_READY = 'ASIST_JSON:{"type":"ready","device":"cpu","frameHz":12.5}\n'

async function classifierReady(child: Child): Promise<void> {
  child.stdout.write('ASIST_JSON:{"type":"ready"}\n')
  await vi.advanceTimersByTimeAsync(100)
  expect(classifier.running()).toBe(true)
}

describe('the watchdog', () => {
  it('tells the aizuchi bank that the TTS answers from its first check on, not only after it saw the TTS down', async () => {
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.ttsAnswered).toHaveBeenCalledWith(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.ttsAnswered).toHaveBeenCalledTimes(2)
  })

  it('tells the aizuchi bank that the TTS came back after it saw it down', async () => {
    mocks.ttsUp = false
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.ttsAnswered).not.toHaveBeenCalled()

    mocks.ttsUp = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.ttsAnswered).toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.ttsAnswered).toHaveBeenLastCalledWith(false)
  })

  it('reports a TTS engine that has become ready when asked to check, without waiting for the next periodic check', async () => {
    mocks.ttsUp = false
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: false, ttsStarting: false })
    mocks.ttsUp = true
    await watchdog.checkHealth()
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: true, ttsStarting: false })
  })

  it('checks once the start of an engine has settled, whether it succeeded or failed', async () => {
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    mocks.ttsUp = false
    watchdog.checkAfter(Promise.reject(new Error('the worker exited')))
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: false, ttsStarting: false })
  })

  it('tells the screens the outcome of a start that failed, though the engine did not answer before it either', async () => {
    mocks.ttsUp = false
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenCalledTimes(1)
    // The settings screen read the engine as loading on its own, after it chose the engine again.
    watchdog.checkAfter(Promise.reject(new Error('the worker exited')))
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: false, ttsStarting: false })
  })

  it('reports an engine that is loading apart from one that is missing, and again once it answers', async () => {
    mocks.ttsUp = false
    mocks.ttsStarting = true
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: false, ttsStarting: true })
    mocks.ttsUp = true
    mocks.ttsStarting = false
    await watchdog.checkHealth()
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: true, ttsStarting: false })
  })

  it('reports speech recognition as down when starting it again fails, as in a build without llama-server, and logs why', async () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const missing = new Error('llama-server is missing from /Applications/ASIST.app/Contents/Resources/llama.cpp/llama-server')
    mocks.asrAvailable = async () => false
    mocks.asrRevive = async () => { throw missing }
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenLastCalledWith({ asr: false, tts: true, ttsStarting: false })
    expect(failed).toHaveBeenCalledWith(expect.any(String), missing)
  })

  it('checks again once a check that was under way when asked has ended, since that one may have read the old state', async () => {
    let release!: () => void
    mocks.asrAvailable = () => new Promise<boolean>((resolve) => { release = () => resolve(true) })
    mocks.ttsUp = false
    const onChange = vi.fn()
    watchdog.start(onChange)
    await vi.advanceTimersByTimeAsync(10)
    mocks.asrAvailable = async () => true
    mocks.ttsUp = true
    await watchdog.checkHealth()
    expect(onChange).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(onChange).toHaveBeenLastCalledWith({ asr: true, tts: true, ttsStarting: false })
  })

  it('starts the aizuchi classifier again after a timeout stopped it', async () => {
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    await classifierReady(classifierChildren()[0])
    const timedOut = classifier.classify({ prev: '', text: '明日の天気' }).catch(() => 'failed')
    await vi.advanceTimersByTimeAsync(5_100)
    expect(await timedOut).toBe('failed')
    expect(classifier.running()).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    const revived = classifierChildren()
    expect(revived).toHaveLength(2)
    await classifierReady(revived[1])
    const request = classifier.classify({ prev: '', text: '明日の天気' })
    await vi.advanceTimersByTimeAsync(10)
    revived[1].stdout.write(
      `ASIST_JSON:${JSON.stringify({ type: 'result', id: revived[1].input[0].id, cls: 'correct', prob: 0.9, complete: 0.9 })}\n`
    )
    await expect(request).resolves.toMatchObject({ cls: 'correct' })
  })

  it('leaves the aizuchi classifier stopped while aizuchi are not wanted', async () => {
    mocks.settings.aizuchi = false
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(classifierChildren()).toEqual([])
  })

  it('has memory start the embedding worker again once it has exited, and leaves a running one alone', async () => {
    const starting = embedding.ensureStarted()
    const [child] = children
    child.stdout.write(`ASIST_JSON:{"type":"ready","dim":${EMBEDDING_MODEL.dim}}\n`)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.startEmbedding).not.toHaveBeenCalled()

    child.exitCode = 1
    child.emit('exit', 1)
    expect(embedding.running()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.startEmbedding).toHaveBeenCalledOnce()
  })

  it('starts the VAP worker again after it crashed, and hands its state to the handler the conversation gave', async () => {
    const states: number[] = []
    const starting = vap.ensureStarted((state) => states.push(state.pNowUser))
    await vi.advanceTimersByTimeAsync(10)
    vapChildren()[0].stdout.write(VAP_READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    watchdog.start(() => {})
    vapChildren()[0].exitCode = 1
    vapChildren()[0].emit('exit', 1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(vapChildren()).toHaveLength(2)
    vapChildren()[1].stdout.write(VAP_READY)
    await vi.advanceTimersByTimeAsync(100)
    vapChildren()[1].stdout.write('ASIST_JSON:{"type":"state","pNowUser":0.8}\n')
    await vi.advanceTimersByTimeAsync(10)
    expect(states).toEqual([0.8])
  })

  it('leaves the VAP worker alone until the conversation starts it, and once the setting stopped it', async () => {
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vapChildren()).toEqual([])

    const starting = vap.ensureStarted(() => {})
    vapChildren()[0].stdout.write(VAP_READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    mocks.settings.vapEnabled = false
    vap.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vapChildren()).toHaveLength(1)
  })

  it('tries a crashed VAP worker once, not on every tick, when it no longer loads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const starting = vap.ensureStarted(() => {})
    vapChildren()[0].stdout.write(VAP_READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    watchdog.start(() => {})
    vapChildren()[0].exitCode = 1
    vapChildren()[0].emit('exit', 1)

    await vi.advanceTimersByTimeAsync(30_000)
    vapChildren()[1].stdout.write('ASIST_JSON:{"type":"fatal","error":"torch is missing"}\n')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(vapChildren()).toHaveLength(2)
  })

  it('stops starting again a VAP worker that keeps crashing after it has loaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const starting = vap.ensureStarted(() => {})
    vapChildren()[0].stdout.write(VAP_READY)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    watchdog.start(() => {})
    for (let crash = 0; crash < 6; crash++) {
      const current = vapChildren().at(-1)!
      current.exitCode = 1
      current.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(30_000)
      if (vapChildren().at(-1) === current) break
      vapChildren().at(-1)!.stdout.write(VAP_READY)
      await vi.advanceTimersByTimeAsync(100)
    }
    const spawned = vapChildren().length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vapChildren()).toHaveLength(spawned)
    expect(spawned).toBeLessThan(7)
  })
})

describe('the watchdog\'s starts of a speech engine that keeps failing to load', () => {
  /** How each engine is made to fail, to answer, and to be chosen anew, with the times the watchdog asked for a start of it. */
  const engines = {
    'speech recognition': {
      fail: (starts: number[]) => {
        mocks.asrAvailable = async () => false
        mocks.asrRevive = async () => { starts.push(Date.now()); return false }
      },
      answer: (up: boolean) => { mocks.asrAvailable = async () => up },
      chooseAnother: () => { mocks.settings.asrModel = 'qwen3-asr-0.6b' }
    },
    'speech synthesis': {
      fail: (starts: number[]) => {
        mocks.ttsUp = false
        mocks.ensureEngine.mockImplementation(async () => { starts.push(Date.now()) })
      },
      answer: (up: boolean) => { mocks.ttsUp = up },
      chooseAnother: () => { mocks.settings.qwenTtsSize = '1.7b' }
    }
  }
  beforeEach(() => {
    // The other workers the watchdog keeps would only add starts of their own.
    mocks.settings.aizuchi = false
    mocks.settings.vapEnabled = false
  })

  it.each(Object.keys(engines) as Array<keyof typeof engines>)('waits longer and longer between its starts of %s, up to a limit, instead of loading it at every check', async (name) => {
    const starts: number[] = []
    engines[name].fail(starts)
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    const gaps = starts.slice(1).map((at, index) => at - starts[index])
    expect(gaps[0]).toBe(30_000)
    for (let index = 1; index < gaps.length; index++) expect(gaps[index]).toBeGreaterThanOrEqual(gaps[index - 1])
    expect(gaps.at(-1)).toBeGreaterThan(gaps[0] * 4)
    expect(gaps.at(-1)).toBe(gaps.at(-2))
  })

  it.each(Object.keys(engines) as Array<keyof typeof engines>)('starts %s at the next check again once it has answered and gone down', async (name) => {
    const starts: number[] = []
    engines[name].fail(starts)
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    engines[name].answer(true)
    await vi.advanceTimersByTimeAsync(30_000)
    engines[name].answer(false)
    const before = starts.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(starts).toHaveLength(before + 1)
  })

  it.each(Object.keys(engines) as Array<keyof typeof engines>)('starts %s at the next check again once the settings choose another model', async (name) => {
    const starts: number[] = []
    engines[name].fail(starts)
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const before = starts.length
    engines[name].chooseAnother()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(starts).toHaveLength(before + 1)
  })
})
