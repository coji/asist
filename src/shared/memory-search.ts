/**
 * Memory search. Tokenization is script-aware, and both the token string stored in the FTS5 column and
 * the FTS query for a search term are built here. The ranking mixes two paths with RRF:
 * - lexical: the FTS5 index ordered by bm25, which catches rare words, names and numbers. An exact
 *   match on a page name or an alias goes to the top regardless of its score.
 * - dense: cosine over the multilingual-e5 embeddings, which catches paraphrases and topics.
 * There is deliberately no morphological analyzer, no stemmer and no reranker.
 *
 * A memory folder holds whatever languages the user has spoken since it was created, and a query can be
 * in a different language from the memory it should find, so the script of each run of text decides how
 * that run is cut, never a setting.
 */

/** Normalizes for search: folds width, lowercases, and drops whitespace and symbols. */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** The bigrams of the text. A single character yields itself, and empty text yields an empty array. */
export function bigrams(text: string): string[] {
  const chars = Array.from(normalizeForSearch(text))
  if (chars.length <= 1) return chars
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

const CJK = '\\u3005\\u3006\\u303b\\u30fc\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}'
/**
 * A run of text written without spaces between words. Punctuation and spaces between two such characters
 * stay inside the run, because the bigrams of Japanese are cut from the text with everything of that kind
 * removed, so that "明日は、晴れ" yields "は晴".
 */
const CJK_RUN = new RegExp(`[${CJK}](?:[\\s\\p{P}\\p{S}]*[${CJK}])*`, 'gu')

/**
 * A run of characters written without spaces that also ends at a space or a mark. The model separates the
 * keywords it recalls by with spaces, as in "猫 犬", where the run of an utterance goes on across them.
 */
const CJK_KEYWORD = new RegExp(`[${CJK}]+`, 'gu')

const SEPARATOR = '[\\s\\p{P}\\p{S}]'

/** A keyword of one character, written without spaces or in Hangul, that stands alone between spaces or marks. */
const LONE_KEYWORD = new RegExp(`(?<=^|${SEPARATOR})([${CJK}]|\\p{Script=Hangul})(?=$|${SEPARATOR})`, 'u')

/**
 * Korean is agglutinative and writes a particle onto the word, so "서울" has to find "서울에서". Words in
 * Hangul therefore carry their character bigrams into the index beside the word itself. Measured on
 * 2026-09-22 against a unit that says "서울에서 회의를": indexed by word alone the query "서울 회의 언제예요"
 * found nothing at all, and with the bigrams beside the word it found the unit at a bm25 of -2.4.
 */
const HANGUL = /\p{Script=Hangul}/u

/**
 * Word segmentation is left to ICU rather than to a property regex, because ICU keeps "5.6", "v1.2.3" and
 * "example.com" whole while a regex over letters and digits cuts them at every dot. ICU's rules for a
 * script written with spaces do not depend on the locale, and the scripts whose segmentation does depend
 * on a dictionary are the ones this tokenizer never hands it.
 */
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' })

const LATIN_WORD = /^[\p{Script=Latin}\p{N}\p{M}\p{P}]+$/u

/**
 * Drops the diacritics of a word written in the Latin script, so that "café" and "cafe" are one token.
 * This is what FTS5's own unicode61 tokenizer does to the column, and doing it here keeps the tokens this
 * file reports equal to the ones SQLite indexes. A mark in Devanagari or Hangul carries a sound rather
 * than an accent and removing it would destroy the word, so only a Latin word is folded.
 */
function foldWord(word: string): string {
  if (!LATIN_WORD.test(word)) return word
  return word.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC')
}

interface Piece {
  kind: 'cjk' | 'word'
  text: string
}

/** Cuts the text into runs written without spaces, as `runs` finds them, and into the words of every other script. */
function pieces(text: string, runs: RegExp = CJK_RUN): Piece[] {
  const folded = text.normalize('NFKC').toLowerCase()
  const out: Piece[] = []
  const pushWords = (slice: string): void => {
    for (const { segment, isWordLike } of WORDS.segment(slice)) {
      if (!isWordLike) continue
      const word = foldWord(segment)
      if (word) out.push({ kind: 'word', text: word })
    }
  }
  let last = 0
  for (const match of folded.matchAll(runs)) {
    pushWords(folded.slice(last, match.index))
    const run = normalizeForSearch(match[0])
    if (run) out.push({ kind: 'cjk', text: run })
    last = match.index + match[0].length
  }
  pushWords(folded.slice(last))
  return out
}

function pieceTokens(piece: Piece): string[] {
  if (piece.kind === 'cjk') return bigrams(piece.text)
  if (!HANGUL.test(piece.text)) return [piece.text]
  return [piece.text, ...bigrams(piece.text).filter((gram) => gram !== piece.text)]
}

/** The tokens of the text: character bigrams inside a run written without spaces, words everywhere else. */
export function searchTokens(text: string): string[] {
  return pieces(text).flatMap(pieceTokens)
}

/**
 * Written after the last character of a run in the index. A private-use character is part of a token for
 * unicode61, and no token cut from text holds one after a character written without spaces, so only the
 * prefix of ftsKeywordQuery reaches the token. Stored bare, the character matched the lone "は" of the
 * utterance "は?" as a whole token at the end of "パスタは", and injected that diary at a bm25 of -3.76
 * where nothing had matched (23 units, 2026-10-02).
 */
const RUN_END = '\uE000'

/**
 * The token string stored in the FTS5 column: the tokens separated by spaces. A run written without spaces
 * also ends with its last character, marked by RUN_END, so that every character of the run begins a token.
 */
export function ftsTokens(text: string): string {
  return pieces(text)
    .flatMap((piece) => {
      const chars = Array.from(piece.text)
      return piece.kind === 'cjk' && chars.length > 1 ? [...pieceTokens(piece), `${chars[chars.length - 1]}${RUN_END}`] : pieceTokens(piece)
    })
    .join(' ')
}

const quoted = (token: string): string => `"${token.replace(/"/g, '""')}"`

/** The FTS5 MATCH expression, joining the tokens with OR, or null when there is no token. */
export function ftsQuery(text: string): string | null {
  const tokens = [...new Set(searchTokens(text))]
  if (tokens.length === 0) return null
  return tokens.map(quoted).join(' OR ')
}

/**
 * The FTS5 MATCH expression for the keywords the model recalls by, cut where it put a space or a mark between
 * them. A keyword of one character that stands alone, such as "猫" or each of "猫 犬", or a Korean word of one
 * syllable, such as "개", is matched as a prefix: FTS5 matches whole tokens, the index holds a character
 * written without spaces only as the start of a bigram or of the marked end of its run, and a Korean word
 * with the particle written onto it ("개를"). A character beside a number or a Latin word, as in "9月1日",
 * "3人" or "iPhone用", belongs to that keyword and is matched whole, as the query of an utterance (ftsQuery)
 * matches every character: a lone character inside an utterance, such as the "分" of "あと5分" or a filler
 * such as "お", names nothing, and as a prefix it injected a diary about "分量" or "お茶".
 *
 * A Korean syllable that stands alone is often a determiner or a pronoun, as in "내 생일" or "그 식당", and as
 * a prefix it also reaches "내일", "내용" or "그는". It is matched as one all the same, because those hits rank
 * below the ones both keywords find, while a whole match loses the noun. Measured on 2026-10-02 over 29
 * units: "내 생일" ranked the unit with "생일" at -5.3 and one with only "내년" and "내용" at -3.9, and "개 이름"
 * found the page of the dog, which says "개를", at -3.7 only as a prefix. Over 20,000 units a prefix keyword
 * added about 20 ms to a search of 22 to 25 ms.
 *
 * Indexing every character alone instead would double the length of each unit in such a script, and bm25
 * divides by the length. Measured on 2026-10-02 over 13 units in English, German, Hindi, Korean and
 * Japanese, that weakened the Japanese matches of every other query by 11 to 15 % and strengthened the
 * English and Korean ones by 15 to 21 %, bringing an English utterance that shares only a common word with
 * a unit from -3.7 to -4.3 against the bar of -5 for injection. With the marked end of each run alone, no
 * score of an utterance moved by more than 3 % over that index and one of 23 units, and every utterance
 * injected the same units as before.
 */
export function ftsKeywordQuery(text: string): string | null {
  // split() with a capturing pattern puts each lone keyword at an odd place, between the rest of the text.
  const parts = text.normalize('NFKC').toLowerCase().split(LONE_KEYWORD)
  const terms = new Set(
    parts.flatMap((part, at) => (at % 2 === 1 ? [`${quoted(part)}*`] : pieces(part, CJK_KEYWORD).flatMap(pieceTokens).map(quoted)))
  )
  return terms.size > 0 ? [...terms].join(' OR ') : null
}

const DEVANAGARI_MARKS = [
  [0x0900, 0x0903],
  [0x093a, 0x0957],
  [0x0962, 0x0963]
].flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i))).join('')

/**
 * The tokenizer argument of the FTS5 table. FTS5 reads the column this file writes with its own tokenizer,
 * and unicode61 counts only letters and digits as token characters, so every Devanagari vowel sign and the
 * virama act as separators and "दिल्ली" is indexed as the three terms "द", "ल", "ल", which no longer tell
 * Delhi from "बिल्ली", a cat. Naming those marks as token characters keeps a Hindi word whole. Latin
 * diacritics need no option here because foldWord has already removed them.
 */
export const FTS5_TOKENIZE = `unicode61 tokenchars '${DEVANAGARI_MARKS}'`

export type TokenKind = 'bigram' | 'word'

/**
 * Which kind of token the text mostly yields, which decides how strict the bm25 bar of an injection is.
 * Hangul counts with the bigrams: a Korean word is indexed by its bigrams as well, and a query in Korean
 * behaves like one in Japanese, where a match on a content word carries several tokens at once.
 */
export function dominantTokenKind(text: string): TokenKind {
  let bigram = 0
  let word = 0
  for (const piece of pieces(text)) {
    if (piece.kind === 'cjk' || HANGUL.test(piece.text)) bigram += piece.text.length
    else word += 1
  }
  return bigram >= word ? 'bigram' : 'word'
}

/**
 * The fraction from 0 to 1 of the query's bigrams that the text contains. The project index uses it to
 * match names.
 */
export function matchRatio(text: string, queryGrams: readonly string[]): number {
  if (queryGrams.length === 0) return 0
  const set = new Set(bigrams(text))
  let hit = 0
  for (const gram of queryGrams) if (set.has(gram)) hit++
  return hit / queryGrams.length
}

export interface RankableMemory {
  id: string
  /** The date of the source as YYYY-MM-DD. A later date ranks first, and an empty date ranks last. */
  date: string
}

/** Orders two memories of equal score, later date first. */
export function compareAuthority(a: RankableMemory, b: RankableMemory): number {
  return b.date.localeCompare(a.date)
}

/**
 * The pieces of the text joined back together, with the positions at which a name may begin or end. Every
 * position inside a run written without spaces is such a position, because a word there has no edge to
 * find; inside a word of a spaced script only its two ends are, so that the page "Mom" is not named by
 * the word "momentum". A Hangul word is treated like a run written without spaces, because a Korean
 * utterance says the name of a page with a particle written onto it.
 */
function searchKey(text: string): { text: string; boundary: boolean[] } {
  let out = ''
  const boundary: boolean[] = []
  for (const piece of pieces(text)) {
    const bounded = piece.kind === 'cjk' || HANGUL.test(piece.text)
    for (let i = 0; i < piece.text.length; i++) boundary.push(bounded || i === 0)
    out += piece.text
  }
  boundary.push(true)
  return { text: out, boundary }
}

/**
 * Whether the query contains a page name or an alias, which counts as an exact hit. A name shorter
 * than two characters is ignored, because a single character such as "一" matches almost anything.
 */
export function exactNameHit(query: string, names: readonly string[]): boolean {
  const q = searchKey(query)
  if (!q.text) return false
  return names.some((name) => {
    const n = searchKey(name).text
    if (n.length < 2) return false
    for (let at = q.text.indexOf(n); at >= 0; at = q.text.indexOf(n, at + 1)) {
      if (q.boundary[at] && q.boundary[at + n.length]) return true
    }
    return false
  })
}

export interface LexicalHit<T> {
  record: T
  /** The bm25 score of FTS5. It is negative, and a smaller value is a better match. */
  bm25: number
  /** Whether a page name or an alias matched exactly. */
  exact: boolean
}

export interface DenseHit<T> {
  record: T
  cosine: number
}

export interface HybridHit<T> {
  record: T
  via: 'lexical' | 'dense' | 'both'
  exact: boolean
  bm25?: number
  cosine?: number
}

/**
 * The RRF constant. 60 is the conventional value: it keeps the top few ranks apart without flattening
 * them, and still gives the lower ranks a non-zero score.
 */
const RRF_K = 60

export interface HybridOptions {
  limit?: number
  /** The lowest cosine a dense hit may have and still be kept. */
  minCosine: number
  /**
   * The highest bm25 a lexical hit may have and still be kept. The value is negative, so a hit is kept
   * when its bm25 is at or below this, that is, at least this large in magnitude. Omitting it keeps
   * every hit, and an exact match is always kept.
   */
  maxBm25?: number
}

/**
 * Merges the lexical ranking by bm25 and the dense ranking by cosine into one with RRF, with exact
 * matches placed above everything else and ties broken by the later date. Lexical catches matches on
 * proper nouns, dense catches paraphrases.
 */
export function mergeHybrid<T extends RankableMemory>(
  lexical: ReadonlyArray<LexicalHit<T>>,
  dense: ReadonlyArray<DenseHit<T>>,
  options: HybridOptions
): HybridHit<T>[] {
  const limit = options.limit ?? 5
  const merged = new Map<string, HybridHit<T> & { score: number }>()
  const keptLexical = lexical
    .filter((hit) => hit.exact || options.maxBm25 === undefined || hit.bm25 <= options.maxBm25)
    .sort((a, b) => a.bm25 - b.bm25)
  keptLexical.forEach((hit, index) => {
    merged.set(hit.record.id, {
      record: hit.record,
      via: 'lexical',
      exact: hit.exact,
      bm25: hit.bm25,
      score: 1 / (RRF_K + index + 1) + (hit.exact ? 1 : 0)
    })
  })
  const keptDense = dense.filter((hit) => hit.cosine >= options.minCosine).sort((a, b) => b.cosine - a.cosine)
  keptDense.forEach((hit, index) => {
    const score = 1 / (RRF_K + index + 1)
    const existing = merged.get(hit.record.id)
    if (existing) {
      existing.cosine = hit.cosine
      existing.via = 'both'
      existing.score += score
    } else {
      merged.set(hit.record.id, { record: hit.record, via: 'dense', exact: false, cosine: hit.cosine, score })
    }
  })
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || compareAuthority(a.record, b.record))
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit)
}
