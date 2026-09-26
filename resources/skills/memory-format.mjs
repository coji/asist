/**
 * The rules of the memory's markdown: how a document is read into its frontmatter, its `# name` line and
 * its sections, and what in it breaks the rules. ASIST applies them when it indexes the memory, when the
 * memory screen saves a document and before it merges a curation, and the curation skills' validate.mjs
 * reports them to the Agent, so a file the Agent's check passes is never refused at the merge. The file is
 * plain JavaScript without imports because validate.mjs runs it with node inside a curation worktree, where
 * nothing is built. It sits two folders above the skills' scripts/, here and where installSkill puts it.
 */

/** The heading every page opens with, and the one the text above a document's first `## ` heading is read as. */
export const SUMMARY_HEADING = Object.freeze({ ja: '要約', en: 'Summary' })

/**
 * The longest a section may be and the longest the body of instruction.md may be, in characters without
 * whitespace. instruction.md goes whole into the system prompt of every turn, and a section is what one
 * search hit carries into a turn, so both are capped rather than left to grow with each curation.
 */
export const SECTION_MAX_CHARS = 800
export const INSTRUCTION_MAX_CHARS = 2000

/** The length the caps are measured in: characters, with the whitespace left out. */
const capLength = (text) => Array.from(text.replace(/\s+/gu, '')).length

/**
 * Whether a piece of memory is written in Japanese. Kana decide it: of the eleven languages a
 * conversation can be held in, only Japanese writes them, and Japanese prose always contains them.
 */
export const writtenInJapanese = (text) => /[\u3041-\u30ff]/.test(text)

const DATE = /^\d{4}-\d{2}-\d{2}$/
const OBSOLETE_KEYS = new Set(['kind', 'links'])
const unquote = (text) => text.trim().replace(/^["']|["']$/g, '')

/**
 * Reads the frontmatter, the `key: value` lines fenced by `---`, and the line the body starts on. A list
 * is read as `[a, b]` on one line and as `- a` lines under its key, indented or not: the Agent writes the
 * first two, and a YAML library writes the items at the key's own indentation.
 */
function parseFrontmatter(lines) {
  const frontmatter = { present: false, aliases: [], hasAliases: false, updated: null, obsoleteKeys: [] }
  if (lines[0]?.trim() !== '---') return { frontmatter, bodyStart: 0, unclosed: false }
  frontmatter.present = true
  // The items of a list follow its key on lines of their own; those of an obsolete key are skipped.
  let listKey = null
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

/**
 * Splits a document into its frontmatter, its `# ` line and its sections, empty ones included. A section is
 * a `## ` heading and the text under it. The text above the first heading is a section too, under the
 * summary heading in the form the document is written in, which is how a short page or a me.md written as
 * prose is read.
 */
function readBody(markdown) {
  const lines = markdown.split(/\r?\n/)
  const { frontmatter, bodyStart, unclosed } = parseFrontmatter(lines)
  let title = null
  let headed = false
  const sections = []
  let current = null
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

const summaryFor = (markdown) => SUMMARY_HEADING[writtenInJapanese(markdown) ? 'ja' : 'en']

/**
 * Reads user.md, me.md, a page or a journal entry into the sections that carry text. A document without
 * its own `# ` line is named `fallbackTitle`.
 */
export function parsePage(markdown, fallbackTitle) {
  const { frontmatter, title, sections } = readBody(markdown)
  return { title: title || fallbackTitle, titled: title !== null, frontmatter, sections: sections.filter((section) => section.text) }
}

/** The body of instruction.md as it goes into the system prompt: every line but the frontmatter and the `# ` line. */
export function instructionBody(markdown) {
  const lines = markdown.split(/\r?\n/)
  return lines
    .slice(parseFrontmatter(lines).bodyStart)
    .filter((line) => !/^# /.test(line))
    .join('\n')
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
export function pageNameIssue(name) {
  if (/[/\\:*?"<>|]/.test(name) || name.startsWith('.')) return 'characters'
  if (WINDOWS_DEVICE_NAME.test(name)) return 'reserved'
  return null
}

/**
 * What in a document breaks the rules, as values rather than sentences, since ASIST writes them in the
 * language of its interface and each skill in its own. `kind` is where the document lives: instruction,
 * me, user, page or journal. A heading may stand only once in a file, because a section is found by its
 * file and heading.
 */
export function documentIssues(kind, markdown) {
  const { frontmatter, unclosed, title, headed, sections } = readBody(markdown)
  const issues = []
  if (kind === 'instruction' && frontmatter.present) issues.push({ kind: 'frontmatterNotAllowed' })
  if ((kind === 'user' || kind === 'me' || kind === 'page') && !frontmatter.present) issues.push({ kind: 'frontmatterMissing' })
  if (unclosed) issues.push({ kind: 'frontmatterUnclosed' })
  for (const key of frontmatter.obsoleteKeys) issues.push({ kind: 'obsoleteKey', key })
  if ((kind === 'user' || kind === 'me') && frontmatter.hasAliases) issues.push({ kind: 'aliasesOnlyOnPages' })
  if (frontmatter.updated && !DATE.test(frontmatter.updated)) issues.push({ kind: 'updatedNotDate' })
  if (kind !== 'journal' && title === null) issues.push({ kind: 'titleMissing' })
  if (kind !== 'me' && !headed) issues.push({ kind: 'noHeadings' })
  const firstLines = new Map()
  for (const { line, heading, text } of sections) {
    const first = firstLines.get(heading)
    if (first === undefined) firstLines.set(heading, line)
    else issues.push({ kind: 'duplicateHeading', line, heading, first })
    const length = capLength(text)
    if (length === 0) issues.push({ kind: 'headingWithoutText', line, heading })
    else if (length > SECTION_MAX_CHARS) issues.push({ kind: 'sectionTooLong', line, heading, length })
  }
  const opening = sections[0]?.heading
  if (kind === 'page' && opening !== undefined && opening !== SUMMARY_HEADING.ja && opening !== SUMMARY_HEADING.en) {
    issues.push({ kind: 'firstHeading', heading: summaryFor(markdown) })
  }
  if (kind === 'instruction') {
    const length = capLength(instructionBody(markdown))
    if (length > INSTRUCTION_MAX_CHARS) issues.push({ kind: 'instructionTooLong', length })
  }
  return issues
}
