import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbeddingKind } from '@shared/memory-embedding'
import { createTranslator } from '@shared/i18n'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted(() => ({
  userData: '',
  modelKey: 'model-a',
  running: vi.fn(() => false),
  ensureStarted: vi.fn(async () => true),
  embed: vi.fn<(texts: readonly string[], kind: EmbeddingKind) => Promise<Float32Array[]>>()
}))
vi.mock('@shared/memory-embedding', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/memory-embedding')>(),
  embeddingModelKey: () => mocks.modelKey
}))
vi.mock('../src/main/services/embedding', () => ({
  running: mocks.running,
  ensureStarted: mocks.ensureStarted,
  embed: mocks.embed,
  installationStatus: () => ({ runtimeInstalled: true, modelInstalled: true, running: mocks.running() })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] }
}))

type MemoryService = typeof import('../src/main/services/memory')
let service: MemoryService

beforeEach(async () => {
  vi.resetModules()
  mocks.running.mockReturnValue(false)
  mocks.embed.mockReset()
  mocks.modelKey = 'model-a'
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-memory-service-'))
  service = await import('../src/main/services/memory')
})

afterEach(() => {
  service.resetForTest()
  fs.rmSync(mocks.userData, { recursive: true, force: true })
})

const memoryFile = (...parts: string[]): string => path.join(mocks.userData, 'memory', ...parts)
const MUGI = '---\naliases: [ムギ, うちの猫]\n---\n# ムギ\n\n## 要約\n本人の猫。キジトラで窓辺によくいる。\n'
const MATSUBAKEN = '---\naliases: [松葉軒, ラーメン屋]\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。\n\n## 好み\n辛さは控えめが好みらしい。替え玉はしないようだ。\n'

function deferredVectors() {
  let resolve!: (vectors: Float32Array[]) => void
  const promise = new Promise<Float32Array[]>((done) => { resolve = done })
  return { promise, resolve }
}

async function enableEmbeddingWithOnePage(): Promise<string> {
  service.ensureLoaded()
  fs.writeFileSync(memoryFile('pages', 'ムギ.md'), MUGI)
  service.reindex()
  const { saveSettings } = await import('../src/main/services/settings')
  saveSettings({ memoryEmbeddingEnabled: true })
  mocks.running.mockReturnValue(true)
  return service.list()[0].id
}

describe('memory service', () => {

  it('turns every heading into a unit on reindex, follows a document rewrite and a delete in the index', async () => {
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    expect(service.reindex().units).toBe(2)
    const [summary] = service.list()
    expect(summary).toMatchObject({ kind: 'section', page: '松葉軒', heading: '要約', aliases: ['松葉軒', 'ラーメン屋'] })
    expect(service.documents().map((d) => [d.kind, d.title])).toEqual([['page', '松葉軒']])
    const rewritten = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。').replace(/## 好み[\s\S]*$/, '')
    service.documentWrite('pages/松葉軒.md', rewritten, MATSUBAKEN)
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ id: summary.id, text: '本人の行きつけの店。' })
    expect((await service.search('松葉軒行った', { mode: 'utterance' }))[0]).toMatchObject({ record: { id: summary.id }, exact: true })
    expect(() => service.documentWrite('pages/松葉軒.md', '# 松葉軒\n## 好み\nx\n', service.documentRead('pages/松葉軒.md')!)).toThrow(ja('memory.check.frontmatterMissing', { file: 'pages/松葉軒.md' }))
    service.documentDelete('pages/松葉軒.md')
    expect(service.list()).toEqual([])
    expect(service.documents()).toEqual([])
  })

  // The rebuild is made to fail with a named pipe (mkfifo), which Windows does not have in a folder.
  it.runIf(process.platform !== 'win32')('counts a committed save as done when the index cannot be rebuilt, and leaves the failure to the next read', () => {
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    service.reindex()
    // git passes over a named pipe, while the rebuild refuses to read it.
    const pipe = memoryFile('pages', 'x.md')
    execFileSync('mkfifo', [pipe])
    const rewritten = MATSUBAKEN.replace('本人の行きつけのラーメン屋。', '本人の行きつけの店。')
    expect(service.documentWrite('pages/松葉軒.md', rewritten, MATSUBAKEN)).toMatchObject({ summary: '本人の行きつけの店。' })
    expect(fs.readFileSync(memoryFile('pages', '松葉軒.md'), 'utf8')).toBe(rewritten)
    expect(() => service.documents()).toThrow('[asist:memory.errors.notRegular')
    fs.rmSync(pipe)
    expect(service.list()[0]).toMatchObject({ text: '本人の行きつけの店。' })
  })

  it('keeps me.md and user.md out of search, which every turn holds whole, so that neither an utterance nor recall brings them again', async () => {
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 話し方と癖\n語尾は柔らかく、冗談は控えめ。\n')
    fs.writeFileSync(memoryFile('user.md'), '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 属性\nくるみアレルギーがある。\n')
    fs.writeFileSync(memoryFile('pages', 'ムギ.md'), MUGI)
    service.reindex()
    expect(service.list().map((unit) => unit.file)).toEqual(['pages/ムギ.md'])
    for (const query of ['冗談', '話し方と癖', 'くるみ', 'くるみのケーキを買ってきた']) {
      for (const mode of ['keyword', 'utterance'] as const) expect([query, mode, await service.search(query, { mode })]).toEqual([query, mode, []])
    }
    expect(service.promptBlock()).toContain('くるみアレルギーがある。')
  })

  it('builds the memory block from me.md and user.md under their headings, returns null without them, and freezes the block for five minutes', () => {
    service.ensureLoaded()
    expect(service.promptBlock(1_000_000)).toBeNull()
    fs.writeFileSync(memoryFile('user.md'), '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 属性\nくるみアレルギーがある。\n')
    fs.writeFileSync(memoryFile('me.md'), '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 私は誰か\n落ち着いて話す。\n')
    expect(service.promptBlock(1_000_000 + 60_000)).toBeNull()
    const headers = service.PROMPT_DOCUMENT_HEADERS
    expect(service.promptBlock(1_000_000 + 6 * 60_000)).toBe(
      [
        `${headers.me.ja}\n## 私は誰か\n落ち着いて話す。`,
        `${headers.user.ja}\n## 属性\nくるみアレルギーがある。`
      ].join('\n\n')
    )
    expect(service.overview()).toMatchObject({ units: 0, pages: 0, lastFailure: null, unavailableReason: null })
  })

  it('puts the change a save on the memory screen made to user.md into the next turn without waiting for the freeze', () => {
    service.ensureLoaded()
    const user = '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 属性\nくるみアレルギーがある。\n'
    fs.writeFileSync(memoryFile('user.md'), user)
    service.reindex()
    expect(service.promptBlock(1_000_000)).toContain('くるみアレルギーがある。')
    service.documentWrite('user.md', user.replace('くるみ', 'そば'), user)
    expect(service.promptBlock(1_000_000 + 1_000)).toContain('そばアレルギーがある。')
  })

  it('embeds the documents while the embedder runs, and finds a paraphrase through the query vector', async () => {
    const vec = (text: string): Float32Array => new Float32Array([/ラーメン|麺/.test(text) ? 1 : 0, /猫/.test(text) ? 1 : 0, 0.1])
    const calls: Array<{ kind: string; texts: string[] }> = []
    const { saveSettings } = await import('../src/main/services/settings')
    saveSettings({ memoryEmbeddingEnabled: true })
    mocks.running.mockReturnValue(true)
    mocks.embed.mockImplementation(async (texts, kind) => {
      calls.push({ kind, texts: [...texts] })
      return texts.map(vec)
    })
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    fs.writeFileSync(memoryFile('pages', 'ムギ.md'), MUGI)
    service.reindex()
    await service.embedMissing()
    expect(calls.some((c) => c.kind === 'document' && c.texts.includes('松葉軒: 本人の行きつけのラーメン屋。'))).toBe(true)
    const hits = await service.search('お昼は麺類の気分', { mode: 'utterance' })
    expect(hits.map((h) => h.record.heading)).toEqual(['要約'])
    expect(hits[0].via).toBe('dense')
    expect(calls.at(-1)).toEqual({ kind: 'query', texts: ['お昼は麺類の気分'] })
    expect(service.embeddingStatus()).toMatchObject({ embedded: 3, total: 3, enabled: true })
  })

  it('reports the conversion from the moment the setting starts it until every memory carries a vector', async () => {
    await enableEmbeddingWithOnePage()
    let started!: (ready: boolean) => void
    mocks.ensureStarted.mockReturnValueOnce(new Promise((resolve) => { started = resolve }))
    const held = deferredVectors()
    mocks.embed.mockReturnValueOnce(held.promise)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 0, total: 1 })

    const run = service.startEmbeddingIfEnabled()
    expect(service.embeddingStatus()).toMatchObject({ converting: true, embedded: 0 })
    started(true)
    await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
    expect(service.embeddingStatus()).toMatchObject({ converting: true, embedded: 0 })
    held.resolve([new Float32Array([1, 0])])
    expect(await run).toBe(true)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 1, total: 1 })
  })

  it('ends the conversion it reported when the worker cannot start', async () => {
    await enableEmbeddingWithOnePage()
    mocks.ensureStarted.mockResolvedValueOnce(false)
    expect(await service.startEmbeddingIfEnabled()).toBe(false)
    expect(service.embeddingStatus()).toMatchObject({ converting: false, embedded: 0, total: 1 })
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('computes no vectors while the setting is off, even when the worker is running', async () => {
    mocks.running.mockReturnValue(true)
    service.ensureLoaded()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    service.reindex()
    expect(await service.embedMissing()).toBe(0)
    expect((await service.search('松葉軒', { mode: 'utterance' }))[0].exact).toBe(true)
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('passes an aborted search on to the embedder and builds no results from vectors that arrive after the abort', async () => {
    await enableEmbeddingWithOnePage()
    const held = deferredVectors()
    mocks.embed.mockReturnValueOnce(held.promise)
    const controller = new AbortController()
    const pending = service.search('ムギ', { mode: 'utterance' }, controller.signal)
    expect(mocks.embed).toHaveBeenCalledWith(['ムギ'], 'query', controller.signal)
    controller.abort()
    held.resolve([new Float32Array([1, 0])])
    await expect(pending).rejects.toBe(controller.signal.reason)
  })

  it('runs neither the embedder nor the text search for a search aborted before it started', async () => {
    await enableEmbeddingWithOnePage()
    const controller = new AbortController()
    controller.abort()
    await expect(service.search('ムギ', {}, controller.signal)).rejects.toBe(controller.signal.reason)
    expect(mocks.embed).not.toHaveBeenCalled()
  })

  it('discards a vector computed from a body that was edited meanwhile and computes it again from the new body', async () => {
    const id = await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise).mockResolvedValueOnce([new Float32Array([0, 1])])
    const pending = service.embedMissing()
    expect(mocks.embed).toHaveBeenCalledOnce()

    expect(service.get(id)).not.toBeNull()
    service.documentWrite('pages/ムギ.md', MUGI.replace('本人の猫。キジトラで窓辺によくいる。', 'チェスを楽しんでいる。'), MUGI)
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(1)
    expect(mocks.embed.mock.calls).toEqual([
      [['ムギ: 本人の猫。キジトラで窓辺によくいる。'], 'document'],
      [['ムギ: チェスを楽しんでいる。'], 'document']
    ])
    mocks.embed.mockResolvedValue([new Float32Array([1, 0])])
    expect(await service.search('以前の話題', { mode: 'utterance' })).toEqual([])
    mocks.embed.mockResolvedValue([new Float32Array([0, 1])])
    expect((await service.search('現在の話題', { mode: 'utterance' }))[0]).toMatchObject({ via: 'dense', record: { text: 'チェスを楽しんでいる。' } })
  })

  it('keeps a memory deleted during the computation out of the index and the vectors once it finishes', async () => {
    const id = await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise)
    const pending = service.embedMissing()

    expect(service.get(id)).not.toBeNull()
    service.documentDelete('pages/ムギ.md')
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(0)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 0, total: 0 })
    expect(mocks.embed).toHaveBeenCalledOnce()
  })

  it('answers a turn\'s search after the one memory being embedded, not after the rest of the backlog', async () => {
    await enableEmbeddingWithOnePage()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    fs.writeFileSync(memoryFile('pages', '鴨川.md'), '# 鴨川\n\n## 要約\n本人は週末に鴨川沿いを走る。\n\n## 距離\n一回に十キロほど。\n')
    // The worker answers in arrival order, as embedding_worker.py does.
    const queue: Array<{ kind: EmbeddingKind; texts: readonly string[]; answer: () => void }> = []
    mocks.embed.mockImplementation((texts, kind) => new Promise((resolve) => {
      queue.push({ kind, texts, answer: () => resolve(texts.map(() => new Float32Array([1, 0]))) })
    }))
    // The rebuild starts embedding the five memories without vectors in the background.
    service.reindex()
    const embedding = service.embedMissing()
    await vi.waitFor(() => expect(queue).toHaveLength(1))
    const search = service.search('鴨川で走る距離', { mode: 'utterance' })
    await vi.waitFor(() => expect(queue.map((request) => request.kind)).toContain('query'))

    let unitsAhead = 0
    for (;;) {
      const request = queue.shift()!
      request.answer()
      if (request.kind === 'query') break
      unitsAhead += request.texts.length
      await vi.waitFor(() => expect(queue.length).toBeGreaterThan(0))
    }
    await search
    expect(unitsAhead).toBe(1)

    while (service.embeddingStatus().converting) {
      queue.shift()?.answer()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await embedding).toBe(5)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 5, total: 5 })
  })

  it('stores no result of the earlier model when the model changes during the computation, and computes again with the current one', async () => {
    await enableEmbeddingWithOnePage()
    const first = deferredVectors()
    const second = deferredVectors()
    mocks.embed.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const pending = service.embedMissing()

    mocks.modelKey = 'model-b'
    first.resolve([new Float32Array([1, 0])])
    expect(await pending).toBe(0)
    expect(mocks.embed).toHaveBeenCalledTimes(2)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 0, total: 1 })
    const recomputed = service.embedMissing()
    second.resolve([new Float32Array([0, 1])])
    expect(await recomputed).toBe(1)
    expect(service.embeddingStatus()).toMatchObject({ embedded: 1, total: 1, model: 'model-b' })
  })

  it('builds the index anew when its file is not a database, rather than leaving memory unavailable', async () => {
    fs.writeFileSync(path.join(mocks.userData, 'memory-index.db'), 'not a database '.repeat(100))
    expect(service.unavailableReason()).toBeNull()
    fs.writeFileSync(memoryFile('pages', '松葉軒.md'), MATSUBAKEN)
    service.reindex()
    expect((await service.search('ラーメン屋'))[0]).toMatchObject({ record: { page: '松葉軒', heading: '要約' } })
  })

  it('reports why memory is unavailable when the index is damaged and its file cannot be deleted to build it again', async () => {
    const { MemoryIndex } = await import('../src/main/services/memory-index')
    const file = path.join(mocks.userData, 'memory-index.db')
    const built = new MemoryIndex(file)
    built.rebuild(Array.from({ length: 2000 }, (_, n) => ({
      id: `p${n}`, file: `pages/p${n}.md`, line: 1, kind: 'section' as const, page: `p${n}`, heading: 'Summary',
      aliases: [], text: `Page ${n} talks about the river, the bread and the week.`, date: '2026-09-01', order: 0
    })))
    built.close()
    // The header and the schema stay readable, so the file opens and the rebuild meets the damage.
    const bytes = fs.readFileSync(file)
    bytes.fill(0x5a, 4096 * 3)
    fs.writeFileSync(file, bytes)
    // What Windows does while a scanner or the search indexer holds the file.
    const rm = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      rm(target, options)
    })
    expect(() => service.list()).toThrow('[asist:memory.errors.openFailed')
    vi.mocked(fs.rmSync).mockRestore()
    expect(service.unavailableReason()).toContain('EBUSY')
    await expect(service.search('river')).rejects.toThrow('[asist:memory.errors.openFailed')
  })

  it('reports why memory alone is unavailable when its directory cannot be created, and leaves the conversation running', () => {
    fs.writeFileSync(path.join(mocks.userData, 'memory'), 'not a directory')
    expect(service.unavailableReason()).toContain(ja('memory.errors.openFailed', { message: '' }).trim())
    expect(service.promptBlock()).toBeNull()
    expect(service.overview().unavailableReason).toContain(ja('memory.errors.openFailed', { message: '' }).trim())
    expect(() => service.list()).toThrow('[asist:memory.errors.openFailed')
  })
})
