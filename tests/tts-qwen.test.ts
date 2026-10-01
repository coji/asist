import type { AppSettings } from '@shared/ipc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The TTS service with Qwen3-TTS selected: which calls reach the worker service and what the playback queue is given. */

const mocks = vi.hoisted(() => ({
  settings: { ttsEngine: 'qwen3tts', qwenTtsVoice: 'ono_anna', conversationLocale: 'ja-JP' } as Partial<AppSettings>,
  stream: vi.fn(),
  synthesizeWav: vi.fn(),
  ensureWorker: vi.fn(async () => true),
  stop: vi.fn()
}))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ ...mocks.settings }) }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/qwen-tts', () => ({
  stream: mocks.stream,
  synthesizeWav: mocks.synthesizeWav,
  ensureWorker: mocks.ensureWorker,
  stop: mocks.stop,
  sampleRate: () => 24_000,
  available: () => true,
  isStarting: () => false
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.settings = { ttsEngine: 'qwen3tts', qwenTtsVoice: 'ono_anna', conversationLocale: 'ja-JP' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

async function* piecesOf(...pieces: number[][]): AsyncGenerator<Float32Array> {
  for (const piece of pieces) yield new Float32Array(piece)
}

describe('TTS service with Qwen3-TTS', () => {
  it('hands a sentence to the playback queue as a stream that still starts with the first piece', async () => {
    mocks.stream.mockReturnValue(piecesOf([1, 2], [3]))
    const tts = await import('../src/main/services/tts')
    const speech = await tts.synthesizeSentence('こんにちは。', 'ja-JP')
    if (speech.kind !== 'stream') throw new Error('expected a stream')
    const received: number[][] = []
    for await (const piece of speech.pieces) received.push([...piece])
    expect(received).toEqual([[1, 2], [3]])
    expect(speech.sampleRate).toBe(24_000)
    expect(mocks.stream).toHaveBeenCalledWith({ text: 'こんにちは。', voice: 'ono_anna', language: 'ja' }, undefined)
  })

  it('lets the renderer speak a sentence through Web Speech when the model produces nothing or fails before the first piece', async () => {
    const tts = await import('../src/main/services/tts')
    mocks.stream.mockReturnValue(piecesOf())
    expect(await tts.synthesizeSentence('…', 'ja-JP')).toEqual({ kind: 'whole', audio: null, phonemes: null })
    mocks.stream.mockReturnValue((async function* (): AsyncGenerator<Float32Array> { throw new Error('worker exited') })())
    expect(await tts.synthesizeSentence('こんにちは。', 'ja-JP')).toEqual({ kind: 'whole', audio: null, phonemes: null })
  })

  it('rejects instead of falling back when the turn was aborted', async () => {
    const controller = new AbortController()
    mocks.stream.mockReturnValue((async function* (): AsyncGenerator<Float32Array> {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })())
    const tts = await import('../src/main/services/tts')
    await expect(tts.synthesizeSentence('こんにちは。', 'ja-JP', controller.signal)).rejects.toThrow('aborted')
  })

  it('synthesizes a clip as a WAV at the clip\'s volume', async () => {
    mocks.synthesizeWav.mockResolvedValue(Buffer.from([1, 2, 3]))
    const tts = await import('../src/main/services/tts')
    const result = await tts.synthesize('うん', undefined, { speedScale: 1.1, volumeScale: 0.8 })
    expect(result).toEqual({ audio: 'AQID', phonemes: null })
    expect(mocks.synthesizeWav).toHaveBeenCalledWith({ text: 'うん', voice: 'ono_anna', language: 'ja' }, undefined, 0.8)
  })

  it('frees the worker\'s memory when another engine is chosen', async () => {
    const tts = await import('../src/main/services/tts')
    await tts.ensureEngine('qwen3tts')
    expect(mocks.ensureWorker).toHaveBeenCalledOnce()
    expect(mocks.stop).not.toHaveBeenCalled()
    await tts.ensureEngine('system')
    expect(mocks.stop).toHaveBeenCalledOnce()
  })
})
