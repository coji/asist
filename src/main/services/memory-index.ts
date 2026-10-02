import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { MemoryUnit, MemoryUnitKind } from '@shared/ipc'
import { EMBEDDING_MODEL, cosine, vectorFromBytes, vectorToBytes } from '@shared/memory-embedding'
import { embeddingTextOf } from '@shared/memory-page'
import {
  FTS5_TOKENIZE,
  dominantTokenKind,
  exactNameHit,
  ftsKeywordQuery,
  ftsQuery,
  ftsTokens,
  mergeHybrid,
  type DenseHit,
  type HybridHit,
  type LexicalHit,
  type TokenKind
} from '@shared/memory-search'

/**
 * The memory index, a single SQLite file. The memory itself is the markdown owned by memory-store.ts, so
 * this file can always be rebuilt from it. It holds a table of units, an FTS5 table of the search tokens,
 * a table of vectors that survives a rebuild, and meta. A search mixes the lexical side, bm25 plus an
 * exact match on a page name or alias, with the dense side, cosine similarity, through RRF. Computing a
 * vector belongs to the layer above in memory.ts; here a vector is only received and stored.
 */

const SCHEMA_VERSION = 6
const META_EMBEDDING_MODEL = 'embedding_model'
const LEXICAL_LIMIT = 30
/**
 * The bm25 ceiling for keeping a hit that only the lexical side found during injection. The score is
 * negative and a hit is kept when its score is at or below the ceiling. An exact match is always kept
 * regardless. The two kinds of token need two ceilings, because a match on one content word carries
 * several bigrams but only a single word.
 *
 * Measured on 2026-09-22 against an index of 31 units in six languages, searching each utterance whole.
 * With bigrams, a Japanese utterance about a unit scored -5.6 to -16.7 and an unrelated one matched
 * nothing at all, which is the separation -2.5 was chosen in. With words, an English utterance about a
 * unit scored -3.3 to -15.7 while an unrelated one reached -4.7 ("that was a really long week and I want
 * to sleep" against a unit that says "week"), and German and Hindi overlapped the same way: a single
 * common word carries as much weight as a real topic match. -5.0 keeps the utterances that name something
 * rare, a walnut allergy at -8.2 or a sister in Lisbon at -10.7, and leaves the rest to the dense side.
 */
export const INJECTION_MAX_BM25: Record<TokenKind, number> = { bigram: -2.5, word: -5 }

type Row = Record<string, SQLOutputValue>

export interface IndexSearchOptions {
  /**
   * 'keyword' is the default and is what recall searches with. 'utterance' is the injection that queries
   * with the whole utterance, and it narrows hits that only the lexical side found by their bm25 score.
   */
  mode?: 'keyword' | 'utterance'
  /** The query embedded with multilingual-e5. The dense side is mixed in only when it is given. */
  queryVector?: Float32Array
  limit?: number
  /** Restricts the search to these kinds of unit. Every kind is searched when it is omitted. */
  kinds?: readonly MemoryUnitKind[]
}

export type MemorySearchHit = HybridHit<MemoryUnit>

export interface MemoryEmbeddingInput {
  id: string
  text: string
  /**
   * The hash of the text that was embedded together with the model, checked again when the vector is
   * stored. A unit keeps its id when its text is edited, so the id alone cannot tell a stale vector from
   * a current one.
   */
  fingerprint: string
}

function embeddingFingerprint(text: string, model: string): string {
  return createHash('sha256').update(JSON.stringify([model, text])).digest('hex')
}

function rowToUnit(row: Row): MemoryUnit {
  const unit: MemoryUnit = {
    id: String(row.id),
    file: String(row.file),
    line: Number(row.line),
    kind: String(row.kind) as MemoryUnitKind,
    page: String(row.page),
    heading: String(row.heading),
    aliases: JSON.parse(String(row.aliases)) as string[],
    text: String(row.text),
    date: String(row.date),
    order: Number(row.ord)
  }
  return unit
}

export class MemoryIndex {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.initialize()
  }

  private initialize(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = this.getMeta('schema_version')
    if (version !== null && Number(version) !== SCHEMA_VERSION) {
      // The index can be rebuilt from the files, so a schema change drops everything, vectors included.
      this.db.exec('DROP TABLE IF EXISTS units; DROP TABLE IF EXISTS units_fts; DROP TABLE IF EXISTS vectors; DELETE FROM meta')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        kind TEXT NOT NULL,
        page TEXT NOT NULL,
        heading TEXT NOT NULL,
        aliases TEXT NOT NULL,
        text TEXT NOT NULL,
        date TEXT NOT NULL,
        ord INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(id UNINDEXED, tokens, tokenize="${FTS5_TOKENIZE}");
      CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, embedding BLOB NOT NULL);
    `)
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Rebuilds the index from the files, keeping only the vectors computed from the same text and model. */
  rebuild(units: readonly MemoryUnit[]): void {
    this.transaction(() => {
      const model = this.getMeta(META_EMBEDDING_MODEL)
      this.db.exec('DELETE FROM units; DELETE FROM units_fts')
      const insertUnit = this.db.prepare(
        `INSERT INTO units (id, file, line, kind, page, heading, aliases, text, date, ord)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertFts = this.db.prepare('INSERT INTO units_fts (id, tokens) VALUES (?, ?)')
      const removeChangedVector = this.db.prepare('DELETE FROM vectors WHERE id = ? AND fingerprint <> ?')
      // A heading repeated in one file gives two units the same id. The rules refuse such a file on a save
      // and at a merge, and one written by hand is reported by the reindex; until it is fixed, the first
      // of the two is indexed.
      const seen = new Set<string>()
      for (const unit of units) {
        if (seen.has(unit.id)) continue
        seen.add(unit.id)
        insertUnit.run(
          unit.id,
          unit.file,
          unit.line,
          unit.kind,
          unit.page,
          unit.heading,
          JSON.stringify(unit.aliases),
          unit.text,
          unit.date,
          unit.order
        )
        insertFts.run(unit.id, ftsTokens(`${unit.page} ${unit.aliases.join(' ')} ${unit.heading} ${unit.text}`))
        if (model !== null) removeChangedVector.run(unit.id, embeddingFingerprint(embeddingTextOf(unit), model))
      }
      this.db.exec('DELETE FROM vectors WHERE id NOT IN (SELECT id FROM units)')
    })
  }

  get count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM units').get() as Row).n)
  }

  get(id: string): MemoryUnit | null {
    const row = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id) as Row | undefined
    return row ? rowToUnit(row) : null
  }

  /** Every unit by file and by its position within the page, which is the order the settings screen lists. */
  list(): MemoryUnit[] {
    return (this.db.prepare('SELECT * FROM units ORDER BY file ASC, ord ASC, line ASC').all() as Row[]).map(rowToUnit)
  }

  private kindFilter(kinds?: readonly MemoryUnitKind[]): { where: string; params: string[] } {
    if (!kinds || kinds.length === 0) return { where: '', params: [] }
    return { where: ` AND u.kind IN (${kinds.map(() => '?').join(', ')})`, params: [...kinds] }
  }

  /** Mixes the lexical side, bm25 and exact name matches, with the dense side, vector cosine, through RRF. */
  search(query: string, options: IndexSearchOptions = {}): MemorySearchHit[] {
    const mode = options.mode ?? 'keyword'
    const limit = options.limit ?? 5
    const { where, params } = this.kindFilter(options.kinds)
    // Only the first section of a page, which is its summary, may win on an exact name match.
    const isExact = (unit: MemoryUnit): boolean =>
      unit.kind === 'section' && unit.order === 0 && exactNameHit(query, [unit.page, ...unit.aliases])
    const lexical = new Map<string, LexicalHit<MemoryUnit>>()
    const match = mode === 'keyword' ? ftsKeywordQuery(query) : ftsQuery(query)
    if (match) {
      const rows = this.db
        .prepare(
          `SELECT u.*, bm25(units_fts) AS score FROM units_fts f JOIN units u ON u.id = f.id
           WHERE units_fts MATCH ?${where} ORDER BY score LIMIT ?`
        )
        .all(match, ...params, LEXICAL_LIMIT) as Row[]
      for (const row of rows) {
        const record = rowToUnit(row)
        lexical.set(record.id, { record, bm25: Number(row.score), exact: isExact(record) })
      }
    }
    // An exact name match becomes a hit even when FTS did not rank it inside the lexical limit.
    const named = this.db
      .prepare(`SELECT u.* FROM units u WHERE u.kind = 'section' AND u.ord = 0${where}`)
      .all(...params) as Row[]
    for (const row of named) {
      const record = rowToUnit(row)
      if (!lexical.has(record.id) && isExact(record)) lexical.set(record.id, { record, bm25: 0, exact: true })
    }
    const dense: DenseHit<MemoryUnit>[] = []
    if (options.queryVector) {
      const queryVector = options.queryVector
      const rows = this.db
        .prepare(`SELECT u.*, v.embedding AS embedding FROM units u JOIN vectors v ON v.id = u.id WHERE 1 = 1${where}`)
        .all(...params) as Row[]
      for (const row of rows) {
        dense.push({ record: rowToUnit(row), cosine: cosine(vectorFromBytes(row.embedding as Uint8Array), queryVector) })
      }
    }
    return mergeHybrid([...lexical.values()], dense, {
      limit,
      minCosine: EMBEDDING_MODEL.minCosine[mode],
      ...(mode === 'utterance' ? { maxBm25: INJECTION_MAX_BM25[dominantTokenKind(query)] } : {})
    })
  }

  /** Dropping the old vectors and recording the new model happen in one transaction. */
  setEmbeddingModel(model: string): void {
    if (this.getMeta(META_EMBEDDING_MODEL) === model) return
    this.transaction(() => {
      this.clearEmbeddings()
      this.setMeta(META_EMBEDDING_MODEL, model)
    })
  }

  /** A vector made stale while it was being computed, by an edit, a deletion or a model change, is not stored. */
  setEmbedding(input: MemoryEmbeddingInput, vector: Float32Array): boolean {
    const model = this.getMeta(META_EMBEDDING_MODEL)
    const unit = this.get(input.id)
    if (model === null || !unit || embeddingFingerprint(embeddingTextOf(unit), model) !== input.fingerprint) return false
    this.db.prepare('INSERT OR REPLACE INTO vectors (id, fingerprint, embedding) VALUES (?, ?, ?)')
      .run(input.id, input.fingerprint, vectorToBytes(vector))
    return true
  }

  clearEmbeddings(): void {
    this.db.exec('DELETE FROM vectors')
  }

  /** The units that have no vector, each with the text to embed, which carries the page name and the heading. */
  missingEmbeddings(limit: number): MemoryEmbeddingInput[] {
    const model = this.getMeta(META_EMBEDDING_MODEL)
    if (model === null) throw new Error('no embedding model is configured')
    return (
      this.db
        .prepare(`SELECT u.* FROM units u LEFT JOIN vectors v ON v.id = u.id WHERE v.id IS NULL ORDER BY u.file, u.ord LIMIT ?`)
        .all(limit) as Row[]
    ).map((row) => {
      const unit = rowToUnit(row)
      const text = embeddingTextOf(unit)
      return { id: unit.id, text, fingerprint: embeddingFingerprint(text, model) }
    })
  }

  embeddingCounts(): { embedded: number; total: number } {
    const row = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM units) AS total, (SELECT COUNT(*) FROM vectors) AS embedded')
      .get() as Row
    return { embedded: Number(row.embedded), total: Number(row.total) }
  }

  close(): void {
    this.db.close()
  }
}
