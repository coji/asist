import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { AppSettings, TtsEngine } from '@shared/ipc'
import type { ConversationLocale } from '@shared/conversation-locale'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: false,
  spawn: vi.fn(),
  settings: { ttsEngine: 'voicevox' as TtsEngine, voicevoxSpeaker: 3, aivisSpeaker: null as number | null, conversationLocale: 'ja-JP' as ConversationLocale }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ ...mocks.settings }),
  saveSettings: (patch: Partial<AppSettings>) => { mocks.settings = { ...mocks.settings, ...patch } }
}))

const fetchMock = vi.fn<typeof fetch>()
const children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn> }> = []

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  mocks.settings = { ttsEngine: 'voicevox', voicevoxSpeaker: 3, aivisSpeaker: null, conversationLocale: 'ja-JP' }
  mocks.windows = false
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
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
    const first = tts.ensureEngine('voicevox')
    const second = tts.ensureEngine('voicevox')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await Promise.all([first, second])

    // The watchdog's next request does not spawn a second process while /version still answers 503.
    await tts.ensureEngine('voicevox')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('can start the engine again after the owned process exits', async () => {
    const tts = await import('../src/main/services/tts')
    const first = tts.ensureEngine('voicevox')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await first
    children[0].emit('exit', 1)

    const retry = tts.ensureEngine('voicevox')
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].emit('spawn')
    await retry
  })

  it('reports a spawn failure to every concurrent caller and retries on the next request', async () => {
    const tts = await import('../src/main/services/tts')
    const first = expect(tts.ensureEngine('voicevox')).rejects.toThrow('spawn failed')
    const second = expect(tts.ensureEngine('voicevox')).rejects.toThrow('spawn failed')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('error', new Error('spawn failed'))
    await Promise.all([first, second])

    const retry = tts.ensureEngine('voicevox')
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].emit('spawn')
    await retry
  })

  it('retries on the next request when spawn throws synchronously', async () => {
    const tts = await import('../src/main/services/tts')
    mocks.spawn.mockImplementationOnce(() => { throw new Error('sync failure') })
    await expect(tts.ensureEngine('voicevox')).rejects.toThrow('sync failure')

    const retry = tts.ensureEngine('voicevox')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0].emit('spawn')
    await retry
  })

  it('does not start an engine that is already running', async () => {
    fetchMock.mockResolvedValue(new Response('ready'))
    const tts = await import('../src/main/services/tts')
    await tts.ensureEngine('voicevox')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts another engine independently while the first one is still starting', async () => {
    const tts = await import('../src/main/services/tts')
    const voicevox = tts.ensureEngine('voicevox')
    const aivis = tts.ensureEngine('aivisspeech')
    await vi.waitFor(() => expect(children).toHaveLength(2))
    for (const child of children) child.emit('spawn')
    await Promise.all([voicevox, aivis])
    expect(mocks.spawn.mock.calls.map(([binary]) => binary)).toEqual([
      expect.stringContaining('voicevox_engine'), expect.stringContaining('aivisspeech_engine')
    ])
  })
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

  it('refuses Qwen3-TTS in the two languages the model has no voice for, and accepts the rest', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.settings.conversationLocale = 'hi-IN'
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotSpeak {"engine":"Qwen3-TTS","language":"Hindi"}]')
    mocks.settings.conversationLocale = 'id-ID'
    await expect(tts.resolveVoice()).rejects.toThrow('Qwen3-TTS')
    mocks.settings.conversationLocale = 'pt-BR'
    await expect(tts.resolveVoice()).resolves.toMatchObject({ engine: 'qwen3tts', language: 'portuguese' })
  })

  it('refuses Qwen3-TTS left in the settings on a machine that cannot run it, with that reason', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.windows = true
    const tts = await import('../src/main/services/tts')
    await expect(tts.resolveVoice()).rejects.toThrow('[asist:voice.speech.cannotRunHere {"engine":"Qwen3-TTS"}]')
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
