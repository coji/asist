import { isJobTerminal } from '@shared/job-status'
import { translate } from '@/i18n'
import { useJobStore, useMailStore, useNoteStore, usePanelStore, useTaskStore, useToastStore } from '@/state/stores'
import { useConfirmStore } from '@/state/confirm'

/**
 * Keeps the stores of what main owns (tasks, notes, mail, confirmations, panels and agent jobs) in step
 * with main: each store loads once and then applies the events main pushes.
 */

export interface StoreSyncHooks {
  /** A confirmation that held the conversation was answered, so the turn that waited for it can be heard again. */
  onHeldConfirmationClosed(): void
}

export async function startStoreSync(hooks: StoreSyncHooks): Promise<void> {
  window.api.onTasksChanged((tasks) => useTaskStore.getState().apply(tasks))
  void useTaskStore.getState().load()
  window.api.onNotesChanged((notes) => useNoteStore.getState().apply(notes))
  void useNoteStore.getState().load()
  // Mail status is copied into the store, while a fetch or a change bumps a generation so the views
  // and the cards load again. A draft that was sent or discarded has its card closed.
  window.api.onMailEvent((event) => {
    if (event.type === 'status') useMailStore.getState().apply(event.status)
    else if (event.type === 'drafts') {
      const alive = new Set(event.drafts.map((draft) => `mail-draft:${draft.id}`))
      useMailStore.getState().applyDrafts(event.drafts)
      for (const panel of usePanelStore.getState().panels) {
        if (panel.type === 'mail-draft' && !alive.has(panel.key)) usePanelStore.getState().apply({ op: 'dismiss', key: panel.key })
      }
    } else useMailStore.getState().bump()
  })
  void useMailStore.getState().refresh()
  void useMailStore.getState().loadDrafts()
  // Confirmations that main asks for are answered in the app's own sheet. A page that loads while main
  // already waits, after a reload or a crash of the renderer, missed their open events, so it asks for
  // them once it listens; a request that opens in between arrives both ways and is queued once.
  window.api.onConfirmEvent((event) => {
    if (event.type === 'open') {
      useConfirmStore.getState().open(event.request)
      return
    }
    const held = useConfirmStore.getState().queue.some((request) => request.id === event.id && request.holdsConversation)
    useConfirmStore.getState().close(event.id)
    if (held) hooks.onHeldConfirmationClosed()
  })
  for (const request of await window.api.confirmPending()) useConfirmStore.getState().open(request)

  window.api.onPanelEvent((event) => {
    usePanelStore.getState().apply(event)
  })

  window.api.onJobEvent((event) => {
    const previousStatus = event.type === 'update'
      ? useJobStore.getState().jobs.find((job) => job.id === event.job.id)?.status
      : undefined
    useJobStore.getState().apply(event)
    if (event.type === 'update' && isJobTerminal(event.job.status) && previousStatus !== event.job.status) {
      const kind = event.job.status === 'done' ? 'ok' : event.job.status === 'error' ? 'error' : 'info'
      useToastStore.getState().push({
        kind,
        title: translate(
          event.job.status === 'done'
            ? 'conversation.job.done'
            : event.job.status === 'error'
              ? 'conversation.job.error'
              : 'conversation.job.cancelled'
        ),
        body: event.job.title
      })
      // The agent-job card reads its body from the store, but it is patched anyway so that the card
      // does not stay on a stale render.
      usePanelStore.getState().apply(
        { op: 'patch', key: `job:${event.job.id}`, props: { jobId: event.job.id } }
      )
    }
  })
  void useJobStore.getState().load()
}
