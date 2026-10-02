import type { ConversationLocale } from './conversation-locale'
import { journalHeading, marker } from './conversation-markers'
import type { MemoryUnit } from './ipc'
import { estimateTokens } from './token-estimate'
import type { ToolExecution } from './tool-registry'

/**
 * Prefetched injection. At the start of a turn the confirmed transcription searches memory, and the
 * units it hits become a note on the user's utterance. The note stays on the user record, in `notes`
 * and `memoryIds`, and is appended after the text in the history as well, so that what the model read
 * and what the history holds agree.
 *
 * A unit whose body the memory block, made of instruction.md, me.md and user.md, already holds is skipped, and so is a unit
 * already shown in the recent history that is sent unsummarized, whether it appeared in an earlier
 * note or in the result of recall.
 *
 * The note starts with the memory marker and then lists the hit units grouped by page, as markdown,
 * without collapsing the bodies:
 *   # page name       a heading unit is "## heading" followed by the body, exactly as in the file
 *   # journal of a    the heading and the body of the journal ASIST wrote in the first person that
 *   day              day; journals have a budget of their own, separate from headings
 * How certain something is comes across in the wording of the body: what the user said is stated
 * plainly, an inference is hedged. The format and how to treat it are explained in the stable layer of
 * the system prompt, in prompt.ts's memory section, and are not repeated every turn.
 */

export type InjectableMemory = Pick<MemoryUnit, 'id' | 'kind' | 'page' | 'heading' | 'text' | 'date'>

export interface MemoryInjectionOptions {
  /** The language of the conversation, which decides the marker the note starts with. */
  locale: ConversationLocale
  /** The memory block already in the system prompt. A body it contains is left out of the note. */
  memoryBlock?: string | null
  /** The ids of units already shown in the recent history that is sent unsummarized. */
  excludeIds?: ReadonlySet<string>
  /** How many heading units from pages the note may carry. */
  maxFacts?: number
  /** How many journal entries the note may carry. */
  maxEpisodes?: number
  /** The length limit of the whole note, in characters. */
  maxChars?: number
}

export interface MemoryInjection {
  text: string
  count: number
  tokens: number
  /**
   * The ids of the units the note carries. They stay on the user record and decide what counts as
   * already recalled later.
   */
  ids: string[]
}

export function injectionPageOf(locale: ConversationLocale, unit: InjectableMemory): string {
  if (unit.kind === 'journal') return journalHeading(locale, unit.date)
  return `# ${unit.page}`
}

/** The unit's body, kept in the shape it has in the file. */
export function injectionBodyOf(unit: InjectableMemory): string {
  return `## ${unit.heading}\n${unit.text.trim()}`
}

export function buildMemoryInjection(
  hits: readonly InjectableMemory[],
  options: MemoryInjectionOptions
): MemoryInjection | null {
  const header = marker(options.locale, 'memory')
  const maxFacts = options.maxFacts ?? 4
  const maxEpisodes = options.maxEpisodes ?? 2
  const maxChars = options.maxChars ?? 3000
  const block = options.memoryBlock ?? ''
  const pages = new Map<string, string[]>()
  const ids: string[] = []
  let facts = 0
  let episodes = 0
  let chars = header.length
  // The search has already decided what is relevant. This loop only watches duplication and volume.
  for (const hit of hits) {
    if (options.excludeIds?.has(hit.id)) continue
    if (hit.text.trim() && block.includes(hit.text.trim())) continue
    const isEpisode = hit.kind === 'journal'
    if (isEpisode ? episodes >= maxEpisodes : facts >= maxFacts) continue
    const body = injectionBodyOf(hit)
    if (!body) continue
    const page = injectionPageOf(options.locale, hit)
    const cost = body.length + 2 + (pages.has(page) ? 0 : page.length + 2)
    if (chars + cost > maxChars) break
    const bodies = pages.get(page) ?? []
    bodies.push(body)
    pages.set(page, bodies)
    ids.push(hit.id)
    chars += cost
    if (isEpisode) episodes++
    else facts++
  }
  if (ids.length === 0) return null
  const sections = [...pages.entries()].map(([page, bodies]) =>
    `${page}\n\n${bodies.join('\n\n')}`
  )
  const text = `${header}\n${sections.join('\n\n')}`
  return { text, count: ids.length, tokens: estimateTokens(text), ids }
}

/**
 * The ids of the memories a tool's execution showed the model. Only recall shows any, as the ids of its
 * hits, and they are read from the result as the model read it, so a result shortened by count yields
 * only the hits that were left in. An error yields nothing.
 */
export function memoryIdsInToolResult(name: string, execution: Pick<ToolExecution, 'value'>): string[] {
  if (name !== 'recall') return []
  const items = (execution.value as Record<string, unknown> | null | undefined)?.hits
  if (!Array.isArray(items)) return []
  const ids: string[] = []
  for (const item of items) {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}
