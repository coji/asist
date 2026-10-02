import { useEffect, useState, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { openTasks, type Task, type TaskPatch, type TaskStatus } from '@shared/tasks'
import { TASK_VIEWS } from '@shared/mini-apps'
import { useTaskStore, useToastStore } from '@/state/stores'
import { useMiniApp, useViewStore } from '@/state/view'
import { askConfirm } from '@/state/confirm'
import { keyForApp } from '@/ui/key-for-app'
import { Board } from './Board'
import { Editor } from './Editor'
import { ListView } from './ListView'
import { useToday } from './today'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * The tasks workspace. It switches between the board, three columns with drag and drop, and the
 * list ordered by due date, and shows the editor on the right. Every change goes to main, and the
 * full set main has committed comes back into the store and redraws the screen.
 */

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function TasksView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const update = useViewStore((s) => s.update)
  const { view, taskId: selectedId } = useMiniApp('tasks')
  const setSelectedId = (taskId: string | null): void => update('tasks', { taskId })
  const tasks = useTaskStore((s) => s.tasks)
  const loaded = useTaskStore((s) => s.loaded)
  const loadError = useTaskStore((s) => s.error)
  const load = useTaskStore((s) => s.load)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const today = useToday()
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (open) void load()
  }, [open, load])
  // A task that is gone, or that the list never had, closes the editor.
  useEffect(() => {
    if (loaded && selectedId !== null && !tasks.some((task) => task.id === selectedId)) update('tasks', { taskId: null })
  }, [loaded, tasks, selectedId, update])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (keyForApp(event) !== 'Escape' || event.defaultPrevented) return
      if (selectedId) update('tasks', { taskId: null })
      else closeApp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selectedId, update, closeApp])

  if (!open) return <></>

  const selected = tasks.find((task) => task.id === selectedId) ?? null
  /** Runs an operation against main, reporting a failure as a toast and returning false. */
  const act = (label: string, run: () => Promise<unknown>): Promise<boolean> =>
    run().then(
      () => true,
      (err: unknown) => {
        toast({ kind: 'error', title: label, body: displayError(err) })
        return false
      }
    )
  const add = (value: string, status: TaskStatus = 'todo'): void =>
    void act(t('tasks.addFailed'), async () => {
      const task = await window.api.taskCreate({ title: value, status })
      setSelectedId(task.id)
    })
  const submitAdd = (event: FormEvent): void => {
    event.preventDefault()
    const value = title.trim()
    if (!value) return
    add(value)
    setTitle('')
  }
  const patch = (task: Task, change: TaskPatch): Promise<boolean> => act(t('tasks.updateFailed'), () => window.api.taskUpdate(task.id, change))
  const move = (id: string, status: TaskStatus, index: number): Promise<boolean> =>
    act(t('tasks.moveFailed'), () => window.api.taskMove({ id, status, index }))
  const remove = async (task: Task): Promise<void> => {
    const approved = await askConfirm({
      message: t('tasks.confirmDelete', { title: task.title }),
      detail: t('tasks.deleteDetail'),
      confirmLabel: t('tasks.deleteTask'),
      destructive: true
    })
    if (!approved) return
    void act(t('tasks.deleteFailed'), async () => {
      await window.api.taskRemove(task.id)
      setSelectedId(null)
    })
  }
  const toggleDone = (task: Task): void => void patch(task, { status: task.status === 'done' ? 'todo' : 'done' })
  const clearDone = async (): Promise<void> => {
    const count = tasks.filter((task) => task.status === 'done').length
    const approved = await askConfirm({
      message: t('tasks.confirmDeleteDone', { count }),
      detail: t('tasks.deleteDetail'),
      confirmLabel: t('tasks.board.deleteDone'),
      destructive: true
    })
    if (!approved) return
    void act(t('tasks.deleteDoneFailed'), async () => {
      const removed = await window.api.tasksClearDone()
      if (selected?.status === 'done') setSelectedId(null)
      toast({ kind: 'ok', title: t('tasks.deletedDone', { count: removed }) })
    })
  }

  const openList = openTasks(tasks)
  const doing = openList.filter((task) => task.status === 'doing').length
  const dueToday = openList.filter((task) => task.due === today).length
  const overdue = openList.filter((task) => task.due !== null && task.due < today).length

  return (
    <section className="builtin-focus glass tk-focus" aria-label="TASKS">
      <header>
        <h2>TASKS</h2>
        <button onClick={closeApp}>
          {t('common.backToConversation')} <X size={16} />
        </button>
      </header>
      <div className="tk-root">
        <div className="tk-toolbar">
          <form className="tk-add" onSubmit={submitAdd}>
            <Plus size={16} />
            <input
              value={title}
              aria-label={t('tasks.newTask')}
              placeholder={t('tasks.newTaskPlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
            {title.trim() && <kbd>Enter</kbd>}
          </form>
          <ul className="tk-stats" aria-label={t('tasks.counts.label')}>
            <li>
              <b>{openList.length}</b> {t('tasks.counts.open')}
            </li>
            <li>
              <b>{doing}</b> {t('tasks.counts.doing')}
            </li>
            {dueToday > 0 && (
              <li data-tone="peach">
                <b>{dueToday}</b> {t('tasks.counts.dueToday')}
              </li>
            )}
            {overdue > 0 && (
              <li data-tone="red">
                <b>{overdue}</b> {t('tasks.counts.overdue')}
              </li>
            )}
          </ul>
          <div className="tk-views" role="group" aria-label={t('tasks.views.label')}>
            {TASK_VIEWS.map((key) => (
              <button key={key} type="button" aria-pressed={view === key} onClick={() => update('tasks', { view: key })}>
                {t(`tasks.views.${key}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="tk-body">
          <div className="tk-main">
            {loadError ? (
              <p className="tk-notice" role="alert">
                {loadError}
                <button type="button" className="cal-btn" onClick={() => void load()}>
                  {t('common.retry')}
                </button>
              </p>
            ) : !loaded ? (
              <p className="tk-notice">{t('common.loading')}</p>
            ) : view === 'board' ? (
              <Board
                tasks={tasks}
                today={today}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={move}
                onAdd={(value, status) => add(value, status)}
                onClearDone={() => void clearDone()}
              />
            ) : (
              <ListView tasks={tasks} today={today} selectedId={selectedId} onSelect={setSelectedId} onToggleDone={toggleDone} />
            )}
          </div>
          {selected && (
            <Editor
              key={selected.id}
              task={selected}
              today={today}
              onChange={(change) => patch(selected, change)}
              onRemove={() => void remove(selected)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>
    </section>
  )
}
