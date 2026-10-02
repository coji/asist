import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, TtsEngine } from '@shared/ipc'
import type { ConversationLocale } from '@shared/conversation-locale'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: false,
  noGpu: false,
  spawn: vi.fn(),
  quitHooks: [] as Array<() => void>,
  settings: { ttsEngine: 'voicevox' as TtsEngine, voicevoxSpeaker: 3, aivisSpeaker: null as number | null, conversationLocale: 'ja-JP' as ConversationLocale }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data',
  on: (event: string, listener: () => void) => { if (event === 'will-quit') mocks.quitHooks.push(listener) }
} }))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS, WINDOWS_WITHOUT_GPU } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.noGpu ? WINDOWS_WITHOUT_GPU : mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ ...mocks.settings }),
  saveSettings: (patch: Partial<AppSettings>) => { mocks.settings = { ...mocks.settings, ...patch } }
}))

const fetchMock = vi.fn<typeof fetch>()
const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = []

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  mocks.settings = { ttsEngine: 'voicevox', voicevoxSpeaker: 3, aivisSpeaker: null, conversationLocale: 'ja-JP' }
  mocks.windows = false
  mocks.noGpu = false
  mocks.quitHooks.length = 0
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() })
    children.push(child)
    return child
  })
  children.length = 0
  fetchMock.mockReset().mockResolvedValue(new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VOICEVOX_URL', 'http://voicevox.test')
  vi.stubEnv('AIVISSPEECH_URL', 'http://aivis.test')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('TTS process startup', () => {
  it('serves concurrent start requests, and a repeat request made before HTTP is ready, from one owned process', async () => {
    const tts = await import('../src/main/services/tts')
    const first = tts.ensureEngine()
    const second = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await Promise.all([first, second])

    // The watchdog's next request does not spawn a second process while /version still answers 503.
    await tts.ensureEngine()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('can start the engine again after the owned process exits', async () => {
    const tts = await import('../src/main/services/tts')
    const first = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await first
    children[0].emit('exit', 1)

    const retry = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].emit('spawn')
    await retry
  })

  it('reports a spawn failure to every concurrent caller and retries on the next request', async () => {
    const tts = await import('../src/main/services/tts')
    const first = expect(tts.ensureEngine()).rejects.toThrow('spawn failed')
    const second = expect(tts.ensureEngine()).rejects.toThrow('spawn failed')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('error', new Error('spawn failed'))
    await Promise.all([first, second])

    const retry = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].emit('spawn')
    await retry
  })

  it('retries on the next request when spawn throws synchronously', async () => {
    const tts = await import('../src/main/services/tts')
    mocks.spawn.mockImplementationOnce(() => { throw new Error('sync failure') })
    await expect(tts.ensureEngine()).rejects.toThrow('sync failure')

    const retry = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await retry
  })

  it('does not start an engine that is already running', async () => {
    fetchMock.mockResolvedValue(new Response('ready'))
    const tts = await import('../src/main/services/tts')
    await tts.ensureEngine()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts nothing for an engine the choice moved away from while it was asked whether it runs', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const probe = deferred<Response>()
    fetchMock.mockReturnValueOnce(probe.promise)
    const tts = await import('../src/main/services/tts')
    const voicevox = tts.ensureEngine()
    mocks.settings.ttsEngine = 'aivisspeech'
    const aivis = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    probe.resolve(new Response('', { status: 503 }))
    await Promise.all([voicevox, aivis])
    // Nothing would stop a VOICEVOX started now: the watchdog asks for no start while AivisSpeech answers.
    expect(mocks.spawn.mock.calls.map(([binary]) => binary)).toEqual([expect.stringContaining('aivisspeech_engine')])
  })
})

describe('an engine this app started', () => {
  async function started(engine: 'voicevox' | 'aivisspeech'): Promise<typeof import('../src/main/services/tts')> {
    mocks.settings.ttsEngine = engine
    const tts = await import('../src/main/services/tts')
    const starting = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await starting
    return tts
  }

  it('stops when the app quits, instead of holding its memory with no app to read aloud for', async () => {
    await started('voicevox')
    for (const quit of mocks.quitHooks) quit()
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('stops once another engine is chosen', async () => {
    const tts = await started('aivisspeech')
    mocks.settings.ttsEngine = 'system'
    await tts.ensureEngine()
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('keeps running while it is the engine the settings choose', async () => {
    const tts = await started('voicevox')
    await tts.ensureEngine()
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('is started anew when chosen again while it still exits, rather than taken for running until it is gone', async () => {
    const tts = await started('voicevox')
    // The process started for VOICEVOX answers, and keeps answering for the moment it takes to exit.
    fetchMock.mockImplementation(async (input) => new Response('"0.25.2"', { status: String(input).startsWith('http://voicevox.test') ? 200 : 503 }))
    mocks.settings.ttsEngine = 'aivisspeech'
    const aivis = tts.ensureEngine()
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].emit('spawn')
    await aivis
    expect(children[0].kill).toHaveBeenCalled()

    mocks.settings.ttsEngine = 'voicevox'
    const again = tts.ensureEngine()
    await expect(tts.available('voicevox')).resolves.toBe(false)
    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    children[0].emit('exit', null, 'SIGTERM')
    await vi.waitFor(() => expect(children).toHaveLength(3))
    expect(mocks.spawn.mock.calls[2][0]).toContain('voicevox_engine')
    children[2].emit('spawn')
    await again
    expect(children[1].kill).toHaveBeenCalled()
    expect(children[2].kill).not.toHaveBeenCalled()
  })
})

describe('where an engine is started from', () => {
  const home = os.homedir()
  const candidates = {
    macos: {
      voicevox: [path.join(home, 'opt', 'voicevox_engine', 'run'), '/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run'],
      aivisspeech: [path.join(home, 'opt', 'aivisspeech_engine', 'run'), '/Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run']
    },
    windows: {
      voicevox: [
        'C:\\Users\\sakura\\AppData\\Local\\Programs\\VOICEVOX\\vv-engine\\run.exe',
        'C:\\Program Files\\VOICEVOX\\vv-engine\\run.exe'
      ],
      aivisspeech: [
        'C:\\Users\\sakura\\AppData\\Local\\Programs\\AivisSpeech\\AivisSpeech-Engine\\run.exe',
        'C:\\Program Files\\AivisSpeech\\AivisSpeech-Engine\\run.exe'
      ]
    }
  } as const

  beforeEach(() => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\sakura\\AppData\\Local')
    vi.stubEnv('ProgramFiles', 'C:\\Program Files')
  })

  async function startWith(engine: 'voicevox' | 'aivisspeech', installed: readonly string[]): Promise<string[]> {
    mocks.settings.ttsEngine = engine
    const tts = await import('../src/main/services/tts')
    const looked: string[] = []
    vi.mocked(fs.existsSync).mockImplementation((file) => {
      looked.push(String(file))
      return installed.includes(String(file))
    })
    const started = tts.ensureEngine()
    if (installed.length > 0) {
      await vi.waitFor(() => expect(children).toHaveLength(1))
      children[0].emit('spawn')
    }
    await started
    return looked
  }

  for (const engine of ['voicevox', 'aivisspeech'] as const) {
    it(`looks for ${engine} in the per-user and then the all-users install on Windows, and starts nothing when neither is there`, async () => {
      mocks.windows = true
      expect(await startWith(engine, [])).toEqual(candidates.windows[engine])
      expect(mocks.spawn).not.toHaveBeenCalled()
    })

    it(`starts ${engine} on Windows from the all-users install when the per-user one is missing`, async () => {
      mocks.windows = true
      const [, allUsers] = candidates.windows[engine]
      await startWith(engine, [allUsers])
      expect(mocks.spawn.mock.calls.map(([binary]) => binary)).toEqual([allUsers])
    })

    it(`starts ${engine} on Windows from the per-user install when both are there`, async () => {
      mocks.windows = true
      const [perUser, allUsers] = candidates.windows[engine]
      await startWith(engine, [allUsers, perUser])
      expect(mocks.spawn.mock.calls.map(([binary]) => binary)).toEqual([perUser])
    })

    it(`keeps looking for ${engine} in the same places on macOS`, async () => {
      expect(await startWith(engine, [])).toEqual(candidates.macos[engine])
      expect(mocks.spawn).not.toHaveBeenCalled()
    })
  }
})

function mockSynthesis(speakers: Promise<Response>): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/speakers')) return speakers
    if (url.includes('/audio_query?')) {
      return Response.json({ accent_phrases: [], speedScale: 1, prePhonemeLength: 0 })
    }
    if (url.includes('/synthesis?')) return new Response(new Uint8Array([1, 2, 3]))
    throw new Error(`unexpected request: ${url}`)
  })
}

const speakerResponse = (): Response => Response.json([
  { name: 'Speaker', styles: [{ id: 1, name: 'First' }, { id: 42, name: 'Selected' }] }
])

describe('reading aloud turned off', () => {
  it('starts no engine, checks no connection, and fails to resolve a voice instead of quietly using another one', async () => {
    mocks.settings.ttsEngine = 'none'
    const tts = await import('../src/main/services/tts')
    await tts.ensureEngine()
    expect(await tts.available()).toBe(false)
    expect(await tts.listSpeakers()).toEqual([])
    await expect(tts.resolveVoice()).rejects.toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('an engine that cannot speak the conversation language', () => {
  it('refuses VOICEVOX outside Japanese instead of reading English as if it were Japanese', async () => {
    mocks.settings.conversationLocale = 'en-US'
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotSpeak {"engine":"VOICEVOX","language":"English"}]')
  })

  it('refuses Irodori-TTS outside Japanese, the one language its model speaks', async () => {
    mocks.settings.ttsEngine = 'irodori'
    mocks.settings.conversationLocale = 'en-US'
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotSpeak {"engine":"Irodori-TTS","language":"English"}]')
  })

  it('refuses Qwen3-TTS in the two languages the model has no voice for, and accepts the rest', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.settings.conversationLocale = 'hi-IN'
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotSpeak {"engine":"Qwen3-TTS","language":"Hindi"}]')
    mocks.settings.conversationLocale = 'id-ID'
    await expect(tts.resolveVoice()).rejects.toThrow('Qwen3-TTS')
    mocks.settings.conversationLocale = 'pt-BR'
    await expect(tts.resolveVoice()).resolves.toMatchObject({ engine: 'qwen3tts', language: 'pt' })
  })

  it('refuses Qwen3-TTS left in the settings on a machine that cannot run it, with that reason', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.noGpu = true
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotRunHere {"engine":"Qwen3-TTS"}]')
  })

  it('starts nothing for Qwen3-TTS left in the settings on a machine that cannot run it, so that the app still starts', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.noGpu = true
    const tts = await import('../src/main/services/tts')
    await expect(tts.ensureEngine()).resolves.toBeUndefined()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('keeps the Japanese engines for a Japanese conversation', async () => {
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).resolves.toEqual({ engine: 'voicevox', speaker: 3 })
  })
})

describe('TTS speaker selection', () => {
  it('uses the id the user picked while the first speaker list was loading and does not overwrite it with the default', async () => {
    mocks.settings.ttsEngine = 'aivisspeech'
    const pending = deferred<Response>()
    mockSynthesis(pending.promise)
    const tts = await import('../src/main/services/tts')
    const speech = tts.synthesize('hello')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    mocks.settings = { ...mocks.settings, aivisSpeaker: 42 }
    pending.resolve(speakerResponse())

    expect((await speech).audio).toBe('AQID')
    expect(mocks.settings.aivisSpeaker).toBe(42)
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('http://aivis.test/audio_query?text=hello&speaker=42')
  })

  it('shares one speaker list between concurrent automatic requests and leaves the setting on automatic', async () => {
    mocks.settings.ttsEngine = 'aivisspeech'
    const pending = deferred<Response>()
    mockSynthesis(pending.promise)
    const tts = await import('../src/main/services/tts')
    const first = tts.synthesize('one')
    const second = tts.synthesize('two')
    pending.resolve(speakerResponse())

    const results = await Promise.all([first, second])
    expect(results.every((result) => result.audio === 'AQID')).toBe(true)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/speakers'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/audio_query?')).map(([url]) => url)).toEqual([
      'http://aivis.test/audio_query?text=one&speaker=1', 'http://aivis.test/audio_query?text=two&speaker=1'
    ])
    expect(mocks.settings.aivisSpeaker).toBeNull()
  })

  it('does not mix the host and the speaker of a synthesis request when the engine changes while the list is loading', async () => {
    mocks.settings.ttsEngine = 'aivisspeech'
    const pending = deferred<Response>()
    mockSynthesis(pending.promise)
    const tts = await import('../src/main/services/tts')
    const aivis = tts.synthesize('before')
    mocks.settings = { ...mocks.settings, ttsEngine: 'voicevox', voicevoxSpeaker: 3 }
    pending.resolve(speakerResponse())
    await aivis
    await tts.synthesize('after')

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/audio_query?')).map(([url]) => url)).toEqual([
      'http://aivis.test/audio_query?text=before&speaker=1', 'http://voicevox.test/audio_query?text=after&speaker=3'
    ])
    expect(mocks.settings).toEqual({ ttsEngine: 'voicevox', voicevoxSpeaker: 3, aivisSpeaker: null, conversationLocale: 'ja-JP' })
  })

  it('does not turn an HTTP failure of the speaker list into an empty list and hands the reason to the UI', async () => {
    const tts = await import('../src/main/services/tts')
    await expect(tts.listSpeakers('aivisspeech')).rejects.toThrow('HTTP 503')
  })
})

describe('the name of the system voice', () => {
  it('names the voice of the OS the app runs on', async () => {
    const { createTranslator } = await import('@shared/i18n')
    const t = createTranslator('ja-JP')
    mocks.settings = { ...mocks.settings, uiLocale: 'ja-JP' } as typeof mocks.settings
    const tts = await import('../src/main/services/tts')
    expect(tts.engineLabel('system')).toBe(t('settings.ttsEngine.system.macos'))
    mocks.windows = true
    expect(tts.engineLabel('system')).toBe(t('settings.ttsEngine.system.windows'))
  })
})

describe('a piece of a reply read by an HTTP engine', () => {
  it('starts at the voice and keeps a short silence after it, since the player leaves the pause between pieces', async () => {
    mockSynthesis(Promise.resolve(speakerResponse()))
    const tts = await import('../src/main/services/tts')
    await tts.synthesizeSentence('明日は晴れです。', 'ja-JP')
    const synthesis = fetchMock.mock.calls.find(([url]) => String(url).includes('/synthesis?'))!
    expect(JSON.parse(String((synthesis[1] as RequestInit).body))).toMatchObject({ prePhonemeLength: 0, postPhonemeLength: 0.1 })
  })
})
