import { describe, expect, it } from 'vitest'
import {
  bigrams,
  compareAuthority,
  dominantTokenKind,
  exactNameHit,
  ftsKeywordQuery,
  ftsQuery,
  ftsTokens,
  matchRatio,
  mergeHybrid,
  normalizeForSearch,
  searchTokens,
  type RankableMemory
} from '@shared/memory-search'

describe('bigram tokenization', () => {
  it('folds full-width and case differences and drops spaces and punctuation', () => {
    expect(normalizeForSearch('ＡＳＩＳＴ の Repo、中野!')).toBe('asistのrepo中野')
  })

  it('cuts overlapping two-character bigrams, keeps a single character as it is, and returns nothing for blank text', () => {
    expect(bigrams('中野駅')).toEqual(['中野', '野駅'])
    expect(bigrams('あ')).toEqual(['あ'])
    expect(bigrams('  ')).toEqual([])
  })

  it('writes the FTS column as space-separated bigrams and the query as quoted bigrams joined by OR', () => {
    expect(ftsTokens('最寄り駅は中野')).toBe('最寄 寄り り駅 駅は は中 中野 野\uE000')
    expect(ftsQuery('中野駅')).toBe('"中野" OR "野駅"')
    expect(ftsQuery('')).toBeNull()
  })

  it('ends each run in the FTS column with its last character, and matches each recall keyword of one character as a prefix, so that any of its characters is found', () => {
    expect(ftsTokens('本人の猫')).toBe('本人 人の の猫 猫\uE000')
    expect(ftsKeywordQuery('猫')).toBe('"猫"*')
    expect(ftsKeywordQuery('my 猫')).toBe('"my" OR "猫"*')
    expect(ftsKeywordQuery('猫 犬')).toBe('"猫"* OR "犬"*')
    expect(ftsKeywordQuery('猫、犬')).toBe('"猫"* OR "犬"*')
    expect(ftsKeywordQuery('9月1日')).toBe('"9" OR "月" OR "1" OR "日"')
    expect(ftsKeywordQuery('내 생일')).toBe('"내"* OR "생일"')
    expect(ftsKeywordQuery('中野駅')).toBe('"中野" OR "野駅"')
    expect(ftsQuery('猫')).toBe('"猫"')
  })

  it('reports the share of the query bigrams that the text contains', () => {
    expect(matchRatio('最寄り駅は中野', bigrams('中野駅'))).toBe(0.5)
    expect(matchRatio('x', [])).toBe(0)
  })
})

describe('tokenization of a language written with spaces', () => {
  it('cuts words instead of bigrams that run across a word edge', () => {
    expect(searchTokens('The cat sat on the mat')).toEqual(['the', 'cat', 'sat', 'on', 'the', 'mat'])
    expect(searchTokens('The cat sat')).not.toContain('ec')
  })

  it('keeps a German compound whole and folds the accents of a Latin word', () => {
    expect(searchTokens('Die Bahnhofstraße hat 30 km/h')).toEqual(['die', 'bahnhofstraße', 'hat', '30', 'km', 'h'])
    expect(searchTokens('El café de la esquina')).toEqual(['el', 'cafe', 'de', 'la', 'esquina'])
  })

  it('leaves the marks of Devanagari on the word, because they carry a sound rather than an accent', () => {
    expect(searchTokens('दिल्ली में बारिश')).toEqual(['दिल्ली', 'में', 'बारिश'])
  })

  it('gives a Hangul word its bigrams as well, so a name said with a particle on it still matches', () => {
    expect(searchTokens('서울에서')).toEqual(['서울에서', '서울', '울에', '에서'])
    expect(searchTokens('서울')).toEqual(['서울'])
  })

  it('keeps a decimal number and a ticker whole instead of cutting them at every dot', () => {
    expect(searchTokens('gpt-5.6 や 7203.T')).toEqual(['gpt', '5.6', 'や', '7203', 't'])
  })

  it('yields both kinds of token for text that mixes the scripts', () => {
    expect(searchTokens('Tokyoの天気')).toEqual(['tokyo', 'の天', '天気'])
    expect(ftsTokens('ASIST、中野の話')).toBe('asist 中野 野の の話 話\uE000')
    expect(ftsQuery('Tokyoの天気')).toBe('"tokyo" OR "の天" OR "天気"')
  })

  it('reports which kind of token a query is mostly made of', () => {
    expect(dominantTokenKind('最寄り駅はどこだっけ')).toBe('bigram')
    expect(dominantTokenKind('Tokyoの天気を教えて')).toBe('bigram')
    expect(dominantTokenKind('서울에서 회의가 있어요')).toBe('bigram')
    expect(dominantTokenKind('where does the cat sleep')).toBe('word')
    expect(dominantTokenKind('how do I get to 中野 from here')).toBe('word')
  })
})

describe('exact matches and authority', () => {
  it('counts a hit when the query contains the page name or one of its aliases, ignoring one-character names', () => {
    expect(exactNameHit('松葉軒行ったんだけどさあ', ['松葉軒', 'ラーメン屋'])).toBe(true)
    expect(exactNameHit('お昼どうしよう', ['松葉軒'])).toBe(false)
    expect(exactNameHit('一つください', ['一'])).toBe(false)
    expect(exactNameHit('ＡＳＩＳＴのリポジトリ', ['asist'])).toBe(true)
  })

  it('reads a name of a language written with spaces only at the edges of a word', () => {
    expect(exactNameHit('I should call Mom tonight', ['Mom'])).toBe(true)
    expect(exactNameHit('the momentum of the project', ['Mom'])).toBe(false)
    expect(exactNameHit('nos vemos en el cafe', ['Café'])).toBe(true)
    expect(exactNameHit('the cafeteria closed early', ['Café'])).toBe(false)
  })

  it('reads a name the utterance says with a particle or a postposition attached to it', () => {
    expect(exactNameHit('서울에서 회의가 있어요', ['서울'])).toBe(true)
    expect(exactNameHit('दिल्ली में बारिश होगी', ['दिल्ली'])).toBe(true)
  })

  it('puts the newer date first at an equal score and the records without a date last', () => {
    const a: RankableMemory = { id: 'a', date: '2026-09-09' }
    const b: RankableMemory = { id: 'b', date: '' }
    const c: RankableMemory = { id: 'c', date: '2026-01-01' }
    expect([b, c, a].sort(compareAuthority).map((r) => r.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('mergeHybrid', () => {
  const rec = (id: string, extra: Partial<RankableMemory> = {}): RankableMemory => ({ id, date: '2026-09-01', ...extra })

  it('ranks the records found by both lists above those found by one, drops the dense hits below the minimum, and reports via and the scores', () => {
    const a = rec('a')
    const b = rec('b')
    const c = rec('c')
    const d = rec('d')
    const hits = mergeHybrid(
      [
        { record: a, bm25: -5, exact: false },
        { record: c, bm25: -2, exact: false }
      ],
      [
        { record: b, cosine: 0.9 },
        { record: a, cosine: 0.85 },
        { record: d, cosine: 0.5 }
      ],
      { minCosine: 0.8 }
    )
    expect(hits.map((h) => h.record.id)).toEqual(['a', 'b', 'c'])
    expect(hits[0]).toMatchObject({ via: 'both', bm25: -5, cosine: 0.85, exact: false })
    expect(hits[1]).toMatchObject({ via: 'dense', cosine: 0.9 })
    expect(hits[2]).toMatchObject({ via: 'lexical', bm25: -2 })
    expect(hits[2].cosine).toBeUndefined()
  })

  it('keeps an exact match on top whatever its score, while maxBm25 filters out the lexical-only hits', () => {
    const x = rec('x')
    const y = rec('y')
    const z = rec('z')
    const hits = mergeHybrid(
      [
        { record: x, bm25: -1, exact: true },
        { record: y, bm25: -1.5, exact: false }
      ],
      [{ record: z, cosine: 0.95 }],
      { minCosine: 0.8, maxBm25: -2.5 }
    )
    expect(hits.map((h) => h.record.id)).toEqual(['x', 'z'])
    expect(hits[0].exact).toBe(true)
  })

  it('orders the records of the same rank newest first and cuts at limit', () => {
    const x = rec('x', { date: '2026-09-01' })
    const y = rec('y', { date: '2026-09-08' })
    const z = rec('z', { date: '2026-09-05' })
    const hits = mergeHybrid(
      [{ record: x, bm25: -3, exact: false }],
      [
        { record: y, cosine: 0.95 },
        { record: z, cosine: 0.9 }
      ],
      { minCosine: 0.8, limit: 2 }
    )
    expect(hits.map((h) => h.record.id)).toEqual(['y', 'x'])
  })
})
