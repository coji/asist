import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  MAX_NOTE_CHARS,
  applyNoteChanges,
  byUpdated,
  isNoteId,
  noteMatches,
  normalizeNoteMarkdown,
  summarizeNote,
  type NoteChange,
  type NoteSummary
} from '@shared/notes'
import { createNoteService, type NoteService, type NoteServiceOptions } from '../src/main/services/notes'

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

  it('keeps the list newest change first as the changes main sends arrive, applying those sent together in their order', () => {
    const older = summarizeNote('20260901-090000-0001', '# 旅行\n', 1)
    const newer = summarizeNote('20260902-090000-0002', '# 買い物\n', 2)
    const rewritten = summarizeNote(older.id, '# 旅行の持ち物\n', 3)
    const added = summarizeNote('20260903-090000-0003', '# 提案書\n', 4)
    let notes = applyNoteChanges([newer, older], [{ type: 'saved', note: rewritten }])
    expect(notes).toEqual([rewritten, newer])
    notes = applyNoteChanges(notes, [{ type: 'saved', note: added }])
    expect(notes).toEqual([added, rewritten, newer])
    expect(applyNoteChanges(notes, [{ type: 'removed', id: newer.id }])).toEqual([added, rewritten])
    const restored = summarizeNote(newer.id, '# 買い物\n', 5)
    expect(
      applyNoteChanges(notes, [
        { type: 'removed', id: added.id },
        { type: 'saved', note: restored },
        { type: 'removed', id: restored.id },
        { type: 'saved', note: restored }
      ])
    ).toEqual([restored, rewritten])
  })

  it('rejects a body that is only whitespace or too long instead of trimming it to fit', () => {
    expect(() => normalizeNoteMarkdown(' \n ')).toThrow()
    expect(() => normalizeNoteMarkdown('a'.repeat(MAX_NOTE_CHARS + 1))).toThrow()
    expect(normalizeNoteMarkdown('# a\r\nb\n\n\n')).toBe('# a\nb\n')
  })
})

describe('note service', () => {
  let directory: string
  let services: NoteService[]
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'asist-notes-'))
    services = []
  })
  afterEach(() => {
    for (const service of services) service.close()
    vi.restoreAllMocks()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const folderOf = (): string => path.join(directory, 'notes')
  const fileOf = (id: string): string => path.join(folderOf(), `${id}.md`)
  const make = (options: Omit<NoteServiceOptions, 'directory'>): NoteService => {
    const service = createNoteService({ directory: folderOf(), ...options })
    services.push(service)
    return service
  }
  const setup = () => {
    const trashed: string[] = []
    const changed = vi.fn()
    let second = 0
    const service = make({
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
  /** Every note file in the folder as the service should hold it, newest change first. */
  const onDisk = (): NoteSummary[] => {
    if (!fs.existsSync(folderOf())) return []
    return fs
      .readdirSync(folderOf())
      .filter((name) => name.endsWith('.md') && isNoteId(name.slice(0, -3)))
      .map((name) => summarizeNote(name.slice(0, -3), fs.readFileSync(path.join(folderOf(), name), 'utf8'), fs.statSync(path.join(folderOf(), name)).mtimeMs))
      .sort(byUpdated)
  }
  const showsWhatIsOnDisk = (shown: () => NoteSummary[]): Promise<void> =>
    vi.waitFor(() => expect(shown()).toEqual(onDisk()), { timeout: 10_000, interval: 20 })
  /**
   * Returns once the watch reports: on macOS a watch reports only from a moment after it opens. A note is
   * written again until the screen shows what was last written twice in a row, since a look at the whole
   * folder can show the first, and is then removed.
   */
  const watching = async (shown: () => NoteSummary[]): Promise<void> => {
    const probe = '20200101-000000-0000'
    let streak = 0
    for (let attempt = 0; attempt < 50 && streak < 2; attempt++) {
      const title = String(attempt)
      fs.writeFileSync(fileOf(probe), `# ${title}\n`)
      const seen = await vi.waitFor(() => expect(shown().find((note) => note.id === probe)?.title).toBe(title), { timeout: 200, interval: 10 }).then(
        () => true,
        () => false
      )
      streak = seen ? streak + 1 : 0
    }
    fs.rmSync(fileOf(probe))
    await showsWhatIsOnDisk(shown)
  }
  /** What the notes screen shows: the list it read once, with every change it was told from then on. */
  const screen = async (service: NoteService, changed: Mock): Promise<() => NoteSummary[]> => {
    const from = changed.mock.calls.length
    const list = await service.list()
    const shown = (): NoteSummary[] =>
      changed.mock.calls.slice(from).reduce<NoteSummary[]>((notes, [changes]) => applyNoteChanges(notes, changes as NoteChange[]), list)
    await watching(shown)
    return shown
  }
  /** Stands between fs.watch and the service, to keep events from it or to hand it events the system did not send. */
  const tapWatches = () => {
    const watch = fs.watch.bind(fs)
    const tap = { deaf: false, folder: [] as Array<{ listener: (event: string, name: string | null) => void; watcher: fs.FSWatcher }>, open: new Set<fs.FSWatcher>() }
    vi.spyOn(fs, 'watch').mockImplementation(((target: string, options: fs.WatchOptions, listener: (event: string, name: string | null) => void) => {
      const watcher = watch(target, options, (event, name) => {
        if (!tap.deaf) listener(event, name)
      })
      const close = watcher.close.bind(watcher)
      watcher.close = () => {
        tap.open.delete(watcher)
        close()
      }
      tap.open.add(watcher)
      if (target === folderOf()) tap.folder.push({ listener, watcher })
      return watcher
    }) as typeof fs.watch)
    return tap
  }
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('writes each note to its own markdown file named by its id, and lists the most recently changed first', async () => {
    const { service, changed } = setup()
    const first = await service.create('# 一つ目\n')
    const second = await service.create('# 二つ目\n')
    expect(first.id).toBe('20260923-153000-abcd')
    expect(fs.readFileSync(fileOf(first.id), 'utf8')).toBe('# 一つ目\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(fileOf(first.id), later, later)
    expect((await service.list()).map((note) => note.id)).toEqual([first.id, second.id])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('tries another id when the one it drew is taken, rather than overwriting a note', async () => {
    const draws = ['abcd', 'abcd', 'ef01']
    const service = make({ trash: async () => {}, now: () => new Date(2026, 8, 23, 15, 30, 0), random: () => draws.shift()! })
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
    expect(trashed).toEqual([fileOf(note.id)])
    expect(await service.list()).toEqual([])
    expect(changed).toHaveBeenLastCalledWith([{ type: 'removed', id: note.id }])
    await expect(service.remove(note.id)).rejects.toThrow()
  })

  it('finds the notes whose body contains every word, and ignores a stray file in the folder', async () => {
    const { service } = setup()
    await service.create('# 旅行\n\n充電器と傘\n')
    await service.create('# 買い物\n\n傘\n')
    fs.writeFileSync(path.join(folderOf(), 'README.md'), '傘 充電器')
    expect((await service.search('充電器 傘')).map((note) => note.title)).toEqual(['旅行'])
    expect(await service.search('')).toHaveLength(2)
  })

  it('answers the list, a search and a note from what it holds, without reading the notes again', async () => {
    const { service } = setup()
    const trip = await service.create('# 旅行\n\n充電器と傘\n')
    await service.create('# 買い物\n\n牛乳\n')
    expect(await service.list()).toHaveLength(2)
    const readFile = vi.spyOn(fsp, 'readFile')
    for (let i = 0; i < 3; i++) expect((await service.search('充電器')).map((note) => note.id)).toEqual([trip.id])
    expect((await service.list()).map((note) => note.title)).toEqual(['買い物', '旅行'])
    expect(await service.read(trip.id)).toBe('# 旅行\n\n充電器と傘\n')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reports a note as saved once its file is in place, even when the file cannot be looked at afterwards', async () => {
    const { service, changed } = setup()
    const stat = fsp.stat.bind(fsp)
    vi.spyOn(fsp, 'stat').mockImplementation(async (file, options) => {
      if (String(file).endsWith('.md')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return stat(file, options)
    })
    const note = await service.create('# 旅行\n')
    expect(fs.readFileSync(fileOf(note.id), 'utf8')).toBe('# 旅行\n')
    expect(note.updatedAt).toBe(fs.statSync(fileOf(note.id)).mtimeMs)
    expect(changed).toHaveBeenCalledWith([{ type: 'saved', note }])
  })

  it('tells the listener each note it saved or removed once, and reads none of them back when the watch sees its writes', async () => {
    const { service, changed } = setup()
    fs.mkdirSync(folderOf())
    for (const id of ['20260901-090000-0001', '20260902-090000-0002']) fs.writeFileSync(fileOf(id), `# ${id}\n`)
    const shown = await screen(service, changed)
    const from = changed.mock.calls.length
    const readFile = vi.spyOn(fsp, 'readFile')
    const created = await service.create('# 新しいメモ\n')
    const rewritten = await service.write(created.id, '# 書き直したメモ\n')
    await service.remove(created.id)
    // The watch reports in order, so once this note is shown, it has seen the writes above as well.
    const outside = '20260903-090000-0003'
    fs.writeFileSync(fileOf(outside), '# 外で書いたメモ\n')
    await showsWhatIsOnDisk(shown)
    expect(readFile.mock.calls.map(([file]) => file)).toEqual([fileOf(outside)])
    expect(changed.mock.calls.slice(from).map(([changes]) => changes)).toEqual([
      [{ type: 'saved', note: created }],
      [{ type: 'saved', note: rewritten }],
      [{ type: 'removed', id: created.id }],
      [{ type: 'saved', note: expect.objectContaining({ id: outside, title: '外で書いたメモ' }) }]
    ])
  }, 30_000)

  it('shows a note added, edited, saved over, trashed, put back or deleted outside ASIST without being asked again', async () => {
    const { service, changed } = setup()
    await service.create('# 旅行\n\n充電器\n')
    const shown = await screen(service, changed)
    const id = '20260920-080000-0e0e'
    fs.writeFileSync(fileOf(id), '# 外で書いたメモ\n')
    await showsWhatIsOnDisk(shown)
    expect((await service.search('外で書いた')).map((note) => note.id)).toEqual([id])
    fs.appendFileSync(fileOf(id), '\n書き足した行\n')
    await showsWhatIsOnDisk(shown)
    expect(await service.read(id)).toBe('# 外で書いたメモ\n\n書き足した行\n')
    // An editor that saves to a temporary file and renames it over the note.
    const temporary = path.join(folderOf(), `.${id}.md.swp`)
    fs.writeFileSync(temporary, '# 書き直したメモ\n')
    fs.renameSync(temporary, fileOf(id))
    await showsWhatIsOnDisk(shown)
    const trash = path.join(directory, `${id}.md`)
    fs.renameSync(fileOf(id), trash)
    await showsWhatIsOnDisk(shown)
    fs.renameSync(trash, fileOf(id))
    await showsWhatIsOnDisk(shown)
    expect(shown().map((note) => note.title)).toContain('書き直したメモ')
    fs.rmSync(fileOf(id))
    await showsWhatIsOnDisk(shown)
    expect(await service.search('書き直した')).toEqual([])
    await expect(service.read(id)).rejects.toThrow()
  }, 30_000)

  it('keeps up with a burst of notes written, edited and deleted outside ASIST, and tells the screen in a few messages', async () => {
    const { service, changed } = setup()
    await service.create('# 最初のメモ\n')
    const shown = await screen(service, changed)
    const before = changed.mock.calls.length
    const ids = Array.from({ length: 600 }, (_, i) => `20260801-0900${String(i % 60).padStart(2, '0')}-${i.toString(16).padStart(4, '0')}`)
    for (const id of ids) fs.writeFileSync(fileOf(id), `# メモ ${id}\n`)
    for (const id of ids.slice(0, 200)) fs.appendFileSync(fileOf(id), '\n書き足した行\n')
    for (const id of ids.slice(400)) fs.rmSync(fileOf(id))
    await showsWhatIsOnDisk(shown)
    expect(shown()).toHaveLength(401)
    expect(await service.list()).toEqual(onDisk())
    // One message per note would have the screen sort its whole list a thousand times.
    expect(changed.mock.calls.length - before).toBeLessThan(100)
  }, 30_000)

  it('follows the folder when it is trashed and put back, replaced by another, or deleted and made again by a save', async () => {
    const { service, changed } = setup()
    await service.create('# 旅行\n')
    await service.create('# 買い物\n')
    const shown = await screen(service, changed)
    const trash = path.join(directory, 'trash')
    fs.renameSync(folderOf(), trash)
    await showsWhatIsOnDisk(shown)
    expect(shown()).toEqual([])
    fs.renameSync(trash, folderOf())
    await showsWhatIsOnDisk(shown)
    expect(shown()).toHaveLength(2)
    const backup = path.join(directory, 'backup')
    fs.mkdirSync(backup)
    fs.writeFileSync(path.join(backup, '20250101-090000-0b0b.md'), '# バックアップのメモ\n')
    fs.renameSync(folderOf(), path.join(directory, 'replaced'))
    fs.renameSync(backup, folderOf())
    await showsWhatIsOnDisk(shown)
    expect(shown().map((note) => note.title)).toEqual(['バックアップのメモ'])
    fs.writeFileSync(fileOf('20250102-090000-0c0c'), '# 置き換えた先のメモ\n')
    await showsWhatIsOnDisk(shown)
    fs.rmSync(folderOf(), { recursive: true })
    await showsWhatIsOnDisk(shown)
    expect(shown()).toEqual([])
    await service.create('# 消したあとのメモ\n')
    fs.writeFileSync(fileOf('20250103-090000-0d0d'), '# 外から足したメモ\n')
    await showsWhatIsOnDisk(shown)
    expect(shown()).toHaveLength(2)
    expect(await service.list()).toEqual(onDisk())
  }, 30_000)

  it('looks at the whole folder again when an event names no entry, the folder itself or a short 8.3 name, as Windows reports lost events, a folder being deleted and a note removed under its short name', async () => {
    const tap = tapWatches()
    const { service, changed } = setup()
    const trip = await service.create('# 旅行\n')
    const plan = await service.create('# 提案書\n')
    const shown = await screen(service, changed)
    tap.deaf = true
    fs.writeFileSync(fileOf('20260920-080000-0e0e'), '# 届かなかったメモ\n')
    fs.rmSync(fileOf(trip.id))
    await pause(300)
    expect(shown()).not.toEqual(onDisk())
    tap.deaf = false
    tap.folder.at(-1)!.listener('rename', null)
    await showsWhatIsOnDisk(shown)
    tap.deaf = true
    fs.rmSync(fileOf(plan.id))
    await pause(300)
    tap.deaf = false
    tap.folder.at(-1)!.listener('rename', '202609~1.MD')
    await showsWhatIsOnDisk(shown)
    expect(shown().map((note) => note.title)).toEqual(['届かなかったメモ'])
    tap.deaf = true
    fs.rmSync(folderOf(), { recursive: true })
    await pause(300)
    tap.deaf = false
    tap.folder.at(-1)!.listener('rename', folderOf())
    await showsWhatIsOnDisk(shown)
    expect(shown()).toEqual([])
  }, 30_000)

  it('looks at the whole folder again when its watch fails and is opened again', async () => {
    const tap = tapWatches()
    const { service, changed } = setup()
    await service.create('# 旅行\n')
    const shown = await screen(service, changed)
    tap.deaf = true
    fs.writeFileSync(fileOf('20260920-080000-0e0e'), '# 届かなかったメモ\n')
    await pause(300)
    tap.deaf = false
    tap.folder.at(-1)!.watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }))
    await showsWhatIsOnDisk(shown)
    expect(shown()).toHaveLength(2)
  }, 30_000)

  it('folds the events that arrive while it looks at the whole folder into one more look, so that a search waits for one look at most', async () => {
    const tap = tapWatches()
    fs.mkdirSync(folderOf())
    for (let i = 0; i < 500; i++) fs.writeFileSync(fileOf(`20250101-0000${String(i % 60).padStart(2, '0')}-${i.toString(16).padStart(4, '0')}`), `# メモ ${i}\n`)
    const { service } = setup()
    await service.list()
    const readdir = fsp.readdir.bind(fsp)
    // Each look at the whole folder is made to take 300 ms more, as one of 40,000 notes takes under load.
    const reads = vi.spyOn(fsp, 'readdir').mockImplementation((async (folder: fs.PathLike, options?: unknown) => {
      if (String(folder) === folderOf()) await pause(300)
      return readdir(folder, options as never)
    }) as typeof fsp.readdir)
    const waits: Promise<number>[] = []
    const end = Date.now() + 1500
    for (let i = 0; Date.now() < end; i++) {
      tap.folder.at(-1)!.listener('change', null)
      if (i % 10 === 0) {
        const start = Date.now()
        waits.push(service.search('メモ 1').then(() => Date.now() - start))
      }
      await pause(20)
    }
    const waited = Math.max(...(await Promise.all(waits)))
    const looks = reads.mock.calls.filter(([folder]) => String(folder) === folderOf()).length
    // Events every 20 ms for 1.5 s would make fifteen looks if each 100 ms of them made one.
    expect(looks).toBeLessThan(8)
    expect(waited).toBeLessThan(2000)
  }, 30_000)

  it('lists, finds and reads the other notes when one cannot be read, reads each note once, and says why that one cannot be read', async () => {
    const { service } = setup()
    const trip = await service.create('# 旅行\n\n傘\n')
    const plan = await service.create('# 提案書\n\n傘\n')
    const readFile = fsp.readFile.bind(fsp)
    const reads = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
      if (String(file) === fileOf(plan.id)) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
      return readFile(file, options as never)
    }) as typeof fsp.readFile)
    expect((await service.list()).map((note) => note.id)).toEqual([trip.id])
    expect((await service.search('傘')).map((note) => note.id)).toEqual([trip.id])
    expect(await service.read(trip.id)).toBe('# 旅行\n\n傘\n')
    await expect(service.read(plan.id)).rejects.toThrow('EACCES')
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('leaves nothing watching when it is closed while it reads the folder', async () => {
    const tap = tapWatches()
    const { service } = setup()
    await service.create('# 旅行\n')
    const readdir = fsp.readdir.bind(fsp)
    let reading!: () => void
    const read = new Promise<void>((resolve) => (reading = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fsp, 'readdir').mockImplementation((async (folder: fs.PathLike, options?: unknown) => {
      if (String(folder) === folderOf()) {
        reading()
        await gate
      }
      return readdir(folder, options as never)
    }) as typeof fsp.readdir)
    const listed = service.list()
    await read
    expect(tap.open.size).toBeGreaterThan(0)
    service.close()
    release()
    await listed
    expect(tap.open.size).toBe(0)
  })

  it('follows the folder when it is moved elsewhere and a link to it is put in its place, as a synced folder is set up', async () => {
    const { service, changed } = setup()
    await service.create('# 旅行\n')
    const shown = await screen(service, changed)
    const elsewhere = path.join(directory, 'synced', 'notes')
    fs.mkdirSync(path.dirname(elsewhere))
    fs.renameSync(folderOf(), elsewhere)
    fs.symlinkSync(elsewhere, folderOf(), 'junction')
    await watching(shown)
    fs.writeFileSync(fileOf('20260920-080000-0e0e'), '# リンクの先で書いたメモ\n')
    await showsWhatIsOnDisk(shown)
    expect(shown()).toHaveLength(2)
  }, 60_000)
})
