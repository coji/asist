import { z } from 'zod'
import { LLM_PROVIDERS, type LlmProvider } from './llm-catalog'

/**
 * The paid API use, summed per local day. Each item keeps what was used and what it cost at the price
 * of the moment it was used, so a later change of the price list does not rewrite past days. Speech
 * recognition and speech synthesis run on this Mac and never appear here; with a live engine they are
 * part of the live engine's price.
 */

/**
 * The live engines a record can name: Gemini Live, and GPT-Live, which is no longer offered but whose
 * days keep their cost.
 */
const USAGE_LIVE_ENGINES = ['gpt-live', 'gemini-live'] as const
type UsageLiveEngine = (typeof USAGE_LIVE_ENGINES)[number]

/** What a conversation model call was for. */
export const LLM_PURPOSES = ['conversation', 'bridge', 'summary'] as const
export type LlmPurpose = (typeof LLM_PURPOSES)[number]

export type UsageItem =
  | {
      kind: 'llm'
      purpose: LlmPurpose
      provider: LlmProvider
      model: string
      calls: number
      input: number
      cacheRead: number
      cacheCreation: number
      output: number
      webSearches: number
      /**
       * Who paid for the calls: the API key's account, or the ChatGPT plan of the account signed in with
       * ChatGPT, which bills no tokens.
       */
      billing: UsageBilling
      /**
       * Null for calls paid from the ChatGPT plan, and for a model the price list does not have; such calls are
       * summed apart from the priced ones.
       */
      costUsd: number | null
    }
  | { kind: 'live'; engine: UsageLiveEngine; model: string; seconds: number; costUsd: number }
  /** The cost the agent CLI reports for a job. Only Claude Code reports one. */
  | { kind: 'agent'; engine: 'claude'; jobs: number; costUsd: number }

export const USAGE_BILLINGS = ['api', 'chatgpt-plan'] as const
export type UsageBilling = (typeof USAGE_BILLINGS)[number]

export type UsageKind = UsageItem['kind']

export interface UsageDay {
  /** The local date, YYYY-MM-DD. */
  date: string
  items: UsageItem[]
}

const count = z.number().nonnegative()
const usageItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('llm'),
    purpose: z.enum(LLM_PURPOSES),
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().min(1),
    calls: count,
    input: count,
    cacheRead: count,
    cacheCreation: count,
    output: count,
    webSearches: count,
    billing: z.enum(USAGE_BILLINGS),
    costUsd: count.nullable()
  }),
  z.strictObject({ kind: z.literal('live'), engine: z.enum(USAGE_LIVE_ENGINES), model: z.string().min(1), seconds: count, costUsd: count }),
  z.strictObject({ kind: z.literal('agent'), engine: z.literal('claude'), jobs: count, costUsd: count })
])

export const usageDaysSchema = z.array(z.strictObject({ date: z.iso.date(), items: z.array(usageItemSchema) }))

/** The identity under which items of one day are summed. */
export function usageItemKey(item: UsageItem): string {
  switch (item.kind) {
    case 'llm':
      return ['llm', item.purpose, item.provider, item.model, item.billing === 'chatgpt-plan' ? 'plan' : item.costUsd === null ? 'unpriced' : 'priced'].join('|')
    case 'live':
      return ['live', item.engine, item.model].join('|')
    case 'agent':
      return ['agent', item.engine].join('|')
  }
}

function mergeItems(a: UsageItem, b: UsageItem): UsageItem {
  if (a.kind === 'llm' && b.kind === 'llm') {
    return {
      ...a,
      calls: a.calls + b.calls,
      input: a.input + b.input,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheCreation: a.cacheCreation + b.cacheCreation,
      output: a.output + b.output,
      webSearches: a.webSearches + b.webSearches,
      costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd
    }
  }
  if (a.kind === 'live' && b.kind === 'live') return { ...a, seconds: a.seconds + b.seconds, costUsd: a.costUsd + b.costUsd }
  if (a.kind === 'agent' && b.kind === 'agent') return { ...a, jobs: a.jobs + b.jobs, costUsd: a.costUsd + b.costUsd }
  throw new Error(`usage items of different kinds cannot be merged: ${a.kind} and ${b.kind}`)
}

/** Adds one item to the day it belongs to, keeping the days in date order. The input is not changed. */
export function addUsage(days: readonly UsageDay[], date: string, item: UsageItem): UsageDay[] {
  const index = days.findIndex((day) => day.date === date)
  if (index === -1) return [...days, { date, items: [item] }].sort((a, b) => a.date.localeCompare(b.date))
  const day = days[index]
  const key = usageItemKey(item)
  const at = day.items.findIndex((existing) => usageItemKey(existing) === key)
  const items = at === -1 ? [...day.items, item] : day.items.map((existing, i) => (i === at ? mergeItems(existing, item) : existing))
  return days.map((d, i) => (i === index ? { date, items } : d))
}

/** The local date of a moment, YYYY-MM-DD, which is the day a use is counted on. */
export function localDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
