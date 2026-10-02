import { useEffect, useState } from 'react'
import { openTasks, type Task } from '@shared/tasks'
import { usePanelStore, useTaskStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { DueChip } from '@/ui/tasks/DueChip'
import { useToday } from '@/ui/tasks/today'
import { keyForApp } from '@/ui/key-for-app'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Empty, More } from '../primitives/Card'
import './todo.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * TODO card. The store is updated only once a save has settled, so right after a press the previous list is
 * still the one on screen.
 */

const LIMIT: Record<CardContext['size'], number> = { l: 8, m: 6, s: 4, focus: Infinity }

function TodoBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const tasks = useTaskStore((s) => s.tasks)
  const loaded = useTaskStore((s) => s.loaded)
  const loadError = useTaskStore((s) => s.error)
  const load = useTaskStore((s) => s.load)
  const setFocused = usePanelStore((s) => s.setFocused)
  const openApp = useViewStore((s) => s.openApp)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const today = useToday()
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load, spec.updatedAt])

  // Until the tasks have been read the card knows nothing about them, so it neither counts them nor
  // takes a new one.
  if (!loaded)
    return (
      <div className="card td" data-size={size}>
        <div className="card-hero">
          <h3>{t('tasks.card.title')}</h3>
        </div>
        <Empty note={loadError || undefined}>{loadError ? t('tasks.card.loadFailed') : t('common.loading')}</Empty>
        <Actions>
          {loadError && <Action onClick={() => void load()}>{t('common.retry')}</Action>}
          <Action leadsTo="screen" onClick={() => openApp({ app: 'tasks' })}>{t('tasks.card.openWorkspace')}</Action>
        </Actions>
      </div>
    )

  const run = (operation: () => Promise<unknown>, after?: () => void): void => {
    if (busy) return
    setBusy(true)
    setError('')
    void operation()
      .then(() => after?.())
      .catch((err: unknown) => setError(displayError(err)))
      .finally(() => setBusy(false))
  }
  const add = (): void => {
    const title = input.trim()
    if (!title) return
    run(() => window.api.taskCreate({ title }), () => setInput(''))
  }
  const complete = (task: Task): void => run(() => window.api.taskUpdate(task.id, { status: 'done' }))

  const open = openTasks(tasks)
  const doing = open.filter((task) => task.status === 'doing').length
  const dueToday = open.filter((task) => task.due === today).length
  const overdue = open.filter((task) => task.due !== null && task.due < today).length
  const shown = open.slice(0, LIMIT[size])
  const rest = open.length - shown.length
  const note = [dueToday ? t('tasks.card.dueToday', { count: dueToday }) : '', overdue ? t('tasks.card.overdue', { count: overdue }) : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="card td" data-size={size}>
      <div className="card-hero">
        <h3>{t('tasks.card.title')}</h3>
        <p>
          {open.length === 0
            ? t('tasks.card.empty')
            : doing
              ? t('tasks.card.countDoing', { count: open.length, doing })
              : t('tasks.card.count', { count: open.length })}
        </p>
        {note && <p className="card-note">{note}</p>}
      </div>
      <Box title={t('tasks.card.list')} note={busy ? t('common.saving') : t('tasks.card.listNote')}>
        {open.length === 0 ? (
          <Empty note={t('tasks.card.emptyListNote')}>{t('tasks.card.emptyList')}</Empty>
        ) : (
          <ul className="card-rows">
            {shown.map((task) => (
              <li key={task.id} className="card-row td-item" data-status={task.status}>
                <button
                  type="button"
                  className="td-check"
                  aria-label={t('tasks.card.markDone')}
                  title={t('tasks.card.markDone')}
                  disabled={busy}
                  onClick={() => complete(task)}
                />
                <span className="card-row-main">
                  <span className="card-row-title">{task.title}</span>
                </span>
                <span className="card-row-aside">
                  {task.status === 'doing' && <span className="td-doing">{t('tasks.card.doing')}</span>}
                  <DueChip due={task.due} today={today} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('tasks.card.more')}>
            {t('common.more', { count: rest })}
          </More>
        )}
        <div className="card-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (keyForApp(e) === 'Enter') add()
            }}
            placeholder={t('tasks.card.addPlaceholder')}
            aria-label={t('tasks.card.addLabel')}
          />
          <Action onClick={add} disabled={busy || !input.trim()}>
            {t('tasks.card.add')}
          </Action>
        </div>
      </Box>
      <Actions>
        <Action leadsTo="screen" onClick={() => openApp({ app: 'tasks' })}>{t('tasks.card.openWorkspace')}</Action>
      </Actions>
      {error && (
        <p className="card-missing" role="alert">
          {t('tasks.card.saveFailed', { message: error })}
        </p>
      )}
    </div>
  )
}

export const todoCard: CardDefinition = {
  Body: TodoBody,
  kicker: 'TODO',
  className: 'td-card'
}
