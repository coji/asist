import { addUsage, localDate, type UsageDay, type UsageItem } from '@shared/api-usage'
import { llmCost } from '@shared/api-pricing'
import { geminiLiveCost } from '@shared/voice-engine'

/**
 * Ninety days of API use ending today, for the costs page. The numbers come from a fixed seed so the
 * screen looks the same on every run: weekdays are busier than weekends, the conversation moved from
 * Claude Sonnet 5 to GPT-5.6 Terra five weeks ago, Gemini Live was tried for about two weeks, and Claude
 * Code jobs run a few times a week.
 */

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

function llm(
  purpose: 'conversation' | 'bridge' | 'summary',
  provider: 'anthropic' | 'openai',
  model: string,
  calls: number,
  perCall: { input: number; cacheRead: number; cacheCreation: number; output: number },
  webSearches = 0
): UsageItem {
  const usage = {
    input: perCall.input * calls,
    cacheRead: perCall.cacheRead * calls,
    cacheCreation: perCall.cacheCreation * calls,
    output: perCall.output * calls,
    webSearches
  }
  return { kind: 'llm', purpose, provider, model, calls, ...usage, billing: 'api', costUsd: llmCost({ provider, id: model }, usage) }
}

export function demoUsageDays(today = new Date()): UsageDay[] {
  const random = seeded(20260923)
  let days: UsageDay[] = []
  for (let back = 89; back >= 0; back--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
    const weekend = date.getDay() === 0 || date.getDay() === 6
    const activity = (weekend ? 0.35 : 1) * (0.6 + random() * 0.8)
    const turns = Math.round(40 * activity)
    if (turns === 0) continue
    const day = localDate(date)
    const add = (item: UsageItem): void => {
      days = addUsage(days, day, item)
    }
    const onTerra = back < 35
    const conversation = onTerra
      ? llm('conversation', 'openai', 'gpt-5.6-terra', turns, { input: 900, cacheRead: 14_000, cacheCreation: 600, output: 220 }, Math.round(turns * 0.08))
      : llm('conversation', 'anthropic', 'claude-sonnet-5', turns, { input: 700, cacheRead: 15_000, cacheCreation: 1_100, output: 240 }, Math.round(turns * 0.08))
    add(conversation)
    add(
      onTerra
        ? llm('bridge', 'openai', 'gpt-5.6-luna', turns * 3, { input: 380, cacheRead: 0, cacheCreation: 0, output: 30 })
        : llm('bridge', 'anthropic', 'claude-haiku-4-5', turns * 3, { input: 380, cacheRead: 0, cacheCreation: 0, output: 30 })
    )
    if (turns > 25) {
      add(
        onTerra
          ? llm('summary', 'openai', 'gpt-5.6-terra', 1, { input: 18_000, cacheRead: 0, cacheCreation: 0, output: 2_400 })
          : llm('summary', 'anthropic', 'claude-sonnet-5', 1, { input: 18_000, cacheRead: 0, cacheCreation: 0, output: 2_400 })
      )
    }
    if (back >= 50 && back < 64 && !weekend) {
      const seconds = Math.round(600 + random() * 1_800)
      add({ kind: 'live', engine: 'gemini-live', model: 'gemini-3.8-live', seconds, costUsd: geminiLiveCost(seconds, seconds * 0.4) })
    }
    if (!weekend && random() < 0.45) {
      const jobs = 1 + Math.floor(random() * 3)
      add({ kind: 'agent', engine: 'claude', jobs, costUsd: jobs * (0.15 + random() * 0.9) })
    }
  }
  return days
}
