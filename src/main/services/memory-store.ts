import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import type { MemoryDocument, MemoryUnit } from '@shared/ipc'
import { localDateKey } from '@shared/local-date'
import { MEMORY_GITIGNORE } from '@shared/memory-curation'
import { isJournalName } from '@shared/memory-format'
import {
  DOCUMENT_FILE,
  PROMPT_DOCUMENTS,
  classifyFile,
  documentKindOf,
  documentOf,
  foldInstruction,
  parseMemoryPageInput,
  parsePage,
  promptBody,
  unitsOfJournal,
  unitsOfPage,
  validateDocument,
  type PromptDocumentKind
} from '@shared/memory-page'
import { writeFileAtomicSync } from './atomic-json'
import { conversationLocale } from './conversation-locale'
import * as git from './git'
import { t } from './i18n'

/**
 * The memory directory, userData/memory/. The markdown files are the memory itself and are kept as a git
 * repository. The writes that happen during the day (editing, creating or deleting a document from the
 * memory screen) happen here and each one is committed. Nothing is memorized during a
 * conversation, and the only writers of a page are the curation Agent and the memory screen. The daily
 * curation job cuts its worktree from HEAD, so an uncommitted change is invisible to the Agent. The index
 * in memory-index.ts is built from these files.
 */

export const ME_FILE = 'me.md'
export const USER_FILE = 'user.md'
export const PAGES_DIR = 'pages'
export const JOURNAL_DIR = 'journal'

/**
 * The subjects of the commits ASIST itself makes in the memory. They belong to the memory and follow the
 * language it is written in, not the language of the interface.
 */
const WRITES = {
  created: { ja: 'asist: 記憶の置き場を作る', en: 'asist: create the memory directory' },
  prepared: { ja: 'asist: 置き場を整える', en: 'asist: tidy the memory directory' },
  edited: { ja: 'asist: 手直し {file}', en: 'asist: edit {file}' },
  pageCreated: { ja: 'asist: ページを作る {name}', en: 'asist: create the page {name}' },
  deleted: { ja: 'asist: 消す {file}', en: 'asist: delete {file}' },
  instructionFolded: { ja: 'asist: instruction.md の中身を me.md と user.md に移す', en: 'asist: move what instruction.md held into me.md and user.md' }
} as const satisfies Record<string, PromptText>

const written = (of: keyof typeof WRITES, values: Record<string, string> = {}): string =>
  fillPrompt(promptText(conversationLocale(), WRITES[of]), values)

export interface ReadResult {
  units: MemoryUnit[]
  pages: number
  /** Problems that should stop a curation from being merged, such as a document over its limit or a heading with no body. */
  errors: string[]
}

/**
 * instruction.md, the summary that rode in every turn before me.md and user.md did. ensureRepo moves what it
 * held into them, and a curation that writes it again is refused like the other files an earlier form of the
 * memory kept.
 */
const INSTRUCTION_FILE = 'instruction.md'
/** The files an earlier form of the memory kept: profile.md, which instruction.md replaced, forget.jsonl and instruction.md. */
const OBSOLETE_FILES = ['profile.md', 'forget.jsonl', INSTRUCTION_FILE]

export function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory')
}

/**
 * Prepares the directory and its repository, creating .gitignore and placing the first commit on the first run,
 * and moves what an instruction.md held into me.md and user.md.
 */
export function ensureRepo(dir = memoryDir()): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const sub of [PAGES_DIR, JOURNAL_DIR]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const gitignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignore) || fs.readFileSync(gitignore, 'utf8') !== MEMORY_GITIGNORE) {
    fs.writeFileSync(gitignore, MEMORY_GITIGNORE, { mode: 0o600 })
  }
  // The folder is a repository of its own once it holds one. Asking git instead would climb to a repository
  // above it, which git may refuse to open, such as one an administrator made at the top of a drive.
  if (!fs.existsSync(path.join(dir, '.git'))) git.init(dir)
  git.commitAll(dir, written(git.hasHead(dir) ? 'prepared' : 'created'))
  foldInstructionIntoPromptDocuments(dir)
}

/**
 * Moves what instruction.md holds into me.md and user.md and removes it, in one commit. Its text goes over
 * word for word, so nothing the user wrote there is lost; the two documents may then pass their limit until
 * the next curation folds the moved sections into their own headings.
 */
function foldInstructionIntoPromptDocuments(dir: string): void {
  const instruction = readFileOf(dir, INSTRUCTION_FILE)
  if (instruction === null) return
  const folded = foldInstruction(instruction, { me: readFileOf(dir, ME_FILE), user: readFileOf(dir, USER_FILE) }, localDateKey(new Date()))
  commitFiles(dir, { [ME_FILE]: folded.me, [USER_FILE]: folded.user, [INSTRUCTION_FILE]: null }, written('instructionFolded'))
}

const notRegular = (file: string): Error => new Error(errorText('memory.errors.notRegular', { file }))

/**
 * Reads a file of the memory, or returns null when there is none. Anything but a regular file is refused
 * before a byte of it is read. The memory folder can hold a named pipe or a symbolic link that was put there
 * by hand, and ensureRepo commits a link like any file, so a checkout of a curation's merge can hold one
 * too: reading a pipe blocks the main process until a writer appears, and a link to /dev/zero never
 * ends. The file is opened without following a link and without waiting for a writer, and its type is
 * checked on the open descriptor, so nothing can be put in its place in between.
 *
 * Windows has neither O_NOFOLLOW nor O_NONBLOCK, and Node leaves both undefined there, so the open follows a
 * symbolic link or a junction. The path is therefore looked at with lstat first, and the opened file must
 * be the one lstat saw. A regular file that another one replaced in between, as an editor or git saves by
 * a rename, is looked at again, and a link put in its place is then refused by the lstat.
 */
function readFileOf(dir: string, file: string): string | null {
  const target = path.join(dir, file)
  for (let attempt = 1; ; attempt++) {
    const read = readIfUnchanged(target, file)
    if (read !== REPLACED) return read
    // A file replaced at every look is refused rather than read without the check.
    if (attempt === READ_ATTEMPTS) throw notRegular(file)
  }
}

const REPLACED = Symbol('replaced')
const READ_ATTEMPTS = 3

/** One look at the file and one read of it, or REPLACED when the file opened is not the one the look saw. */
function readIfUnchanged(target: string, file: string): string | null | typeof REPLACED {
  let seen: fs.BigIntStats
  try {
    seen = fs.lstatSync(target, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!seen.isFile()) throw notRegular(file)
  let fd: number
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw notRegular(file)
    throw error
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!opened.isFile()) throw notRegular(file)
    if (opened.ino !== seen.ino || opened.dev !== seen.dev) return REPLACED
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The markdown files of pages/ or journal/. A link in place of the folder would list a folder outside the memory. */
function listMarkdown(dir: string, sub: string): string[] {
  const target = path.join(dir, sub)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!stat.isDirectory()) throw notRegular(sub)
  return fs
    .readdirSync(target)
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => `${sub}/${name}`)
}

/**
 * Turns the pages and the journal into units. instruction.md, me.md and user.md go whole into the system
 * prompt, so they are only validated and never indexed: a search hit on them would repeat what every turn
 * already holds. The files an earlier form of the memory used are reported, so that a curation removes
 * them.
 */
export function readAll(dir = memoryDir()): ReadResult {
  const units: MemoryUnit[] = []
  const errors: string[] = []
  let pages = 0
  const read = (file: string): string | null => readFileOf(dir, file)

  for (const file of listMarkdown(dir, PAGES_DIR)) {
    const markdown = read(file) ?? ''
    const page = parsePage(markdown, classifyFile(file).title)
    errors.push(...validateDocument(file, markdown, t))
    units.push(...unitsOfPage(file, page, page.title))
    pages++
  }
  for (const file of listMarkdown(dir, JOURNAL_DIR)) {
    const date = classifyFile(file).title
    const markdown = read(file) ?? ''
    if (!isJournalName(date)) errors.push(t('memory.check.fileName', { file }))
    else errors.push(...validateDocument(file, markdown, t))
    const page = parsePage(markdown, date)
    units.push(...unitsOfJournal(file, page, date))
    pages++
  }
  for (const { file } of PROMPT_DOCUMENTS) {
    const markdown = read(file)
    if (markdown !== null) errors.push(...validateDocument(file, markdown, t))
  }
  for (const file of OBSOLETE_FILES) if (fs.existsSync(path.join(dir, file))) errors.push(t('memory.check.obsoleteFile', { file }))
  return { units, pages, errors }
}

/** The documents in the order the screen shows them: me.md, user.md, the pages by name, then the journal with the newest day first. */
export function listDocuments(dir = memoryDir()): MemoryDocument[] {
  const files = [ME_FILE, USER_FILE, ...listMarkdown(dir, PAGES_DIR), ...listMarkdown(dir, JOURNAL_DIR).reverse()]
  return files.flatMap((file) => {
    const markdown = DOCUMENT_FILE.test(file) ? readFileOf(dir, file) : null
    return markdown === null ? [] : [documentOf(file, markdown)]
  })
}

function documentPath(dir: string, file: string): string {
  return path.join(dir, documentFile(file))
}

function documentFile(file: string): string {
  if (!DOCUMENT_FILE.test(file)) throw new Error(errorText('memory.errors.notADocument', { file }))
  return file
}

export function readDocument(file: string, dir = memoryDir()): string | null {
  return readFileOf(dir, documentFile(file))
}

/**
 * Replaces a whole document and commits it, on the user's own action from the memory screen. `base` is
 * the text the screen read before the user started editing. A document that has changed or gone since,
 * as a curation merged meanwhile changes or removes it, is not written, because the save would take back
 * what the other writer did without anyone seeing it; a removed page is not made again, since the
 * curation removes one when it moves what it held elsewhere. A document that breaks the rules is not
 * written either, and the reason is thrown.
 */
export function writeDocument(file: string, markdown: string, base: string, dir = memoryDir()): MemoryDocument {
  const current = readFileOf(dir, documentFile(file))
  if (current === null) throw new Error(errorText('memory.errors.removedSinceOpened'))
  if (current !== base) throw new Error(errorText('memory.errors.changedSinceOpened'))
  const errors = validateDocument(file, markdown, t)
  if (errors.length > 0) throw new Error(errors.join(' / '))
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  commitFiles(dir, { [file]: text }, written('edited', { file }))
  return documentOf(file, text)
}

/** Creates a page from the template and commits it. A name that already exists is refused rather than overwritten. */
export function createPage(name: string, template: string, dir = memoryDir()): MemoryDocument {
  const input = parseMemoryPageInput({ name })
  const file = `${PAGES_DIR}/${input.name}.md`
  if (fs.existsSync(documentPath(dir, file))) throw new Error(errorText('memory.errors.pageExists', { name: input.name }))
  // The name goes in through a function, because a replacement string reads `$&` or `$$` in it as a pattern.
  const markdown = template
    .replace(/^updated: .*$/m, `updated: ${localDateKey(new Date())}`)
    .replace(/^# .*$/m, () => `# ${input.name}`)
  const errors = validateDocument(file, markdown, t)
  if (errors.length > 0) throw new Error(errorText('memory.errors.templateInvalid', { errors: errors.join(' / ') }))
  commitFiles(dir, { [file]: markdown }, written('pageCreated', { name: input.name }))
  return documentOf(file, markdown)
}

/**
 * Deletes a page or a journal day, on the user's own action from the memory screen. A page that is
 * talked about on a day not curated yet can be written again by the next curation.
 */
export function deleteDocument(file: string, dir = memoryDir()): void {
  const kind = documentKindOf(file)
  if (kind !== 'page' && kind !== 'journal') throw new Error(errorText('memory.errors.deleteKind'))
  if (!fs.existsSync(documentPath(dir, file))) throw new Error(errorText('memory.errors.notFound', { file }))
  commitFiles(dir, { [file]: null }, written('deleted', { file }))
}

/**
 * Puts each file in its new state, removing it for null, and commits them together; when a write or the
 * commit fails, every file already put goes back to what it held. Each change from the screen is meant to be a
 * commit: the curation cuts its worktree from HEAD and would not see a change left on disk, and the screen
 * would take such a change for someone else's and refuse its own next save of the document. A text replaces
 * its file only once it is whole on the disk, because a document cut short by a full disk or a power loss
 * would be committed as the memory by the next curation, which commits whatever is on disk before it starts;
 * a write that fails therefore leaves its own file as it was, with nothing to put back.
 */
function commitFiles(dir: string, changes: Record<string, string | null>, message: string): void {
  const put = (file: string, content: string | null): void => {
    if (content === null) fs.rmSync(path.join(dir, file), { force: true })
    else writeFileAtomicSync(path.join(dir, file), content)
  }
  const before = new Map(Object.keys(changes).map((file) => [file, readFileOf(dir, file)]))
  const done: string[] = []
  try {
    for (const [file, text] of Object.entries(changes)) {
      put(file, text)
      done.push(file)
    }
    git.commitAll(dir, message)
  } catch (error) {
    for (const file of done) put(file, before.get(file) ?? null)
    throw error
  }
}

/**
 * The documents that go whole into the system prompt, in the order they go there, each as its body without
 * the frontmatter and the `# ` line. A document that is missing or has no body is left out.
 */
export function readPromptDocuments(dir = memoryDir()): Array<{ kind: PromptDocumentKind; body: string }> {
  return PROMPT_DOCUMENTS.flatMap(({ kind, file }) => {
    const text = readFileOf(dir, file)
    const body = text === null ? '' : promptBody(text)
    return body ? [{ kind, body }] : []
  })
}

/** Whether the working tree has no uncommitted change, which the curation job checks before it starts. */
export function isClean(dir = memoryDir()): boolean {
  return git.isClean(dir)
}
