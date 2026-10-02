import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnEvent } from '@shared/ipc'
import { executeClientTool, toolRegistry } from '../src/main/services/brain/tools'
import { createNoteService, type NoteService } from '../src/main/services/notes'

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
let service: NoteService
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(tmpdir(), 'asist-note-tools-'))
  service = createNoteService({ directory, trash: async () => {} })
  mocks.service = service
})
afterEach(() => {
  service.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function call(name: string, input: Record<string, unknown>) {
  const events: TurnEvent[] = []
  const ctx = { turnId: 7, signal: new AbortController().signal, emit: (event: TurnEvent) => events.push(event) }
  const execution = await executeClientTool(name, input, ctx, 'ja-JP')
  return { execution, events, result: execution.isError ? null : JSON.parse(execution.content) }
}

describe('note tools', () => {
  it('puts up the notes card from search_notes only when asked', async () => {
    const quiet = await call('search_notes', {})
    expect(quiet.events).toEqual([])
    const shown = await call('search_notes', { card: true })
    expect(shown.result).toMatchObject({ count: expect.any(Number) })
    expect(shown.events).toEqual([
      { type: 'panel', turnId: 7, event: { op: 'create', key: 'notes', type: 'notes', slot: 'right', props: {}, state: 'ready', source: 'LOCAL' } }
    ])
  })

  it('saves a new note from add_note and puts up the notes card marking it', async () => {
    const { result, events } = await call('add_note', { markdown: '# 歓迎会\n\n- 8人\n' })
    const [note] = await service.list()
    expect(result).toEqual({ id: note.id, title: '歓迎会' })
    expect(events).toEqual([
      { type: 'panel', turnId: 7, event: { op: 'create', key: 'notes', type: 'notes', slot: 'right', props: { focusId: note.id }, state: 'ready' } }
    ])
  })

  it('reports an empty note as a failed call and saves nothing', async () => {
    const { execution, events } = await call('add_note', { markdown: '  ' })
    expect(execution.isError).toBe(true)
    expect(events).toEqual([])
    expect(await service.list()).toEqual([])
  })

  it('finds a note by its words and reads its whole text, but gives no tool that changes or deletes one', async () => {
    const saved = await service.create('# 旅行の持ち物\n\n充電器と傘\n')
    await service.create('# 買い物\n\n牛乳\n')
    const { result: found } = await call('search_notes', { query: '充電器' })
    expect(found).toMatchObject({ count: 1, notes: [{ id: saved.id, title: '旅行の持ち物' }] })
    const { result: read } = await call('read_note', { id: saved.id })
    expect(read).toEqual({ id: saved.id, markdown: '# 旅行の持ち物\n\n充電器と傘\n' })
    expect((await call('read_note', { id: '../settings' })).execution.isError).toBe(true)
    const noteTools = toolRegistry('ja-JP').definitions.map((def) => def.name).filter((name) => name.includes('note'))
    expect(noteTools.sort()).toEqual(['add_note', 'read_note', 'search_notes'])
  })
})
