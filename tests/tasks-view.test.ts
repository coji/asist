// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKeyOf, type Task, type TaskStatus } from '@shared/tasks'
import { createTranslator } from '@shared/i18n'
import { TasksView } from '../src/renderer/src/ui/tasks/TasksView'
import { useTaskStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { answerConfirm } from './helpers/confirm'
import type { DndContextProps, DragEndEvent, DragStartEvent } from '@dnd-kit/core'

/** The board's own drag handlers, so that a test can lift and drop a card as a pointer would. */
const dnd = vi.hoisted(() => ({ props: null as null | DndContextProps }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      dnd.props = props
      return createElement(actual.DndContext, props)
    }
  }
})

/** The tasks view: what the board and the list show, that add, edit and complete reach main, and the order Escape closes things in. */

const t = createTranslator('ja-JP')
const today = dayKeyOf(new Date())
const task = (id: string, title: string, status: TaskStatus, order: number, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  notes: '',
  status,
  due: null,
  order,
  createdAt: 1,
  updatedAt: 1,
  completedAt: status === 'done' ? 1 : null,
  ...patch
})
const tasks = [
  task('a', '相槌を増やす', 'todo', 0, { due: '2000-01-01' }),
  task('b', '経費精算', 'todo', 1, { due: today }),
  task('c', 'レビュー', 'doing', 0, { notes: '月表示を見る' }),
  task('d', '背景を作る', 'done', 0)
]
const api = {
  tasksList: vi.fn(async () => tasks),
  taskCreate: vi.fn(async (input: { title: string; status?: TaskStatus }) => task('new', input.title, input.status ?? 'todo', 9)),
  taskUpdate: vi.fn(async (id: string) => tasks.find((t) => t.id === id)!),
  taskMove: vi.fn(async () => tasks[0]),
  taskRemove: vi.fn(async (id: string) => tasks.find((t) => t.id === id)!),
  tasksClearDone: vi.fn(async () => 1)
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  useTaskStore.setState({ tasks, loaded: true, error: '' })
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'tasks' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(TasksView, { open: true })))
  return container.querySelector<HTMLElement>('[aria-label="TASKS"]')!
}
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
/** Chromium on macOS sends the Enter that confirms an IME conversion, and the Escape that cancels one, with isComposing set. */
const press = (target: EventTarget, key: string, isComposing = false): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing, bubbles: true }))
const leave = (field: HTMLElement): boolean => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

describe('board', () => {
  it('groups the tasks by column and shows the count, the due chip and how many are due today or overdue', async () => {
    const view = await render()
    expect(api.tasksList).toHaveBeenCalled()
    const titles = (status: TaskStatus): string[] =>
      [...view.querySelectorAll(`.tk-column[data-status="${status}"] .tk-card-title`)].map((el) => el.textContent)
    expect(titles('todo')).toEqual(['相槌を増やす', '経費精算'])
    expect(titles('doing')).toEqual(['レビュー'])
    expect(titles('done')).toEqual(['背景を作る'])
    expect(view.querySelector('.tk-column[data-status="todo"] .tk-count')?.textContent).toBe('2')
    expect(view.querySelector('.tk-column[data-status="todo"] .tk-due')?.getAttribute('data-state')).toBe('overdue')
    expect(view.querySelector('.tk-stats')?.textContent).toContain('1 今日')
    expect(view.querySelector('.tk-stats')?.textContent).toContain('1 期限切れ')
  })

  it('adds from the field at the top on Enter, and the field under a column sends that column status to main', async () => {
    const view = await render()
    const input = view.querySelector<HTMLInputElement>('.tk-add input')!
    await act(async () => setValue(input, '歯医者の予約'))
    await act(async () => view.querySelector<HTMLFormElement>('.tk-add')!.requestSubmit())
    expect(api.taskCreate).toHaveBeenCalledWith({ title: '歯医者の予約', status: 'todo' })
    expect(input.value).toBe('')

    await act(async () => view.querySelector<HTMLButtonElement>('.tk-column[data-status="doing"] .tk-quick-add button')!.click())
    const quick = view.querySelector<HTMLInputElement>('.tk-column[data-status="doing"] .tk-quick-add input')!
    await act(async () => setValue(quick, '今すぐやる'))
    await act(async () => quick.closest('form')!.requestSubmit())
    expect(api.taskCreate).toHaveBeenLastCalledWith({ title: '今すぐやる', status: 'doing' })
  })

  it('opens the editor on the right when a card is clicked and sends status, due date, title and notes changes to main', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLElement>('.tk-column[data-status="doing"] .tk-card')!.click())
    const editor = view.querySelector<HTMLElement>('.tk-editor')!
    expect(editor.querySelector<HTMLInputElement>('.tk-editor-title')?.value).toBe('レビュー')
    expect(editor.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('月表示を見る')
    expect(editor.querySelector('.tk-editor-status [aria-pressed="true"]')?.textContent).toBe(t('tasks.status.doing'))

    await act(async () => [...editor.querySelectorAll<HTMLButtonElement>('.tk-editor-status button')][2].click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { status: 'done' })
    await act(async () => [...editor.querySelectorAll<HTMLButtonElement>('.tk-quick button')].find((b) => b.textContent === t('tasks.editor.dueTomorrow'))!.click())
    expect(api.taskUpdate.mock.calls.at(-1)?.[1]).toEqual({ due: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })

    const title = editor.querySelector<HTMLInputElement>('.tk-editor-title')!
    await act(async () => setValue(title, 'レビューを終える'))
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { title: 'レビューを終える' })
    await act(async () => setValue(title, '   '))
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate.mock.calls.filter(([, patch]) => 'title' in patch)).toHaveLength(1)

    const notes = editor.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => setValue(notes, '週表示も見る'))
    await act(async () => notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { notes: '週表示も見る' })
  })

  it('closes the editor on the first Escape and the view on the second, and removes a task only after the confirmation', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLElement>('.tk-card')!.click())
    expect(view.querySelector('.tk-editor')).not.toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(view.querySelector('.tk-editor')).toBeNull()
    expect(useViewStore.getState().open?.app).toBe('tasks')

    await act(async () => view.querySelector<HTMLElement>('.tk-card')!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-danger')!.click())
    await answerConfirm(false)
    expect(api.taskRemove).not.toHaveBeenCalled()
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-danger')!.click())
    await answerConfirm(true)
    expect(api.taskRemove).toHaveBeenCalledWith('a')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('tasks')
  })

  it('puts a dropped card where it was let go even when main removed a card above that place during the drag', async () => {
    await render()
    const [a, b, c, d] = tasks
    await act(async () => dnd.props!.onDragStart!({ active: { id: c.id } } as unknown as DragStartEvent))
    // The model finishes the first to-do while the card is held.
    await act(async () => useTaskStore.setState({ tasks: [{ ...b, order: 0 }, c, { ...d, order: 1 }, { ...a, status: 'done', order: 0 }] }))
    // Let go above the second to-do, which is now the first.
    await act(async () =>
      dnd.props!.onDragEnd!({ active: { id: c.id }, over: { id: b.id }, collisions: [{ id: b.id, data: { placement: 'before' } }] } as unknown as DragEndEvent)
    )
    expect(api.taskMove).toHaveBeenCalledWith({ id: c.id, status: 'todo', index: 0 })
  })

  it('clears every done task at once from the tool on the done column, after a confirmation', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-column[data-status="done"] .tk-column-tool')!.click())
    await answerConfirm(true)
    expect(api.tasksClearDone).toHaveBeenCalled()
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe(t('tasks.deletedDone', { count: 1 }))
  })
})

describe('editor', () => {
  async function openEditor(): Promise<HTMLElement> {
    const view = await render()
    await act(async () => view.querySelector<HTMLElement>('.tk-column[data-status="doing"] .tk-card')!.click())
    return view.querySelector<HTMLElement>('.tk-editor')!
  }
  const titleField = (editor: HTMLElement): HTMLInputElement => editor.querySelector<HTMLInputElement>('.tk-editor-title')!
  const notesField = (editor: HTMLElement): HTMLTextAreaElement => editor.querySelector<HTMLTextAreaElement>('textarea')!
  /** update_task from the conversation commits a change, and main delivers every task. */
  const changeInMain = (patch: Partial<Task>): void =>
    useTaskStore.getState().apply(tasks.map((item) => (item.id === 'c' ? { ...item, ...patch, updatedAt: 2 } : item)))

  it('shows the title and the notes main committed while the editor was open', async () => {
    const editor = await openEditor()
    await act(async () => changeInMain({ title: 'レビューを終える', notes: '週表示も見る' }))
    expect(titleField(editor).value).toBe('レビューを終える')
    expect(notesField(editor).value).toBe('週表示も見る')
  })

  it('saves nothing when the title and the notes are entered and left without typing after main changed them', async () => {
    const editor = await openEditor()
    await act(async () => changeInMain({ title: 'レビューを終える', notes: '週表示も見る' }))
    await act(async () => void leave(notesField(editor)))
    await act(async () => void leave(titleField(editor)))
    expect(api.taskUpdate).not.toHaveBeenCalled()
  })

  it('keeps the text being typed while main changes the task, and saves it when the field is left', async () => {
    const editor = await openEditor()
    await act(async () => setValue(notesField(editor), '月表示と週表示を見る'))
    await act(async () => changeInMain({ notes: '週表示も見る' }))
    expect(notesField(editor).value).toBe('月表示と週表示を見る')
    await act(async () => void leave(notesField(editor)))
    expect(api.taskUpdate.mock.calls).toEqual([['c', { notes: '月表示と週表示を見る' }]])
  })

  it('saves nothing when the typed text is put back to what the field held before the typing', async () => {
    const editor = await openEditor()
    await act(async () => setValue(notesField(editor), '月表示を見る。'))
    await act(async () => changeInMain({ notes: '週表示も見る' }))
    await act(async () => setValue(notesField(editor), '月表示を見る'))
    await act(async () => void leave(notesField(editor)))
    expect(api.taskUpdate).not.toHaveBeenCalled()
    expect(notesField(editor).value).toBe('週表示も見る')
  })

  it('keeps a title main refused in the field, and saves it again when the field is left again', async () => {
    api.taskUpdate.mockRejectedValueOnce(new Error('tasks.json に書けません'))
    const editor = await openEditor()
    const title = titleField(editor)
    await act(async () => setValue(title, 'レビューを終える'))
    await act(async () => void leave(title))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: t('tasks.updateFailed') })
    expect(title.value).toBe('レビューを終える')
    await act(async () => void leave(title))
    expect(api.taskUpdate.mock.calls).toEqual([
      ['c', { title: 'レビューを終える' }],
      ['c', { title: 'レビューを終える' }]
    ])
  })

  it('gives way to a change from the conversation after main refused the typed notes, and does not write them over it', async () => {
    api.taskUpdate.mockRejectedValueOnce(new Error('tasks.json に書けません'))
    const editor = await openEditor()
    await act(async () => setValue(notesField(editor), 'ユーザーの補足'))
    await act(async () => void leave(notesField(editor)))
    await act(async () => changeInMain({ notes: 'モデルの補足' }))
    expect(notesField(editor).value).toBe('モデルの補足')
    await act(async () => void leave(notesField(editor)))
    expect(api.taskUpdate.mock.calls).toEqual([['c', { notes: 'ユーザーの補足' }]])
  })

  it('saves a title typed back to the saved one while the save of the first edit is under way', async () => {
    let answerFirst!: () => void
    api.taskUpdate.mockImplementationOnce((id: string) => new Promise((resolve) => (answerFirst = () => resolve(tasks.find((item) => item.id === id)!))))
    const editor = await openEditor()
    const title = titleField(editor)
    await act(async () => setValue(title, 'レビュー2'))
    await act(async () => void leave(title))
    await act(async () => setValue(title, 'レビュー'))
    await act(async () => void leave(title))
    await act(async () => {
      changeInMain({ title: 'レビュー2' })
      answerFirst()
    })
    expect(api.taskUpdate.mock.calls).toEqual([
      ['c', { title: 'レビュー2' }],
      ['c', { title: 'レビュー' }]
    ])
  })

  it('keeps a second title main refused after the first one arrived from main', async () => {
    let answerFirst!: () => void
    let refuseSecond!: () => void
    api.taskUpdate
      .mockImplementationOnce((id: string) => new Promise((resolve) => (answerFirst = () => resolve(tasks.find((item) => item.id === id)!))))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuseSecond = () => reject(new Error('tasks.json に書けません')))))
    const editor = await openEditor()
    const title = titleField(editor)
    await act(async () => setValue(title, '一回目'))
    await act(async () => void leave(title))
    await act(async () => setValue(title, '二回目'))
    await act(async () => void leave(title))
    await act(async () => {
      changeInMain({ title: '一回目' })
      answerFirst()
    })
    expect(title.value).toBe('二回目')
    await act(async () => refuseSecond())
    expect(title.value).toBe('二回目')
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: t('tasks.updateFailed') })
  })

  it('saves the notes being typed when the editor closes while they still have focus, as when the model opens another task', async () => {
    const editor = await openEditor()
    const notes = notesField(editor)
    notes.focus()
    await act(async () => setValue(notes, '打ちかけの補足'))
    await act(async () => useViewStore.getState().update('tasks', { taskId: 'a' }))
    expect(api.taskUpdate.mock.calls).toEqual([['c', { notes: '打ちかけの補足' }]])
  })

  it('puts the title back and saves nothing when Escape is pressed in the title field', async () => {
    const editor = await openEditor()
    const title = titleField(editor)
    title.focus()
    await act(async () => setValue(title, 'レビュー書きかけ'))
    await act(async () => void press(title, 'Escape'))
    expect(api.taskUpdate).not.toHaveBeenCalled()
    expect(title.value).toBe('レビュー')
    expect(document.activeElement).not.toBe(title)
    expect(container.querySelector('.tk-editor')).not.toBeNull()
  })

  it('stays in the title field on the Enter that confirms an IME conversion, and saves the title on the next Enter', async () => {
    const editor = await openEditor()
    const title = titleField(editor)
    title.focus()
    await act(async () => setValue(title, '資料を'))
    await act(async () => void press(title, 'Enter', true))
    expect(document.activeElement).toBe(title)
    expect(api.taskUpdate).not.toHaveBeenCalled()
    await act(async () => setValue(title, '資料を作る'))
    await act(async () => void press(title, 'Enter'))
    expect(api.taskUpdate.mock.calls).toEqual([['c', { title: '資料を作る' }]])
  })

  it('keeps the typed title, the editor and the screen on the Escape that cancels an IME conversion in the title', async () => {
    const editor = await openEditor()
    const title = titleField(editor)
    title.focus()
    await act(async () => setValue(title, 'レビューしりょう'))
    await act(async () => void press(title, 'Escape', true))
    expect(title.value).toBe('レビューしりょう')
    expect(document.activeElement).toBe(title)
    expect(container.querySelector('.tk-editor')).not.toBeNull()
    expect(useViewStore.getState().open?.app).toBe('tasks')
  })

  it('keeps the field at the top, the field under a column and the editor on the Escape that cancels an IME conversion in a field', async () => {
    await openEditor()
    const view = container.querySelector<HTMLElement>('[aria-label="TASKS"]')!
    const top = view.querySelector<HTMLInputElement>('.tk-add input')!
    await act(async () => setValue(top, 'はいしゃ'))
    await act(async () => void press(top, 'Escape', true))
    expect(top.value).toBe('はいしゃ')
    expect(view.querySelector('.tk-editor')).not.toBeNull()
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-column[data-status="doing"] .tk-quick-add button')!.click())
    const quick = view.querySelector<HTMLInputElement>('.tk-column[data-status="doing"] .tk-quick-add input')!
    await act(async () => setValue(quick, 'いますぐ'))
    await act(async () => void press(quick, 'Escape', true))
    expect(quick.isConnected).toBe(true)
    expect(quick.value).toBe('いますぐ')
    expect(view.querySelector('.tk-editor')).not.toBeNull()
    expect(useViewStore.getState().open?.app).toBe('tasks')
  })
})

describe('list view', () => {
  it('groups the rows by due date, toggles done from the circle, and keeps the done rows in a collapsed section', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.tk-views button')].find((b) => b.textContent === t('tasks.views.list'))!.click())
    const sections = [...view.querySelectorAll<HTMLElement>('.tk-section')].map((el) => el.dataset.key)
    expect(sections).toEqual(['overdue', 'today', 'none', 'done'])
    expect(view.querySelector('.tk-section[data-key="none"] .tk-chip')?.textContent).toBe(t('tasks.status.doing'))
    expect(view.querySelector('.tk-section[data-key="done"] .tk-rows')).toBeNull()

    await act(async () => view.querySelector<HTMLButtonElement>('.tk-section[data-key="today"] .tk-check')!.click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('b', { status: 'done' })
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-toggle')!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-section[data-key="done"] .tk-check')!.click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('d', { status: 'todo' })
  })

  it('shows the reason and a retry when loading fails', async () => {
    useTaskStore.setState({ tasks: [], loaded: false, error: 'tasks.json が壊れています' })
    api.tasksList.mockRejectedValueOnce(new Error('tasks.json が壊れています'))
    const view = await render()
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('tasks.json が壊れています')
  })
})
