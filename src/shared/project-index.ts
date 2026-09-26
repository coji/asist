import { baseName, samePath, trimTrailingSeparator } from './file-path'
import { bigrams, matchRatio, normalizeForSearch } from './memory-search'

/**
 * The project index, which resolves a place named by voice from names, aliases and paths. It grows
 * only from actual use, meaning the working directory of past jobs and any place named explicitly
 * once, and from registrations made by saying "このフォルダ覚えて". Matching goes from a normalized
 * exact match to a substring match to a bigram overlap ratio, so that a name mangled by ASR, such as
 * "アシスト" for asist, still resolves.
 */

export interface ProjectEntry {
  /** The name used to refer to the project by voice. It defaults to the directory name. */
  name: string
  /** The absolute path. */
  path: string
  aliases: string[]
  /** When a job last used the project, or when it was registered. */
  lastUsedAt: number
  /** 'job' means the entry came from actual use, 'told' from the user saying "このフォルダ覚えて". */
  source: 'job' | 'told'
}

export interface ProjectCandidate {
  entry: ProjectEntry
  /** 1 is an exact match, 0.9 a substring match, and anything lower is the bigram overlap ratio. */
  score: number
}

/** The words an entry can be matched against: its name, its aliases and the directory name. */
function labelsOf(entry: ProjectEntry): string[] {
  return [entry.name, ...entry.aliases, baseName(entry.path)]
}

/** Returns the candidates best matching the query first, dropping those below the minimum ratio. */
export function matchProjects(
  entries: readonly ProjectEntry[],
  query: string,
  options: { limit?: number; minRatio?: number } = {}
): ProjectCandidate[] {
  const q = normalizeForSearch(query)
  if (!q) return []
  const grams = [...new Set(bigrams(query))]
  const minRatio = grams.length <= 2 ? 1 / Math.max(1, grams.length) : (options.minRatio ?? 0.5)
  const scored = entries
    .map((entry) => {
      let score = 0
      for (const label of labelsOf(entry)) {
        const l = normalizeForSearch(label)
        if (!l) continue
        if (l === q) score = Math.max(score, 1)
        else if (l.includes(q) || q.includes(l)) score = Math.max(score, 0.9)
        else score = Math.max(score, matchRatio(label, grams) * 0.8)
      }
      return { entry, score }
    })
    .filter((c) => c.score >= 0.9 || c.score / 0.8 >= minRatio - 1e-9)
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.lastUsedAt - a.entry.lastUsedAt)
  return scored.slice(0, options.limit ?? 3)
}

/**
 * Grows the index from use or from a registration. An entry with the same path, however a Windows path
 * spells its separators and letter case, keeps one set of names and aliases and moves its timestamp
 * forward. A name given by a registration becomes the entry's name, and the previous name becomes an
 * alias.
 */
export function upsertProject(
  entries: readonly ProjectEntry[],
  input: { path: string; name?: string; alias?: string; source: ProjectEntry['source']; now: number }
): ProjectEntry[] {
  const path = trimTrailingSeparator(input.path)
  const givenName = input.name?.trim() || undefined
  const existing = entries.find((e) => samePath(e.path, path))
  if (!existing) {
    const name = givenName ?? baseName(path)
    return [
      ...entries,
      {
        name,
        path,
        aliases: input.alias && input.alias !== name ? [input.alias] : [],
        lastUsedAt: input.now,
        source: input.source
      }
    ]
  }
  const rename = input.source === 'told' ? givenName : undefined
  const name = rename ?? existing.name
  const aliases = new Set(existing.aliases)
  if (rename && rename !== existing.name) aliases.add(existing.name)
  if (!rename && givenName) aliases.add(givenName)
  if (input.alias) aliases.add(input.alias)
  aliases.delete(name)
  return entries.map((e) =>
    e === existing
      ? {
          ...e,
          name,
          aliases: [...aliases],
          lastUsedAt: Math.max(e.lastUsedAt, input.now),
          source: input.source === 'told' ? 'told' : e.source
        }
      : e
  )
}

/** The recently used projects, for the block of the prompt that reports the state of the jobs. */
export function recentProjects(entries: readonly ProjectEntry[], limit = 5): ProjectEntry[] {
  return [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, limit)
}
