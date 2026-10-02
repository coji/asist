import { describe, expect, it, vi } from 'vitest'
import {
  bridgeAllowed,
  categoryOfClassification,
  nextClassification,
  normalizeForClassifier,
  parseAizuchiWorkerLine
} from '@shared/aizuchi-classifier'
import { AizuchiClassifierFeed } from '@/voice/aizuchi-classify'

describe('normalizeForClassifier', () => {
  it('drops punctuation, whitespace and brackets, and turns full-width letters and digits into half-width ones', () => {
    expect(normalizeForClassifier('明日って、雨だっけ？')).toBe('明日って雨だっけ')
    expect(normalizeForClassifier('まあ そうね。')).toBe('まあそうね')
    expect(normalizeForClassifier('ＰＫＳＨＡ(3993)の株価')).toBe('PKSHA3993の株価')
  })
})

describe('parseAizuchiWorkerLine', () => {
  it('parses result, ready and failure lines, and drops a line without the prefix or with an unknown class', () => {
    expect(parseAizuchiWorkerLine('ASIST_JSON:{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(
      parseAizuchiWorkerLine('ASIST_JSON:{"type":"result","id":"a","cls":"work","prob":0.93,"complete":0.1}')
    ).toEqual({ type: 'result', id: 'a', cls: 'work', prob: 0.93, complete: 0.1 })
    expect(parseAizuchiWorkerLine('ASIST_JSON:{"type":"error","id":"a","error":"text is empty"}')).toEqual({
      type: 'error',
      id: 'a',
      error: 'text is empty'
    })
    expect(parseAizuchiWorkerLine('ASIST_JSON:{"type":"fatal","error":"no model"}')).toEqual({
      type: 'fatal',
      error: 'no model'
    })
    expect(parseAizuchiWorkerLine('warning: something')).toBeNull()
    expect(parseAizuchiWorkerLine('ASIST_JSON:{"type":"result","id":"a","cls":"joke","prob":1,"complete":1}')).toBeNull()
    expect(parseAizuchiWorkerLine('ASIST_JSON:{not json')).toBeNull()
  })
})

describe('categoryOfClassification / bridgeAllowed', () => {
  it('plays nothing for a greeting, an unfinished sentence or a low probability, and otherwise uses the class as the category', () => {
    expect(categoryOfClassification(null)).toBeNull()
    expect(categoryOfClassification({ cls: 'none', prob: 0.99, complete: 1 })).toBeNull()
    expect(categoryOfClassification({ cls: 'hold', prob: 0.99, complete: 0 })).toBeNull()
    expect(categoryOfClassification({ cls: 'work', prob: 0.4, complete: 1 })).toBeNull()
    expect(categoryOfClassification({ cls: 'work', prob: 0.8, complete: 1 })).toBe('work')
    expect(categoryOfClassification({ cls: 'surprise', prob: 0.6, complete: 1 })).toBe('surprise')
  })
  it('allows no bridge after a plain reply, a correction, a greeting or an unfinished sentence', () => {
    expect(bridgeAllowed('work')).toBe(true)
    expect(bridgeAllowed('understand')).toBe(true)
    for (const cls of ['flow', 'correct', 'none', 'hold'] as const) expect(bridgeAllowed(cls)).toBe(false)
  })
})

describe('nextClassification', () => {
  it('updates the current class, and switches to another one only when it leads by enough or is very probable', () => {
    const work = { cls: 'work', prob: 0.7, complete: 0.2 } as const
    expect(nextClassification(null, work)).toEqual(work)
    expect(nextClassification(work, { cls: 'work', prob: 0.6, complete: 0.9 })).toEqual({
      cls: 'work',
      prob: 0.6,
      complete: 0.9
    })
    // With too small a lead the class stays and only `complete` comes from the latest partial transcript.
    expect(nextClassification(work, { cls: 'check', prob: 0.75, complete: 0.95 })).toEqual({
      cls: 'work',
      prob: 0.7,
      complete: 0.95
    })
    expect(nextClassification(work, { cls: 'check', prob: 0.9, complete: 0.95 })).toEqual({
      cls: 'check',
      prob: 0.9,
      complete: 0.95
    })
    expect(nextClassification({ cls: 'work', prob: 0.95, complete: 0 }, { cls: 'hold', prob: 0.92, complete: 0 }).cls).toBe(
      'hold'
    )
  })
})

describe('AizuchiClassifierFeed', () => {
  function setup() {
    const resolvers: Array<(r: { cls: 'work' | 'hold'; prob: number; complete: number }) => void> = []
    const classify = vi.fn(
      () =>
        new Promise<{ cls: 'work' | 'hold'; prob: number; complete: number }>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const onResult = vi.fn()
    const onFailure = vi.fn()
    const feed = new AizuchiClassifierFeed({ classify, running: async () => true, onResult, onFailure })
    return { feed, classify, resolvers, onResult, onFailure }
  }
  const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('sends one request at a time, keeps only the latest input while one is in flight, and skips input that is too short or unchanged', async () => {
    const { feed, classify, resolvers } = setup()
    feed.observe({ prev: '', text: 'あ' })
    expect(classify).not.toHaveBeenCalled()
    feed.observe({ prev: '', text: '明日の' })
    feed.observe({ prev: '', text: '明日の天気' })
    feed.observe({ prev: '', text: '明日の天気教えて' })
    feed.observe({ prev: '', text: '明日の天気教えて' })
    expect(classify).toHaveBeenCalledTimes(1)
    resolvers[0]({ cls: 'work', prob: 0.6, complete: 0.1 })
    await flush()
    expect(classify).toHaveBeenCalledTimes(2)
    expect(classify).toHaveBeenLastCalledWith({ prev: '', text: '明日の天気教えて' })
    expect(feed.current()).toEqual({ cls: 'work', prob: 0.6, complete: 0.1 })
  })

  it('classifies the first partial transcript of the next capture while a request of the previous capture is still in flight', async () => {
    const { feed, classify, resolvers } = setup()
    feed.observe({ prev: '', text: '昨日の会議で' })
    feed.reset()
    feed.observe({ prev: '', text: '明日の予定を教えて' })
    expect(classify).toHaveBeenLastCalledWith({ prev: '', text: '明日の予定を教えて' })

    resolvers[1]({ cls: 'work', prob: 0.9, complete: 0.9 })
    await flush()
    resolvers[0]({ cls: 'hold', prob: 0.99, complete: 0 })
    await flush()
    expect(feed.current()).toEqual({ cls: 'work', prob: 0.9, complete: 0.9 })
  })

  it('drops a stale result that arrives after a reset, and reports a hold through holding()', async () => {
    const { feed, resolvers, onResult } = setup()
    feed.observe({ prev: '', text: 'えっとね' })
    feed.reset()
    resolvers[0]({ cls: 'hold', prob: 0.99, complete: 0 })
    await flush()
    expect(feed.current()).toBeNull()
    expect(onResult).not.toHaveBeenCalled()
    feed.observe({ prev: '', text: 'えっとね昨日の' })
    resolvers[1]({ cls: 'hold', prob: 0.99, complete: 0 })
    await flush()
    expect(feed.holding()).toBe(true)
    expect(onResult).toHaveBeenCalledOnce()
  })

  it('takes the worker as running only from the newest answer of main, and as not running when asking fails', async () => {
    const answers: Array<{ resolve: (running: boolean) => void; reject: (error: Error) => void }> = []
    const onFailure = vi.fn()
    const feed = new AizuchiClassifierFeed({
      classify: vi.fn(),
      running: () => new Promise<boolean>((resolve, reject) => answers.push({ resolve, reject })),
      onResult: vi.fn(),
      onFailure
    })
    expect(feed.running).toBe(false)
    const older = feed.check()
    const newer = feed.check()
    answers[1].resolve(true)
    await newer
    answers[0].resolve(false)
    await older
    expect(feed.running).toBe(true)

    const failed = feed.check()
    answers[2].reject(new Error('no answer'))
    await failed
    expect(feed.running).toBe(false)
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
