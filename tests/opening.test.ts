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
  aizuchi: true,
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
  /** Whether the player sounds, as the aizuchi does right after the speech ends. */
  const player = { sounding: false }
  const measure = vi.fn()
  const bridgeEnded = vi.fn()
  const opening = new TurnOpening({
    pickAizuchi,
    play,
    synthesizeBridge,
    bodyQueuedAfter: () => bodyQueued.after,
    measure,
    bridgeEnded,
    sounding: () => player.sounding,
    withdrawBridge: (queued) => {
      waiting.splice(0, waiting.length, ...waiting.filter((waitingClip) => waitingClip !== queued))
    }
  })
  return { opening, play, pickAizuchi, synthesizeBridge, resolvers, rejecters, bodyQueued, measure, bridgeEnded, waiting, player }
}

/** The clips handed to the player, in order. */
const queued = (play: ReturnType<typeof setup>['play']): SpeechSegment[] => play.mock.results.map((result) => result.value as SpeechSegment)
const bridgesOf = (segments: SpeechSegment[]): string[] => segments.filter((segment) => segment.clip === 'bridge').map((segment) => segment.text)

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

  it('gives up a bridge no classification screened whose phrase is unsettled when the final transcript arrives, and reports it as unsettled', async () => {
    const { opening, synthesizeBridge, measure, bridgeEnded } = setup()
    let settle!: (plan: BridgePlan | null) => void
    opening.begin({ ...input, bridge: { plan: new Promise((resolve) => (settle = resolve)), screened: false } })
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
    expect(measure).toHaveBeenCalledWith(10, { bridge: 'unsettled' })
    expect(bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'unsettled' })
    settle(plan)
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(bridgeEnded).toHaveBeenCalledOnce()
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

  it('leaves the bridge unplayed and reports it as late when the body of the reply was queued first', async () => {
    const { opening, play, resolvers, bodyQueued, measure, bridgeEnded } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    bodyQueued.after = true
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenCalledTimes(1)
    expect(measure).toHaveBeenCalledWith(10, { bridge: 'late' })
    expect(bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'late' })
  })

  it('hands brain no bridge that was left out as late before the final transcript', async () => {
    const { opening, resolvers, bodyQueued, measure } = setup()
    // The answer to the turn before was queued after this speech ended.
    bodyQueued.after = true
    opening.begin(input)
    await flush()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(measure).toHaveBeenCalledWith(10, { bridge: 'late' })
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('hands brain no bridge whose synthesis failed before the final transcript', async () => {
    const { opening, rejecters, measure } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    opening.begin(input)
    await flush()
    rejecters[0](new Error('tts down'))
    await flush()
    expect(measure).toHaveBeenCalledWith(10, { bridge: 'failed' })
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
    vi.restoreAllMocks()
  })

  it('reports a bridge brain was told is coming as failed when the look-ahead fails, and as declined when it answers with no phrase', async () => {
    const failing = setup()
    let fail!: (error: Error) => void
    failing.opening.begin({ ...input, bridge: { plan: new Promise((_resolve, reject) => (fail = reject)), screened: true } })
    expect(failing.opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: true })
    fail(new Error('quota exceeded'))
    await flush()
    expect(failing.measure).toHaveBeenCalledWith(10, { bridge: 'failed' })
    expect(failing.bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'failed' })

    const declining = setup()
    let settle!: (plan: BridgePlan | null) => void
    declining.opening.begin({ ...input, bridge: { plan: new Promise((resolve) => (settle = resolve)), screened: true } })
    expect(declining.opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: true })
    settle({ bridge: '' })
    await flush()
    expect(declining.synthesizeBridge).not.toHaveBeenCalled()
    expect(declining.measure).toHaveBeenCalledWith(10, { bridge: 'declined' })
    expect(declining.bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'declined' })
  })

  it('reports the bridge as failed when its synthesis throws', async () => {
    const { opening, rejecters, measure, bridgeEnded } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    opening.begin(input)
    await flush()
    rejecters[0](new Error('tts down'))
    await flush()
    expect(measure).toHaveBeenCalledWith(10, { bridge: 'failed' })
    expect(bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'failed' })
    vi.restoreAllMocks()
  })

  it('asks for no bridge and hands over the aizuchi alone when the lookahead carries no bridge text', async () => {
    const { opening, synthesizeBridge } = setup()
    opening.begin({ ...input, bridge: { plan: Promise.resolve({ bridge: '' }), screened: true } })
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('turns the real start of a clip into the delay since its speech ended and the length of the clip, per role', async () => {
    const { opening, play, measure, resolvers } = setup()
    opening.begin(input)
    opening.clipStarted(queued(play)[0], 640.4, 1250)
    expect(measure).toHaveBeenLastCalledWith(10, { aizuchiMs: 250, aizuchiClipMs: 640 })
    // A listening aizuchi belongs to no opening.
    opening.clipStarted({ turnId: 1, index: -1, text: 'うん', audio: 'eA==', phonemes: null, clip: 'listening' }, 500, 1300)
    expect(measure).toHaveBeenCalledOnce()
    await flush()
    opening.claim(10)
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    opening.clipStarted(queued(play)[1], 900, 2100)
    expect(measure).toHaveBeenLastCalledWith(10, { bridgeMs: 1100, bridgeClipMs: 900, bridge: 'played' })
  })

  it('reports the phrase of a bridge as played only once it starts sounding, not when it is queued', async () => {
    const { opening, play, resolvers, bridgeEnded } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(bridgesOf(queued(play))).toEqual(['会議の件ですね。'])
    expect(bridgeEnded).not.toHaveBeenCalled()
    opening.clipStarted(queued(play)[1], 900, 2100)
    expect(bridgeEnded).toHaveBeenCalledWith(10, { outcome: 'played', text: '会議の件ですね。' })
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

  it('hands nothing to the transcript of another utterance, holds a bridge while a newer speech waits for its transcript, and ends it once that speech becomes a turn', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    expect(opening.claim(99)).toBeNull()
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(bridgesOf(queued(play))).toEqual([])
    // The older transcript comes first, and its turn may still go on should the newer speech come to nothing.
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
    expect(opening.claim(20)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
    resolvers[1]({ text: '明日の件ですね。', audio: 'Yg==' })
    await flush()
    expect(bridgesOf(queued(play))).toEqual(['明日の件ですね。'])
  })

  it('plays a bridge it held for a newer speech once that speech yields no turn', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(bridgesOf(queued(play))).toEqual([])
    opening.cancel(20)
    expect(bridgesOf(queued(play))).toEqual(['会議の件ですね。'])
  })

  it('starts no bridge while a capture opened in silence is open, and plays it once that capture ends without speech', async () => {
    const { opening, resolvers, waiting } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    opening.captureStarted()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(bridgesOf(waiting)).toEqual([])
    opening.captureEnded()
    expect(bridgesOf(waiting)).toEqual(['会議の件ですね。'])
  })

  it('leaves a capture opened over the aizuchi to the barge-in judgement: the bridge queued behind it stays, and one synthesized meanwhile joins it', async () => {
    const { opening, resolvers, waiting, player } = setup()
    opening.begin(input)
    player.sounding = true
    await flush()
    opening.claim(10)
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    opening.captureStarted()
    expect(waiting.map((waitingClip) => waitingClip.clip)).toEqual(['aizuchi', 'bridge'])

    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    opening.claim(20)
    opening.captureStarted()
    resolvers[1]({ text: '明日の件ですね。', audio: 'Yg==' })
    await flush()
    expect(bridgesOf(waiting)).toEqual(['明日の件ですね。'])
  })

  it('starts no bridge over a capture opened over the aizuchi once the aizuchi has ended, and lets the speech that capture ends in hold none back', async () => {
    const { opening, resolvers, waiting, player } = setup()
    opening.begin(input)
    player.sounding = true
    await flush()
    opening.claim(10)
    opening.captureStarted()
    player.sounding = false
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(bridgesOf(waiting)).toEqual([])
    // The echo of the aizuchi ends in speech of its own, whose transcript the bridge does not wait for.
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    expect(bridgesOf(waiting)).toEqual(['会議の件ですね。'])
  })

  it('drops the recorded opening when the transcript is discarded as an echo, and ignores a cancel for another utterance', () => {
    const { opening, play, measure } = setup()
    opening.begin(input)
    const aizuchi = queued(play)[0]
    opening.cancel(99)
    opening.clipStarted(aizuchi, 600, 1200)
    expect(measure).toHaveBeenCalledOnce()
    opening.cancel(10)
    opening.clipStarted(aizuchi, 600, 1200)
    expect(measure).toHaveBeenCalledOnce()
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
