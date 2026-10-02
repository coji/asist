import { describe, expect, it, vi } from 'vitest'
import type { BridgePlan } from '@shared/ipc'
import { BridgePlanner } from '@/voice/bridge-plan'

const plan = (bridge: string): BridgePlan => ({ bridge })

function setup() {
  const resolvers: Array<(plan: BridgePlan) => void> = []
  const rejecters: Array<(error: Error) => void> = []
  const request = vi.fn(
    () =>
      new Promise<BridgePlan>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
  )
  const onPlan = vi.fn()
  const onFailure = vi.fn()
  const planner = new BridgePlanner({ plan: request, onPlan, onFailure })
  return { planner, request, resolvers, rejecters, onPlan, onFailure }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BridgePlanner', () => {
  it('sends one request at a time and keeps only the latest partial transcript while a request is in flight', async () => {
    const { planner, request, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(1)
    resolvers[0](plan('会議の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('会議の件ですね。'))
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    resolvers[1](plan('予算の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('予算の件ですね。'))
  })

  it('sends nothing for a partial transcript that is too short or unchanged', () => {
    const { planner, request } = setup()
    planner.observe({ text: 'あの', lastAssistantText: '' })
    expect(request).not.toHaveBeenCalled()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で ', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('drops a stale result that arrives after a reset and reports no failure for it', async () => {
    const { planner, resolvers, rejecters, onPlan, onFailure } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    planner.reset()
    resolvers[0](plan('古い'))
    await flush()
    expect(planner.current()).toBeNull()
    expect(onPlan).not.toHaveBeenCalled()
    // The reset also drops the held input, so nothing is sent again.
    expect(rejecters).toHaveLength(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('waits at the end of an utterance for the request in flight and the held one, and returns the latest plan', async () => {
    const { planner, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    const settled = planner.finish({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    resolvers[0](plan('会議の件ですね。'))
    await flush()
    // The held request is sent again, so the wait continues.
    let done = false
    void settled.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    resolvers[1](plan('予算の件ですね。'))
    await expect(settled).resolves.toEqual(plan('予算の件ですね。'))
  })

  it('sends the last partial transcript at the end of an utterance when nothing is in flight, and returns null at once when there is nothing to send', async () => {
    const { planner, request, resolvers } = setup()
    const settled = planner.finish({ text: 'あの', lastAssistantText: '' })
    expect(request).toHaveBeenCalledWith({ text: 'あの', lastAssistantText: '' })
    resolvers[0](plan(''))
    await expect(settled).resolves.toEqual(plan(''))
    planner.reset()
    await expect(planner.finish({ text: '', lastAssistantText: '' })).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('still answers an end of utterance that waits when a new capture begins, without making that plan the latest', async () => {
    const { planner, resolvers, onPlan } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    const settled = planner.finish({ text: '昨日の会議で', lastAssistantText: '' })
    planner.reset()
    resolvers[0](plan('会議の件ですね。'))
    await expect(settled).resolves.toEqual(plan('会議の件ですね。'))
    expect(planner.current()).toBeNull()
    expect(onPlan).not.toHaveBeenCalled()
  })

  it('answers an end of utterance with the plan of its newest partial transcript, which still goes out after a new capture began', async () => {
    const { planner, request, resolvers } = setup()
    planner.observe({ text: '昨日の会', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議の件なんですけど', lastAssistantText: '' })
    const settled = planner.finish({ text: '昨日の会議の件なんですけど', lastAssistantText: '' })
    planner.reset()
    resolvers[0](plan('会の件ですね。'))
    await flush()
    expect(request).toHaveBeenLastCalledWith({ text: '昨日の会議の件なんですけど', lastAssistantText: '' })
    resolvers[1](plan('会議の件ですね。'))
    await expect(settled).resolves.toEqual(plan('会議の件ですね。'))
    expect(planner.current()).toBeNull()
  })

  it('plans the next capture on its first partial transcript while a request of the previous capture is still in flight', async () => {
    const { planner, request, resolvers, onPlan } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.reset()
    planner.observe({ text: '明日の予定を教えて', lastAssistantText: '' })
    const settled = planner.finish({ text: '明日の予定を教えて', lastAssistantText: '' })
    expect(request).toHaveBeenLastCalledWith({ text: '明日の予定を教えて', lastAssistantText: '' })

    // The stale plan returns first and is dropped; the new capture still waits for its own.
    resolvers[0](plan('古い'))
    await flush()
    expect(planner.current()).toBeNull()
    resolvers[1](plan('明日の予定ですね。'))
    await expect(settled).resolves.toEqual(plan('明日の予定ですね。'))
    expect(onPlan).toHaveBeenCalledOnce()
  })

  it('sends the last partial transcript at the end of an utterance whose capture has sent nothing, whatever the previous capture still runs', async () => {
    const { planner, request, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.reset()
    const settled = planner.finish({ text: 'あの件', lastAssistantText: '' })
    expect(request).toHaveBeenLastCalledWith({ text: 'あの件', lastAssistantText: '' })
    resolvers[1](plan('あの件ですね。'))
    await expect(settled).resolves.toEqual(plan('あの件ですね。'))
  })

  it('reports a failure and sends again on the next partial transcript', async () => {
    const { planner, request, rejecters, resolvers, onFailure } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    rejecters[0](new Error('timeout'))
    await flush()
    expect(onFailure).toHaveBeenCalledOnce()
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(2)
    resolvers[1](plan('予算の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('予算の件ですね。'))
  })
})
