import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', conversationLocale: 'ja-JP' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'ja-JP', conversationLocale: mocks.conversationLocale, region: 'JP' })
}))

import * as store from '../src/main/services/memory-store'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { MEMORY_GITIGNORE } from '@shared/memory-curation'
import { PROMPT_DOCUMENTS, PROMPT_DOCUMENT_MAX_TOKENS, promptSize, textForTokens, type DocumentIssue } from '@shared/memory-format'
import { documentIssueText } from '@shared/memory-page'
import CASES from './fixtures/memory-format-cases.json'
import { sectionsOverTheLimit } from './helpers/memory'
import { longTempFolder } from './helpers/temp'

const ja = createTranslator('ja-JP')

const commits = (dir: string): number =>
  Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim())
const git = (dir: string, args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

const PAGE_TEMPLATE =
  '---\naliases: []\nupdated: YYYY-MM-DD\n---\n# 名前\n\n## 要約\nこれが何で、本人とどう関わるか。\n\n## 経緯\nいつ何があったか。\n\n## 私の印象\n私から見てどういう存在か。\n'
const INSTRUCTION = '# いつも覚えておくこと\n\n## この人について\n- 予約サービスの企画担当\n- 猫のムギと暮らす\n'
const USER = '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 属性\n- 予約サービスの企画担当\n- 猫のムギと暮らす\n'
const MATSUBAKEN = `---
aliases: [松葉軒, ラーメン屋]
updated: 2026-09-09
---
# 松葉軒

## 要約
本人の行きつけのラーメン屋。

## 好み
辛さは控えめが好みらしい。替え玉はしないようだ。
`

beforeEach(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-memory-store-'))
  mocks.conversationLocale = 'ja-JP'
  store.ensureRepo()
})

const subjects = (dir: string): string[] => git(dir, ['log', '--format=%s']).split('\n').filter(Boolean)

type DirectoryProblem = { file: string; kind: string } & Record<string, unknown>

/**
 * The sentences ASIST refuses a merge with for a problem the curation's Python reports for a folder. A
 * markdown file beside the documents and a page name another system cannot hold are refused by the Python
 * alone, which only makes the Agent fix more than the merge needs.
 */
function mergeErrors({ file, kind, ...rest }: DirectoryProblem): string[] {
  switch (kind) {
    case 'journalFileName':
      return [ja('memory.check.fileName', { file })]
    case 'formerDocument':
    case 'forgetFile':
      return [ja('memory.check.obsoleteFile', { file })]
    case 'strayFile':
    case 'pageName':
      return []
    default:
      return [documentIssueText(file, { kind, ...rest } as DocumentIssue, ja)]
  }
}

describe('the memory store', () => {
  it('creates pages, journal and .gitignore with one initial commit, and adds nothing on a second call', () => {
    const dir = store.memoryDir()
    for (const name of ['pages', 'journal', '.gitignore', '.git']) {
      expect(fs.existsSync(path.join(dir, name))).toBe(true)
    }
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(MEMORY_GITIGNORE)
    expect(commits(dir)).toBe(1)
    expect(store.isClean()).toBe(true)
    store.ensureRepo()
    expect(commits(dir)).toBe(1)
  })

  it('makes the memory folder a repository of its own inside a repository that git refuses to open', () => {
    const parent = longTempFolder('asist-memory-parent-')
    git(parent, ['init', '-q'])
    // A repository of a form this git does not know, which it refuses as it refuses one owned by another user.
    git(parent, ['config', 'core.repositoryformatversion', '99'])
    const dir = path.join(parent, 'memory')
    store.ensureRepo(dir)
    expect(commits(dir)).toBe(1)
    expect(fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim())).toBe(fs.realpathSync(dir))
  })

  it('reads the pages and the journal into units, leaves the two documents of the prompt out of them, and reports what to fix in all', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'user.md'), '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 好み\nコーヒーは砂糖なし。\n')
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    fs.writeFileSync(path.join(dir, 'pages', '壊れ.md'), '# 壊れ\n\n## 経緯\n書きかけのまま残った。\n')
    fs.writeFileSync(path.join(dir, 'me.md'), '---\nkind: me\n---\n# 私について\n\n## 私は誰か\n落ち着いた声で話す。\n')
    fs.writeFileSync(path.join(dir, 'journal', '2026-09-07.md'), '# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n')
    const result = store.readAll()
    expect(result.pages).toBe(3)
    expect(result.errors).toEqual([
      ja('memory.check.frontmatterMissing', { file: 'pages/壊れ.md' }),
      ja('memory.check.firstHeading', { file: 'pages/壊れ.md', heading: '要約' }),
      ja('memory.check.obsoleteKey', { file: 'me.md', key: 'kind' })
    ])
    expect(result.units.map((u) => [u.file, u.kind, u.page, u.heading, u.text])).toEqual([
      ['pages/壊れ.md', 'section', '壊れ', '経緯', '書きかけのまま残った。'],
      ['pages/松葉軒.md', 'section', '松葉軒', '要約', '本人の行きつけのラーメン屋。'],
      ['pages/松葉軒.md', 'section', '松葉軒', '好み', '辛さは控えめが好みらしい。替え玉はしないようだ。'],
      ['journal/2026-09-07.md', 'journal', '2026-09-07', '四季の話', '春は桜を勧めた。']
    ])
    expect(result.units[1].aliases).toEqual(['松葉軒', 'ラーメン屋'])
    expect(store.listDocuments().map((d) => [d.kind, d.title])).toEqual([
      ['me', '私について'],
      ['user', 'ユーザー'],
      ['page', '壊れ'],
      ['page', '松葉軒'],
      ['journal', '2026-09-07']
    ])
    expect(store.readDocument('journal/2026-09-07.md')).toBe('# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n')
    expect(store.readDocument('journal/2026-09-08.md')).toBeNull()
    expect(() => store.readDocument('../me.md')).toThrow(errorText('memory.errors.notADocument', { file: '../me.md' }))
  })

  it('reports the files an earlier form of the memory kept, instruction.md among them, so that a curation cannot be merged over them', () => {
    const dir = store.memoryDir()
    expect(store.readAll().errors).toEqual([])
    fs.writeFileSync(path.join(dir, 'instruction.md'), INSTRUCTION)
    fs.writeFileSync(path.join(dir, 'profile.md'), '# 要点\n- 猫のムギと暮らす\n')
    fs.writeFileSync(path.join(dir, 'forget.jsonl'), '')
    expect(store.readAll().errors).toEqual([
      ja('memory.check.obsoleteFile', { file: 'profile.md' }),
      ja('memory.check.obsoleteFile', { file: 'forget.jsonl' }),
      ja('memory.check.obsoleteFile', { file: 'instruction.md' })
    ])
    expect(store.listDocuments()).toEqual([])
  })

  it('moves what instruction.md held into me.md and user.md in one commit as it prepares the memory, and leaves nothing for a second start', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'instruction.md'), `${INSTRUCTION}\n## 私について\n落ち着いて短く話す。\n\n## 頼まれていること\n「一言で」と言われたら一言で返す。\n`)
    fs.writeFileSync(path.join(dir, 'user.md'), USER)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'memory'])
    const before = commits(dir)
    store.ensureRepo()
    expect(fs.existsSync(path.join(dir, 'instruction.md'))).toBe(false)
    expect(store.readDocument('user.md')).toBe(`${USER}\n## この人について\n- 予約サービスの企画担当\n- 猫のムギと暮らす\n\n## 頼まれていること\n「一言で」と言われたら一言で返す。\n`)
    expect(store.readDocument('me.md')).toMatch(/^---\nupdated: \d{4}-\d{2}-\d{2}\n---\n# 私について\n\n## 私について\n落ち着いて短く話す。\n$/)
    expect(commits(dir)).toBe(before + 1)
    expect(store.isClean()).toBe(true)
    store.ensureRepo()
    expect(commits(dir)).toBe(before + 1)
  })

  it('leaves instruction.md, me.md and user.md as they were when the commit of the move fails, so that the next start moves them again', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'instruction.md'), INSTRUCTION)
    fs.writeFileSync(path.join(dir, 'user.md'), USER)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'memory'])
    // A lock on the branch fails the commit only after the change is staged.
    const lock = path.join(dir, '.git', 'refs', 'heads', 'main.lock')
    fs.writeFileSync(lock, '')
    expect(() => store.ensureRepo()).toThrow()
    fs.rmSync(lock)
    expect(fs.readFileSync(path.join(dir, 'instruction.md'), 'utf8')).toBe(INSTRUCTION)
    expect(fs.readFileSync(path.join(dir, 'user.md'), 'utf8')).toBe(USER)
    expect(fs.existsSync(path.join(dir, 'me.md'))).toBe(false)
    store.ensureRepo()
    expect(fs.existsSync(path.join(dir, 'instruction.md'))).toBe(false)
    expect(store.readDocument('user.md')).toContain('## この人について\n- 予約サービスの企画担当')
  })

  it('rewrites a whole document and commits it, refuses a save that breaks the rules, creates a page from its template, and deletes a page with a commit', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    const before = commits(dir)
    const saved = store.writeDocument('pages/松葉軒.md', MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。'), MATSUBAKEN)
    expect(saved).toMatchObject({ kind: 'page', title: '松葉軒', summary: '本人の行きつけの店。', headings: ['要約', '好み'] })
    expect(fs.readFileSync(path.join(dir, 'pages', '松葉軒.md'), 'utf8')).toContain('## 要約\n本人の行きつけの店。\n')
    expect(commits(dir)).toBe(before + 1)
    expect(() => store.writeDocument('pages/松葉軒.md', '# 松葉軒\n\n## 好み\n辛さ控えめ\n', store.readDocument('pages/松葉軒.md')!)).toThrow(ja('memory.check.frontmatterMissing', { file: 'pages/松葉軒.md' }))
    expect(store.readDocument('pages/松葉軒.md')).toContain('本人の行きつけの店。')

    const created = store.createPage(' 田中さん ', PAGE_TEMPLATE)
    expect(created).toMatchObject({ file: 'pages/田中さん.md', kind: 'page', title: '田中さん', headings: ['要約', '経緯', '私の印象'] })
    expect(fs.readFileSync(path.join(dir, 'pages', '田中さん.md'), 'utf8')).toMatch(/^---\naliases: \[\]\nupdated: \d{4}-\d{2}-\d{2}\n---\n# 田中さん\n/)
    expect(() => store.createPage('田中さん', PAGE_TEMPLATE)).toThrow(errorText('memory.errors.pageExists', { name: '田中さん' }))
    expect(() => store.createPage('../x', PAGE_TEMPLATE)).toThrow(errorText('memory.errors.nameCharacters'))

    const beforeDelete = commits(dir)
    store.deleteDocument('pages/田中さん.md')
    expect(fs.existsSync(path.join(dir, 'pages', '田中さん.md'))).toBe(false)
    expect(commits(dir)).toBe(beforeDelete + 1)
    expect(() => store.deleteDocument('me.md')).toThrow(errorText('memory.errors.deleteKind'))
    expect(store.isClean()).toBe(true)
  })

  it('refuses to save over a document that changed after the screen read it, and keeps what the other writer added', () => {
    const dir = store.memoryDir()
    const file = 'user.md'
    fs.writeFileSync(path.join(dir, file), USER)
    const opened = store.readDocument(file)!
    // A curation is merged while the user edits the copy read before it.
    const curated = opened.replace('- 猫のムギと暮らす', '- 猫のムギと暮らす\n- 最寄り駅は中野')
    fs.writeFileSync(path.join(dir, file), curated)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'merge curation'])
    const before = commits(dir)
    const draft = opened.replace('- 予約サービスの企画担当', '- 予約サービスの企画担当(2026-09 から)')
    expect(() => store.writeDocument(file, draft, opened)).toThrow(errorText('memory.errors.changedSinceOpened'))
    expect(store.readDocument(file)).toBe(curated)
    expect(commits(dir)).toBe(before)
    // Saved over the version read now, the edit goes through.
    store.writeDocument(file, curated.replace('- 予約サービスの企画担当', '- 予約サービスの企画担当(2026-09 から)'), curated)
    expect(store.readDocument(file)).toContain('- 最寄り駅は中野')
    expect(commits(dir)).toBe(before + 1)
  })

  it('refuses to save a page removed after the screen read it, rather than making it again', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    const opened = store.readDocument('pages/松葉軒.md')!
    fs.rmSync(path.join(dir, 'pages', '松葉軒.md'))
    const draft = opened.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。')
    expect(() => store.writeDocument('pages/松葉軒.md', draft, opened)).toThrow(errorText('memory.errors.removedSinceOpened'))
    expect(store.readDocument('pages/松葉軒.md')).toBeNull()
  })

  it('leaves each file as it was when its commit fails, so that the same save can be made again', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'page'])
    const before = commits(dir)
    // A lock left behind by a git process that died stops every commit until it is removed.
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
    const draft = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。')
    expect(() => store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)).toThrow()
    expect(store.readDocument('pages/松葉軒.md')).toBe(MATSUBAKEN)
    expect(() => store.createPage('田中さん', PAGE_TEMPLATE)).toThrow()
    expect(store.readDocument('pages/田中さん.md')).toBeNull()
    expect(() => store.deleteDocument('pages/松葉軒.md')).toThrow()
    expect(store.readDocument('pages/松葉軒.md')).toBe(MATSUBAKEN)
    fs.rmSync(path.join(dir, '.git', 'index.lock'))
    expect(store.isClean()).toBe(true)
    store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)
    expect(store.readDocument('pages/松葉軒.md')).toBe(draft)
    expect(commits(dir)).toBe(before + 1)
  })

  it('keeps the whole document when writing the new text stops part way, so that the next curation does not commit it cut short', () => {
    const dir = store.memoryDir()
    const file = path.join(dir, 'pages', '松葉軒.md')
    fs.writeFileSync(file, MATSUBAKEN)
    store.ensureRepo()
    const draft = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。駅前にある。')
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (data !== draft) return write(target, data, options)
      // The disk fills after the first half of the new text.
      write(target, draft.slice(0, Math.floor(draft.length / 2)), options)
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })
    try {
      expect(() => store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)).toThrow('ENOSPC')
    } finally {
      vi.restoreAllMocks()
    }
    expect(store.readDocument('pages/松葉軒.md')).toBe(MATSUBAKEN)
    // Every curation commits what is on disk before it cuts its worktree.
    store.ensureRepo()
    expect(git(dir, ['show', 'HEAD:pages/松葉軒.md'])).toBe(MATSUBAKEN)
    store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)
    expect(git(dir, ['show', 'HEAD:pages/松葉軒.md'])).toBe(draft)
  })

  it('leaves the document itself untouched when the new text cannot be written', () => {
    const dir = store.memoryDir()
    const file = path.join(dir, 'pages', '松葉軒.md')
    fs.writeFileSync(file, MATSUBAKEN)
    store.ensureRepo()
    const before = fs.statSync(file, { bigint: true })
    const draft = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。')
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (data === draft) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return write(target, data, options)
    })
    try {
      expect(() => store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)).toThrow('ENOSPC')
    } finally {
      vi.restoreAllMocks()
    }
    const after = fs.statSync(file, { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })

  it('keeps out of the memory the temporary file of a save that a power loss cut off before its rename', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md.0123456789ab.tmp'), MATSUBAKEN.slice(0, 20))
    store.ensureRepo()
    expect(git(dir, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean)).toEqual(['.gitignore', 'pages/松葉軒.md'])
  })

  it('leaves nothing staged when a commit fails after the file was staged, so that a curation can still start', () => {
    const dir = store.memoryDir()
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), MATSUBAKEN)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'page'])
    // A lock on the branch fails the commit only after the change is staged, where a lock on the index fails it before.
    const lock = path.join(dir, '.git', 'refs', 'heads', 'main.lock')
    fs.writeFileSync(lock, '')
    const draft = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。')
    expect(() => store.writeDocument('pages/松葉軒.md', draft, MATSUBAKEN)).toThrow()
    fs.rmSync(lock)
    expect(store.readDocument('pages/松葉軒.md')).toBe(MATSUBAKEN)
    expect(store.isClean()).toBe(true)
  })

  // Windows has no named pipe in a folder (mkfifo); the refusal of a symbolic link below runs on both.
  it.runIf(process.platform !== 'win32')('refuses a named pipe at once instead of waiting for a writer, since git never shows one in a curation worktree', () => {
    const dir = store.memoryDir()
    const pipe = path.join(dir, 'pages', 'x.md')
    execFileSync('mkfifo', [pipe])
    // A writer opens the pipe after 1.5 seconds, so that a read that waits ends instead of hanging the run.
    spawn('sh', ['-c', `sleep 1.5; printf '# x\\n' > '${pipe}'`], { detached: true, stdio: 'ignore' }).unref()
    const started = Date.now()
    expect(() => store.readAll()).toThrow(errorText('memory.errors.notRegular', { file: 'pages/x.md' }))
    expect(Date.now() - started).toBeLessThan(500)
    expect(() => store.listDocuments()).toThrow(errorText('memory.errors.notRegular', { file: 'pages/x.md' }))
  })

  it('reads no file through a symbolic link, neither one in place of a document nor one in place of pages/', () => {
    const dir = store.memoryDir()
    const outside = mkdtempSync(path.join(tmpdir(), 'asist-memory-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.md'), MATSUBAKEN)
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'user.md'))
    expect(() => store.readAll()).toThrow(errorText('memory.errors.notRegular', { file: 'user.md' }))
    expect(() => store.readDocument('user.md')).toThrow(errorText('memory.errors.notRegular', { file: 'user.md' }))
    fs.rmSync(path.join(dir, 'user.md'))
    fs.rmSync(path.join(dir, 'pages'), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'pages'))
    expect(() => store.readAll()).toThrow(errorText('memory.errors.notRegular', { file: 'pages' }))
  })

  it('reads a document that a save by rename replaced between the look at it and the open', () => {
    const dir = store.memoryDir()
    const document = path.join(dir, 'user.md')
    fs.writeFileSync(document, '# 本人\n')
    const open = fs.openSync
    let saves = 0
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: number) => {
      if (saves++ === 0) {
        fs.writeFileSync(`${document}.saving`, '# 本人\n\n## 好み\n麺類。\n')
        fs.renameSync(`${document}.saving`, document)
      }
      return open(target, flags)
    }) as never)
    try {
      expect(store.readDocument('user.md')).toBe('# 本人\n\n## 好み\n麺類。\n')
    } finally {
      vi.restoreAllMocks()
    }
  })

  describe('on Windows, which has no O_NOFOLLOW and whose open follows a link or a junction', () => {
    /** Opens as Windows does, where both flags are 0. beforeOpen runs between the look at the file and the open. */
    const openAsWindows = (beforeOpen: () => void = () => {}): void => {
      const open = fs.openSync
      const unixOnly = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: number) => {
        beforeOpen()
        return open(target, flags & ~unixOnly)
      }) as never)
    }
    const secretOutside = (): string => {
      const secret = path.join(mkdtempSync(path.join(tmpdir(), 'asist-memory-outside-')), 'secret.md')
      fs.writeFileSync(secret, MATSUBAKEN)
      return secret
    }

    it('reads no file through a link in place of a document', () => {
      const dir = store.memoryDir()
      fs.symlinkSync(secretOutside(), path.join(dir, 'user.md'))
      openAsWindows()
      try {
        expect(() => store.readDocument('user.md')).toThrow(errorText('memory.errors.notRegular', { file: 'user.md' }))
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('refuses a document that a link replaced between the look at it and the open', () => {
      const dir = store.memoryDir()
      const document = path.join(dir, 'user.md')
      fs.writeFileSync(document, '# 本人\n')
      const secret = secretOutside()
      openAsWindows(() => {
        fs.rmSync(document)
        fs.symlinkSync(secret, document)
      })
      try {
        expect(() => store.readDocument('user.md')).toThrow(errorText('memory.errors.notRegular', { file: 'user.md' }))
      } finally {
        vi.restoreAllMocks()
      }
    })
  })

  it('writes a page name holding the dollar patterns of a replacement string as it was given, in the page and in the commit', () => {
    const dir = store.memoryDir()
    for (const name of ['Ke$$ha', 'A$&B', "C$'D", 'E$`F']) {
      const created = store.createPage(name, PAGE_TEMPLATE)
      expect(created).toMatchObject({ file: `pages/${name}.md`, title: name })
      expect(fs.readFileSync(path.join(dir, created.file), 'utf8')).toContain(`\n# ${name}\n`)
      expect(subjects(dir)[0]).toBe(`asist: ページを作る ${name}`)
    }
  })

  it('reads me.md and user.md for the prompt in that order, without their frontmatter and name lines, leaving out one with no body', () => {
    const dir = store.memoryDir()
    expect(store.readPromptDocuments()).toEqual([])
    fs.writeFileSync(path.join(dir, 'user.md'), '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 好み\nコーヒーは砂糖なし。\n')
    fs.writeFileSync(path.join(dir, 'me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n')
    expect(store.readPromptDocuments()).toEqual([{ kind: 'user', body: '## 好み\nコーヒーは砂糖なし。' }])
    fs.writeFileSync(path.join(dir, 'me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n\n落ち着いた声で話す。\n')
    expect(store.readPromptDocuments()).toEqual([
      { kind: 'me', body: '落ち着いた声で話す。' },
      { kind: 'user', body: '## 好み\nコーヒーは砂糖なし。' }
    ])
  })

  it('refuses a save from the memory screen that takes a document of the prompt over its limit, and leaves the file as it was', () => {
    const dir = store.memoryDir()
    const user = '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 好み\nコーヒーは砂糖なし。\n'
    fs.writeFileSync(path.join(dir, 'user.md'), user)
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'user'])
    const long = user.replace('## 好み\nコーヒーは砂糖なし。', sectionsOverTheLimit('麺類が好きで、辛さは控えめを選ぶ。'))
    let refused: unknown = null
    try {
      store.writeDocument('user.md', long, user)
    } catch (error) {
      refused = error
    }
    expect(fs.readFileSync(path.join(dir, 'user.md'), 'utf8')).toBe(user)
    const size = promptSize(long)
    expect((refused as Error | null)?.message).toBe(
      ja('memory.check.tooManyTokens', {
        file: 'user.md',
        tokens: size.tokens,
        limit: PROMPT_DOCUMENT_MAX_TOKENS,
        characters: textForTokens(size, size.tokens - PROMPT_DOCUMENT_MAX_TOKENS).characters
      })
    )
    expect(store.writeDocument('user.md', user.replace('砂糖なし', 'ミルク入り'), user).file).toBe('user.md')
  })

  it('writes its own commits in the language the memory is written in', () => {
    const dir = store.memoryDir()
    expect(subjects(dir)).toEqual(['asist: 記憶の置き場を作る'])
    mocks.conversationLocale = 'de-DE'
    const page = '---\nupdated: 2026-09-09\n---\n# Matsubaken\n\n## Summary\nThe ramen shop.\n'
    fs.writeFileSync(path.join(dir, 'pages', 'Matsubaken.md'), page)
    store.writeDocument('pages/Matsubaken.md', page.replace('The ramen shop.', 'The ramen shop they keep going back to.'), page)
    store.createPage('Tanaka', PAGE_TEMPLATE.replace('## 要約', '## Summary'))
    store.deleteDocument('pages/Tanaka.md')
    expect(subjects(dir).slice(0, 4)).toEqual([
      'asist: delete pages/Tanaka.md',
      'asist: create the page Tanaka',
      'asist: edit pages/Matsubaken.md',
      'asist: 記憶の置き場を作る'
    ])
  })

  it('reads every folder of the shared cases as the curation Python does, and refuses a merge for nothing the Python passes', () => {
    for (const { name, files, problems, sizes } of CASES.directories) {
      const dir = mkdtempSync(path.join(tmpdir(), 'asist-memory-case-'))
      for (const [file, content] of Object.entries(files as Record<string, string | { hex: string }>)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : Buffer.from(content.hex, 'hex'))
      }
      const refused = (problems as DirectoryProblem[]).flatMap(mergeErrors)
      expect([name, [...store.readAll(dir).errors].sort()]).toEqual([name, refused.sort()])
      const read = Object.fromEntries(PROMPT_DOCUMENTS.map(({ file }) => [file, ((text) => (text === null ? null : promptSize(text)))(store.readDocument(file, dir))]))
      expect([name, read]).toEqual([name, sizes])
    }
  })
})
