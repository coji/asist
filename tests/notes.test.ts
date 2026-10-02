import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_NOTE_CHARS, applyNoteChange, noteMatches, normalizeNoteMarkdown, summarizeNote } from '@shared/notes'
import { createNoteService } from '../src/main/services/notes'

describe('note summaries', () => {
  it('takes the first heading as the title and reads the rest as plain text, without list, check box or table marks', () => {
    const note = summarizeNote(
      '20260923-153012-a1b2',
      '前置きの行\n\n## 提案書の構成\n\n- [x] 数字を**集める**\n1. [資料](https://example.com)を読む\n\n| 章 | 内容 |\n| --- | :---: |\n| 1 | 結論 |\n',
      5
    )
    expect(note).toMatchObject({ title: '提案書の構成', excerpt: '前置きの行 数字を集める 資料を読む 章 内容 1 結論', updatedAt: 5 })
    expect(note.createdAt).toBe(new Date(2026, 8, 23, 15, 30, 12).getTime())
  })

  it('falls back to the first line for a note without a heading, and cuts a long excerpt', () => {
    const note = summarizeNote('20260923-153012-a1b2', `買い物\n${'あ'.repeat(200)}\n`, 1)
    expect(note.title).toBe('買い物')
    expect(note.excerpt).toBe(`${'あ'.repeat(160)}…`)
  })

  it('matches a note only when every word of the query appears in it, ignoring case', () => {
    const note = { ...summarizeNote('20260923-153012-a1b2', '# Trip\n\n充電器と変換プラグ\n', 1), markdown: '# Trip\n\n充電器と変換プラグ\n' }
    expect(noteMatches(note, 'trip 充電器')).toBe(true)
    expect(noteMatches(note, 'trip 傘')).toBe(false)
  })

  it('keeps the list newest change first as the changes main writes arrive', () => {
    const older = summarizeNote('20260901-090000-0001', '# 旅行\n', 1)
    const newer = summarizeNote('20260902-090000-0002', '# 買い物\n', 2)
    const rewritten = summarizeNote(older.id, '# 旅行の持ち物\n', 3)
    const added = summarizeNote('20260903-090000-0003', '# 提案書\n', 4)
    let notes = applyNoteChange([newer, older], { type: 'saved', note: rewritten })
    expect(notes).toEqual([rewritten, newer])
    notes = applyNoteChange(notes, { type: 'saved', note: added })
    expect(notes).toEqual([added, rewritten, newer])
    expect(applyNoteChange(notes, { type: 'removed', id: newer.id })).toEqual([added, rewritten])
  })

  it('rejects a body that is only whitespace or too long instead of trimming it to fit', () => {
    expect(() => normalizeNoteMarkdown(' \n ')).toThrow()
    expect(() => normalizeNoteMarkdown('a'.repeat(MAX_NOTE_CHARS + 1))).toThrow()
    expect(normalizeNoteMarkdown('# a\r\nb\n\n\n')).toBe('# a\nb\n')
  })
})

describe('note service', () => {
  let directory: string
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'asist-notes-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const setup = () => {
    const trashed: string[] = []
    const changed = vi.fn()
    let second = 0
    const service = createNoteService({
      directory: path.join(directory, 'notes'),
      trash: async (file) => {
        trashed.push(file)
        fs.rmSync(file)
      },
      now: () => new Date(2026, 8, 23, 15, 30, second++),
      random: () => 'abcd',
      onChanged: changed
    })
    return { service, trashed, changed }
  }

  it('writes each note to its own markdown file named by its id, and lists the most recently changed first', async () => {
    const { service, changed } = setup()
    const first = await service.create('# 一つ目\n')
    const second = await service.create('# 二つ目\n')
    expect(first.id).toBe('20260923-153000-abcd')
    expect(fs.readFileSync(path.join(directory, 'notes', `${first.id}.md`), 'utf8')).toBe('# 一つ目\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(directory, 'notes', `${first.id}.md`), later, later)
    expect((await service.list()).map((note) => note.id)).toEqual([first.id, second.id])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('tries another id when the one it drew is taken, rather than overwriting a note', async () => {
    const draws = ['abcd', 'abcd', 'ef01']
    const service = createNoteService({
      directory: path.join(directory, 'notes'),
      trash: async () => {},
      now: () => new Date(2026, 8, 23, 15, 30, 0),
      random: () => draws.shift()!
    })
    await service.create('# 一つ目\n')
    const second = await service.create('# 二つ目\n')
    expect(second.id).toBe('20260923-153000-ef01')
    expect(await service.read('20260923-153000-abcd')).toBe('# 一つ目\n')
  })

  it('refuses an id that is not a note id, so no path outside the folder is read, written or trashed', async () => {
    const { service, trashed } = setup()
    fs.writeFileSync(path.join(directory, 'secret.md'), 'x')
    await expect(service.read('../secret')).rejects.toThrow()
    await expect(service.write('../secret', '# x')).rejects.toThrow()
    await expect(service.remove('../secret')).rejects.toThrow()
    expect(trashed).toEqual([])
    expect(fs.readFileSync(path.join(directory, 'secret.md'), 'utf8')).toBe('x')
  })

  it('overwrites an existing note, refuses to write one that does not exist, and hands a deleted note to the trash', async () => {
    const { service, trashed, changed } = setup()
    const note = await service.create('# 旅行\n')
    const saved = await service.write(note.id, '# 旅行の持ち物\n\n傘\n')
    expect(saved).toMatchObject({ id: note.id, title: '旅行の持ち物', excerpt: '傘' })
    await expect(service.write('20260101-000000-0000', '# x')).rejects.toThrow()
    await service.remove(note.id)
    expect(trashed).toEqual([path.join(directory, 'notes', `${note.id}.md`)])
    expect(await service.list()).toEqual([])
    expect(changed).toHaveBeenLastCalledWith({ type: 'removed', id: note.id })
    await expect(service.remove(note.id)).rejects.toThrow()
  })

  it('tells the listener the note it saved or removed without reading any other note back', async () => {
    const { service, changed } = setup()
    const folder = path.join(directory, 'notes')
    fs.mkdirSync(folder)
    for (const id of ['20260901-090000-0001', '20260902-090000-0002']) fs.writeFileSync(path.join(folder, `${id}.md`), `# ${id}\n`)
    const readFile = vi.spyOn(fsp, 'readFile')
    const created = await service.create('# 新しいメモ\n')
    const rewritten = await service.write(created.id, '# 書き直したメモ\n')
    await service.remove(created.id)
    expect(readFile).not.toHaveBeenCalled()
    expect(changed.mock.calls).toEqual([[{ type: 'saved', note: created }], [{ type: 'saved', note: rewritten }], [{ type: 'removed', id: created.id }]])
  })

  it('finds the notes whose body contains every word, and ignores a stray file in the folder', async () => {
    const { service } = setup()
    await service.create('# 旅行\n\n充電器と傘\n')
    await service.create('# 買い物\n\n傘\n')
    fs.writeFileSync(path.join(directory, 'notes', 'README.md'), '傘 充電器')
    expect((await service.search('充電器 傘')).map((note) => note.title)).toEqual(['旅行'])
    expect(await service.search('')).toHaveLength(2)
  })
})
