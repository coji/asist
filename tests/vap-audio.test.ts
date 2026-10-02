import { describe, expect, it, vi } from 'vitest'
import { VapAudio } from '../src/renderer/src/voice/VapAudio'

const samples = (length: number, value: number): Float32Array => new Float32Array(length).fill(value)

describe('VapAudio', () => {
  it('packs uneven chunks into 80 ms blocks in order and fills the part with no playback audio with silence', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1000, 0.5), 16_000)
    audio.pushUser(samples(600, 1))
    expect(emit).not.toHaveBeenCalled()
    audio.pushUser(samples(1960, 2))
    expect(emit).toHaveBeenCalledTimes(2)
    const [firstUser, firstAssistant] = emit.mock.calls[0]
    expect([...firstUser]).toEqual([...samples(600, 1), ...samples(680, 2)])
    expect([...firstAssistant]).toEqual([...samples(1000, 0.5), ...samples(280, 0)])
    expect([...emit.mock.calls[1][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[1][1]]).toEqual([...samples(1280, 0)])
  })

  it('drops the older playback audio and pairs the newest with the microphone when the microphone lags', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(16_000, 1), 16_000)
    audio.pushAssistant(samples(1280, 2), 16_000)
    audio.pushUser(samples(1280, 0))
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 2)])
  })

  it('pairs the microphone with what is playing now after a whole reply played before its first frame', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    // The output tap's render quanta at 48 kHz: a second of reply while the microphone is still
    // starting, then 400 ms more.
    for (let i = 0; i < 375; i++) audio.pushAssistant(samples(128, 1), 48_000)
    for (let i = 0; i < 150; i++) audio.pushAssistant(samples(128, 2), 48_000)
    audio.pushUser(samples(1280, 0))

    expect([...(emit.mock.calls[0][1] as Float32Array)]).toEqual([...samples(1280, 2)])
  })

  /**
   * Plays a ramp through the output tap's 128-sample render quanta at 48 kHz for ten seconds, hands the
   * microphone over in chunks of the given length, each up to 3 ms early or late, and returns where the
   * played audio paired with it breaks off after the first second.
   */
  function breaksInPlayedAudio(chunkSamples: number): number[] {
    const paired: number[] = []
    const audio = new VapAudio((_user, assistant) => paired.push(...assistant))
    const tapMs = 128 / 48
    const chunkMs = chunkSamples / 16
    const jitterMs = [0, 3, -3, 2, -2, 1]
    const events: Array<{ at: number; tap: number | null }> = []
    for (let i = 0; i * tapMs < 10_000; i++) events.push({ at: i * tapMs, tap: i })
    for (let i = 1; i * chunkMs < 10_000; i++) events.push({ at: i * chunkMs + 15 + jitterMs[i % 6], tap: null })
    events.sort((a, b) => a.at - b.at)
    for (const { tap } of events) {
      if (tap === null) audio.pushUser(samples(chunkSamples, 0))
      else audio.pushAssistant(Float32Array.from({ length: 128 }, (_, k) => (tap * 128 + k + 48) / 48_000), 48_000)
    }
    const steady = paired.slice(16_000)
    return steady.slice(1).filter((value, index) => Math.abs(value - steady[index] - 1 / 16_000) > 1e-6)
  }

  it('passes the played audio on without gaps or padding when the native helper hands over 100 ms at a time', () => {
    expect(breaksInPlayedAudio(1_600)).toEqual([])
  })

  it('passes the played audio on without gaps or padding when getUserMedia hands over 21 ms at a time', () => {
    expect(breaksInPlayedAudio(341)).toEqual([])
  })

  it('does not mix in unsent audio or a resampling remainder from before the microphone stopped', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1, 1), 48_000)
    audio.pushUser(samples(500, 1))
    audio.reset()
    audio.pushAssistant(samples(3841, 0.5), 48_000)
    audio.pushUser(samples(1280, 2))
    expect(emit).toHaveBeenCalledOnce()
    expect([...emit.mock.calls[0][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 0.5)])
  })
})
