import { describe, expect, it } from 'vitest'
import { llmCost } from '@shared/api-pricing'
import { addUsage, usageDaysSchema, type UsageDay, type UsageItem } from '@shared/api-usage'
import { MAX_SERIES, OTHER_SERIES, dateRange, usageReport } from '@shared/usage-report'

/** The price of a response, the daily sums of the usage record, and the chart and table drawn from them. */

const usage = (patch: Partial<Parameters<typeof llmCost>[1]> = {}) => ({ input: 0, cacheRead: 0, cacheCreation: 0, output: 0, webSearches: 0, ...patch })

const llm = (patch: Partial<Extract<UsageItem, { kind: 'llm' }>> = {}): UsageItem => ({
  kind: 'llm',
  purpose: 'conversation',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  calls: 1,
  input: 100,
  cacheRead: 0,
  cacheCreation: 0,
  output: 10,
  webSearches: 0,
  billing: 'api',
  costUsd: 0.01,
  ...patch
})

describe('the price of a response', () => {
  it('prices uncached input, cache reads, cache writes and output separately', () => {
    // Sonnet 5: $2 in, $0.20 cache read, $2.50 five-minute cache write, $10 out, per million tokens.
    const cost = llmCost({ provider: 'anthropic', id: 'claude-sonnet-5' }, usage({ input: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000, output: 1_000_000 }))
    expect(cost).toBeCloseTo(2 + 0.2 + 2.5 + 10)
  })

  it('prices the OpenAI cache writes apart from the input, as on every provider', () => {
    const cost = llmCost({ provider: 'openai', id: 'gpt-5.6-terra' }, usage({ input: 60_000, cacheCreation: 40_000 }))
    expect(cost).toBeCloseTo(0.06 * 2 + 0.04 * 2.5)
  })

  it('bills a whole OpenAI request at the long-context prices once its prompt passes 272K tokens', () => {
    const model = { provider: 'openai', id: 'gpt-5.6-luna' } as const
    expect(llmCost(model, usage({ input: 272_000, output: 1_000_000 }))).toBeCloseTo(0.272 * 0.2 + 1.2)
    expect(llmCost(model, usage({ input: 272_001, output: 1_000_000 }))).toBeCloseTo(0.272001 * 0.2 * 2 + 1.2 * 1.5)
    // The prompt is every token of it, wherever it was read from or written to.
    expect(llmCost(model, usage({ input: 72_000, cacheRead: 100_000, cacheCreation: 100_001 }))).toBeCloseTo((0.072 * 0.2 + 0.1 * 0.02 + 0.100001 * 0.25) * 2)
  })

  it('adds the fee of each web search to the tokens', () => {
    expect(llmCost({ provider: 'google', id: 'gemini-3.8-flash' }, usage({ webSearches: 2 }))).toBeCloseTo(0.028)
  })

  it('has no price for a model the list does not have', () => {
    expect(llmCost({ provider: 'openai', id: 'my-own-model' }, usage({ input: 10 }))).toBeNull()
  })
})

describe('the daily sums', () => {
  it('adds a use of the same model and purpose into the one item of that day', () => {
    const days = addUsage(addUsage([], '2026-09-23', llm({ costUsd: 0.25 })), '2026-09-23', llm({ calls: 2, input: 50, costUsd: 0.5 }))
    expect(days).toEqual([{ date: '2026-09-23', items: [llm({ calls: 3, input: 150, output: 20, costUsd: 0.75 })] }])
  })

  it('keeps unpriced calls apart, so a missing price never erases the cost of the priced ones', () => {
    const days = addUsage(addUsage([], '2026-09-23', llm()), '2026-09-23', llm({ costUsd: null }))
    expect(days[0].items.map((item) => item.costUsd)).toEqual([0.01, null])
  })

  it('keeps calls paid from the ChatGPT plan apart from unpriced API calls of the same model', () => {
    const plan = llm({ provider: 'openai', model: 'gpt-5.6-terra', billing: 'chatgpt-plan', costUsd: null })
    const days = addUsage(addUsage([], '2026-09-23', plan), '2026-09-23', llm({ provider: 'openai', model: 'gpt-5.6-terra', costUsd: null }))
    expect(days[0].items.map((item) => item.kind === 'llm' && item.billing)).toEqual(['chatgpt-plan', 'api'])
  })

  it('keeps the days in date order whatever order they arrive in', () => {
    let days: UsageDay[] = []
    for (const date of ['2026-09-23', '2026-09-21', '2026-09-22']) days = addUsage(days, date, llm())
    expect(days.map((day) => day.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23'])
  })

  it('rejects a record whose items are not of a known kind', () => {
    expect(() => usageDaysSchema.parse([{ date: '2026-09-23', items: [{ kind: 'image', costUsd: 1 }] }])).toThrow()
  })
})

describe('the report', () => {
  const days: UsageDay[] = [
    { date: '2026-08-01', items: [llm({ costUsd: 5 })] },
    { date: '2026-09-22', items: [llm({ costUsd: 1 }), { kind: 'agent', engine: 'claude', jobs: 1, costUsd: 0.5 }] },
    { date: '2026-09-23', items: [llm({ costUsd: 2 }), llm({ model: 'mine', costUsd: null })] }
  ]

  it('covers the days of the range up to the end date, across a month boundary', () => {
    expect(dateRange('2026-10-02', 4)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
  })

  it('stacks each day by kind and leaves days outside the range and unpriced calls out of the totals', () => {
    const report = usageReport(days, '2026-09-23', 7, 'kind')
    expect(report.totalUsd).toBeCloseTo(3.5)
    expect(report.series.map((s) => [s.id, s.values.slice(-2)])).toEqual([
      ['llm', [1, 2]],
      ['agent', [0.5, 0]]
    ])
    expect(report.lines.map((line) => [line.kind, line.costUsd])).toEqual([
      ['llm', 3],
      ['agent', 0.5],
      ['llm', null]
    ])
  })

  it('keeps the color of a series when the range changes the series that are shown', () => {
    const slotOf = (range: number) => usageReport(days, '2026-09-23', range, 'kind').series.find((s) => s.id === 'agent')?.slot
    expect(slotOf(7)).toBe(slotOf(90))
  })

  it('sums the models that appeared after the first seven into one series with the last color', () => {
    const many: UsageDay[] = [{ date: '2026-09-23', items: Array.from({ length: MAX_SERIES + 2 }, (_, i) => llm({ model: `m${i}`, costUsd: 1 })) }]
    const report = usageReport(many, '2026-09-23', 1, 'model')
    expect(report.series).toHaveLength(MAX_SERIES + 1)
    expect(report.series.at(-1)).toMatchObject({ id: OTHER_SERIES, slot: MAX_SERIES, total: 2 })
  })
})
