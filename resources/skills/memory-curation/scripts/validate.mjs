#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { INSTRUCTION_MAX_CHARS, SECTION_MAX_CHARS, documentIssues, pageNameIssue } from '../../memory-format.mjs'

// Checks a memory directory. Usage: node validate.mjs <memoryDir>
// Every problem is printed on its own line and the exit code is 1; with none it prints OK. The rules for a
// single file come from memory-format.mjs, which ASIST applies as well when it merges a curation. The
// English skill ships the same checks with its problems written in English.

const dir = path.resolve(process.argv[2] ?? '.')
const problems = []
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TOP_LEVEL = ['user.md', 'me.md', 'instruction.md', 'AGENTS.md']

const MESSAGES = {
  frontmatterNotAllowed: () => 'frontmatter は要りません。消してください',
  frontmatterMissing: () => 'frontmatter がありません',
  frontmatterUnclosed: () => 'frontmatter が閉じていません(--- が一つしかありません)',
  obsoleteKey: ({ key }) => `frontmatter の ${key} は使わないので消してください`,
  aliasesOnlyOnPages: () => 'aliases は pages/ のページにだけ書きます。消してください',
  updatedNotDate: () => 'updated は YYYY-MM-DD の日付にしてください',
  titleMissing: (_, kind) => (kind === 'instruction' ? '「# いつも覚えておくこと」の見出しがありません' : '「# 名前」の見出しがありません'),
  noHeadings: (_, kind) =>
    kind === 'journal' ? '「## 見出し」が一つもありません(日記は話題ごとに ## で区切ってください)' : '「## 見出し」が一つもありません',
  duplicateHeading: ({ heading, first }) =>
    `見出し「${heading}」が ${first} 行目にもあります。同じ見出しは一つにまとめてください`,
  headingWithoutText: ({ heading }) => `見出し「${heading}」の下に本文がありません(書くことが無い見出しは消してください)`,
  sectionTooLong: ({ heading, length }) => `見出し「${heading}」の本文が ${length} 字あります(${SECTION_MAX_CHARS} 字までにしてください)`,
  firstHeading: ({ heading }) => `最初の見出しは「${heading}」にしてください(名前が会話に出たとき、ここが読まれます)`,
  instructionTooLong: ({ length }) =>
    `本文が ${length} 字あります(${INSTRUCTION_MAX_CHARS} 字までにしてください。詳しいことは user.md、me.md、ページに残します)`
}

const NAME_MESSAGES = {
  characters: 'ページの名前に使えない文字があります(/ \\ : * ? " < > | は使えません)。名前を変えてください',
  reserved: 'この名前は Windows でファイルの名前に使えません。名前を変えてください'
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
  problems.push('instruction.md: ありません(毎回の会話に載せる要約なので、user.md、me.md、ページから書いてください)')
}
for (const file of listMd('pages')) {
  const nameIssue = pageNameIssue(path.basename(file, '.md'))
  if (nameIssue) problems.push(`${file}: ${NAME_MESSAGES[nameIssue]}`)
  check(file, 'page')
}
for (const file of listMd('journal')) {
  if (DATE.test(path.basename(file, '.md'))) check(file, 'journal')
  else problems.push(`${file}: ファイル名は YYYY-MM-DD.md にしてください`)
}
if (fs.existsSync(path.join(dir, 'profile.md'))) {
  problems.push('profile.md: 使わないので、中身を instruction.md / user.md に移してから消してください')
}
if (fs.existsSync(path.join(dir, 'forget.jsonl'))) problems.push('forget.jsonl: 使わないので消してください')
for (const stray of fs.readdirSync(dir)) {
  if (/\.md$/.test(stray) && stray !== 'profile.md' && !TOP_LEVEL.includes(stray)) {
    problems.push(`${stray}: 置く場所が違います(人や場所や物事は pages/、記録は journal/ に置いてください)`)
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log('OK')
