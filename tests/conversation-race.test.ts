import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const turn = {
    activeTurnId: 7,
    timings: {},
    resetTimings: vi.fn(),
    setTimingsTurn: vi.fn(),
    setPhase: vi.fn(),
    setActiveTurn: vi.fn((id: number) => {
      turn.activeTurnId = id
    })
  }
  return {
    turn,
    feed: {
      append: vi.fn(() => 1),
      update: vi.fn(),
      appendToText: vi.fn()
    },
    speechPlayer: {
      interrupt: vi.fn(),
      discardBody: vi.fn(),
      beginTurn: vi.fn(),
      enqueue: vi.fn(),
      isPlaying: false
    }
  }
})

vi.mock('@/voice/VoiceController', () => ({
  voiceController: {
    current: 'off',
    msSinceBackchannel: Infinity,
    events: { on: vi.fn() }
  }
}))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: mocks.speechPlayer }))
vi.mock('@/voice/aizuchi-bank', () => ({
  loadAizuchiBank: vi.fn(),
  pickAizuchi: vi.fn(() => null),
  pickListeningClip: vi.fn(() => null)
}))
vi.mock('@/state/stores', () => ({
  useTurnStore: { getState: () => mocks.turn },
  useFeedStore: { getState: () => mocks.feed },
  useJobStore: { getState: () => ({}) },
  usePanelStore: { getState: () => ({ dismissLoadingOwnedBy: vi.fn() }) },
  useSettingsStore: { getState: () => ({ settings: null }) },
  useStatusStore: { getState: () => ({}) },
  useToastStore: { getState: () => ({ push: vi.fn() }) }
}))

describe('conversation request generations', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.turn.activeTurnId = 7
  })

  it('does not send an older request after waiting for the previous abort', async () => {
    const ids = ['request-a', 'request-b']
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => ids.shift()!) })

    let releaseAbort!: () => void
    const aborting = new Promise<void>((resolve) => (releaseAbort = resolve))
    const turnAbort = vi.fn((turnId: number) =>
      turnId === 7 ? aborting : Promise.resolve()
    )
    const turnStart = vi.fn(async () => 8)
    vi.stubGlobal('window', { api: { turnAbort, turnStart } })

    const { sendTypedMessage } = await import('../src/renderer/src/conversation')
    const older = sendTypedMessage('older')
    await Promise.resolve()
    const latest = sendTypedMessage('latest')
    await latest

    expect(turnStart).toHaveBeenCalledTimes(1)
    expect(turnStart).toHaveBeenCalledWith('latest', {
      typed: true,
      clientRequestId: 'request-b'
    })

    releaseAbort()
    await older

    expect(turnStart).toHaveBeenCalledTimes(1)
    expect(mocks.turn.activeTurnId).toBe(8)
  })

  it('immediately rejects an interject started while renderer still owns a user turn', async () => {
    const turnPlaybackAck = vi.fn(async () => undefined)
    vi.stubGlobal('window', { api: { turnPlaybackAck } })
    const { handleTurnEvent } = await import('../src/renderer/src/conversation')

    handleTurnEvent({ type: 'started', turnId: 9, origin: 'interject' })

    expect(turnPlaybackAck).toHaveBeenCalledOnce()
    expect(turnPlaybackAck).toHaveBeenCalledWith(9, 'interrupted')
    expect(mocks.speechPlayer.beginTurn).not.toHaveBeenCalled()
  })

  it('acknowledges done/error immediately when an accepted interject produced no body segment', async () => {
    const turnPlaybackAck = vi.fn(async () => undefined)
    vi.stubGlobal('window', { api: { turnPlaybackAck } })
    mocks.turn.activeTurnId = -1
    const { handleTurnEvent } = await import('../src/renderer/src/conversation')

    handleTurnEvent({ type: 'started', turnId: 10, origin: 'interject' })
    handleTurnEvent({ type: 'done', turnId: 10, fullText: '' })
    handleTurnEvent({ type: 'started', turnId: 11, origin: 'interject' })
    handleTurnEvent({ type: 'error', turnId: 11, message: 'TTS failed' })

    expect(turnPlaybackAck.mock.calls).toEqual([
      [10, 'interrupted'],
      [11, 'interrupted']
    ])
  })

  it('keeps a received interject body queued after done until SpeechPlayer starts it', async () => {
    const turnPlaybackAck = vi.fn(async () => undefined)
    vi.stubGlobal('window', { api: { turnPlaybackAck } })
    mocks.turn.activeTurnId = -1
    const { handleTurnEvent } = await import('../src/renderer/src/conversation')
    const body = { turnId: 12, index: 0, text: '完了しました', audio: null, phonemes: null }

    handleTurnEvent({ type: 'started', turnId: 12, origin: 'interject' })
    handleTurnEvent({ type: 'segment', turnId: 12, segment: body })
    handleTurnEvent({ type: 'done', turnId: 12, fullText: body.text })

    expect(turnPlaybackAck).not.toHaveBeenCalled()
    expect(mocks.speechPlayer.enqueue).toHaveBeenCalledWith(body)
  })
})
