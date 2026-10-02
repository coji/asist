import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnMetricLog, TurnTimings } from '@shared/ipc'
import { TurnMetrics } from '../src/renderer/src/turn-metrics'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(typed = false) {
  const save = vi.fn<(payload: TurnMetricLog) => Promise<void>>(async () => {})
  const show = vi.fn<(timings: TurnTimings, utterance: number | null) => void>()
  const metrics = new TurnMetrics(save, show, () => 1000, () => 5000)
  if (typed) {
    metrics.beginRequest('request', { typed: true })
  } else {
    metrics.beginUtterance(10, 400, { vadMs: 350 })
    metrics.beginRequest('request', { typed: false, utterance: 10 })
  }
  metrics.activate(1, 'request')
  metrics.update(1, { ttftMs: 120 })
  return { metrics, save, show }
}

describe('TurnMetrics', () => {
  it('appends the measured playback under the same id and timestamp when audio starts after the response finished', () => {
    const { metrics, save } = setup()
    metrics.finish(1)
    expect(save.mock.calls[0][0]).toMatchObject({ id: 'request', revision: 1, occurredAt: 5000, ttftMs: 120 })
    metrics.playbackStarted(1, 0)
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'request', revision: 2, occurredAt: 5000, e2eMs: 600 })
    metrics.playbackStarted(1, 0)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('saves the collected values once when the audio starts before the response finishes', () => {
    const { metrics, save } = setup()
    metrics.playbackStarted(1, 0)
    metrics.update(1, { ttsMs: 90 })
    metrics.finish(1)
    metrics.finish(1)
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][0]).toMatchObject({ revision: 1, e2eMs: 600, ttsMs: 90 })
  })

  it('appends the barge-ins and the user aizuchi counted during playback and closes the turn when playback ends', () => {
    const { metrics, save } = setup()
    metrics.finish(1)
    metrics.playbackStarted(1, 0)
    expect(metrics.increment(1, 'userBackchannels')).toBe(true)
    expect(metrics.increment(1, 'userBackchannels')).toBe(true)
    expect(metrics.increment(1, 'bargeIns')).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    metrics.playbackIdle(1)
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2][0]).toMatchObject({ revision: 3, e2eMs: 600, userBackchannels: 2, bargeIns: 1 })
    // Events after the turn is closed are ignored, and the end of playback appends nothing more.
    expect(metrics.increment(1, 'bargeIns')).toBe(false)
    metrics.playbackIdle(1)
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('does not close the turn when playback ends with only an aizuchi played, and waits for the reply', () => {
    const { metrics, save } = setup()
    metrics.finish(1)
    metrics.playbackIdle(1)
    metrics.playbackStarted(1, 0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ e2eMs: 600 })
    metrics.playbackIdle(1)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('does not measure E2E from a filler played while working or from the second sentence', () => {
    const { metrics, save } = setup()
    metrics.playbackStarted(1, 998)
    metrics.playbackStarted(1, 1)
    metrics.finish(1)
    expect(save.mock.calls[0][0]).not.toHaveProperty('e2eMs')
  })

  it('keeps typed input and system reports out of the voice E2E measurement', () => {
    const { metrics, save } = setup(true)
    expect(metrics.update(2, { ttsMs: 100 })).toBe(false)
    metrics.playbackStarted(1, 0)
    metrics.finish(1)
    metrics.finish(2)
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][0]).toMatchObject({ typed: true, revision: 1 })
    expect(save.mock.calls[0][0]).not.toHaveProperty('e2eMs')
    // A typed turn closes at the end of playback without waiting for the reply to be measured.
    metrics.playbackIdle(1)
    expect(metrics.increment(1, 'bargeIns')).toBe(false)
  })

  it('attaches no measurement to a discarded request or to one that was replaced', () => {
    const { metrics, save } = setup()
    metrics.discard(1)
    metrics.beginRequest('a', { typed: true })
    metrics.beginRequest('b', { typed: true })
    metrics.activate(2, 'a')
    metrics.discardRequest('b')
    metrics.activate(3, 'b')
    metrics.update(2, { ttftMs: 100 })
    metrics.update(3, { ttftMs: 100 })
    metrics.finish(1)
    metrics.finish(2)
    metrics.finish(3)
    expect(save).not.toHaveBeenCalled()
  })

  it('discards a turn whose playback never arrives once the wait expires', () => {
    const { metrics, save } = setup()
    metrics.finish(1)
    vi.runAllTimers()
    metrics.playbackStarted(1, 0)
    expect(save).toHaveBeenCalledOnce()
  })

  it('writes the values counted after done when the wait for the end of playback expires', () => {
    const { metrics, save } = setup()
    metrics.finish(1)
    metrics.increment(1, 'bargeIns')
    vi.runAllTimers()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'request', revision: 2, bargeIns: 1 })
    expect(metrics.increment(1, 'bargeIns')).toBe(false)
  })

  it('measures a turn from its own utterance, whatever a newer speech end measured meanwhile', () => {
    const save = vi.fn<(payload: TurnMetricLog) => Promise<void>>(async () => {})
    const metrics = new TurnMetrics(save, () => {}, () => 1000, () => 5000)
    metrics.beginUtterance(10, 400, { vadMs: 350 })
    metrics.updateUtterance(10, { aizuchiClipMs: 400 })
    metrics.beginUtterance(20, 900, { vadMs: 500 })
    metrics.updateUtterance(20, { aizuchiClipMs: 900 })
    metrics.updateUtterance(10, { asrMs: 420 })
    metrics.beginRequest('request', { typed: false, utterance: 10 })
    metrics.activate(1, 'request')
    // The bridge of the utterance plays after its turn began.
    metrics.updateUtterance(10, { bridge: 'played' })
    metrics.finish(1)
    expect(save.mock.calls[0][0]).toEqual({ id: 'request', revision: 1, occurredAt: 5000, vadMs: 350, aizuchiClipMs: 400, asrMs: 420, bridge: 'played' })
  })

  it('shows the latest input in the HUD with the utterance it is of, and the one before again once the latest yields no turn', () => {
    const { metrics, show } = setup()
    expect(show).toHaveBeenLastCalledWith({ vadMs: 350, ttftMs: 120 }, 10)
    metrics.beginUtterance(20, 900, { vadMs: 500 })
    metrics.update(1, { ttsMs: 90 })
    expect(show).toHaveBeenLastCalledWith({ vadMs: 500 }, 20)
    metrics.dropUtterance(20)
    expect(show).toHaveBeenLastCalledWith({ vadMs: 350, ttftMs: 120, ttsMs: 90 }, 10)
    metrics.beginRequest('typed', { typed: true })
    expect(show).toHaveBeenLastCalledWith({}, null)
  })

  it('retries a failed save without mixing in values from later turns or updates', async () => {
    const { metrics, save } = setup()
    save.mockRejectedValueOnce(new Error('IPC interrupted'))
    metrics.finish(1)
    metrics.playbackStarted(1, 0)
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[2][0])
    expect(save.mock.calls[0][0]).not.toHaveProperty('e2eMs')
    expect(save.mock.calls[1][0]).toMatchObject({ revision: 2, e2eMs: 600 })
  })
})
