import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { errMessage } from '@shared/api-errors'
import { promptText, type PromptText } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import type { EmbeddingStatus, MemoryDocument, MemoryOverview, MemoryUnit } from '@shared/ipc'
import { FrozenMemoryBlock } from '@shared/memory-block'
import { embeddingModelKey } from '@shared/memory-embedding'
import * as embedding from './embedding'
import { MemoryIndex, type IndexSearchOptions, type MemorySearchHit } from './memory-index'
import { parseMemoryPageInput, type PromptDocumentKind } from '@shared/memory-page'
import * as store from './memory-store'
import { conversationLocale } from './conversation-locale'
import { skillSourceDir } from './memory-curation-skill'
import { errorMessage } from './i18n'
import { getSettings } from './settings'

/**
 * The entry point of long-term memory. The memory itself is the markdown under `userData/memory/`, owned
 * by memory-store.ts, and search runs against the index built from it by memory-index.ts in
 * userData/memory-index.db.
 *
 * There are three ways memory is read: me.md and user.md, which become the memory block in
 * the system prompt and are read again only when at least 5 minutes have passed since the previous turn or
 * after a change ASIST made to them; the injection that runs ahead of a turn, through search; and the
 * recall tool, also through search. The pages and the journal are reached only through search.
 *
 * Nothing is memorized during a conversation. The memory is written by the daily curation Agent in
 * memory-curation.ts, which works in a worktree, and by editing, creating and deleting from the memory
 * screen; reindex rebuilds the index once a curation has been merged. When the directory cannot be
 * prepared the conversation still runs and only memory is unavailable, with a reason.
 *
 * Embedding, multilingual-e5 in the worker of embedding.ts, is used only when the setting enables it. Vectors are
 * attached to the indexed units in the background by embedMissing, and a search embeds the query and
 * hands the vector to the index. Having no worker is a normal state in which search falls back to FTS.
 */

const INDEX_FILE = 'memory-index.db'
/**
 * How many units without a vector are read from the index at a time. Finding them scans and sorts the
 * whole table on the main thread: over 20,000 units, measured on 2026-09-26, the scans took 84 s in all
 * when read one at a time and 2.8 s when read 32 at a time.
 */
const MISSING_SCAN = 32

/** The line each document of the memory block stands under in the system prompt, read by the model in its language. */
export const PROMPT_DOCUMENT_HEADERS: Record<PromptDocumentKind, PromptText> = {
  me: {
    ja: '# 私について(me.md。私自身のこと。人柄、大事にしていること、この人との関係、いま思っていること。毎日の整理が書き、本人も直す)',
    en: '# About me (me.md: myself. Who I am, what I care about, how the two of us get on, what is on my mind. The daily curation writes it, and the user edits it too.)'
  },
  user: {
    ja: '# ユーザー(user.md。この人のこと。属性、好み、習慣、ASIST への期待。「ASIST への期待」は本人に頼まれたこと。毎日の整理が書き、本人も直す)',
    en: '# The user (user.md: this person. Their details, preferences, habits, and what they expect of me, which is what they have asked of me. The daily curation writes it, and the user edits it too.)'
  }
}

let index: MemoryIndex | null = null
let openFailure: string | null = null
let loaded = false

function open(): MemoryIndex {
  if (index) return index
  if (openFailure) throw new Error(openFailure)
  try {
    store.ensureRepo()
    index = new MemoryIndex(path.join(app.getPath('userData'), INDEX_FILE))
    return index
  } catch (err) {
    throw unavailable(err)
  }
}

/** Makes memory unavailable for the rest of the run with the reason, and returns the error to throw. */
function unavailable(err: unknown): Error {
  index = null
  openFailure = errorText('memory.errors.openFailed', { message: errMessage(err) })
  console.error('memory:', openFailure)
  return new Error(openFailure)
}

/**
 * Why memory is unavailable, or null when it works. The memory settings show it as it is, so it is
 * already written in the language of the interface.
 */
export function unavailableReason(): string | null {
  try {
    open()
    return null
  } catch (err) {
    return errorMessage(err)
  }
}

/** Rebuilds the index from the files. Problems are reported on the console, and the units they came from are still indexed. */
export function reindex(): { units: number; errors: string[] } {
  const idx = open()
  const result = store.readAll()
  try {
    idx.rebuild(result.units)
  } catch (error) {
    // A damaged index whose file could not be deleted closes itself, and memory stays unavailable for that reason.
    throw idx.isOpen ? error : unavailable(error)
  }
  for (const error of result.errors) console.warn('memory page:', error)
  loaded = true
  embedInBackground()
  return { units: result.units.length, errors: result.errors }
}

/** Called at startup and after the directory has been touched. It does nothing when memory cannot be opened; unavailableReason then holds the reason. */
export function ensureLoaded(): void {
  if (loaded) return
  if (unavailableReason()) return
  reindex()
}

export function list(): MemoryUnit[] {
  ensureLoaded()
  return open().list()
}

export function get(id: string): MemoryUnit | null {
  ensureLoaded()
  return open().get(id)
}

function requireOpen(): void {
  open()
  ensureLoaded()
}

/** The documents in the order the screen shows them: me.md, user.md, the pages, then the journal with the newest day first. */
export function documents(): MemoryDocument[] {
  requireOpen()
  return store.listDocuments()
}

export function documentRead(file: string): string | null {
  requireOpen()
  return store.readDocument(file)
}

/**
 * Replaces a whole document on the user's own action from the memory screen, unless it has changed since
 * the screen read `base`. A document that breaks the rules is not written and the reason is thrown.
 */
export function documentWrite(file: string, markdown: string, base: string): MemoryDocument {
  requireOpen()
  const document = store.writeDocument(file, markdown, base)
  reindexAfterChange()
  block.invalidate()
  return document
}

export function documentCreate(input: unknown): MemoryDocument {
  requireOpen()
  const { name } = parseMemoryPageInput(input)
  const template = fs.readFileSync(path.join(skillSourceDir(), 'assets', 'templates', 'page.md'), 'utf8')
  const document = store.createPage(name, template)
  reindexAfterChange()
  return document
}

/** Deletes a page or a journal day. */
export function documentDelete(file: string): void {
  requireOpen()
  store.deleteDocument(file)
  reindexAfterChange()
  block.invalidate()
}

/**
 * Rebuilds the index after the screen committed a change, at once, so that a vector still being computed
 * for the old text is not stored. The change stands once it is committed: a rebuild that fails leaves the
 * index to be rebuilt by whatever reads it next, such as the screen's list right after, which reports the
 * failure, rather than turning the saved change into a failed save whose retry would meet its own text as
 * someone else's.
 */
function reindexAfterChange(): void {
  try {
    reindex()
  } catch (error) {
    loaded = false
    console.error('memory: the index could not be rebuilt after a change from the screen:', errMessage(error))
  }
}

/** Searches. When embedding is available the query is embedded and memory-index.search mixes the dense scores in. */
export async function search(
  query: string,
  options: Omit<IndexSearchOptions, 'queryVector'> = {},
  signal?: AbortSignal
): Promise<MemorySearchHit[]> {
  signal?.throwIfAborted()
  ensureLoaded()
  const idx = open()
  let queryVector: Float32Array | undefined
  if (embeddingAvailable()) [queryVector] = await embedding.embed([query], 'query', signal)
  signal?.throwIfAborted()
  return idx.search(query, { ...options, queryVector })
}

/**
 * The bodies of me.md and user.md as they are now. The index leaves them out, since every prompt holds them
 * whole, so a lookup that searches the memory for something other than the prompt reads them here.
 */
export function promptDocumentBodies(): string[] {
  open()
  return store.readPromptDocuments().map(({ body }) => body)
}

export function overview(): MemoryOverview {
  const reason = unavailableReason()
  if (reason) {
    return {
      dir: store.memoryDir(),
      units: 0,
      pages: 0,
      curatedThrough: null,
      pendingJobId: null,
      lastFailure: null,
      unavailableReason: reason
    }
  }
  ensureLoaded()
  const read = store.readAll()
  return {
    dir: store.memoryDir(),
    units: read.units.length,
    pages: read.pages,
    curatedThrough: null,
    pendingJobId: null,
    lastFailure: null,
    unavailableReason: null
  }
}

const embeddingAvailable = (): boolean => getSettings().memoryEmbeddingEnabled && embedding.running()

let embedInFlight: Promise<number> | null = null
let embedAgain = false

/**
 * Attaches vectors to the units that have none, rebuilding all of them when the model has changed.
 * Concurrent calls collapse into one run, and a call that arrives while a run is in flight makes it run
 * once more afterwards. Returns how many vectors were attached.
 */
export function embedMissing(): Promise<number> {
  if (embedInFlight) {
    embedAgain = true
    return embedInFlight
  }
  const operation = embedMissingOnce().finally(() => {
    if (embedInFlight === operation) embedInFlight = null
    if (embedAgain) {
      embedAgain = false
      void embedMissing().catch((err) => console.error('memory embedding:', errMessage(err)))
    }
  })
  embedInFlight = operation
  return operation
}

/**
 * Sends the units to the worker one per request, though they are read in groups. The worker answers in
 * arrival order, so a turn's query waits behind the request in flight, and it pads the texts of a request
 * to the longest one. Measured on 2026-09-26 over the 110 units of a real index (30 to 804 characters,
 * median 176) on one thread, with other work running: a request of 32 units kept the worker busy for a
 * median of 1.6 to 1.9 s and up to 5.7 s, a request of one unit for 16 to 41 ms and up to 0.4 s, and the
 * whole index took no longer.
 */
async function embedMissingOnce(): Promise<number> {
  if (!embeddingAvailable()) return 0
  ensureLoaded()
  const idx = open()
  const key = embeddingModelKey()
  idx.setEmbeddingModel(key)
  let done = 0
  for (;;) {
    const inputs = idx.missingEmbeddings(MISSING_SCAN)
    if (inputs.length === 0) return done
    for (const input of inputs) {
      const vectors = await embedding.embed([input.text], 'document')
      if (vectors.length !== 1) throw new Error(`the worker returned ${vectors.length} vectors for one text`)
      if (embeddingModelKey() !== key) {
        embedAgain = true
        return done
      }
      if (idx.setEmbedding(input, vectors[0])) done++
    }
  }
}

function embedInBackground(): void {
  if (!embeddingAvailable()) return
  void embedMissing().catch((err) => console.error('memory embedding:', errMessage(err)))
}

let startInFlight: Promise<boolean> | null = null

/**
 * Starts the worker when the setting enables it and catches up on the units without vectors. It is called at
 * startup, when the setting is turned on and after a preparation. The run is recorded before the first await,
 * so a status read right after the call already reports the conversion.
 */
export function startEmbeddingIfEnabled(): Promise<boolean> {
  if (!getSettings().memoryEmbeddingEnabled) return Promise.resolve(false)
  const operation = (async () => {
    const ready = await embedding.ensureStarted()
    if (ready) await embedMissing()
    return ready
  })().finally(() => {
    if (startInFlight === operation) startInFlight = null
  })
  startInFlight = operation
  return operation
}

export function embeddingStatus(): EmbeddingStatus {
  const counts = unavailableReason() ? { embedded: 0, total: 0 } : (ensureLoaded(), open().embeddingCounts())
  return {
    ...embedding.installationStatus(),
    enabled: getSettings().memoryEmbeddingEnabled,
    converting: startInFlight !== null || embedInFlight !== null,
    ...counts,
    model: embeddingModelKey()
  }
}

/**
 * The memory block built from me.md and user.md. It is rebuilt only when at least 5 minutes
 * have passed since the previous turn, and stays frozen while the prompt cache is alive.
 */
const block = new FrozenMemoryBlock(() => {
  const locale = conversationLocale()
  const documents = store.readPromptDocuments().map(({ kind, body }) => `${promptText(locale, PROMPT_DOCUMENT_HEADERS[kind])}\n${body}`)
  return documents.length > 0 ? documents.join('\n\n') : null
})

/** Called at the start of a turn. It returns null when memory is unavailable or neither me.md nor user.md has a body. */
export function promptBlock(now = Date.now()): string | null {
  if (unavailableReason()) return null
  return block.forTurn(now)
}

/** Makes the next turn rebuild the memory block, for instance after a curation has been merged. */
export function invalidateBlock(): void {
  block.invalidate()
}

export function resetForTest(): void {
  index?.close()
  index = null
  openFailure = null
  loaded = false
  block.invalidate()
}
