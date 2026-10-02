import FORMAT from '../../resources/skills/memory-format.json'

/**
 * The rules of the memory's markdown: how a document is read into its frontmatter, its `# name` line and
 * its sections, what in it breaks the rules, and what a document that goes into every prompt costs there.
 * ASIST applies them when it indexes the memory, when the memory screen saves a document, before it merges
 * a curation and when it builds the prompt. The curation Agent checks its work with the same rules in
 * Python (resources/skills/memory_format.py), because its scripts run where neither Node nor a Python of the
 * user's may be; the values both read are in resources/skills/memory-format.json, and
 * tests/fixtures/memory-format-cases.json holds the cases both must answer the same, so that a file the
 * Agent's checks pass is never refused at the merge.
 */

export type DocumentKind = 'me' | 'user' | 'page' | 'journal'
export type PromptDocumentKind = 'me' | 'user'

export interface PageFrontmatter {
  present: boolean
  aliases: string[]
  /** Whether the frontmatter has an aliases key at all, even an empty one, which only a page may carry. */
  hasAliases: boolean
  updated: string | null
  /** The keys an earlier form of the memory used, kind and links, which a page may no longer carry. */
  obsoleteKeys: string[]
}

export interface PageSection {
  /** The heading's line number, counted from one. The text above the first heading reports its first line. */
  line: number
  heading: string
  text: string
}

export interface ParsedPage {
  title: string
  /** Whether the page has its own `# name` line. */
  titled: boolean
  frontmatter: PageFrontmatter
  /** The sections that carry text. */
  sections: PageSection[]
}

/** An amount of a document's own text. */
export interface TextAmount {
  /** Characters without whitespace. */
  characters: number
  words: number
}

export interface PromptSize extends TextAmount {
  tokens: number
}

export type DocumentIssue =
  | { kind: 'frontmatterMissing' }
  | { kind: 'frontmatterUnclosed' }
  | { kind: 'obsoleteKey'; key: string }
  | { kind: 'aliasesOnlyOnPages' }
  | { kind: 'updatedNotDate' }
  | { kind: 'titleMissing' }
  | { kind: 'noHeadings' }
  | { kind: 'duplicateHeading'; line: number; heading: string; first: number }
  | { kind: 'headingWithoutText'; line: number; heading: string }
  | { kind: 'sectionTooLong'; line: number; heading: string; length: number }
  | { kind: 'firstHeading'; heading: string }
  | { kind: 'tooManyTokens'; tokens: number; limit: number; cut: TextAmount }

export type PageNameIssue = 'characters' | 'reserved'

/** The heading every page opens with, and the one the text above a document's first `## ` heading is read as. */
export const SUMMARY_HEADING = FORMAT.summaryHeading as { readonly ja: string; readonly en: string }

/**
 * The documents that go whole into the system prompt of every turn, by kind, in the order they go there.
 * The pages and the journal are reached through search instead.
 */
export const PROMPT_DOCUMENTS = FORMAT.promptDocuments as ReadonlyArray<{ readonly kind: PromptDocumentKind; readonly file: string }>

/**
 * The most tokens, as tokenEstimate counts them, that each document of PROMPT_DOCUMENTS may cost. They ride
 * in every turn, so each is capped rather than left to grow with every curation.
 */
export const PROMPT_DOCUMENT_MAX_TOKENS: number = FORMAT.promptDocumentMaxTokens

/**
 * The longest a section of a page or a journal entry may be, in characters without whitespace. A section is
 * what one search hit carries into a turn.
 */
export const SECTION_MAX_CHARS: number = FORMAT.sectionMaxChars

const within = (ranges: number[][], codePoint: number): boolean => ranges.some(([from, to]) => codePoint >= from && codePoint <= to)

/**
 * Whitespace as JavaScript's \s and trim read it, written out in memory-format.json so that the Python of the
 * curation, whose \s also takes a few control characters, reads the same characters as space.
 */
const isSpace = (codePoint: number): boolean => within(FORMAT.whitespace, codePoint)

/** The length the section cap is measured in: characters, with the whitespace left out. */
const capLength = (text: string): number => Array.from(text).filter((character) => !isSpace(character.codePointAt(0)!)).length

/**
 * The tokens a character is taken to cost, by the script it belongs to, from the first class of
 * memory-format.json that holds it. Measured on 2026-10-02 over 82 texts in the eleven conversation
 * languages (the app's dictionary and documentation, memory written for the purpose) and three real memory
 * files, against o200k_base (OpenAI, gpt-oss) and the countTokens of Gemini 3.8 Flash: the estimate came to
 * 0.94 to 1.13 times o200k for Japanese, which costs more there than in Gemini (0.8 times o200k), 0.97 to
 * 1.13 for Korean, 0.95 to 1.19 for Hindi, 0.94 to 1.21 for the other languages written in Latin letters and
 * 1.07 to 1.27 for English, and to no less than 0.94 times Gemini in any language. Qwen3's tokenizer counts
 * Hindi 2.4 times this estimate. Claude's tokenizer could not be measured. A byte count, the other light
 * estimate, gave 1.5 to 2 times what o200k counts for Hindi.
 */
function characterTokens(codePoint: number): number {
  for (const { name, weight, ranges } of FORMAT.tokenWeights) {
    if (name === 'whitespace' ? isSpace(codePoint) : within(ranges!, codePoint)) return weight
  }
  return FORMAT.otherWeight
}

/**
 * The tokens a conversation model is estimated to read for the text. It needs nothing to download, which a
 * real tokenizer would, and it errs on the side of more tokens in every language measured.
 */
export function tokenEstimate(text: string): number {
  let tokens = 0
  for (const character of text) tokens += characterTokens(character.codePointAt(0)!)
  return Math.ceil(tokens)
}

/**
 * Whether a piece of memory is written in Japanese. Kana decide it: of the eleven languages a
 * conversation can be held in, only Japanese writes them, and Japanese prose always contains them.
 */
export const writtenInJapanese = (text: string): boolean => /[ぁ-ヿ]/.test(text)

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Whether a journal entry's file name, without .md, is the date it stands for. */
export const isJournalName = (name: string): boolean => DATE.test(name)

const OBSOLETE_KEYS = new Set(['kind', 'links'])
const unquote = (text: string): string => text.trim().replace(/^["']|["']$/g, '')

/**
 * Reads the frontmatter, the `key: value` lines fenced by `---`, and the line the body starts on. A list
 * is read as `[a, b]` on one line and as `- a` lines under its key, indented or not: the Agent writes the
 * first two, and a YAML library writes the items at the key's own indentation.
 */
function parseFrontmatter(lines: string[]): { frontmatter: PageFrontmatter; bodyStart: number; unclosed: boolean } {
  const frontmatter: PageFrontmatter = { present: false, aliases: [], hasAliases: false, updated: null, obsoleteKeys: [] }
  if (lines[0]?.trim() !== '---') return { frontmatter, bodyStart: 0, unclosed: false }
  frontmatter.present = true
  // The items of a list follow its key on lines of their own; those of an obsolete key are skipped.
  let listKey: 'aliases' | 'skip' | null = null
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '---') return { frontmatter, bodyStart: i + 1, unclosed: false }
    const item = /^\s*-\s*(.+)$/.exec(raw)
    if (item && listKey) {
      if (listKey === 'aliases') frontmatter.aliases.push(unquote(item[1]))
      continue
    }
    const match = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw)
    if (!match) continue
    const [, key, value] = match
    listKey = null
    if (OBSOLETE_KEYS.has(key)) {
      frontmatter.obsoleteKeys.push(key)
      if (!value.trim()) listKey = 'skip'
    } else if (key === 'updated') frontmatter.updated = value.trim() || null
    else if (key === 'aliases') {
      frontmatter.hasAliases = true
      frontmatter.aliases = value.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map(unquote).filter(Boolean)
      if (!value.trim()) listKey = 'aliases'
    }
  }
  return { frontmatter, bodyStart: lines.length, unclosed: true }
}

interface Body {
  frontmatter: PageFrontmatter
  unclosed: boolean
  title: string | null
  headed: boolean
  sections: PageSection[]
}

/**
 * Splits a document into its frontmatter, its `# ` line and its sections, empty ones included. A section is
 * a `## ` heading and the text under it. The text above the first heading is a section too, under the
 * summary heading in the form the document is written in, which is how a short page or a me.md written as
 * prose is read.
 */
function readBody(markdown: string): Body {
  const lines = markdown.split(/\r?\n/)
  const { frontmatter, bodyStart, unclosed } = parseFrontmatter(lines)
  let title: string | null = null
  let headed = false
  const sections: PageSection[] = []
  let current: PageSection | null = null
  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i]
    if (/^# /.test(raw)) {
      title = raw.slice(2).trim()
      continue
    }
    if (/^## /.test(raw)) {
      headed = true
      current = { line: i + 1, heading: raw.slice(3).trim(), text: '' }
      sections.push(current)
      continue
    }
    if (!raw.trim()) continue
    if (!current) {
      current = { line: i + 1, heading: summaryFor(markdown), text: '' }
      sections.push(current)
    }
    current.text = current.text ? `${current.text}\n${raw.trimEnd()}` : raw.trimEnd()
  }
  return { frontmatter, unclosed, title, headed, sections }
}

const summaryFor = (markdown: string): string => SUMMARY_HEADING[writtenInJapanese(markdown) ? 'ja' : 'en']

/**
 * Reads user.md, me.md, a page or a journal entry into the sections that carry text. A document without
 * its own `# ` line is named `fallbackTitle`.
 */
export function parsePage(markdown: string, fallbackTitle: string): ParsedPage {
  const { frontmatter, title, sections } = readBody(markdown)
  return { title: title || fallbackTitle, titled: title !== null, frontmatter, sections: sections.filter((section) => section.text) }
}

/**
 * A document of PROMPT_DOCUMENTS as it goes into the system prompt: every line but the frontmatter and the
 * `# ` line, trimmed. The prompt puts a heading of its own above it.
 */
export function promptBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  return lines
    .slice(parseFrontmatter(lines).bodyStart)
    .filter((line) => !/^# /.test(line))
    .join('\n')
    .trim()
}

/**
 * What a document of PROMPT_DOCUMENTS costs in the prompt, and how much of its own text one token stands
 * for: its characters without whitespace and its words, the units a curation in Japanese and in any other
 * language cuts by.
 */
export function promptSize(markdown: string): PromptSize {
  const body = promptBody(markdown)
  return { tokens: tokenEstimate(body), characters: capLength(body), words: body.split(/\s+/u).filter(Boolean).length }
}

/** How much of the document's own text, in characters and in words, comes to `tokens` tokens. */
export function textForTokens(size: PromptSize, tokens: number): TextAmount {
  const share = (count: number): number => (size.tokens === 0 ? 0 : Math.ceil((tokens * count) / size.tokens))
  return { characters: share(size.characters), words: share(size.words) }
}

/** The names Windows keeps for devices. No file there can take one, whatever extension follows it. */
const WINDOWS_DEVICE_NAME = /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i

/**
 * What keeps a page's name, its file name without .md, from being used, or null when nothing does. A
 * memory folder is a git repository that may be cloned on macOS or on Windows, so a name either of them
 * cannot give a file is refused on both: 'characters' for a character that cannot stand in a file name or
 * a leading dot, which hides the file, and 'reserved' for a name Windows keeps for a device. A dot or a
 * space at the end of the name is not at the end of the file name, which always ends in .md.
 */
export function pageNameIssue(name: string): PageNameIssue | null {
  if (/[/\\:*?"<>|]/.test(name) || name.startsWith('.')) return 'characters'
  if (WINDOWS_DEVICE_NAME.test(name)) return 'reserved'
  return null
}

const inPrompt = (kind: DocumentKind): boolean => PROMPT_DOCUMENTS.some((document) => document.kind === kind)

/**
 * What in a document breaks the rules, as values rather than sentences, since ASIST writes them in the
 * language of its interface and each skill in its own. `kind` is where the document lives: me, user, page
 * or journal. A heading may stand only once in a file, because a section is found by its file and heading.
 */
export function documentIssues(kind: DocumentKind, markdown: string): DocumentIssue[] {
  const { frontmatter, unclosed, title, headed, sections } = readBody(markdown)
  const issues: DocumentIssue[] = []
  if ((kind === 'user' || kind === 'me' || kind === 'page') && !frontmatter.present) issues.push({ kind: 'frontmatterMissing' })
  if (unclosed) issues.push({ kind: 'frontmatterUnclosed' })
  for (const key of frontmatter.obsoleteKeys) issues.push({ kind: 'obsoleteKey', key })
  if ((kind === 'user' || kind === 'me') && frontmatter.hasAliases) issues.push({ kind: 'aliasesOnlyOnPages' })
  if (frontmatter.updated && !DATE.test(frontmatter.updated)) issues.push({ kind: 'updatedNotDate' })
  if (kind !== 'journal' && title === null) issues.push({ kind: 'titleMissing' })
  if (kind !== 'me' && !headed) issues.push({ kind: 'noHeadings' })
  const firstLines = new Map<string, number>()
  for (const { line, heading, text } of sections) {
    const first = firstLines.get(heading)
    if (first === undefined) firstLines.set(heading, line)
    else issues.push({ kind: 'duplicateHeading', line, heading, first })
    const length = capLength(text)
    if (length === 0) issues.push({ kind: 'headingWithoutText', line, heading })
    else if (length > SECTION_MAX_CHARS && !inPrompt(kind)) issues.push({ kind: 'sectionTooLong', line, heading, length })
  }
  const opening = sections[0]?.heading
  if (kind === 'page' && opening !== undefined && opening !== SUMMARY_HEADING.ja && opening !== SUMMARY_HEADING.en) {
    issues.push({ kind: 'firstHeading', heading: summaryFor(markdown) })
  }
  if (inPrompt(kind)) {
    const size = promptSize(markdown)
    const over = size.tokens - PROMPT_DOCUMENT_MAX_TOKENS
    if (over > 0) issues.push({ kind: 'tooManyTokens', tokens: size.tokens, limit: PROMPT_DOCUMENT_MAX_TOKENS, cut: textForTokens(size, over) })
  }
  return issues
}
