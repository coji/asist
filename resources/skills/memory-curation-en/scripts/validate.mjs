#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { SECTION_MAX_CHARS, documentIssues, pageNameIssue } from '../../memory-format.mjs'

// Checks a memory directory. Usage: node validate.mjs <memoryDir>
// Every problem is printed on its own line and the exit code is 1; with none it prints OK. The rules for a
// single file come from memory-format.mjs, which ASIST applies as well when it merges a curation. The
// Japanese skill ships the same checks with its problems written in Japanese.

const dir = path.resolve(process.argv[2] ?? '.')
const problems = []
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TOP_LEVEL = ['user.md', 'me.md', 'instruction.md', 'AGENTS.md']

const MESSAGES = {
  frontmatterNotAllowed: () => 'it takes no frontmatter; delete it',
  frontmatterMissing: () => 'there is no frontmatter',
  frontmatterUnclosed: () => 'the frontmatter is not closed (there is only one ---)',
  obsoleteKey: ({ key }) => `${key} in the frontmatter is no longer used; delete it`,
  aliasesOnlyOnPages: () => 'aliases belong only on the pages under pages/; delete it',
  updatedNotDate: () => 'updated must be a date in the form YYYY-MM-DD',
  titleMissing: (_, kind) => (kind === 'instruction' ? 'there is no "# Always keep in mind" line' : 'there is no "# name" line'),
  noHeadings: (_, kind) =>
    kind === 'journal' ? 'there is not one "## heading" (a journal entry is divided by ## into its subjects)' : 'there is not one "## heading"',
  duplicateHeading: ({ heading, first }) =>
    `the heading "${heading}" is also on line ${first}; merge the two into one`,
  headingWithoutText: ({ heading }) => `there is nothing under the heading "${heading}" (delete a heading you have nothing to write under)`,
  sectionTooLong: ({ heading, length }) => `the heading "${heading}" holds ${length} characters (keep it to ${SECTION_MAX_CHARS})`,
  firstHeading: ({ heading }) => `make the first heading "${heading}" (it is what gets read when the name comes up in the conversation)`,
  tooManyTokens: ({ tokens, limit, cut }) =>
    `it comes to ${tokens} tokens (keep it to ${limit}: cut about ${cut.words} words, and check with count.mjs)`
}

const NAME_MESSAGES = {
  characters: 'the page name holds a character a file name cannot (/ \\ : * ? " < > |); rename the page',
  reserved: 'Windows does not allow this name for a file; rename the page'
}

/** Checks one file against the rules for its kind, and returns whether it exists. */
function check(file, kind) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return false
  for (const issue of documentIssues(kind, fs.readFileSync(full, 'utf8'))) {
    problems.push(`${file}${'line' in issue ? `:${issue.line}` : ''}: ${MESSAGES[issue.kind](issue, kind)}`)
  }
  return true
}

function listMd(sub) {
  const target = path.join(dir, sub)
  if (!fs.existsSync(target)) return []
  return fs.readdirSync(target).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort().map((n) => `${sub}/${n}`)
}

check('user.md', 'user')
check('me.md', 'me')
if (!check('instruction.md', 'instruction')) {
  problems.push('instruction.md: it is missing (it is the summary that goes into every conversation; write it from user.md, me.md and the pages)')
}
for (const file of listMd('pages')) {
  const nameIssue = pageNameIssue(path.basename(file, '.md'))
  if (nameIssue) problems.push(`${file}: ${NAME_MESSAGES[nameIssue]}`)
  check(file, 'page')
}
for (const file of listMd('journal')) {
  if (DATE.test(path.basename(file, '.md'))) check(file, 'journal')
  else problems.push(`${file}: the file name must be YYYY-MM-DD.md`)
}
if (fs.existsSync(path.join(dir, 'profile.md'))) {
  problems.push('profile.md: it is no longer used; move what it holds into instruction.md / user.md, then delete it')
}
if (fs.existsSync(path.join(dir, 'forget.jsonl'))) problems.push('forget.jsonl: it is no longer used; delete it')
for (const stray of fs.readdirSync(dir)) {
  if (/\.md$/.test(stray) && stray !== 'profile.md' && !TOP_LEVEL.includes(stray)) {
    problems.push(`${stray}: this is in the wrong place (a person, a place or a subject belongs in pages/, a record in journal/)`)
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log('OK')
