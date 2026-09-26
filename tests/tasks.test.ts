import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskService } from '../src/main/services/tasks'
import {
  addDaysKey,
  applyTaskPatch,
  columnOf,
  dueLabel,
  dueState,
  openTasks,
  parseStoredTaskSnapshot,
  placeTask,
  reindex,
  taskInputSchema,
  taskSummary,
  taskPatchSchema,
  type Task
} from '@shared/tasks'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { CollisionDetection, UniqueIdentifier } from '@dnd-kit/core'
import { boardCollision, columnsOf, previewColumns } from '../src/renderer/src/ui/tasks/Board'

/** Tasks: the order inside a column and moves between columns, how a due date reads, and saving and broadcasting in main. */

const temporaryDirectories: string[] = []
async function temporaryFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asist-tasks-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'tasks.json')
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

const task = (id: string, status: Task['status'], order: number, patch: Partial<Task> = {}): Task => ({
  id,
  title: id,
  notes: '',
  status,
  due: null,
  order,
  createdAt: 1,
  updatedAt: 1,
  completedAt: status === 'done' ? 1 : null,
  ...patch
})
const board = [task('a', 'todo', 0), task('b', 'todo', 1), task('c', 'todo', 2), task('d', 'doing', 0), task('e', 'done', 0)]
const ids = (tasks: Task[], status: Task['status']): string[] => columnOf(tasks, status).map((t) => t.id)

describe('ordering and moving inside the columns', () => {
  it('shifts the tasks in between when a task moves forward or back inside the same column', () => {
    expect(ids(placeTask(board, 'c', 'todo', 0, 9), 'todo')).toEqual(['c', 'a', 'b'])
    expect(ids(placeTask(board, 'a', 'todo', 2, 9), 'todo')).toEqual(['b', 'c', 'a'])
    expect(ids(placeTask(board, 'a', 'todo', 99, 9), 'todo')).toEqual(['b', 'c', 'a'])
    const same = placeTask(board, 'b', 'todo', 1, 9)
    expect(same.find((t) => t.id === 'b')?.updatedAt).toBe(1)
  })

  it('changes the status on a move, sets the completion time on entering done and clears it on leaving', () => {
    const moved = placeTask(board, 'a', 'doing', 0, 42)
    expect(ids(moved, 'todo')).toEqual(['b', 'c'])
    expect(ids(moved, 'doing')).toEqual(['a', 'd'])
    expect(moved.find((t) => t.id === 'a')).toMatchObject({ status: 'doing', updatedAt: 42, completedAt: null })
    const done = placeTask(moved, 'a', 'done', 1, 43)
    expect(ids(done, 'done')).toEqual(['e', 'a'])
    expect(done.find((t) => t.id === 'a')?.completedAt).toBe(43)
    const back = placeTask(done, 'e', 'todo', 0, 44)
    expect(back.find((t) => t.id === 'e')).toMatchObject({ status: 'todo', completedAt: null, order: 0 })
    expect(() => placeTask(board, 'zz', 'todo', 0, 1)).toThrow(errorText('tasks.errors.notFound'))
  })

  it('patches only the fields it is given and puts the task last in the target column when the status changes', () => {
    const patched = applyTaskPatch(board, 'a', { status: 'doing', due: '2026-09-20' }, 50)
    expect(patched.find((t) => t.id === 'a')).toMatchObject({ status: 'doing', order: 1, due: '2026-09-20', updatedAt: 50, title: 'a' })
    expect(applyTaskPatch(board, 'b', { title: '新しい題' }, 51).find((t) => t.id === 'b')).toMatchObject({ title: '新しい題', order: 1 })
  })

  it('previews a drag by inserting at the card under the pointer, or at the end when the pointer is over a column', () => {
    const columns = columnsOf(board)
    expect(columns).toEqual({ todo: ['a', 'b', 'c'], doing: ['d'], done: ['e'] })
    expect(previewColumns(columns, 'a', 'c').todo).toEqual(['b', 'c', 'a'])
    expect(previewColumns(columns, 'a', 'd')).toMatchObject({ todo: ['b', 'c'], doing: ['a', 'd'] })
    expect(previewColumns(columns, 'a', 'column:done')).toMatchObject({ todo: ['b', 'c'], done: ['e', 'a'] })
    expect(previewColumns(columns, 'a', 'column:todo').todo).toEqual(['b', 'c', 'a'])
    expect(previewColumns(columns, 'a', 'nowhere')).toBe(columns)
    expect(previewColumns(columns, 'a', 'd', 'after').doing).toEqual(['d', 'a'])
    expect(previewColumns(columns, 'a', 'a')).toBe(columns)
  })

  describe('board collision detection', () => {
    /** The rectangles of the columns and the cards: todo holds a, b and c, doing holds d, and done is empty. */
    const rects: Record<string, [number, number, number, number]> = {
      'column:todo': [0, 0, 200, 600],
      'column:doing': [220, 0, 200, 600],
      'column:done': [440, 0, 200, 600],
      a: [10, 10, 180, 60],
      b: [10, 80, 180, 60],
      c: [10, 150, 180, 60],
      d: [230, 10, 180, 60]
    }
    const detect = boardCollision({ current: { todo: ['a', 'b', 'c'], doing: ['d'], done: [] } })
    const over = (x: number, y: number, active = 'a'): { id: UniqueIdentifier; placement?: string } => {
      const droppableRects = new Map(
        Object.entries(rects).map(([id, [left, top, width, height]]) => [id, { left, top, width, height, right: left + width, bottom: top + height }])
      )
      const args = {
        active: { id: active },
        collisionRect: droppableRects.get(active),
        droppableRects,
        droppableContainers: Object.keys(rects).map((id) => ({ id })),
        pointerCoordinates: { x, y }
      } as unknown as Parameters<CollisionDetection>[0]
      const [hit] = detect(args)
      return { id: hit.id, placement: hit.data?.placement }
    }

    it('rewrites over inside the same column so that above a card center means before it and below means after', () => {
      expect(over(100, 95)).toEqual({ id: 'a', placement: 'before' })
      expect(over(100, 120)).toEqual({ id: 'b', placement: 'after' })
      expect(over(100, 165)).toEqual({ id: 'b', placement: 'before' })
      expect(over(100, 200)).toEqual({ id: 'c', placement: 'after' })
      expect(over(100, 20, 'c')).toEqual({ id: 'a', placement: 'before' })
      expect(over(100, 60, 'c')).toEqual({ id: 'b', placement: 'after' })
    })

    it('returns the vertically nearest card and a side in another column, and the column itself when it is empty', () => {
      expect(over(300, 30)).toEqual({ id: 'd', placement: 'before' })
      expect(over(300, 50)).toEqual({ id: 'd', placement: 'after' })
      expect(over(300, 500)).toEqual({ id: 'd', placement: 'after' })
      expect(over(500, 300)).toEqual({ id: 'column:done', placement: 'before' })
    })

    it('judges by the horizontally nearest column when the pointer is in the gap between columns', () => {
      expect(over(215, 30)).toEqual({ id: 'd', placement: 'before' })
      expect(over(205, 30)).toEqual({ id: 'a', placement: 'before' })
    })
  })

  it('lists the open tasks with doing first and each column in its own order', () => {
    expect(openTasks(board).map((t) => t.id)).toEqual(['d', 'a', 'b', 'c'])
    expect(reindex([task('x', 'todo', 7), task('y', 'todo', 3)]).map((t) => [t.id, t.order])).toEqual([
      ['y', 0],
      ['x', 1]
    ])
  })
})

describe('due dates', () => {
  it('splits a due date against today into overdue, today, tomorrow, within a week and later', () => {
    const today = '2026-09-16'
    expect(dueState('2026-09-15', today)).toBe('overdue')
    expect(dueState('2026-09-16', today)).toBe('today')
    expect(dueState('2026-09-17', today)).toBe('tomorrow')
    expect(dueState('2026-09-23', today)).toBe('week')
    expect(dueState('2026-09-24', today)).toBe('later')
    expect(dueState(null, today)).toBeNull()
    expect(addDaysKey('2026-09-30', 1)).toBe('2026-10-01')
  })

  it('labels a nearby day in words and a distant one with its date', () => {
    const today = '2026-09-16'
    const ja = createTranslator('ja-JP')
    const label = (due: string): string => dueLabel(due, today, ja, 'ja-JP')
    expect(label('2026-09-16')).toBe(ja('tasks.due.today'))
    expect(label('2026-09-17')).toBe(ja('tasks.due.tomorrow'))
    expect(label('2026-09-15')).toBe(ja('tasks.due.yesterday'))
    expect(label('2026-09-13')).toBe(ja('tasks.due.daysAgo', { count: 3 }))
    expect(label('2026-09-20')).toBe(ja('tasks.due.inDays', { count: 4 }))
    expect(label('2026-10-04')).toBe('10/4(日)')
    expect(label('2027-01-05')).toBe('2027/1/5(火)')
    expect(dueLabel('2026-09-17', today, createTranslator('en-US'), 'en-US')).toBe('Tomorrow')
  })

  it('names the status of a task in the language the tools are written in', () => {
    const task = { id: 'a', title: 'x', notes: '', status: 'doing' as const, due: null, order: 0, createdAt: 0, updatedAt: 0, completedAt: null }
    expect(taskSummary(task, 'ja').statusLabel).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
    expect(taskSummary(task, 'en').statusLabel).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
  })

  it('tells the Agent when a task was finished on the local day, as the same instant', () => {
    const zone = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      // 00:30 on 2026-09-16 in Japan, which is still 2026-09-15 in UTC.
      const finished = Date.UTC(2026, 8, 15, 15, 30)
      const task = { id: 'a', title: 'x', notes: '', status: 'done' as const, due: null, order: 0, createdAt: 0, updatedAt: finished, completedAt: finished }
      const completedAt = String(taskSummary(task, 'en').completedAt)
      expect(completedAt.startsWith('2026-09-16T00:30')).toBe(true)
      expect(Date.parse(completedAt)).toBe(finished)
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('rejects an empty or overlong title, a date that does not exist, and an unknown field', () => {
    expect(taskInputSchema.safeParse({ title: '  買い物  ' }).data).toMatchObject({ title: '買い物', status: 'todo', due: null, notes: '' })
    expect(taskInputSchema.safeParse({ title: '' }).success).toBe(false)
    expect(taskInputSchema.safeParse({ title: 'a', due: '2026-02-30' }).success).toBe(false)
    expect(taskInputSchema.safeParse({ title: 'a', due: '9/16' }).success).toBe(false)
    expect(taskInputSchema.safeParse({ title: 'a', extra: 1 }).success).toBe(false)
    expect(taskPatchSchema.safeParse({}).success).toBe(false)
    expect(taskPatchSchema.safeParse({ due: null }).success).toBe(true)
  })
})

describe('persistence in main', () => {
  it('returns from a create, update, move or remove only after the rename, and broadcasts the whole committed list', async () => {
    const filePath = await temporaryFile()
    let sequence = 0
    const changes: string[][] = []
    const service = createTaskService({
      filePath,
      now: () => 1_000 + sequence,
      createId: () => `id-${++sequence}`,
      onChanged: (tasks) => changes.push(tasks.map((t) => `${t.status}:${t.title}`))
    })
    const first = await service.create({ title: '牛乳を買う', due: '2026-09-20' })
    expect(first).toMatchObject({ id: 'id-1', status: 'todo', order: 0, due: '2026-09-20' })
    await service.create({ title: 'レビュー', status: 'doing' })
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['tasks.json'])
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({ version: 1, tasks: [{ title: '牛乳を買う' }, { title: 'レビュー' }] })

    const updated = await service.update('id-1', { status: 'done', notes: '2本' })
    expect(updated).toMatchObject({ status: 'done', notes: '2本', order: 0 })
    expect(updated.completedAt).not.toBeNull()
    await service.move({ id: 'id-1', status: 'todo', index: 0 })
    expect((await service.list()).find((t) => t.id === 'id-1')).toMatchObject({ status: 'todo', completedAt: null })
    expect((await service.remove('id-1')).title).toBe('牛乳を買う')
    expect(await service.list()).toHaveLength(1)
    expect(changes).toEqual([
      ['todo:牛乳を買う'],
      ['todo:牛乳を買う', 'doing:レビュー'],
      ['doing:レビュー', 'done:牛乳を買う'],
      ['todo:牛乳を買う', 'doing:レビュー'],
      ['doing:レビュー']
    ])
    await expect(service.update('id-1', { title: 'x' })).rejects.toThrow(errorText('tasks.errors.notFound'))
    await expect(service.create({ title: '' })).rejects.toThrow(errorText('tasks.errors.titleEmpty'))
  })

  it('fails without overwriting a corrupt file and refuses a version it does not know', async () => {
    const filePath = await temporaryFile()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '{ broken')
    const service = createTaskService({ filePath })
    await expect(service.list()).rejects.toThrow('[asist:app.storage.jsonBroken')
    await expect(service.create({ title: 'x' })).rejects.toThrow('[asist:app.storage.jsonBroken')
    expect(await fs.readFile(filePath, 'utf8')).toBe('{ broken')

    const future = JSON.stringify({ version: 2, tasks: [] })
    await fs.writeFile(filePath, future)
    await expect(createTaskService({ filePath }).list()).rejects.toThrow(errorText('app.storage.versionTooNew', { file: 'tasks.json', version: 2, supported: 1 }))
    expect(await fs.readFile(filePath, 'utf8')).toBe(future)
    expect(() => parseStoredTaskSnapshot({ tasks: [task('a', 'todo', 0), task('a', 'todo', 1)] })).toThrow(errorText('tasks.errors.storeDuplicateId', { id: 'a' }))
    expect(() => parseStoredTaskSnapshot({ tasks: [{ ...task('a', 'todo', 0), due: 'bad' }] })).toThrow('[asist:tasks.errors.storeItemBroken')
  })

  it('serializes concurrent creates so none are lost, and closes the gaps in the order when done tasks are cleared', async () => {
    const filePath = await temporaryFile()
    let sequence = 0
    const service = createTaskService({ filePath, now: () => sequence, createId: () => `c-${sequence++}` })
    await Promise.all(Array.from({ length: 30 }, (_, i) => service.create({ title: `t${i}`, status: i % 3 ? 'todo' : 'done' })))
    const tasks = await service.list()
    expect(tasks).toHaveLength(30)
    expect(columnOf(tasks, 'todo').map((t) => t.order)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(await service.clearDone()).toBe(10)
    expect(await service.clearDone()).toBe(0)
    expect((await service.list()).every((t) => t.status !== 'done')).toBe(true)
  })

  it('does not rename when the write is aborted after the temp file, so the saved content stays', async () => {
    const filePath = await temporaryFile()
    const service = createTaskService({ filePath, now: () => 1, createId: () => `k-${Math.random()}` })
    await service.create({ title: '元からある' })
    const original = await fs.readFile(filePath, 'utf8')
    const controller = new AbortController()
    controller.abort()
    await expect(service.create({ title: '中断される' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await fs.readFile(filePath, 'utf8')).toBe(original)
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['tasks.json'])
    expect((await service.list()).map((t) => t.title)).toEqual(['元からある'])
  })
})
