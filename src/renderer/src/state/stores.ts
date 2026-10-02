import { create } from 'zustand'
import type { Task } from '@shared/tasks'
import type { NoteSummary } from '@shared/notes'
import type { MailDraft, MailStatus } from '@shared/mail'
import type { SettingsPatch } from '@shared/settings'
import type {
  AgentJob,
  AppSettings,
  AppStatus,
  JobEvent,
  JobLogLine,
  LiveConnection,
  LiveUsage,
  PanelEvent,
  PanelSlot,
  PanelSpec,
  TurnEvent,
  TurnTimings
} from '@shared/ipc'
import type { AizuchiClass } from '@shared/aizuchi-classifier'
import { catalogByType } from '@shared/panel-catalog'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'

interface StatusState {
  status: AppStatus | null
  refresh: () => Promise<void>
  /** Holds the status unless main read it before the one held. */
  apply: (status: AppStatus) => void
}

export const useStatusStore = create<StatusState>((set, get) => ({
  status: null,
  refresh: async () => {
    try {
      get().apply(await window.api.getStatus())
    } catch (error) {
      useToastStore.getState().push({ kind: 'error', title: translate('app.status.checkFailed'), body: displayError(error) })
    }
  },
  apply: (status) => {
    // The order of arrival is not the order of reading. With Electron 43.7.7, the answer to a read overtook a
    // push main had sent just before it in 209 of 500 reads made at once (2026-10-02), and a read that waits
    // for the API key to be checked can end after a read begun later.
    const held = get().status
    if (held === null || status.sequence >= held.sequence) set({ status })
  }
}))

interface SettingsState {
  settings: AppSettings | null
  load: () => Promise<void>
  save: (patch: SettingsPatch) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  load: async () => set({ settings: await window.api.getSettings() }),
  save: async (patch) => set({ settings: await window.api.saveSettings(patch) })
}))

export type Phase = 'idle' | 'listen' | 'think' | 'speak'

/**
 * What the latest turn's routing did, kept as what happened rather than as a sentence, so that the HUD words it
 * in the language the interface has when it is drawn. A detail is an error's message as it was thrown.
 */
export type RouterNote =
  | { kind: 'bridgeFailed' | 'heardAsBackchannel' | 'droppedClipEcho' | 'droppedSelfEcho' | 'interrupted' }
  | { kind: 'bridge'; text: string }
  | { kind: 'aizuchi'; cls: AizuchiClass; percent: number }
  | { kind: 'live'; state: LiveConnection; detail?: string }
  | { kind: 'tool'; name: string; status: Extract<TurnEvent, { type: 'tool' }>['status']; detail?: string }

interface TurnState {
  phase: Phase
  micState: 'off' | 'loading' | 'on'
  micProgress: number
  /** The partial recognition text while the user is still speaking. */
  partial: string
  activeTurnId: number
  /** The measurements of the latest input and its turn, as TurnMetrics shows them in the HUD. */
  timings: TurnTimings
  /** What the latest turn's routing did, null until the first turn. */
  routerNote: RouterNote | null
  setPhase: (phase: Phase) => void
  setMic: (micState: TurnState['micState'], progress?: number) => void
  setPartial: (partial: string) => void
  setActiveTurn: (id: number) => void
  setTimings: (timings: TurnTimings) => void
  setRouterNote: (note: RouterNote) => void
}

export const useTurnStore = create<TurnState>((set) => ({
  phase: 'idle',
  micState: 'off',
  micProgress: 0,
  partial: '',
  activeTurnId: -1,
  timings: {},
  routerNote: null,
  setPhase: (phase) => set({ phase }),
  setMic: (micState, progress = 0) => set({ micState, micProgress: progress }),
  setPartial: (partial) => set({ partial }),
  setActiveTurn: (id) => set({ activeTurnId: id }),
  setTimings: (timings) => set({ timings }),
  setRouterNote: (routerNote) => set({ routerNote })
}))

interface LiveState {
  connection: LiveConnection
  /** Detail of the connection, such as the reason for an error. */
  detail: string
  usage: LiveUsage | null
  /** The latest response time, from the end of the user's transcript to the first audio. */
  responseMs: number | null
  /** How long the latest session took to open. */
  connectMs: number | null
  setConnection: (connection: LiveConnection, detail?: string) => void
  setUsage: (usage: LiveUsage) => void
  setLatency: (responseMs: number | null, connectMs?: number) => void
  reset: () => void
}

export const useLiveStore = create<LiveState>((set) => ({
  connection: 'off',
  detail: '',
  usage: null,
  responseMs: null,
  connectMs: null,
  setConnection: (connection, detail = '') => set({ connection, detail }),
  setUsage: (usage) => set({ usage }),
  setLatency: (responseMs, connectMs) => set((s) => ({ responseMs: responseMs ?? s.responseMs, connectMs: connectMs ?? s.connectMs })),
  reset: () => set({ connection: 'off', detail: '', usage: null, responseMs: null, connectMs: null })
}))

/**
 * A line of the interface that is drawn from the dictionary each time, so that it follows a change of the language.
 * The message of an error is kept as it was thrown, key and all, and worded when the line is drawn.
 */
export type FeedMessage = { key: 'conversation.start' } | { key: 'conversation.error'; values: { message: string } }

export interface FeedLine {
  id: number
  role: 'user' | 'ai' | 'sys'
  text: string
  /** Set on a system line: what the line says, resolved by the Feed in the current language. `text` is then empty. */
  message?: FeedMessage
  chip?: string
  turnId?: number
  streaming?: boolean
}

interface FeedState {
  lines: FeedLine[]
  append: (line: Omit<FeedLine, 'id'>) => number
  /** Inserts before the given line, which puts a late user transcript ahead of the reply, and appends when that line is gone. */
  insertBefore: (beforeId: number, line: Omit<FeedLine, 'id'>) => number
  update: (id: number, patch: Partial<FeedLine>) => void
  appendToText: (id: number, delta: string) => void
}

let nextLineId = 1

export const useFeedStore = create<FeedState>((set) => ({
  lines: [],
  append: (line) => {
    const id = nextLineId++
    set((s) => ({ lines: [...s.lines, { ...line, id }].slice(-60) }))
    return id
  },
  insertBefore: (beforeId, line) => {
    const id = nextLineId++
    set((s) => {
      const index = s.lines.findIndex((l) => l.id === beforeId)
      const lines = index < 0 ? [...s.lines, { ...line, id }] : [...s.lines.slice(0, index), { ...line, id }, ...s.lines.slice(index)]
      return { lines: lines.slice(-60) }
    })
    return id
  },
  update: (id, patch) =>
    set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
  appendToText: (id, delta) =>
    set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, text: l.text + delta } : l)) }))
}))

interface PanelState {
  panels: PanelSpec[]
  /** The key of the panel that focus mode shows enlarged in the center. */
  focusedKey: string | null
  apply: (
    event: PanelEvent,
    opts?: { ownerTurnId?: number }
  ) => void
  dismiss: (key: string) => void
  /**
   * Settles what a superseded or aborted turn left unfinished, matched by the turn that owns it: a card the turn
   * was making is removed, and a card it was fetching again goes back to what it showed before.
   */
  dismissLoadingOwnedBy: (turnId: number) => void
  setFocused: (key: string | null) => void
}

export const PANEL_STALE_GRACE_MS = 30_000
let panelLifecycleTimer: ReturnType<typeof setTimeout> | null = null

const normalizeTtl = (ttl: number | undefined): number | undefined =>
  ttl !== undefined && Number.isFinite(ttl) && ttl > 0 ? ttl : undefined

/**
 * When a panel next changes by itself. A ready panel turns stale when its TTL runs out, and a panel with a
 * TTL is removed PANEL_STALE_GRACE_MS later. The TTL is how long data stays current, so a panel still
 * loading or one that failed has none to go out of date: it keeps its state until it is removed, since a
 * stale panel draws its body from the data.
 */
function nextPanelDeadline(panel: PanelSpec): number | undefined {
  if (panel.state === 'stale') return (panel.staleAt ?? panel.updatedAt) + PANEL_STALE_GRACE_MS
  if (panel.ttl === undefined) return undefined
  const staleAt = panel.updatedAt + panel.ttl
  return panel.state === 'ready' ? staleAt : staleAt + PANEL_STALE_GRACE_MS
}

function schedulePanelLifecycle(): void {
  if (panelLifecycleTimer !== null) clearTimeout(panelLifecycleTimer)
  panelLifecycleTimer = null
  const deadlines = usePanelStore
    .getState()
    .panels.map(nextPanelDeadline)
    .filter((deadline): deadline is number => deadline !== undefined)
  if (!deadlines.length) return
  const delay = Math.max(0, Math.min(...deadlines) - Date.now())
  panelLifecycleTimer = setTimeout(() => advancePanelLifecycle(), delay)
  // In Vitest and Node, a pending timer with a long TTL would otherwise hold the process open.
  ;(panelLifecycleTimer as unknown as { unref?: () => void }).unref?.()
}

/** Evaluates the TTLs, turning an expired panel stale and removing a panel once its grace period is over. */
export function advancePanelLifecycle(now = Date.now()): void {
  const current = usePanelStore.getState()
  let changed = false
  const panels = current.panels.flatMap((panel): PanelSpec[] => {
    const deadline = nextPanelDeadline(panel)
    if (deadline === undefined || now < deadline) return [panel]
    changed = true
    return panel.state === 'ready' && now < deadline + PANEL_STALE_GRACE_MS ? [{ ...panel, state: 'stale', staleAt: deadline }] : []
  })
  if (changed) {
    const focusedKey = panels.some((panel) => panel.key === current.focusedKey)
      ? current.focusedKey
      : null
    usePanelStore.setState({ panels, focusedKey })
  }
  schedulePanelLifecycle()
}

/** Whether a panel in this state is waiting for data, which the shell draws as a skeleton in place of the card. */
const fetching = (state: PanelSpec['state']): boolean => state === 'loading' || state === 'skeleton'

/**
 * The panel after a patch, or after a create for a key already on screen, which merges its props into the old
 * ones like a patch. Props without a state make a patched panel ready.
 */
function changed(
  panel: PanelSpec,
  event: Extract<PanelEvent, { op: 'create' | 'patch' }>,
  ownerTurnId: number | undefined,
  now: number
): PanelSpec {
  const state = event.state ?? (event.op === 'patch' && event.props ? 'ready' : panel.state)
  return {
    ...panel,
    props: event.props ? { ...panel.props, ...event.props } : panel.props,
    state,
    source: event.source ?? panel.source,
    error: event.op === 'patch' ? event.error : panel.error,
    ttl: event.ttl === undefined ? panel.ttl : normalizeTtl(event.ttl),
    staleAt: state === 'stale' ? (panel.staleAt ?? now) : undefined,
    ownerTurnId: ownerTurnId ?? panel.ownerTurnId,
    // A card that a later call fetches again keeps what it showed until the new data arrives, to go back to if
    // that call is abandoned.
    beforeRefresh: !fetching(state) ? undefined : fetching(panel.state) ? panel.beforeRefresh : panel,
    updatedAt: now
  }
}

export const usePanelStore = create<PanelState>((set) => ({
  panels: [],
  focusedKey: null,
  apply: (event, opts) => {
    set((s) => {
      const now = Date.now()
      if (event.op === 'dismiss') {
        return {
          panels: s.panels.filter((p) => p.key !== event.key),
          focusedKey: s.focusedKey === event.key ? null : s.focusedKey
        }
      }
      if (event.op === 'patch' || s.panels.some((p) => p.key === event.key)) {
        return { panels: s.panels.map((p) => (p.key === event.key ? changed(p, event, opts?.ownerTurnId, now) : p)) }
      }
      // The array keeps the order in which panels appeared, and patch and upsert never reorder it.
      // A new panel takes a free slot, and when both sides are full it takes over the place of the
      // first card.
      const preferred = event.slot ?? catalogByType.get(event.type)?.slot ?? 'right'
      const opposite: PanelSlot = preferred === 'left' ? 'right' : 'left'
      const occupied = (slot: PanelSlot): boolean => s.panels.some((p) => p.slot === slot)
      const replaced = s.panels.find(p => p.key === event.replacesKey)
        ?? (occupied(preferred) && occupied(opposite) ? s.panels[0] : undefined)
      const slot = replaced?.slot ?? (occupied(preferred) ? opposite : preferred)
      const spec: PanelSpec = {
        key: event.key,
        type: event.type,
        slot,
        state: event.state ?? 'skeleton',
        props: event.props,
        source: event.source,
        ownerTurnId: opts?.ownerTurnId,
        ttl: normalizeTtl(event.ttl ?? catalogByType.get(event.type)?.ttl),
        staleAt: event.state === 'stale' ? now : undefined,
        createdAt: now,
        updatedAt: now
      }
      const panels = replaced ? s.panels.filter((p) => p.key !== replaced.key) : s.panels
      return {
        panels: [...panels, spec],
        focusedKey: replaced?.key === s.focusedKey ? null : s.focusedKey
      }
    })
    schedulePanelLifecycle()
  },
  dismiss: (key) => {
    set((s) => ({
      panels: s.panels.filter((p) => p.key !== key),
      focusedKey: s.focusedKey === key ? null : s.focusedKey
    }))
    schedulePanelLifecycle()
  },
  dismissLoadingOwnedBy: (turnId) => {
    set((s) => {
      const panels = s.panels.flatMap((panel) =>
        panel.ownerTurnId !== turnId || !fetching(panel.state) ? [panel] : panel.beforeRefresh ? [panel.beforeRefresh] : []
      )
      return {
        panels,
        focusedKey: panels.some((panel) => panel.key === s.focusedKey) ? s.focusedKey : null
      }
    })
    schedulePanelLifecycle()
  },
  setFocused: (focusedKey) => set({ focusedKey })
}))

interface JobState {
  jobs: AgentJob[]
  logs: Record<string, JobLogLine[]>
  apply: (event: JobEvent) => void
  load: () => Promise<void>
  loadLog: (id: string) => Promise<void>
}

/** The jobs whose log failed to load and has not loaded since, which have had their toast. */
const jobLogFailuresShown = new Set<string>()

export const useJobStore = create<JobState>((set) => ({
  jobs: [],
  logs: {},
  apply: (event) =>
    set((s) => {
      if (event.type === 'update') {
        const exists = s.jobs.some((j) => j.id === event.job.id)
        return {
          jobs: exists
            ? s.jobs.map((j) => (j.id === event.job.id ? event.job : j))
            : [event.job, ...s.jobs]
        }
      }
      const log = [...(s.logs[event.id] ?? []), event.line].slice(-500)
      return { logs: { ...s.logs, [event.id]: log } }
    }),
  load: async () => set({ jobs: await window.api.jobList() }),
  loadLog: async (id) => {
    let log: JobLogLine[]
    try {
      log = await window.api.jobLog(id)
    } catch (error) {
      // Every card of the job and every opening of the jobs screen loads the log, and one toast per job says it.
      if (!jobLogFailuresShown.has(id)) {
        jobLogFailuresShown.add(id)
        useToastStore.getState().push({ kind: 'error', title: translate('jobs.log.loadFailed'), body: displayError(error) })
      }
      return
    }
    jobLogFailuresShown.delete(id)
    set((s) => ({ logs: { ...s.logs, [id]: log } }))
  }
}))

interface TaskState {
  tasks: Task[]
  loaded: boolean
  error: string
  load: () => Promise<void>
  /** Every task, as main has committed it to storage. */
  apply: (tasks: Task[]) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  loaded: false,
  error: '',
  load: async () => {
    try {
      set({ tasks: await window.api.tasksList(), loaded: true, error: '' })
    } catch (error) {
      set({ error: displayError(error) })
    }
  },
  apply: (tasks) => set({ tasks, loaded: true, error: '' })
}))

interface NoteState {
  notes: NoteSummary[]
  loaded: boolean
  error: string
  load: () => Promise<void>
  /** Every note, as main has written it. */
  apply: (notes: NoteSummary[]) => void
}

export const useNoteStore = create<NoteState>((set) => ({
  notes: [],
  loaded: false,
  error: '',
  load: async () => {
    try {
      set({ notes: await window.api.notesList(), loaded: true, error: '' })
    } catch (error) {
      set({ error: displayError(error) })
    }
  },
  apply: (notes) => set({ notes, loaded: true, error: '' })
}))

interface MailState {
  status: MailStatus | null
  /** How many times the cache has changed. The views and the cards use it as the key to load their lists again. */
  revision: number
  /** Every draft main has stored. The "下書き" box of the mail view and the draft cards read it. */
  drafts: MailDraft[]
  draftsLoaded: boolean
  /**
   * The drafts this window has asked main to send and not yet heard back about. Every send starts from a
   * draft editor in this window, so the card and the composer open on the same draft both know that a send
   * is under way, while main already records its start in the draft.
   */
  sending: string[]
  refresh: () => Promise<void>
  loadDrafts: () => Promise<void>
  apply: (status: MailStatus) => void
  applyDrafts: (drafts: MailDraft[]) => void
  setSending: (id: string, sending: boolean) => void
  bump: () => void
}

export const useMailStore = create<MailState>((set) => ({
  status: null,
  revision: 0,
  drafts: [],
  draftsLoaded: false,
  sending: [],
  refresh: async () => {
    try {
      set({ status: await window.api.mailStatus() })
    } catch (error) {
      console.warn('mail status:', error)
    }
  },
  loadDrafts: async () => {
    try {
      set({ drafts: await window.api.mailDraftList(), draftsLoaded: true })
    } catch (error) {
      console.warn('mail drafts:', error)
    }
  },
  apply: (status) => set({ status }),
  applyDrafts: (drafts) => set({ drafts, draftsLoaded: true }),
  setSending: (id, sending) => set((s) => ({ sending: sending ? [...s.sending, id] : s.sending.filter((item) => item !== id) })),
  bump: () => set((s) => ({ revision: s.revision + 1 }))
}))

export interface Toast {
  id: number
  title: string
  body?: string
  kind: 'ok' | 'error' | 'info'
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  /** Keeps the toast up while someone reads it, until `release`. */
  hold: (id: number) => void
  /** Lets a held toast go away TOAST_MS later. */
  release: (id: number) => void
  remove: (id: number) => void
}

/** How long a toast stays up after it appears, or after it is released. */
export const TOAST_MS = 5000

let nextToastId = 1
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

export const useToastStore = create<ToastState>((set, get) => {
  const stop = (id: number): void => {
    clearTimeout(toastTimers.get(id))
    toastTimers.delete(id)
  }
  const removeLater = (id: number): void => {
    stop(id)
    toastTimers.set(id, setTimeout(() => get().remove(id), TOAST_MS))
  }
  return {
    toasts: [],
    push: (t) => {
      const id = nextToastId++
      set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }))
      removeLater(id)
    },
    hold: stop,
    release: (id) => {
      if (get().toasts.some((x) => x.id === id)) removeLater(id)
    },
    remove: (id) => {
      stop(id)
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
    }
  }
})
