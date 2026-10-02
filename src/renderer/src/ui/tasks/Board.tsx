import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlignLeft, Plus } from 'lucide-react'
import { TASK_STATUSES, columnOf, type Task, type TaskStatus } from '@shared/tasks'
import { keyForApp } from '@/ui/key-for-app'
import { DueChip } from './DueChip'
import { useT } from '@/i18n'

/**
 * The board. Cards stand in three columns, and dragging changes both the column and the order.
 * During a drag the order of the ids is held locally per column, and on drop main is told which
 * column and which position the card landed in. That local order is kept afterwards and aligned only
 * when main sends back the full set it has committed. Aligning at the moment of the drop, with the
 * tasks from before the save, shows the card back in its old place for an instant, which was seen on
 * the device on 2026-09-16.
 *
 * The copy of the grabbed card, the DragOverlay, is rendered into document.body. The frame of a
 * workspace carries a backdrop-filter, and inside it position: fixed resolves against the frame's
 * top left corner, which moves the copy down and to the right of the pointer; the offset was
 * measured as the frame's own (16, 74) px on 2026-09-16.
 */

export type Columns = Record<TaskStatus, string[]>
export type Placement = 'before' | 'after'
const COLUMN_ID: Record<TaskStatus, string> = { todo: 'column:todo', doing: 'column:doing', done: 'column:done' }
const statusOfColumnId = (id: UniqueIdentifier): TaskStatus | null =>
  (TASK_STATUSES.find((status) => COLUMN_ID[status] === id) as TaskStatus | undefined) ?? null

export const columnsOf = (tasks: readonly Task[]): Columns => ({
  todo: columnOf(tasks, 'todo').map((task) => task.id),
  doing: columnOf(tasks, 'doing').map((task) => task.id),
  done: columnOf(tasks, 'done').map((task) => task.id)
})

const columnHolding = (columns: Columns, id: UniqueIdentifier): TaskStatus | null =>
  statusOfColumnId(id) ?? TASK_STATUSES.find((status) => columns[status].includes(String(id))) ?? null

/**
 * The order during a drag, which moves the active card into the column it is over.
 * - Another column: before the card it is over, or after it when the placement is after, and at the
 *   end of the column when it is over the column itself.
 * - The same column: the active card moves to that position and the cards in between close the gap,
 *   through arrayMove.
 * The same object comes back when nothing changes.
 */
export function previewColumns(
  columns: Columns,
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  placement: Placement = 'before'
): Columns {
  const from = columnHolding(columns, activeId)
  const to = columnHolding(columns, overId)
  if (!from || !to) return columns
  const active = String(activeId)
  const over = String(overId)
  if (from === to) {
    const fromIndex = columns[from].indexOf(active)
    const toIndex = statusOfColumnId(overId) ? columns[to].length - 1 : columns[to].indexOf(over)
    if (fromIndex === toIndex || toIndex < 0) return columns
    return { ...columns, [from]: arrayMove(columns[from], fromIndex, toIndex) }
  }
  const source = columns[from].filter((id) => id !== active)
  const target = columns[to].filter((id) => id !== active)
  const overIndex = statusOfColumnId(overId) ? -1 : target.indexOf(over)
  target.splice(overIndex < 0 ? target.length : overIndex + (placement === 'after' ? 1 : 0), 0, active)
  return { ...columns, [from]: source, [to]: target }
}

interface Point {
  x: number
  y: number
}
interface Rect {
  top: number
  left: number
  width: number
  height: number
}
const centerY = (rect: Rect): number => rect.top + rect.height / 2
const contains = (rect: Rect, point: Point): boolean =>
  point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height

/**
 * Collision detection. Within the column the pointer is in, or the horizontally nearest column when
 * it is outside them all, the vertically nearest card becomes the one being dragged over. With
 * closestCorners that target jumped the moment the pointer crossed between columns or sat in a gap,
 * and the drop position kept wobbling.
 *
 * The placement is before the card when the pointer is above its center and after it when below.
 * Inside one column that placement is translated into the neighbouring card so that it agrees with
 * the result of arrayMove: placing before means the previous card, and nothing moves when the
 * neighbour is the dragged card itself. Across columns the placement is handed to dragOver, which
 * inserts the card. Dragging with the keyboard has no pointer, so closestCorners does the work.
 */
export function boardCollision(columnsRef: { readonly current: Columns }): CollisionDetection {
  return (args) => {
    const point = args.pointerCoordinates
    if (!point) return closestCorners(args)
    const { droppableRects, droppableContainers, active } = args
    const rectOf = (id: UniqueIdentifier): Rect | undefined => droppableRects.get(id)
    const columnContainers = droppableContainers.filter((container) => statusOfColumnId(container.id) !== null)
    let column = columnContainers.find((container) => {
      const rect = rectOf(container.id)
      return rect !== undefined && contains(rect, point)
    })
    if (!column) {
      let best = Infinity
      for (const container of columnContainers) {
        const rect = rectOf(container.id)
        if (!rect) continue
        const distance = Math.abs(point.x - (rect.left + rect.width / 2))
        if (distance < best) {
          best = distance
          column = container
        }
      }
    }
    if (!column) return []
    const status = statusOfColumnId(column.id) as TaskStatus
    const ids = columnsRef.current[status]
    let nearest: { id: UniqueIdentifier; distance: number; placement: Placement } | null = null
    for (const container of droppableContainers) {
      if (!ids.includes(String(container.id))) continue
      const rect = rectOf(container.id)
      if (!rect) continue
      const distance = Math.abs(point.y - centerY(rect))
      if (!nearest || distance < nearest.distance) {
        nearest = { id: container.id, distance, placement: point.y < centerY(rect) ? 'before' : 'after' }
      }
    }
    if (!nearest) return [{ id: column.id, data: { placement: 'before' } }]
    let overId = nearest.id
    const activeIndex = ids.indexOf(String(active.id))
    const overIndex = ids.indexOf(String(nearest.id))
    if (activeIndex >= 0 && overIndex >= 0 && activeIndex !== overIndex) {
      if (activeIndex < overIndex && nearest.placement === 'before') overId = ids[overIndex - 1]
      else if (activeIndex > overIndex && nearest.placement === 'after') overId = ids[overIndex + 1]
    }
    return [{ id: overId, data: { placement: nearest.placement } }]
  }
}

const placementOf = (collisions: Collision[] | null | undefined): Placement =>
  collisions?.[0]?.data?.placement === 'after' ? 'after' : 'before'

interface BoardProps {
  tasks: Task[]
  today: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Sends the move to main and answers true once it is saved; false makes the local order fall back to tasks. */
  onMove: (id: string, status: TaskStatus, index: number) => Promise<boolean>
  onAdd: (title: string, status: TaskStatus) => void
  onClearDone: () => void
}

export function Board({ tasks, today, selectedId, onSelect, onMove, onAdd, onClearDone }: BoardProps): React.JSX.Element {
  const [columns, setColumns] = useState<Columns>(() => columnsOf(tasks))
  const [activeId, setActiveId] = useState<string | null>(null)
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const sensors = useSensors(
    // Movement below 5 px still counts as a click, so pressing a card selects it.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space lifts a card, the arrow keys move it and Space drops it. Enter stays with opening a card.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] }
    })
  )
  const collisionDetection = useMemo(() => boardCollision(columnsRef), [])

  // The columns follow the tasks main has committed, and only those. Tasks that arrive during a drag
  // are taken over when the card is dropped.
  useEffect(() => {
    if (activeRef.current === null) setColumns(columnsOf(tasks))
  }, [tasks])

  const onDragStart = ({ active }: DragStartEvent): void => setActiveId(String(active.id))
  const onDragOver = ({ active, over, collisions }: DragOverEvent): void => {
    if (!over) return
    // Inside one column the order stays as it is and the sortable strategy does the visual shifting;
    // changing the order here as well would move the cards twice.
    const from = columnHolding(columnsRef.current, active.id)
    const to = columnHolding(columnsRef.current, over.id)
    if (!from || !to || from === to) return
    setColumns((current) => previewColumns(current, active.id, over.id, placementOf(collisions)))
  }
  const onDragEnd = ({ active, over, collisions }: DragEndEvent): void => {
    const final = over ? previewColumns(columns, active.id, over.id, placementOf(collisions)) : columns
    const status = columnHolding(final, active.id)
    setActiveId(null)
    const task = status ? byId.get(String(active.id)) : undefined
    const index = status ? final[status].indexOf(String(active.id)) : -1
    if (!status || !task || (task.status === status && task.order === index)) {
      setColumns(columnsOf(tasksRef.current))
      return
    }
    setColumns(final)
    void onMove(task.id, status, index).then((saved) => {
      if (!saved) setColumns(columnsOf(tasksRef.current))
    })
  }
  const onDragCancel = (): void => {
    setColumns(columnsOf(tasks))
    setActiveId(null)
  }
  const active = activeId ? byId.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="tk-board" data-dragging={activeId !== null || undefined}>
        {TASK_STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            ids={columns[status]}
            byId={byId}
            today={today}
            selectedId={selectedId}
            onSelect={onSelect}
            onAdd={(title) => onAdd(title, status)}
            onClearDone={status === 'done' ? onClearDone : undefined}
          />
        ))}
      </div>
      {createPortal(
        <DragOverlay
          dropAnimation={{
            duration: 200,
            easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)',
            sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } })
          }}
        >
          {active && <CardView task={active} today={today} overlay />}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}

function Column({
  status,
  ids,
  byId,
  today,
  selectedId,
  onSelect,
  onAdd,
  onClearDone
}: {
  status: TaskStatus
  ids: string[]
  byId: Map<string, Task>
  today: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (title: string) => void
  onClearDone?: () => void
}): React.JSX.Element {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: COLUMN_ID[status] })
  const items = ids.map((id) => byId.get(id)).filter((task): task is Task => task !== undefined)
  return (
    <section className="tk-column" data-status={status} data-over={isOver || undefined} aria-label={t(`tasks.status.${status}`)}>
      <header className="tk-column-head">
        <h3>
          {t(`tasks.status.${status}`)}
          <span className="tk-count">{items.length}</span>
        </h3>
        {onClearDone && items.length > 0 && (
          <button type="button" className="tk-column-tool" onClick={onClearDone}>
            {t('tasks.board.deleteDone')}
          </button>
        )}
      </header>
      <SortableContext id={COLUMN_ID[status]} items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="tk-column-body">
          {items.map((task) => (
            <SortableCard key={task.id} task={task} today={today} selected={task.id === selectedId} onSelect={onSelect} />
          ))}
          {items.length === 0 && (
            <p className="tk-column-empty">
              {status === 'todo' ? t('tasks.board.emptyTodo') : status === 'doing' ? t('tasks.board.emptyDoing') : t('tasks.board.emptyDone')}
            </p>
          )}
        </div>
      </SortableContext>
      <QuickAdd status={status} onAdd={onAdd} />
    </section>
  )
}

function SortableCard({
  task,
  today,
  selected,
  onSelect
}: {
  task: Task
  today: string
  selected: boolean
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  return (
    <CardView
      ref={setNodeRef}
      task={task}
      today={today}
      selected={selected}
      dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onSelect(selected ? null : task.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect(task.id)
      }}
      {...attributes}
      {...listeners}
    />
  )
}

interface CardViewProps extends React.HTMLAttributes<HTMLElement> {
  task: Task
  today: string
  selected?: boolean
  dragging?: boolean
  overlay?: boolean
  ref?: React.Ref<HTMLElement>
}

/** How a card looks, both inside the board and as the copy shown in the drag overlay. */
function CardView({ task, today, selected, dragging, overlay, ref, ...rest }: CardViewProps): React.JSX.Element {
  const t = useT()
  return (
    <article
      ref={ref}
      className={overlay ? 'tk-card is-overlay' : 'tk-card'}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-status={task.status}
      aria-label={task.title}
      {...rest}
    >
      <span className="tk-card-title">{task.title}</span>
      {(task.due || task.notes) && (
        <span className="tk-card-meta">
          <DueChip due={task.due} today={today} done={task.status === 'done'} />
          {task.notes && <AlignLeft size={12} aria-label={t('tasks.notes')} />}
        </span>
      )}
    </article>
  )
}

/** The add field under a column. Pressing it turns it into an input, Enter adds the task and Escape closes it. */
function QuickAdd({ status, onAdd }: { status: TaskStatus; onAdd: (title: string) => void }): React.JSX.Element {
  const t = useT()
  const statusLabel = t(`tasks.status.${status}`)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const value = title.trim()
    if (!value) return
    onAdd(value)
    setTitle('')
  }
  if (!editing) {
    return (
      <div className="tk-quick-add">
        <button type="button" onClick={() => setEditing(true)} aria-label={t('tasks.board.addTo', { status: statusLabel })}>
          <Plus size={14} /> {t('tasks.board.add')}
        </button>
      </div>
    )
  }
  return (
    <form className="tk-quick-add" onSubmit={submit}>
      <input
        ref={inputRef}
        value={title}
        placeholder={t('tasks.board.addToPlaceholder', { status: statusLabel })}
        aria-label={t('tasks.board.addToInput', { status: statusLabel })}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (!title.trim()) setEditing(false)
        }}
        onKeyDown={(event) => {
          if (keyForApp(event) === 'Escape') {
            event.stopPropagation()
            setTitle('')
            setEditing(false)
          }
        }}
      />
    </form>
  )
}
