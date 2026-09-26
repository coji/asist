import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRoundExecutor } from '@shared/tool-round'
import { executeClientTool, toolRegistry } from '../src/main/services/brain/tools'
import { createNoteService } from '../src/main/services/notes'

const mocks = vi.hoisted(() => ({ service: undefined as unknown }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/memory', () => ({}))
vi.mock('../src/main/services/agent', () => ({}))
vi.mock('../src/main/services/project-index', () => ({}))
vi.mock('../src/main/services/panel-fetchers', () => ({}))
vi.mock('../src/main/services/timers', () => ({}))
vi.mock('../src/main/services/user-notes', () => ({ getNoteService: () => mocks.service }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => ({}) }))

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(tmpdir(), 'asist-tool-write-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function setup() {
  const notesDirectory = path.join(directory, 'notes')
  const notify = vi.fn()
  const service = createNoteService({ directory: notesDirectory, trash: async () => {}, onChanged: notify })
  mocks.service = service
  const saved = (): string[] => (fs.existsSync(notesDirectory) ? fs.readdirSync(notesDirectory) : [])
  const bodies = (): string[] => saved().map((name) => fs.readFileSync(path.join(notesDirectory, name), 'utf8'))
  const round = new ToolRoundExecutor({
    signal: new AbortController().signal,
    isParallel: (name) => toolRegistry().find(name)!.parallel,
    execute: (call, signal) => executeClientTool(call.name, call.input, { turnId: 1, signal, emit: () => {} })
  })
  return { saved, bodies, notify, service, round }
}

describe('tool completion and committing a local save', () => {
  it('waits for a rename and its notification that already started after the response timed out, and leaves no write behind on close', async () => {
    const { saved, bodies, notify, service, round } = await setup()
    const gate = deferred()
    const entered = deferred()
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      entered.resolve()
      await gate.promise
      await rename(from, to)
    })
    vi.useFakeTimers()
    const result = round.submit({ id: 'note', name: 'add_note', input: { markdown: '# 保存開始済みのメモ' } })
    await entered.promise
    await vi.advanceTimersByTimeAsync(2_001)
    expect((await result).execution.isError).toBe(true)
    let closed = false
    const closing = round.close().then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(closed).toBe(false)
    expect(saved().filter((name) => name.endsWith('.md'))).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    gate.resolve()
    await closing
    expect(notify).toHaveBeenCalledOnce()
    expect(bodies()).toEqual(['# 保存開始済みのメモ\n'])
    expect((await service.list())[0].title).toBe('保存開始済みのメモ')
  })

  it('does not rename when the write is aborted after the temp file, keeping the saved data and the in-memory state', async () => {
    const { saved, bodies, notify, service, round } = await setup()
    await service.create('# 元からあるメモ')
    notify.mockClear()
    const before = saved()
    const gate = deferred()
    const entered = deferred()
    const writeFile = fsp.writeFile.bind(fsp)
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
      await writeFile(...args)
      entered.resolve()
      await gate.promise
    })
    const rename = vi.spyOn(fsp, 'rename')
    vi.useFakeTimers()
    const result = round.submit({ id: 'note', name: 'add_note', input: { markdown: '# 保存を中断するメモ' } })
    await entered.promise
    await vi.advanceTimersByTimeAsync(2_001)
    expect((await result).execution.isError).toBe(true)
    const closing = round.close()
    gate.resolve()
    await closing
    expect(rename).not.toHaveBeenCalled()
    expect(saved()).toEqual(before)
    expect(bodies()).toEqual(['# 元からあるメモ\n'])
    expect((await service.list()).map((note) => note.title)).toEqual(['元からあるメモ'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('never starts a change aborted while it waited in the save queue, even after the save ahead of it finishes', async () => {
    const { bodies, service } = await setup()
    const gate = deferred()
    const entered = deferred()
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      entered.resolve()
      await gate.promise
      await rename(from, to)
    })
    const first = service.create('# 先行する保存')
    await entered.promise
    const controller = new AbortController()
    const queued = service.create('# 待機中に中断', controller.signal)
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    gate.resolve()
    await first
    await rejected
    expect(bodies()).toEqual(['# 先行する保存\n'])
  })
})
