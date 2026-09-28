import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { RendererApi } from '@shared/ipc'

/** The setup demo walks through choosing the in-browser Whisper without downloading its model. */

class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  createAnalyser(): AnalyserNode {
    return { fftSize: 0, connect: vi.fn(), getByteTimeDomainData: vi.fn() } as unknown as AnalyserNode
  }
  createGain(): GainNode {
    return {
      connect: vi.fn(),
      gain: { cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() }
    } as unknown as GainNode
  }
  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return { stream: {} } as MediaStreamAudioDestinationNode
  }
}

beforeAll(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', class { srcObject: unknown = null; autoplay = false })
})
afterEach(() => {
  vi.useRealTimers()
})

it('prepares no real in-browser Whisper when the microphone turns on with local recognition chosen', async () => {
  const settings = { ttsEngine: 'voicevox', conversationModel: { provider: 'anthropic' }, onboardingVersion: 1 }
  const api = {
    getSettings: async () => settings,
    saveSettings: async () => settings,
    getStatus: async () => ({ asr: false, asrInstalled: false }),
    getSetupStatus: async () => ({}),
    completeSetup: async () => settings
  } as unknown as RendererApi
  vi.stubGlobal('window', { api })
  const { prepareSetupDemo } = await import('../src/renderer/src/demo/setup-demo')
  const { voiceController } = await import('../src/renderer/src/voice/VoiceController')
  const engine = (voiceController.recognition as unknown as { asr: { init: ReturnType<typeof vi.fn> } }).asr
  engine.init = vi.fn(async () => 'wasm')
  prepareSetupDemo(api, 'fresh')
  voiceController.localFallbackEnabled = true

  vi.useFakeTimers()
  const choosing = voiceController.recognition.choose(() => true)
  await vi.advanceTimersByTimeAsync(5_000)

  expect(await choosing).toBe(true)
  expect(voiceController.recognition.onServer).toBe(false)
  expect(engine.init).not.toHaveBeenCalled()
})
