import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { AsrBackend } from '../src/renderer/src/voice/AsrBackend'

type FakeAsr = {
  init: ReturnType<typeof vi.fn>
  transcribe: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

interface Internals {
  backend: 'server' | 'local'
  asr: FakeAsr
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      transcribe: vi.fn(),
      transcribeCancel: vi.fn(async () => true),
      getStatus: vi.fn(async () => ({ asr: true }))
    }
  })
})

function fakeAsr(): FakeAsr {
  return {
    init: vi.fn(async () => 'wasm'),
    transcribe: vi.fn(),
    reset: vi.fn()
  }
}

function backend(): { recognition: AsrBackend; state: Internals; asr: FakeAsr; serverLost: ReturnType<typeof vi.fn> } {
  const serverLost = vi.fn()
  const recognition = new AsrBackend({ onProgress: () => {}, onServerLost: serverLost })
  const state = recognition as unknown as Internals
  const asr = fakeAsr()
  state.asr = asr
  return { recognition, state, asr, serverLost }
}

const always = (): boolean => true

describe('AsrBackend', () => {
  it('does not initialize or download local ASR by default', async () => {
    const { recognition, asr } = backend()
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))

    await expect(recognition.transcribe(new Float32Array([0.1]), always)).rejects.toThrow('[asist:speechRecognition.errors.serverTranscribeFailed')
    expect(recognition.localFallbackEnabled).toBe(false)
    expect(asr.init).not.toHaveBeenCalled()
    expect(asr.transcribe).not.toHaveBeenCalled()
  })

  it('keeps the reason the server gave whole in its error, so the screen words it in the language shown when it is read', async () => {
    const { recognition } = backend()
    const reason = errorText('speechRecognition.errors.transcribeTimeout')
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error(`Error invoking remote method 'asr-transcribe': Error: ${reason}`))

    // The interface is in Japanese while the error is thrown, and in English when it is read.
    const thrown = await recognition.transcribe(new Float32Array([0.1]), always).catch((error: unknown) => error as Error)
    const en = createTranslator('en-US')
    expect(readErrorText(thrown.message, 'en-US')).toBe(
      en('speechRecognition.errors.serverTranscribeFailed', { detail: en('speechRecognition.errors.transcribeTimeout') })
    )
    expect(thrown.message).not.toContain('Error invoking remote method')
  })

  it('rescues the same server utterance through explicitly enabled local ASR, and stops the partial transcriptions', async () => {
    const { recognition, asr, serverLost } = backend()
    recognition.localFallbackEnabled = true
    const audio = new Float32Array([0.1, 0.2])
    vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))
    asr.transcribe.mockResolvedValue('救済しました')

    await expect(recognition.transcribe(audio, always)).resolves.toBe('救済しました')
    expect(asr.init).toHaveBeenCalledTimes(1)
    expect(asr.transcribe).toHaveBeenCalledWith(audio, 'japanese')
    expect(recognition.onServer).toBe(false)
    expect(serverLost).toHaveBeenCalledOnce()
  })

  it('asks the in-browser Whisper for the conversation language', async () => {
    const { useSettingsStore } = await import('@/state/stores')
    useSettingsStore.setState({ settings: { conversationLocale: 'de-DE' } as AppSettings })
    try {
      const { recognition, asr } = backend()
      recognition.localFallbackEnabled = true
      vi.mocked(window.api.transcribe).mockRejectedValue(new Error('server offline'))
      asr.transcribe.mockResolvedValue('Guten Tag')

      await expect(recognition.transcribe(new Float32Array([0.1]), always)).resolves.toBe('Guten Tag')
      expect(asr.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 'german')
    } finally {
      useSettingsStore.setState({ settings: null })
    }
  })

  it('resets local ASR and retries one time after a local failure', async () => {
    const { recognition, state, asr } = backend()
    state.backend = 'local'
    recognition.localFallbackEnabled = true
    asr.transcribe.mockRejectedValueOnce(new Error('device lost')).mockResolvedValueOnce('復旧')

    await expect(recognition.transcribe(new Float32Array([0.1]), always)).resolves.toBe('復旧')
    expect(asr.reset).toHaveBeenCalledTimes(1)
    expect(asr.init).toHaveBeenCalledTimes(2)
    expect(asr.transcribe).toHaveBeenCalledTimes(2)
  })

  it('switches away from a stopped server and promotes it again when available', () => {
    const { recognition, serverLost } = backend()

    recognition.handleStatus(false)
    expect(recognition.onServer).toBe(false)
    expect(serverLost).toHaveBeenCalledOnce()
    recognition.handleStatus(true)
    expect(recognition.onServer).toBe(true)
  })

  it('moves up to a server that has come up while local was in use', async () => {
    const { recognition, state } = backend()
    state.backend = 'local'
    vi.mocked(window.api.getStatus).mockResolvedValueOnce({ asr: false } as never)
    await recognition.probeUpgrade()
    expect(recognition.onServer).toBe(false)

    await recognition.probeUpgrade()
    expect(recognition.onServer).toBe(true)
  })
})
