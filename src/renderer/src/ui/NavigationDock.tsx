import { useEffect, useState } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core'
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { isJobExecuting } from '@shared/job-status'
import { dayKeyOf, openTasks } from '@shared/tasks'
import { DEFAULT_DOCK_ORDER, type DockItem } from '@shared/dock'
import type { MessageKey } from '@shared/i18n'
import { useT } from '@/i18n'
import { useJobStore, useMailStore, useSettingsStore, useTaskStore, useToastStore } from '@/state/stores'
import { activeMiniApp, useViewStore } from '@/state/view'
import asistIcon from '@/assets/holo/asist.png'
import agentIcon from '@/assets/holo/agent.png'
import tasksIcon from '@/assets/holo/tasks.png'
import mailIcon from '@/assets/holo/mail.png'
import memoryIcon from '@/assets/holo/memory.png'
import notesIcon from '@/assets/holo/notes.png'
import calendarIcon from '@/assets/holo/calendar.png'
import settingsIcon from '@/assets/holo/settings.png'
import { displayError } from '@/display-error'

/**
 * The navigation along the bottom. ASIST, the conversation, stays at the left edge, and the other
 * screens follow the dockOrder setting. The icons can be reordered by dragging them sideways, where
 * movement below 6 px still counts as a click, and the order is saved through main.
 */

const ITEMS = {
  jobs: { label: 'navigation.items.jobs', icon: agentIcon },
  tasks: { label: 'navigation.items.tasks', icon: tasksIcon },
  notes: { label: 'navigation.items.notes', icon: notesIcon },
  mail: { label: 'navigation.items.mail', icon: mailIcon },
  memory: { label: 'navigation.items.memory', icon: memoryIcon },
  calendar: { label: 'navigation.items.calendar', icon: calendarIcon },
  settings: { label: 'navigation.items.settings', icon: settingsIcon }
} as const satisfies Record<DockItem, { label: MessageKey; icon: string }>

/** Allows sideways movement only, holding the vertical offset at zero. */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 })

export function NavigationDock(): React.JSX.Element {
  const open = useViewStore(activeMiniApp)
  const toggleApp = useViewStore((s) => s.toggleApp)
  const closeApp = useViewStore((s) => s.closeApp)
  const t = useT()
  const savedOrder = useSettingsStore((s) => s.settings?.dockOrder ?? DEFAULT_DOCK_ORDER)
  const save = useSettingsStore((s) => s.save)
  const toast = useToastStore((s) => s.push)
  // The order a drag produced is held locally until the save finishes, or until a failed save puts
  // the previous order back.
  const [pendingOrder, setPendingOrder] = useState<readonly DockItem[] | null>(null)
  const order = pendingOrder ?? savedOrder
  const runningJobs = useJobStore((s) => s.jobs.filter((job) => isJobExecuting(job.status)).length)
  // Open tasks that are due today or overdue, counted on the badge so that the number can be read
  // without opening the screen.
  const dueTasks = useTaskStore((s) => {
    const today = dayKeyOf(new Date())
    return openTasks(s.tasks).filter((task) => task.due !== null && task.due <= today).length
  })
  // Unread mail from the last 24 hours only, so that old unread mail does not inflate the number.
  const recentMail = useMailStore((s) => s.status?.unreadRecent ?? 0)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // The calendar, tasks, notes, mail and memory screens handle Escape themselves, because a card or an
  // editor inside them has to close first.
  useEffect(() => {
    if (open !== 'settings' && open !== 'jobs') return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      closeApp()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, closeApp])

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const next = arrayMove([...order], order.indexOf(active.id as DockItem), order.indexOf(over.id as DockItem))
    setPendingOrder(next)
    void save({ dockOrder: next })
      .catch((err: unknown) => toast({ kind: 'error', title: t('navigation.orderSaveFailed'), body: displayError(err) }))
      .finally(() => setPendingOrder(null))
  }

  const badges: Record<DockItem, number> = { jobs: runningJobs, tasks: dueTasks, notes: 0, mail: recentMail, memory: 0, calendar: 0, settings: 0 }

  return (
    <nav aria-label={t('navigation.label')} className="navigation-dock glass">
      <button aria-label={t('navigation.conversation')} aria-pressed={open === null} onClick={closeApp}>
        <img src={asistIcon} alt="" />
        <span>ASIST</span>
      </button>
      <span className="dock-divider" aria-hidden />
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[horizontalOnly]} onDragEnd={onDragEnd}>
        <SortableContext items={order as DockItem[]} strategy={horizontalListSortingStrategy}>
          {order.map((item) => (
            <DockButton key={item} item={item} pressed={open === item} badge={badges[item]} toggle={() => toggleApp(item)} />
          ))}
        </SortableContext>
      </DndContext>
    </nav>
  )
}

function DockButton({
  item,
  pressed,
  badge,
  toggle
}: {
  item: DockItem
  pressed: boolean
  badge: number
  toggle: () => void
}): React.JSX.Element {
  const t = useT()
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: item })
  const { label, icon } = ITEMS[item]
  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-item={item}
      data-dragging={isDragging || undefined}
      aria-label={t(label)}
      aria-pressed={pressed}
      onClick={toggle}
      {...listeners}
    >
      <img src={icon} alt="" />
      <span>{t(label)}</span>
      {badge > 0 && <b className="dock-badge">{badge}</b>}
    </button>
  )
}
