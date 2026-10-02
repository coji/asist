import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryUnit } from '@shared/ipc'
import { INJECTION_MAX_BM25, MemoryIndex } from '../src/main/services/memory-index'

let dir = ''
let index: MemoryIndex

const unit = (id: string, text: string, extra: Partial<MemoryUnit> = {}): MemoryUnit => ({
  id,
  file: 'pages/松葉軒.md',
  line: 1,
  kind: 'section',
  page: '松葉軒',
  heading: '要約',
  aliases: ['ラーメン屋'],
  text,
  date: '2026-09-08',
  order: 0,
  ...extra
})
const v = (...values: number[]): Float32Array => new Float32Array(values)
const inputFor = (id: string) => index.missingEmbeddings(100).find((input) => input.id === id)!

const UNITS: MemoryUnit[] = [
  unit('u1', '本人の行きつけのラーメン屋。'),
  unit('u1b', '辛さは控えめが好みらしい。', { heading: '好み', order: 2 }),
  unit('u2', '本人の猫。キジトラで窓辺によくいる。', { file: 'pages/ムギ.md', page: 'ムギ', aliases: ['猫', 'うちの猫'] }),
  unit('u4', '春は桜を勧めた。', { file: 'journal/2026-09-07.md', kind: 'journal', page: '2026-09-07', heading: '四季の話', aliases: [], date: '2026-09-07' }),
  unit('u5', '最寄り駅は中野', { file: 'user.md', page: 'ユーザー', heading: '住まい', aliases: [], date: '2026-09-09' })
]

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'asist-memory-index-'))
  index = new MemoryIndex(path.join(dir, 'index.db'))
  index.setEmbeddingModel('model-a')
  index.rebuild(UNITS)
})

afterEach(() => {
  index.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryIndex', () => {
  it('lists the rebuilt units by file and by their order inside the page, and looks one up by id', () => {
    expect(index.count).toBe(5)
    expect(index.list().map((u) => u.id)).toEqual(['u4', 'u2', 'u1', 'u1b', 'u5'])
    expect(index.get('u4')).toMatchObject({ kind: 'journal', date: '2026-09-07' })
    expect(index.get('nope')).toBeNull()
  })

  it('returns the lexical hits of a keyword search in bm25 order and filters them by kind', () => {
    expect(index.search('春は桜').map((h) => h.record.id)).toEqual(['u4'])
    expect(index.search('春は桜', { kinds: ['section'] })).toEqual([])
    const hits = index.search('キジトラ')
    expect(hits[0]).toMatchObject({ record: { id: 'u2' }, via: 'lexical', exact: false })
    expect(hits[0].bm25).toBeLessThan(0)
  })

  it('finds a memory by a keyword of one kanji in its text or its alias, without taking the one-character alias for an exact name', () => {
    expect(index.search('桜').map((h) => h.record.id)).toEqual(['u4'])
    // The last character of "最寄り駅は中野" begins no bigram.
    expect(index.search('野').map((h) => h.record.id)).toEqual(['u5'])
    // A one-character alias such as "猫" matches almost anything, so it is never used for an exact match.
    const hits = index.search('猫')
    expect(hits.map((h) => h.record.id)).toEqual(['u2'])
    expect(hits[0]).toMatchObject({ via: 'lexical', exact: false })
  })

  it('puts the summary of the page the utterance names or aliases exactly on top, and drops the weak lexical-only hits', () => {
    const hits = index.search('松葉軒行ったんだけどさあ', { mode: 'utterance' })
    expect(hits[0]).toMatchObject({ record: { id: 'u1' }, exact: true })
    expect(hits.every((h) => h.exact || (h.bm25 ?? 0) <= INJECTION_MAX_BM25.bigram || h.via !== 'lexical')).toBe(true)
    expect(index.search('うちの猫がうるさい', { mode: 'utterance' })[0]).toMatchObject({ record: { id: 'u2' }, exact: true })
    // Only the summary is guaranteed by an exact match; the other headings depend on their score.
    expect(index.search('松葉軒', { mode: 'utterance' }).filter((h) => h.exact).map((h) => h.record.id)).toEqual(['u1'])
  })

  it('mixes in the cosine hits when the query carries a vector, so a paraphrase no lexical search finds still comes back', () => {
    index.setEmbedding(inputFor('u1'), v(1, 0, 0))
    index.setEmbedding(inputFor('u2'), v(0, 1, 0))
    expect(index.search('お昼は麺類の気分', { mode: 'utterance' })).toEqual([])
    const hits = index.search('お昼は麺類の気分', { mode: 'utterance', queryVector: v(0.95, 0.05, 0) })
    expect(hits.map((h) => h.record.id)).toEqual(['u1'])
    expect(hits[0]).toMatchObject({ via: 'dense', exact: false })
    expect(hits[0].cosine).toBeGreaterThan(0.9)
  })

  it('keeps a vector across a rebuild while its input is unchanged, drops the one of a removed unit, and embeds the page name and a heading the curation chose with the text', () => {
    index.setEmbedding(inputFor('u1'), v(1, 0))
    index.setEmbedding(inputFor('u5'), v(0, 1))
    expect(index.embeddingCounts()).toEqual({ embedded: 2, total: 5 })
    index.rebuild(UNITS.filter((u) => u.id !== 'u5'))
    expect(index.embeddingCounts()).toEqual({ embedded: 1, total: 4 })
    const missing = index.missingEmbeddings(10)
    expect(missing.map((m) => m.id).sort()).toEqual(['u1b', 'u2', 'u4'])
    expect(missing.find((m) => m.id === 'u1b')?.text).toBe('松葉軒 好み: 辛さは控えめが好みらしい。')
    expect(missing.find((m) => m.id === 'u2')?.text).toBe('ムギ: 本人の猫。キジトラで窓辺によくいる。')
    expect(missing.find((m) => m.id === 'u4')?.text).toBe('2026-09-07の日記 四季の話: 春は桜を勧めた。')
    index.clearEmbeddings()
    expect(index.embeddingCounts().embedded).toBe(0)
  })

  it.each([
    { text: '今は自炊することが多い。' },
    { page: '新しい店名' },
    { heading: '最近の暮らし' }
  ])('recomputes only the units whose embedding input changed, and rejects a result computed from the old input: %j', (patch) => {
    const before = inputFor('u1')
    index.setEmbedding(before, v(1, 0))
    index.setEmbedding(inputFor('u2'), v(0, 1))
    index.rebuild(UNITS.map((u) => u.id === 'u1' ? { ...u, ...patch } : u))

    expect(index.embeddingCounts()).toEqual({ embedded: 1, total: 5 })
    expect(inputFor('u1').fingerprint).not.toBe(before.fingerprint)
    expect(index.setEmbedding(before, v(1, 0))).toBe(false)
    expect(index.setEmbedding(inputFor('u1'), v(0.5, 0.5))).toBe(true)
    expect(index.embeddingCounts().embedded).toBe(2)
  })

  it('treats a change of the record date as a change of the embedding input', () => {
    const before = inputFor('u4')
    index.setEmbedding(before, v(1, 0))
    index.rebuild(UNITS.map((u) => u.id === 'u4' ? { ...u, date: '2026-09-10' } : u))

    expect(inputFor('u4').fingerprint).not.toBe(before.fingerprint)
    expect(index.setEmbedding(before, v(1, 0))).toBe(false)
    expect(index.embeddingCounts().embedded).toBe(0)
  })

  it('reuses the vector across a restart and a rebuild when only the line or the aliases changed, which the embedding does not read', () => {
    index.setEmbedding(inputFor('u1'), v(1, 0))
    index.close()
    index = new MemoryIndex(path.join(dir, 'index.db'))
    index.rebuild(UNITS.map((u) => u.id === 'u1' ? { ...u, line: 10, order: 7, aliases: ['新しい別名'] } : u))

    expect(index.missingEmbeddings(100).map((input) => input.id)).not.toContain('u1')
    expect(index.embeddingCounts()).toEqual({ embedded: 1, total: 5 })
  })

  it('does not store the vector of a unit that was removed while it was being computed', () => {
    const before = inputFor('u1')
    index.rebuild(UNITS.filter((u) => u.id !== 'u1'))

    expect(index.setEmbedding(before, v(1, 0))).toBe(false)
    expect(index.embeddingCounts()).toEqual({ embedded: 0, total: 4 })
  })

  it('reuses the vectors of the same model, and stores no result of the previous model once the model changed', () => {
    const before = inputFor('u1')
    index.setEmbedding(before, v(1, 0))
    index.setEmbeddingModel('model-a')
    expect(index.embeddingCounts().embedded).toBe(1)
    index.setEmbeddingModel('model-b')

    expect(index.embeddingCounts().embedded).toBe(0)
    expect(index.setEmbedding(before, v(1, 0))).toBe(false)
    expect(inputFor('u1').text).toBe(before.text)
    expect(inputFor('u1').fingerprint).not.toBe(before.fingerprint)
    expect(index.setEmbedding(inputFor('u1'), v(0, 1))).toBe(true)
  })

  it('keeps the meta values when the index is closed and opened again', () => {
    index.setMeta('example', 'x')
    index.close()
    index = new MemoryIndex(path.join(dir, 'index.db'))
    expect(index.getMeta('example')).toBe('x')
    expect(index.count).toBe(5)
  })
})

const page = (id: string, file: string, name: string, heading: string, text: string): MemoryUnit =>
  unit(id, text, { file, page: name, heading, aliases: [] })

/** A folder the user has spoken several languages into, which is what changing the setting leaves behind. */
const MULTI: MemoryUnit[] = [
  page('en-allergy', 'pages/Allergy.md', 'Allergy', 'Summary', 'The user is allergic to walnuts and reads the label of every bread roll.'),
  page('en-cat', 'pages/Mugi.md', 'Mugi', 'Summary', 'The cat is a brown tabby and sleeps on the windowsill in the afternoon.'),
  page('en-running', 'pages/Running.md', 'Running', 'Summary', 'The user runs five kilometres before breakfast three times a week along the river.'),
  page('de-kaffee', 'pages/Kaffee.md', 'Kaffee', 'Zusammenfassung', 'Der Nutzer trinkt jeden Morgen einen Milchkaffee im Café am Büro.'),
  page('hi-rain', 'pages/delhi.md', 'दिल्ली', 'सारांश', 'उपयोगकर्ता को दिल्ली में बारिश की जानकारी हर सुबह चाहिए।'),
  page('hi-cat', 'pages/mugi-hi.md', 'मुगी', 'सारांश', 'बिल्ली भूरी है और खिड़की पर सोती है। मैं उसे रोज़ देखता हूँ।'),
  page('ko-trip', 'pages/trip.md', '출장', '요약', '사용자는 매주 금요일에 부산으로 가고 서울에서 회의를 합니다.'),
  ...UNITS
]

describe('MemoryIndex over memories in several languages', () => {
  beforeEach(() => index.rebuild(MULTI))

  const ids = (query: string, options?: Parameters<MemoryIndex['search']>[1]): string[] =>
    index.search(query, options).map((hit) => hit.record.id)

  it('finds the memory by a word and not by a fragment that spans two of them', () => {
    expect(ids('walnuts')).toEqual(['en-allergy'])
    // "ec" is the bigram a character split cuts out of "the cat", and it must not reach that memory.
    expect(ids('specimen')).toEqual([])
    expect(ids('sleeps')).toEqual(['en-cat'])
  })

  it('finds a German compound whole and reads an accented word as its unaccented spelling', () => {
    expect(ids('Milchkaffee')).toEqual(['de-kaffee'])
    expect(ids('Büro')).toEqual(['de-kaffee'])
    expect(ids('cafe')).toEqual(['de-kaffee'])
  })

  it('tells two Hindi words apart that differ only in a vowel sign', () => {
    expect(ids('बारिश')).toEqual(['hi-rain'])
    expect(ids('मैं')).toEqual(['hi-cat'])
    expect(ids('में')).toEqual(['hi-rain'])
  })

  it('finds a Korean memory by the bare noun that it writes with a particle', () => {
    expect(ids('서울')).toEqual(['ko-trip'])
    expect(ids('부산')).toEqual(['ko-trip'])
  })

  it('still finds the Japanese memories in the same index', () => {
    expect(ids('最寄り駅')).toEqual(['u5'])
    expect(ids('キジトラ')).toEqual(['u2'])
    expect(ids('松葉軒行ったんだけどさあ', { mode: 'utterance' })[0]).toBe('u1')
  })

  it('matches a recall keyword of one character wherever it stands, and a lone character inside an utterance only as a whole token', () => {
    const journal = (id: string, heading: string, text: string): MemoryUnit =>
      unit(id, text, { file: `journal/${id}.md`, kind: 'journal', page: '2026-09-25', heading, aliases: [], date: '2026-09-25' })
    index.rebuild([...MULTI, journal('j-pasta', '料理', 'パスタは8分ゆでる。分量は100グラム。'), journal('j-tea', 'お茶', '緑茶を飲むと落ち着く。')])
    expect(ids('分')).toEqual(['j-pasta'])
    expect(ids('あと5分', { mode: 'utterance' })).toEqual([])
    expect(ids('タイマー3分', { mode: 'utterance' })).toEqual([])
    expect(ids('お', { mode: 'utterance' })).toEqual([])
    // "パスタは" ends its run with "は", which the index holds marked so that a whole token never matches it.
    expect(ids('は?', { mode: 'utterance' })).toEqual([])
  })

  it('finds a memory by each of several recall keywords of one character, and by a Korean word of one syllable that the memory writes with a particle', () => {
    index.rebuild([
      ...MULTI,
      page('ja-family', 'pages/家族.md', '家族', '要約', '母は毎朝薬を飲む。犬を一匹飼っている。'),
      page('ko-dog', 'pages/dog.md', '초코', '요약', '사용자는 개를 키웁니다.')
    ])
    expect(new Set(ids('猫 犬'))).toEqual(new Set(['u2', 'ja-family']))
    expect(ids('母 薬')).toEqual(['ja-family'])
    expect(ids('개')).toEqual(['ko-dog'])
  })

  it('matches as a prefix only a recall keyword of one character that stands alone, not one beside a number or a Latin word', () => {
    index.rebuild([
      ...MULTI,
      page('ja-gym', 'pages/ジム.md', 'ジム', '要約', '月曜日はジムに行く。人が多い。'),
      page('ja-errand', 'pages/用事.md', '用事', '要約', '用事は昼に済ませる。')
    ])
    expect(ids('9月1日')).toEqual([])
    expect(ids('3人')).toEqual([])
    expect(ids('iPhone用')).toEqual([])
    expect(ids('月 人')[0]).toBe('ja-gym')
  })

  it('injects a memory the utterance names and nothing for an utterance that only shares a common word', () => {
    expect(ids('I think I am allergic to walnuts', { mode: 'utterance' })).toEqual(['en-allergy'])
    expect(ids('that was a really long week and I want to sleep', { mode: 'utterance' })).toEqual([])
  })

  it('injects no section for an utterance that only says the words of a heading its template wrote, and still injects one for what is written under it', () => {
    const journal = (id: string, heading: string, text: string): MemoryUnit =>
      unit(id, text, { file: 'journal/2026-09-20.md', kind: 'journal', page: '2026-09-20', heading, aliases: [], date: '2026-09-20' })
    index.rebuild([
      ...MULTI,
      page('en-maps', 'pages/Collecting.md', 'Collecting', 'Summary', 'They collect old railway maps.'),
      page('ja-maps', 'pages/集めているもの.md', '集めているもの', '要約', '古い地図と電車の名前。最近は盆栽。'),
      unit('en-impression', 'The evenings are calmer when the cat comes up.', { file: 'pages/Mugi.md', page: 'Mugi', heading: 'My impression', aliases: [], order: 1 }),
      unit('ja-impression', '疲れた日に名前が出る。', { heading: '私の印象', order: 3 }),
      journal('en-subject', 'A subject', 'We went through the train timetable for Saturday.'),
      journal('ja-subject', '話題', '土曜日の電車の時刻を一緒に調べた。'),
      journal('en-self', 'Myself today', 'A quiet Sunday, and I liked hearing about the bonsai.'),
      journal('ja-self', '今日の私', '静かな日曜日。盆栽の話を聞けてうれしかった。')
    ])
    const ordinary = [
      'my impression of the movie was mixed',
      '私の印象では悪くない',
      'what a dull subject that was',
      '話題を変えよう',
      'I did not like myself today',
      '今日の私はだめだった'
    ]
    const injected = (utterances: string[]): Record<string, string[]> =>
      Object.fromEntries(utterances.map((utterance) => [utterance, ids(utterance, { mode: 'utterance' })]))
    expect(injected(ordinary)).toEqual(Object.fromEntries(ordinary.map((utterance) => [utterance, []])))
    expect(injected(['do you still collect old railway maps', '古い地図を見に行こう'])).toEqual({
      'do you still collect old railway maps': ['en-maps'],
      古い地図を見に行こう: ['ja-maps']
    })
    // Recall still reads a section by such a heading.
    expect(ids('impression')).toEqual(['en-impression'])
    expect(ids('私の印象')).toEqual(['ja-impression'])
  })

  it('injects a section of a page by a heading the curation or the user added to it', () => {
    index.rebuild([
      ...MULTI,
      page('en-maps', 'pages/Collecting.md', 'Collecting', 'Old railway maps', 'I like how the lines change from decade to decade. The 1964 one is my favourite.'),
      page('en-shifts', 'pages/The hospital.md', 'The hospital', 'Night shifts', 'Tuesday and Wednesday, from 16:30.'),
      page('ja-walnut', 'pages/かかりつけの病院.md', 'かかりつけの病院', 'クルミアレルギー', 'パンを買うときは必ず表示を確かめ、注射薬を持ち歩いている。')
    ])
    expect(ids('I bought an old railway map', { mode: 'utterance' })).toEqual(['en-maps'])
    expect(ids('I am so done with night shifts', { mode: 'utterance' })).toEqual(['en-shifts'])
    expect(ids('このケーキにクルミ入ってる?', { mode: 'utterance' })).toEqual(['ja-walnut'])
  })

  it('ranks a section for recall by a word of a heading its template wrote as it ranks one by a word of its text', () => {
    index.rebuild([
      ...MULTI,
      page('en-mugi', 'pages/Mugi.md', 'Mugi', 'My impression', 'The evenings are calmer when the cat comes up.'),
      page('en-hotel', 'pages/Hotel.md', 'Hotel', 'Summary', 'The hotel near the station left a good impression at check-in and keeps a long list of pillows, views and floors for every guest.')
    ])
    // The two hold the word once each, and the shorter section comes first.
    expect(ids('impression')).toEqual(['en-mugi', 'en-hotel'])
  })

  it('scores a section for an utterance as recall does when no template wrote its heading, so a word the templates write on many headings stays as common as it is', () => {
    const journal = (id: string, heading: string, text: string): MemoryUnit =>
      unit(id, text, { file: 'journal/2026-09-20.md', kind: 'journal', page: '2026-09-20', heading, aliases: [], date: '2026-09-20' })
    index.rebuild([
      ...MULTI,
      page('p-kyoto', 'pages/Kyoto.md', 'Kyoto', 'Headings that fit the subject', 'Temples and the river.'),
      page('p-ken', 'pages/Ken.md', 'Ken', 'Headings that fit the subject', 'Takes up bonsai.'),
      journal('j-prices', 'A subject', 'The talk about electricity prices on 2026-09-14.'),
      unit('j-quiz', 'They asked me the subject of a song that came out that year, and I found it.', {
        file: 'journal/2026-09-26.md', kind: 'journal', page: '2026-09-26', heading: 'Pub quiz', aliases: [], date: '2026-09-26'
      })
    ])
    const utterance = 'what was the subject of that song'
    const scoreOf = (mode: 'keyword' | 'utterance'): number | undefined =>
      index.search(utterance, { mode }).find((hit) => hit.record.id === 'j-quiz')?.bm25
    expect(scoreOf('utterance')).toBeLessThan(INJECTION_MAX_BM25.word)
    expect(scoreOf('utterance')).toBeCloseTo(scoreOf('keyword')!, 9)
  })

  it('rebuilds every token when the schema version on disk is not the current one', () => {
    index.close()
    const db = new DatabaseSync(path.join(dir, 'index.db'))
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    db.close()

    index = new MemoryIndex(path.join(dir, 'index.db'))
    expect(index.count).toBe(0)
    index.rebuild(MULTI)
    expect(index.count).toBe(MULTI.length)
    expect(ids('walnuts')).toEqual(['en-allergy'])
  })

  it('builds the text search anew on every rebuild, so that damage inside its data, which no rebuild reads, fails no search', () => {
    const file = path.join(dir, 'index.db')
    index.rebuild(Array.from({ length: 300 }, (_, n) => page(`p${n}`, `pages/p${n}.md`, `p${n}`, 'Summary', `Page ${n} talks about the river and walnut ${n}.`)))
    index.close()
    // What bit rot inside a page does: the bytes of the search data change while the b-tree that holds them stays intact.
    const db = new DatabaseSync(file)
    db.exec("UPDATE units_fts_data SET block = CAST(replace(hex(block), '0', 'F') AS BLOB) WHERE id > 10")
    db.close()
    index = new MemoryIndex(file)
    index.rebuild(MULTI)
    expect(ids('walnuts')).toEqual(['en-allergy'])
    expect(ids('I think I am allergic to walnuts', { mode: 'utterance' })).toEqual(['en-allergy'])
  })

  it('builds the index anew from the files when SQLite finds its file damaged', () => {
    const file = path.join(dir, 'index.db')
    const many = Array.from({ length: 2000 }, (_, n) => page(`p${n}`, `pages/p${n}.md`, `p${n}`, 'Summary', `Page ${n} talks about the river, the bread and the week.`))
    index.rebuild(many)
    index.close()
    // What a disk error or a copy cut short leaves: the header and the schema stay readable, the tables do not.
    const bytes = readFileSync(file)
    bytes.fill(0x5a, 4096 * 3)
    writeFileSync(file, bytes)
    index = new MemoryIndex(file)
    index.rebuild(MULTI)
    expect(index.count).toBe(MULTI.length)
    expect(ids('walnuts')).toEqual(['en-allergy'])
  })
})
