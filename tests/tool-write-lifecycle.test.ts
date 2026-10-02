import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_TIMEOUT_MS } from '@shared/tool-registry'
import { ToolRoundExecutor } from '@shared/tool-round'
import { executeClientTool, toolRegistry } from '../src/main/services/brain/tools'
import { createNoteService, type NoteService } from '../src/main/services/notes'
import { createTaskService } from '../src/main/services/tasks'

const mocks = vi.hoisted(() => ({ service: undefined as unknown, tasks: undefined as unknown }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/memory', () => ({}))
vi.mock('../src/main/services/agent', () => ({}))
vi.mock('../src/main/services/project-index', () => ({}))
vi.mock('../src/main/services/panel-fetchers', () => ({}))
vi.mock('../src/main/services/timers', () => ({}))
vi.mock('../src/main/services/user-notes', () => ({ getNoteService: () => mocks.service }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => mocks.tasks }))

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(tmpdir(), 'asist-tool-write-')) })
afterEach(() => {
  const notes = mocks.service as NoteService | undefined
  notes?.close()
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
  const tasks = createTaskService({ filePath: path.join(directory, 'tasks.json') })
  mocks.tasks = tasks
  const round = new ToolRoundExecutor({
    signal: new AbortController().signal,
    locale: 'ja-JP',
    isParallel: (name) => toolRegistry('ja-JP').find(name)!.parallel,
    execute: (call, signal) => executeClientTool(call.name, call.input, { turnId: 1, signal, emit: () => {} }, 'ja-JP')
  })
  return { saved, bodies, notify, service, tasks, round }
}

/** How the wait for a tool is cut off: by its time limit, or by the user cutting in, which closes the round. */
type Cut = 'its time limit' | 'the user cutting in'

/** Cuts off the wait for the call, lets the held step go on, and returns what the model is told once the round has closed. */
async function cutOff(round: ToolRoundExecutor, result: ReturnType<ToolRoundExecutor['submit']>, cut: Cut, gate: { resolve: () => void }) {
  if (cut === 'its time limit') await vi.advanceTimersByTimeAsync(LOCAL_TIMEOUT_MS + 1)
  const closing = round.close()
  const { execution } = await result
  gate.resolve()
  await closing
  return execution
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
    // Nothing was written, so the model may simply call it again.
    const { execution } = await result
    expect(execution.isError).toBe(true)
    expect(execution.unfinished).toBeUndefined()
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

describe('a write whose wait is cut off once it has begun', () => {
  it.each<Cut>(['its time limit', 'the user cutting in'])('tells the model that add_note cut off by %s while its file was being renamed into place may have saved it, so that it does not save a second one', async (cut) => {
    const { saved, round } = await setup()
    const gate = deferred()
    const entered = deferred()
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      entered.resolve()
      await gate.promise
      await rename(from, to)
    })
    vi.useFakeTimers()
    const result = round.submit({ id: 'note', name: 'add_note', input: { markdown: '# 一度だけ残すメモ' } })
    await entered.promise
    const execution = await cutOff(round, result, cut, gate)
    expect(execution).toMatchObject({ isError: true, unfinished: true })
    expect(saved()).toHaveLength(1)
  })

  it.each<Cut>(['its time limit', 'the user cutting in'])('tells the model the same of add_task cut off by %s while its file was being renamed into place', async (cut) => {
    const { tasks, round } = await setup()
    const gate = deferred()
    const entered = deferred()
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      entered.resolve()
      await gate.promise
      await rename(from, to)
    })
    vi.useFakeTimers()
    const result = round.submit({ id: 'task', name: 'add_task', input: { title: '請求書を送る' } })
    await entered.promise
    const execution = await cutOff(round, result, cut, gate)
    expect(execution).toMatchObject({ isError: true, unfinished: true })
    expect((await tasks.list()).map((task) => task.title)).toEqual(['請求書を送る'])
  })
})
