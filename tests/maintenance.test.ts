import { describe, expect, it, vi } from 'vitest'
import type { ConversationRecord } from '../src/main/services/brain/conversation-log'

/** The idle compaction, run against a real history whose log is on disk but has not been read yet. */

vi.mock('../src/main/services/brain/session', async () => {
  const { ConversationHistory } = await import('../src/main/services/brain/history')
  const long = 'あ'.repeat(1_000)
  const records: ConversationRecord[] = [1, 2].flatMap((turnId): ConversationRecord[] => [
    { t: turnId * 2, kind: 'user', turnId, text: long },
    { t: turnId * 2 + 1, kind: 'assistant', turnId, text: long }
  ])
  const history = new ConversationHistory({
    recentTurns: 0,
    compressAtTokens: 300,
    limitTokens: 600,
    hardLimitTokens: 900,
    load: () => records,
    saveCheckpoint: () => {},
    summarize: async () => '要約',
    locale: () => 'ja-JP'
  })
  return { history, lastActivity: () => null, turnScheduler: { activeTurnId: null } }
})

describe('the idle compaction', () => {
  it('sees a log over the limit that no turn has read since the app started', async () => {
    const { compactionJob } = await import('../src/main/services/maintenance')
    expect(compactionJob.due!()).toBe(true)
  })
})

describe('the maintenance loop', () => {
  it('goes on to the next job when a due check throws', async () => {
    const { initMaintenance } = await import('../src/main/services/maintenance')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn(async () => {})
    const stop = initMaintenance([
      { name: 'broken', conditions: { quietMs: 0 }, due: () => { throw new Error('log unreadable') }, run: async () => {} },
      { name: 'next', conditions: { quietMs: 0 }, run }
    ])
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    stop()
    error.mockRestore()
  })
})
