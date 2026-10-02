import { describe, expect, it, vi } from 'vitest'
import type { BridgeClip, AizuchiClip, BridgePlan, ClipRole, SpeechSegment } from '@shared/ipc'
import type { AizuchiClassification } from '@shared/aizuchi-classifier'
import { TurnOpening } from '@/voice/opening'

const clip: AizuchiClip = { text: 'なるほど。', category: 'understand', weight: 1, audio: 'eA==' }
const plan: BridgePlan = { bridge: '会議の件ですね。' }
const classification: AizuchiClassification = { cls: 'understand', prob: 0.9, complete: 0.8 }
const input = {
  startedAt: 10,
  speechEndAt: 1000,
  classification,
  /** The lookahead plan is already resolved when the speech ends, and the classification lets the utterance have a bridge. */
  bridge: { plan: Promise.resolve<BridgePlan | null>(plan), screened: true },
  sinceListeningMs: 9000
}

function setup(picked: AizuchiClip | null = clip) {
  /** The clips handed to the player that are still to sound, as far as the opening can withdraw them. */
  const waiting: SpeechSegment[] = []
  const play = vi.fn((played: { audio: string | null; text: string }, role: ClipRole): SpeechSegment => {
    const queued: SpeechSegment = { turnId: 1, index: -1, text: played.text, audio: played.audio, phonemes: null, clip: role }
    waiting.push(queued)
    return queued
  })
  const pickAizuchi = vi.fn(() => picked)
  const resolvers: Array<(bridge: BridgeClip) => void> = []
  const rejecters: Array<(error: Error) => void> = []
  const synthesizeBridge = vi.fn(
    () =>
      new Promise<BridgeClip>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
  )
  const bodyQueued = { after: false }
  const onBridgeOutcome = vi.fn()
  const opening = new TurnOpening({
    pickAizuchi,
    play,
    synthesizeBridge,
    bodyQueuedAfter: () => bodyQueued.after,
    onBridgeOutcome,
    withdrawBridge: (queued) => {
      waiting.splice(0, waiting.length, ...waiting.filter((waitingClip) => waitingClip !== queued))
    }
  })
  return { opening, play, pickAizuchi, synthesizeBridge, resolvers, rejecters, bodyQueued, onBridgeOutcome, waiting }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TurnOpening', () => {
  it('plays the aizuchi when the speech ends, asks for the bridge to be synthesized, and hands both texts over with the final transcript', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge, resolvers } = setup()
    opening.begin(input)
    expect(pickAizuchi).toHaveBeenCalledWith(classification)
    expect(play).toHaveBeenCalledWith(clip, 'aizuchi')
    await flush()
    expect(synthesizeBridge).toHaveBeenCalledWith('会議の件ですね。')
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
    // Once it has been claimed, the same utterance never receives it a second time.
    expect(opening.claim(10)).toBeNull()
    // A synthesis that finishes after the claim still plays, as long as the body of the reply has not arrived.
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenLastCalledWith({ text: '会議の件ですね。', audio: 'YQ==' }, 'bridge')
  })

  it('plays the aizuchi from the classification even when the lookahead is late, and asks for the bridge once the plan resolves', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge, resolvers } = setup()
    let settle!: (plan: BridgePlan | null) => void
    const settled = new Promise<BridgePlan | null>((resolve) => (settle = resolve))
    opening.begin({ ...input, bridge: { plan: settled, screened: true } })
    expect(pickAizuchi).toHaveBeenCalledWith(classification)
    expect(play).toHaveBeenCalledWith(clip, 'aizuchi')
    // The final transcript arrives first, so the bridge is handed over as still pending.
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: true })
    settle(plan)
    await flush()
    expect(synthesizeBridge).toHaveBeenCalledWith('会議の件ですね。')
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenLastCalledWith({ text: '会議の件ですね。', audio: 'YQ==' }, 'bridge')
  })

  it('settles without a bridge when the lookahead produced no plan', async () => {
    const { opening, synthesizeBridge } = setup()
    opening.begin({ ...input, bridge: { plan: Promise.resolve(null), screened: true } })
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('neither tells nor plays a bridge no classification screened whose phrase is unsettled when the final transcript arrives', async () => {
    const { opening, synthesizeBridge } = setup()
    let settle!: (plan: BridgePlan | null) => void
    opening.begin({ ...input, bridge: { plan: new Promise((resolve) => (settle = resolve)), screened: false } })
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
    settle(plan)
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
  })

  it('hands over and plays a bridge no classification screened once its phrase is settled before the final transcript', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin({ ...input, bridge: { plan: Promise.resolve(plan), screened: false } })
    await flush()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenLastCalledWith({ text: '会議の件ですね。', audio: 'YQ==' }, 'bridge')
  })

  it('settles at once without a bridge for an utterance that may have none, so brain is never told one is coming', async () => {
    const { opening, play, synthesizeBridge } = setup(null)
    opening.begin({ ...input, classification: null, bridge: null })
    expect(opening.claim(10)).toEqual({ aizuchi: null, bridge: null, bridgePending: false })
    await flush()
    expect(play).not.toHaveBeenCalled()
    expect(synthesizeBridge).not.toHaveBeenCalled()
  })

  it('leaves the bridge unplayed and records it as late when the body of the reply was queued first', async () => {
    const { opening, play, resolvers, bodyQueued, onBridgeOutcome } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    bodyQueued.after = true
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenCalledTimes(1)
    expect(onBridgeOutcome).toHaveBeenCalledWith({ bridge: 'late' })
  })

  it('records the bridge as failed when its synthesis throws', async () => {
    const { opening, rejecters, onBridgeOutcome } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    opening.begin(input)
    await flush()
    rejecters[0](new Error('tts down'))
    await flush()
    expect(onBridgeOutcome).toHaveBeenCalledWith({ bridge: 'failed' })
    vi.restoreAllMocks()
  })

  it('asks for no bridge and hands over the aizuchi alone when the lookahead carries no bridge text', async () => {
    const { opening, synthesizeBridge } = setup()
    opening.begin({ ...input, bridge: { plan: Promise.resolve({ bridge: '' }), screened: true } })
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('turns the real start of a clip into the delay since the speech ended and the length of the clip, per role', async () => {
    const { opening } = setup()
    opening.begin(input)
    expect(opening.clipStarted('aizuchi', 640.4, 1250)).toEqual({ aizuchiMs: 250, aizuchiClipMs: 640 })
    expect(opening.clipStarted('listening', 500, 1300)).toBeNull()
    await flush()
    opening.claim(10)
    expect(opening.clipStarted('bridge', 900, 2100)).toEqual({ bridgeMs: 1100, bridgeClipMs: 900, bridge: 'played' })
  })

  it('plays no aizuchi right after a listening aizuchi, while still asking for the bridge', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge } = setup()
    opening.begin({ ...input, sinceListeningMs: 1500 })
    await flush()
    expect(pickAizuchi).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
    expect(synthesizeBridge).toHaveBeenCalledOnce()
    expect(opening.claim(10)).toEqual({ aizuchi: null, bridge: '会議の件ですね。', bridgePending: false })
  })

  it('hands nothing to the transcript of another utterance, is replaced when the next utterance starts, and never plays the old bridge', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    expect(opening.claim(99)).toBeNull()
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play.mock.calls.filter(([, role]) => role === 'bridge')).toHaveLength(0)
    expect(opening.claim(10)).toBeNull()
    expect(opening.claim(20)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
  })

  it('drops the recorded opening when the transcript is discarded as an echo, and ignores a cancel for another utterance', () => {
    const { opening } = setup()
    opening.begin(input)
    opening.cancel(99)
    expect(opening.clipStarted('aizuchi', 600, 1200)).not.toBeNull()
    opening.cancel(10)
    expect(opening.clipStarted('aizuchi', 600, 1200)).toBeNull()
    expect(opening.claim(10)).toBeNull()
  })

  it('plays no bridge that finishes synthesizing after the user talked over the claimed turn', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    opening.interrupt()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play.mock.calls.filter(([, role]) => role === 'bridge')).toHaveLength(0)
  })

  it('withdraws its bridge when the claimed turn ends without a word, whether the bridge waits to play or is still being synthesized', async () => {
    const { opening, resolvers, waiting } = setup()
    const bridge = { text: '会議の件ですね。', audio: 'YQ==' }
    opening.begin(input)
    await flush()
    opening.claim(10)
    resolvers[0](bridge)
    await flush()
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi', 'bridge'])
    opening.withdraw()
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi'])

    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    opening.claim(20)
    opening.withdraw()
    resolvers[1](bridge)
    await flush()
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi', 'aizuchi'])
  })

  it('withdraws the bridge of a speech that yields no turn, and keeps it for a cancel of another utterance', async () => {
    const { opening, resolvers, waiting } = setup()
    opening.begin(input)
    await flush()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    opening.cancel(99)
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi', 'bridge'])
    opening.cancel(10)
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi'])
  })

  it('withdraws only the bridge of the speech that is cancelled, not the one the turn before still waits to play', async () => {
    const { opening, resolvers, waiting } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    resolvers[1]({ text: '明日の件ですね。', audio: 'Yg==' })
    await flush()
    opening.cancel(20)
    expect(waiting.filter((waitingClip) => waitingClip.clip === 'bridge').map((waitingClip) => waitingClip.text)).toEqual(['会議の件ですね。'])
  })
})
