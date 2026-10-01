import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '@shared/ipc'
import type { TtsVoice } from '../src/main/services/tts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dir: '',
  engine: 'aivisspeech',
  locale: 'ja-JP',
  speaker: null as number | null,
  resolveVoice: vi.fn(),
  synthesize: vi.fn(),
  engineUp: true,
  qwenModelInstalled: true
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir, getAppPath: () => mocks.dir, isPackaged: false } }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({
    ttsEngine: mocks.engine,
    aivisSpeaker: mocks.speaker,
    qwenTtsVoice: 'ono_anna',
    conversationLocale: mocks.locale
  })
}))
vi.mock('../src/main/services/local-tts', () => ({
  installationStatus: () => ({ modelInstalled: mocks.qwenModelInstalled })
}))
vi.mock('../src/main/services/tts', () => ({
  available: () => Promise.resolve(mocks.engineUp),
  resolveVoice: mocks.resolveVoice,
  synthesize: mocks.synthesize
}))

beforeEach(() => {
  vi.resetModules()
  mocks.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-aizuchi-'))
  mocks.speaker = null
  mocks.engine = 'aivisspeech'
  mocks.locale = 'ja-JP'
  mocks.engineUp = true
  mocks.qwenModelInstalled = true
  mocks.resolveVoice.mockReset().mockImplementation(async (settings: AppSettings) => ({
    engine: settings.ttsEngine, speaker: settings.aivisSpeaker ?? 1
  }))
  mocks.synthesize.mockReset().mockImplementation(async (_text, _signal, _prosody, voice: TtsVoice) => ({
    audio: Buffer.from(JSON.stringify(voice)).toString('base64'), phonemes: null
  }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(mocks.dir, { recursive: true, force: true })
})

const audioFor = (speaker: number): string => Buffer.from(JSON.stringify({ engine: 'aivisspeech', speaker })).toString('base64')

describe('aizuchi voice cache', () => {
  it('synthesizes clips without leading silence and deletes WAV files of other settings while building the bank', async () => {
    const stale = path.join(mocks.dir, 'aizuchi', 'deadbeef00000000.wav')
    fs.mkdirSync(path.dirname(stale), { recursive: true })
    fs.writeFileSync(stale, 'old')
    const aizuchi = await import('../src/main/services/aizuchi')
    await aizuchi.getBank()
    const prosody = mocks.synthesize.mock.calls[0][2] as { prePhonemeLength?: number; postPhonemeLength?: number }
    expect(prosody.prePhonemeLength).toBe(0)
    expect(prosody.postPhonemeLength).toBeLessThan(0.1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.readdirSync(path.dirname(stale))).toHaveLength(mocks.synthesize.mock.calls.length)
  })

  it('caches automatic and explicit selection under the speaker ID that is actually passed to synthesis', async () => {
    const aizuchi = await import('../src/main/services/aizuchi')
    const automatic = await aizuchi.getBank()
    expect(automatic.every((clip) => clip.audio === audioFor(1))).toBe(true)
    expect(mocks.speaker).toBeNull()

    mocks.speaker = 0
    aizuchi.rebuild()
    const explicit = await aizuchi.getBank()
    expect(explicit.every((clip) => clip.audio === audioFor(0))).toBe(true)

    // Going back to automatic selection reuses the files already synthesized for the resolved speaker 1.
    const synthesized = mocks.synthesize.mock.calls.length
    mocks.speaker = null
    aizuchi.rebuild()
    const reloaded = await aizuchi.getBank()
    expect(reloaded).toEqual(automatic)
    expect(mocks.synthesize).toHaveBeenCalledTimes(synthesized)
  })

  it('does not overwrite the bank of the new settings with an older build, and gives waiting callers the latest one', async () => {
    let release!: (voice: TtsVoice) => void
    mocks.resolveVoice.mockImplementationOnce(() => new Promise<TtsVoice>((resolve) => { release = resolve }))
    const aizuchi = await import('../src/main/services/aizuchi')
    const old = aizuchi.getBank()
    await vi.waitFor(() => expect(mocks.resolveVoice).toHaveBeenCalledTimes(1))

    mocks.speaker = 42
    aizuchi.rebuild()
    const current = await aizuchi.getBank()
    expect(current.every((clip) => clip.audio === audioFor(42))).toBe(true)
    release({ engine: 'aivisspeech', speaker: 1 })

    expect(await old).toEqual(current)
    expect(await aizuchi.getBank()).toEqual(current)
  })
})

describe('aizuchi bank rebuild', () => {
  it('tells the renderer once the bank of the old settings is gone, and the bank it then asks for is built from the new ones', async () => {
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).every((clip) => clip.audio === audioFor(1))).toBe(true)
    const reloaded: Array<Promise<Awaited<ReturnType<typeof aizuchi.getBank>>>> = []
    aizuchi.events.on('changed', () => reloaded.push(aizuchi.getBank()))

    mocks.speaker = 7
    aizuchi.rebuild()

    expect(reloaded).toHaveLength(1)
    expect((await reloaded[0]).every((clip) => clip.audio === audioFor(7))).toBe(true)
  })
})

describe('aizuchi bank built while the TTS does not answer', () => {
  it('is built again with audio once the TTS answers, as when the engine was spawned but did not serve HTTP yet', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.engineUp = false
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).every((clip) => clip.audio === null)).toBe(true)
    expect(warned).toHaveBeenCalled()
    const changed = vi.fn()
    aizuchi.events.on('changed', changed)

    mocks.engineUp = true
    aizuchi.ttsAnswered(false)

    expect(changed).toHaveBeenCalledOnce()
    expect((await aizuchi.getBank()).every((clip) => clip.audio === audioFor(1))).toBe(true)
  })

  it('keeps a bank that already has audio when the TTS answers', async () => {
    const aizuchi = await import('../src/main/services/aizuchi')
    await aizuchi.getBank()
    const changed = vi.fn()
    aizuchi.events.on('changed', changed)

    aizuchi.ttsAnswered(false)
    aizuchi.ttsAnswered(true)

    expect(changed).not.toHaveBeenCalled()
  })

  it('is built again once the TTS answers after the engine died while the clips were synthesized', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.synthesize.mockRejectedValueOnce(new Error('connection refused'))
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).some((clip) => clip.audio === null)).toBe(true)

    aizuchi.ttsAnswered(false)

    expect((await aizuchi.getBank()).every((clip) => clip.audio === audioFor(1))).toBe(true)
  })

  it('is not built again on every check while synthesis keeps failing with the TTS answering, only when the TTS comes back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.synthesize.mockRejectedValue(new Error('speaker not found'))
    const aizuchi = await import('../src/main/services/aizuchi')
    await aizuchi.getBank()
    const changed = vi.fn()
    aizuchi.events.on('changed', changed)

    aizuchi.ttsAnswered(false)
    await aizuchi.getBank()
    aizuchi.ttsAnswered(false)
    await aizuchi.getBank()
    expect(changed).toHaveBeenCalledOnce()

    aizuchi.ttsAnswered(true)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('aizuchi bank outside Japanese', () => {
  it('builds nothing, because the clips are Japanese interjections', async () => {
    mocks.locale = 'en-US'
    const aizuchi = await import('../src/main/services/aizuchi')
    expect(await aizuchi.getBank()).toEqual([])
    expect(await aizuchi.randomClip('work')).toBeNull()
    expect(mocks.resolveVoice).not.toHaveBeenCalled()
    expect(mocks.synthesize).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(mocks.dir, 'aizuchi'))).toBe(false)
  })

  it('builds the bank again once the conversation goes back to Japanese', async () => {
    mocks.locale = 'en-US'
    const aizuchi = await import('../src/main/services/aizuchi')
    expect(await aizuchi.getBank()).toEqual([])

    mocks.locale = 'ja-JP'
    aizuchi.rebuild()
    const bank = await aizuchi.getBank()
    expect(bank.length).toBeGreaterThan(0)
    expect(bank.every((clip) => clip.audio === audioFor(1))).toBe(true)
  })
})

describe('aizuchi bank with Irodori-TTS', () => {
  beforeEach(() => {
    mocks.engine = 'irodori'
    mocks.resolveVoice.mockImplementation(async () => ({ engine: 'irodori', voice: 'calm-young-woman', language: 'ja' }))
  })

  it('synthesizes every clip with the chosen voice and caches it, as it does for the HTTP engines', async () => {
    const aizuchi = await import('../src/main/services/aizuchi')
    const bank = await aizuchi.getBank()
    expect(bank.every((clip) => clip.audio !== null)).toBe(true)
    expect(mocks.synthesize).toHaveBeenCalledWith('うん。', undefined, expect.objectContaining({ volumeScale: 0.8 }), { engine: 'irodori', voice: 'calm-young-woman', language: 'ja' })
    const cached = fs.readdirSync(path.join(mocks.dir, 'aizuchi')).filter((name) => name.endsWith('.wav'))
    expect(cached).toHaveLength(new Set(bank.map((clip) => clip.text)).size)
  })

  it('builds the bank again once the worker that was still loading answers', async () => {
    mocks.engineUp = false
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).every((clip) => clip.audio === null)).toBe(true)
    mocks.engineUp = true
    aizuchi.ttsAnswered(false)
    expect((await aizuchi.getBank()).every((clip) => clip.audio !== null)).toBe(true)
  })
})

describe('aizuchi bank with Qwen3-TTS', () => {
  async function shipClips(texts: string[]): Promise<void> {
    const { AIZUCHI_BANK } = await import('@shared/aizuchi-bank')
    const dir = path.join(mocks.dir, 'resources', 'aizuchi', 'qwen3tts', 'ono_anna')
    fs.mkdirSync(dir, { recursive: true })
    const clips = AIZUCHI_BANK.filter((def) => texts.length === 0 || texts.includes(def.text)).map((def, index) => {
      fs.writeFileSync(path.join(dir, `${index}.wav`), `wav of ${def.text}`)
      return { text: def.text, speedScale: def.speedScale, volumeScale: def.volumeScale, file: `${index}.wav` }
    })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ clips }))
  }

  it('plays the clips shipped for the chosen voice and synthesizes none, because the model rambles on a short interjection', async () => {
    mocks.engine = 'qwen3tts'
    await shipClips([])
    const aizuchi = await import('../src/main/services/aizuchi')
    const bank = await aizuchi.getBank()
    expect(bank.find((clip) => clip.text === 'うんうん。')!.audio).toBe(Buffer.from('wav of うんうん。').toString('base64'))
    expect(bank.every((clip) => clip.audio !== null)).toBe(true)
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })

  it('plays the shipped clips while the worker is still loading, which is the moment the engine is switched to', async () => {
    mocks.engine = 'qwen3tts'
    mocks.engineUp = false
    await shipClips([])
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).every((clip) => clip.audio !== null)).toBe(true)
  })

  it('stays silent when the model is not installed, because the replies are then read with another voice', async () => {
    mocks.engine = 'qwen3tts'
    mocks.qwenModelInstalled = false
    mocks.engineUp = false
    await shipClips([])
    const aizuchi = await import('../src/main/services/aizuchi')
    expect((await aizuchi.getBank()).every((clip) => clip.audio === null)).toBe(true)
  })

  it('fails when the shipped clips do not cover the bank, instead of starting with some aizuchi silent', async () => {
    mocks.engine = 'qwen3tts'
    await shipClips(['うん。'])
    const aizuchi = await import('../src/main/services/aizuchi')
    await expect(aizuchi.getBank()).rejects.toThrow('no pre-rendered aizuchi clip')
  })

  it('logs a rebuild that fails, which nothing waits for, instead of leaving the rejection unhandled', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.engine = 'qwen3tts'
    await shipClips(['うん。'])
    const aizuchi = await import('../src/main/services/aizuchi')
    aizuchi.rebuild()
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('aizuchi bank failed:', expect.objectContaining({
      message: expect.stringContaining('no pre-rendered aizuchi clip')
    })))
  })
})
