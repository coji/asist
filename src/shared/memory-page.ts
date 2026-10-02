import { z } from 'zod'
import type { PromptText } from './conversation-locale'
import type { Translate } from './i18n'
import { errorText } from './i18n/error-text'
import type { MemoryDocument, MemoryDocumentKind, MemoryPageInput, MemoryUnit, MemoryUnitKind } from './ipc'
import {
  PROMPT_DOCUMENTS,
  SECTION_MAX_CHARS,
  SUMMARY_HEADING,
  documentIssues,
  pageNameIssue,
  parsePage,
  promptBody,
  writtenInJapanese,
  type DocumentIssue,
  type PageNameIssue,
  type ParsedPage,
  type PromptDocumentKind
} from '../../resources/skills/memory-format.mjs'
import journalTemplateJa from '../../resources/skills/memory-curation/assets/templates/journal.md?raw'
import meTemplateJa from '../../resources/skills/memory-curation/assets/templates/me.md?raw'
import pageTemplateJa from '../../resources/skills/memory-curation/assets/templates/page.md?raw'
import userTemplateJa from '../../resources/skills/memory-curation/assets/templates/user.md?raw'
import journalTemplateEn from '../../resources/skills/memory-curation-en/assets/templates/journal.md?raw'
import meTemplateEn from '../../resources/skills/memory-curation-en/assets/templates/me.md?raw'
import pageTemplateEn from '../../resources/skills/memory-curation-en/assets/templates/page.md?raw'
import userTemplateEn from '../../resources/skills/memory-curation-en/assets/templates/user.md?raw'

export { PROMPT_DOCUMENTS, parsePage, promptBody, type PromptDocumentKind }

/**
 * Reading and writing the memory pages, which are markdown. They live in `userData/memory/`, and the
 * files are the memory itself. How a document is read and what breaks its rules live in
 * resources/skills/memory-format.mjs, which the curation skills' scripts read too; this file turns what it
 * reads into units and list entries, and its findings into sentences. A heading and the body under it,
 * called a section, is the unit of search and injection for the pages and the journal, and its id is
 * derived from the file path and the heading, so rewriting the body leaves the unit identical.
 */

/**
 * The headings and the page names this code depends on, in the two forms a memory directory can hold.
 * The body of a memory is written in the language of the conversation, but these are fixed: Japanese in
 * a memory written in Japanese, English in every other language, so that reading a page needs no table
 * of headings per language. Both forms are read whatever the language currently is, because the user can
 * change it and the directory then holds pages written under each. The skills in resources/skills write
 * them, one skill per form.
 */
export const FIXED = {
  /** The heading every page opens with, and the one the text above a document's first `## ` line is read as. */
  summary: SUMMARY_HEADING,
  /** The heading the curation closes every journal entry with. */
  journalSelf: { ja: '今日の私', en: 'Myself today' },
  /** The heading the curation keeps on every page about a person, a place or a topic for its own view of them. */
  impression: { ja: '私の印象', en: 'My impression' },
  /** The `# name` line of the three pages whose name comes from their role rather than from a person. */
  user: { ja: 'ユーザー', en: 'The user' },
  me: { ja: '私について', en: 'About me' },
  instruction: { ja: 'いつも覚えておくこと', en: 'Always keep in mind' },
  /** The word that stands before a journal entry in the text that gets embedded. */
  journalOf: { ja: '{date}の日記', en: 'Journal of {date}' }
} as const satisfies Record<string, PromptText>

/**
 * Because it stands in every entry, the memory screen leaves this heading out of the entry's preview
 * line, in both the form a Japanese curation writes and the form the other languages write.
 */
export const JOURNAL_SELF_HEADINGS: readonly string[] = [FIXED.journalSelf.ja, FIXED.journalSelf.en]

/**
 * The form of a fixed text that fits the memory it is written into, told by its kana, so that the prefix of
 * the text that gets embedded keeps the form the entry was written in after the conversation changed
 * language.
 */
const fixedFor = (text: PromptText, markdown: string): string => text[writtenInJapanese(markdown) ? 'ja' : 'en']

/**
 * A 16-digit id built from two 32-bit FNV-1a hashes. The same file path and key, which is a heading
 * or a body, always produce the same id.
 */
export function unitId(file: string, key: string): string {
  const input = `${file}\n${key}`
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ ((c << 1) | 1), 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export type FileKind = 'user' | 'me' | 'instruction' | 'page' | 'journal' | null

/** Derives the kind and the page's default name from the file path. */
export function classifyFile(file: string): { kind: FileKind; title: string } {
  const base = file.replace(/\\/g, '/').replace(/\.md$/, '')
  const name = base.split('/').pop() ?? base
  // The title is what a page is called when its own `# name` line is missing, so the Japanese form stands.
  if (base === 'user') return { kind: 'user', title: FIXED.user.ja }
  if (base === 'me') return { kind: 'me', title: FIXED.me.ja }
  if (base === 'instruction') return { kind: 'instruction', title: FIXED.instruction.ja }
  if (base.startsWith('journal/')) return { kind: 'journal', title: name }
  if (base.startsWith('pages/')) return { kind: 'page', title: name }
  return { kind: null, title: name }
}

const templateHeadings = (fixed: readonly PromptText[], ...templates: string[]): ReadonlySet<string> =>
  new Set([
    ...[FIXED.summary, ...fixed].flatMap((text) => [text.ja, text.en]),
    ...templates.flatMap((template) => parsePage(template, '').sections.map((section) => section.heading))
  ])

/**
 * The headings the templates of the curation skills write into each kind of document that is searched, in the
 * two forms the templates exist in, with the fixed headings ASIST reads: the summary, which the text above a
 * document's first heading is read under, the impression of a page and the close of a journal day.
 */
const TEMPLATE_HEADINGS: Record<'user' | 'me' | 'page' | 'journal', ReadonlySet<string>> = {
  user: templateHeadings([], userTemplateJa, userTemplateEn),
  me: templateHeadings([], meTemplateJa, meTemplateEn),
  page: templateHeadings([FIXED.impression], pageTemplateJa, pageTemplateEn),
  journal: templateHeadings([FIXED.journalSelf], journalTemplateJa, journalTemplateEn)
}

/**
 * Whether the heading of a section of the file is one its template writes, rather than one the curation or the
 * user chose for what the section says. Such a heading is the same in every memory and in ordinary words, so it
 * is no reason to put the section beside an utterance. Measured on 2026-10-02 over memories of 26 units written
 * from the templates in each language: as a search word, "who am I kidding" injected me.md's "Who I am" at bm25
 * -5.2 against the bar of -5 and 「気になっていることがあるんだけど」 me.md's 「好きなもの、気になっていること」 at
 * -11.4 against -2.5; in the embedded text, "I did not like myself today" brought the close of a journal day to a
 * cosine of 0.868 against the bar of 0.84, and 0.835 without the heading. A heading anyone else writes says what
 * the section holds: over 53 units, "Ken bought a bonsai yesterday" injects a "Bonsai" the curation added to
 * me.md at -8.3, and nothing once that heading is no search word. A curation held in a language other than
 * Japanese or English writes me.md's example headings in that language, and those are not in this set.
 */
export function headingFromTemplate(file: string, heading: string): boolean {
  const { kind } = classifyFile(file)
  return kind !== null && kind !== 'instruction' && TEMPLATE_HEADINGS[kind].has(heading)
}

/** Turns the headings of a page, meaning user, me or pages, into units. */
export function unitsOfPage(file: string, page: ParsedPage, pageName: string): MemoryUnit[] {
  const date = page.frontmatter.updated ?? ''
  return page.sections.map((section, order) => ({
    id: unitId(file, section.heading),
    file,
    line: section.line,
    kind: 'section' as MemoryUnitKind,
    page: pageName,
    heading: section.heading,
    aliases: page.frontmatter.aliases,
    text: section.text,
    date,
    order
  }))
}

/** Turns the headings of a journal entry into units, using the date as the page name. */
export function unitsOfJournal(file: string, page: ParsedPage, date: string): MemoryUnit[] {
  return page.sections.map((section, order) => ({
    id: unitId(file, section.heading),
    file,
    line: section.line,
    kind: 'journal' as MemoryUnitKind,
    page: date,
    heading: section.heading,
    aliases: [],
    text: section.text,
    date,
    order
  }))
}

/**
 * The text that gets embedded. A section unit is prefixed with the page name and the heading, which
 * also makes the other headings of the same page reachable. Aliases are not appended in parentheses,
 * because that lowers the scores; they are carried on the bigram side only. A journal unit is prefixed
 * with the date and the heading, in the language the entry is written in, so that changing the language
 * of the conversation does not send every entry written so far back through the embedding worker. A heading
 * its template wrote is left out (headingFromTemplate).
 */
export function embeddingTextOf(unit: Pick<MemoryUnit, 'file' | 'kind' | 'page' | 'heading' | 'text' | 'date'>): string {
  const heading = headingFromTemplate(unit.file, unit.heading) ? '' : ` ${unit.heading}`
  if (unit.kind !== 'journal') return `${unit.page}${heading}: ${unit.text}`
  const label = fixedFor(FIXED.journalOf, `${unit.heading}\n${unit.text}`).replace('{date}', unit.date)
  return `${label}${heading}: ${unit.text}`
}


/**
 * The files the memory screen can open: instruction.md, me.md, user.md, pages/<name>.md and
 * journal/YYYY-MM-DD.md.
 */
export const DOCUMENT_FILE = /^(instruction\.md|me\.md|user\.md|pages\/[^/\\]+\.md|journal\/\d{4}-\d{2}-\d{2}\.md)$/

const MAX_PAGE_NAME_LENGTH = 60

const PAGE_NAME_ERRORS = {
  characters: 'memory.errors.nameCharacters',
  reserved: 'memory.errors.nameReserved'
} as const satisfies Record<PageNameIssue, string>

/** Why a page's name, its file name without .md, cannot be used, or null when it can. */
export function pageNameError(name: string): string | null {
  const issue = pageNameIssue(name)
  return issue ? errorText(PAGE_NAME_ERRORS[issue]) : null
}

/** The input for a new page. The name becomes the file name. */
export const memoryPageInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, errorText('memory.errors.nameEmpty'))
    .max(MAX_PAGE_NAME_LENGTH, errorText('memory.errors.nameTooLong', { limit: MAX_PAGE_NAME_LENGTH }))
    .superRefine((name, context) => {
      const message = pageNameError(name)
      if (message) context.addIssue({ code: 'custom', message })
    })
})

export function documentKindOf(file: string): MemoryDocumentKind | null {
  if (!DOCUMENT_FILE.test(file)) return null
  return classifyFile(file).kind as MemoryDocumentKind
}

/** The first sentence, at most 80 characters, used as the gist shown in the list. */
function firstSentence(text: string): string {
  const line = (text.split('\n').find((candidate) => candidate.trim()) ?? '').replace(/^\s*[-*]\s+/, '')
  const match = /^(.{0,80}?[。.!?！？])/.exec(line)
  return (match ? match[1] : line.slice(0, 80)).trim()
}

/**
 * What the list shows about a document: its frontmatter, its name, its headings, and the first
 * sentence of its summary.
 */
export function documentOf(file: string, markdown: string): MemoryDocument {
  const kind = documentKindOf(file)
  if (!kind) throw new Error(errorText('memory.errors.notADocument', { file }))
  const { title } = classifyFile(file)
  const page = parsePage(markdown, title)
  const first = page.sections[0]
  return {
    file,
    kind,
    title: kind === 'page' ? page.title : title,
    aliases: page.frontmatter.aliases,
    updated: kind === 'journal' ? title : page.frontmatter.updated,
    headings: page.sections.map((section) => section.heading),
    summary: first ? firstSentence(first.text) : ''
  }
}

/** A finding of documentIssues as a sentence in the language of the interface. */
function issueText(file: string, issue: DocumentIssue, t: Translate): string {
  switch (issue.kind) {
    case 'duplicateHeading':
      return t('memory.check.duplicateHeading', { file, line: issue.line, heading: issue.heading, first: issue.first })
    case 'headingWithoutText':
      return t('memory.check.headingWithoutText', { file, line: issue.line, heading: issue.heading })
    case 'sectionTooLong':
      return t('memory.check.sectionTooLong', { file, line: issue.line, heading: issue.heading, limit: SECTION_MAX_CHARS })
    case 'tooManyTokens':
      return t('memory.check.tooManyTokens', { file, tokens: issue.tokens, limit: issue.limit, characters: issue.cut.characters })
    case 'firstHeading':
      return t('memory.check.firstHeading', { file, heading: issue.heading })
    case 'obsoleteKey':
      return t('memory.check.obsoleteKey', { file, key: issue.key })
    default:
      return t(`memory.check.${issue.kind}`, { file })
  }
}

/**
 * Checks the document against the rules of memory-format.mjs and returns what needs fixing, in the
 * language of the interface, or nothing when it is valid. Reading the whole directory and saving from
 * the screen apply the same rules.
 */
export function validateDocument(file: string, markdown: string, t: Translate): string[] {
  const kind = documentKindOf(file)
  if (!kind) return [t('memory.check.wrongPlace', { file })]
  return documentIssues(kind, markdown).map((issue) => issueText(file, issue, t))
}

export function parseMemoryPageInput(value: unknown): MemoryPageInput {
  const result = memoryPageInputSchema.safeParse(value)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}
