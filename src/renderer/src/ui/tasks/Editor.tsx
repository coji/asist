import { flushSync } from 'react-dom'
import { Trash2, X } from 'lucide-react'
import { TASK_STATUSES, addDaysKey, type Task, type TaskPatch, type TaskStatus } from '@shared/tasks'
import { relativeTime } from '@/panels/primitives/format'
import { useFieldDraft } from '@/ui/field-draft'
import { keyForApp } from '@/ui/key-for-app'
import { useT } from '@/i18n'

/**
 * The editor on the right. The title and the notes are saved when the field loses focus, while the
 * status and the due date are saved the moment they are pressed. The parent gives it key={task.id},
 * so selecting another task builds it anew.
 */
export function Editor({
  task,
  today,
  onChange,
  onRemove,
  onClose
}: {
  task: Task
  today: string
  /** Saves a change through main, reporting a failure itself, and resolves to whether it was saved. */
  onChange: (patch: TaskPatch) => Promise<boolean>
  onRemove: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const title = useFieldDraft(task.title, { format: (text) => text, parse: (text) => text.trim() || null, save: (value) => onChange({ title: value }) })
  const notes = useFieldDraft(task.notes, { format: (text) => text, parse: (text) => text, save: (value) => onChange({ notes: value }) })
  const setStatus = (status: TaskStatus): void => {
    if (status !== task.status) void onChange({ status })
  }
  const setDue = (due: string | null): void => {
    if (due !== task.due) void onChange({ due })
  }
  const quick: Array<[string, string | null]> = [
    [t('tasks.editor.dueToday'), today],
    [t('tasks.editor.dueTomorrow'), addDaysKey(today, 1)],
    [t('tasks.editor.dueNextWeek'), addDaysKey(today, 7)],
    [t('tasks.editor.dueNone'), null]
  ]
  return (
    <aside className="tk-editor" aria-label={t('tasks.editor.label')}>
      <div className="tk-editor-head">
        <div className="tk-editor-status" role="group" aria-label={t('tasks.editor.status')}>
          {TASK_STATUSES.map((status) => (
            <button key={status} type="button" aria-pressed={task.status === status} onClick={() => setStatus(status)}>
              {t(`tasks.status.${status}`)}
            </button>
          ))}
        </div>
        <button type="button" className="tk-editor-close" aria-label={t('tasks.editor.close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <input
        className="tk-editor-title"
        aria-label={t('tasks.editor.title')}
        {...title.props}
        onKeyDown={(event) => {
          title.props.onKeyDown(event)
          if (keyForApp(event) === 'Escape') {
            const field = event.currentTarget
            event.stopPropagation()
            // blur() runs onBlur before React would apply a discard made in this handler, and that onBlur
            // would save the text Escape throws away.
            flushSync(title.discard)
            field.blur()
          }
        }}
      />
      <div className="tk-field">
        <label htmlFor={`due-${task.id}`}>{t('tasks.editor.due')}</label>
        <input
          id={`due-${task.id}`}
          type="date"
          value={task.due ?? ''}
          onChange={(event) => setDue(event.target.value || null)}
        />
        <div className="tk-quick" role="group" aria-label={t('tasks.editor.dueChoices')}>
          {quick.map(([label, value]) => (
            <button key={label} type="button" aria-pressed={task.due === value} onClick={() => setDue(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="tk-field">
        <label htmlFor={`notes-${task.id}`}>{t('tasks.editor.notes')}</label>
        <textarea
          id={`notes-${task.id}`}
          placeholder={t('tasks.editor.notesPlaceholder')}
          {...notes.props}
          onKeyDown={(event) => {
            notes.props.onKeyDown(event)
            if (keyForApp(event) === 'Escape') event.stopPropagation()
          }}
        />
      </div>
      <dl className="tk-editor-meta">
        <div>
          <dt>{t('tasks.editor.createdAt')}</dt>
          <dd>{relativeTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>{t('tasks.editor.updatedAt')}</dt>
          <dd>{relativeTime(task.updatedAt)}</dd>
        </div>
        {task.completedAt && (
          <div>
            <dt>{t('tasks.editor.completedAt')}</dt>
            <dd>{relativeTime(task.completedAt)}</dd>
          </div>
        )}
      </dl>
      <div className="tk-editor-foot">
        <button type="button" className="tk-danger" onClick={onRemove}>
          <Trash2 size={14} /> {t('common.delete')}
        </button>
      </div>
    </aside>
  )
}
