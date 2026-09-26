/** The types of memory-format.mjs, which stays plain JavaScript so that validate.mjs runs it without a build. */

export type DocumentKind = 'instruction' | 'me' | 'user' | 'page' | 'journal'

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

export type DocumentIssue =
  | { kind: 'frontmatterNotAllowed' }
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
  | { kind: 'instructionTooLong'; length: number }

export declare const SUMMARY_HEADING: { readonly ja: '要約'; readonly en: 'Summary' }
export declare const SECTION_MAX_CHARS: 800
export declare const INSTRUCTION_MAX_CHARS: 2000
export declare function writtenInJapanese(text: string): boolean
export declare function parsePage(markdown: string, fallbackTitle: string): ParsedPage
export declare function instructionBody(markdown: string): string
export declare function documentIssues(kind: DocumentKind, markdown: string): DocumentIssue[]
export type PageNameIssue = 'characters' | 'reserved'
export declare function pageNameIssue(name: string): PageNameIssue | null
