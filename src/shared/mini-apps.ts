import { z } from 'zod'
import { dayKey } from './calendar-layout'
import { MAIL_VIEWS } from './mail'
import type { PlatformCapabilities } from './platform'

/**
 * ASIST's mini apps: the screens opened from the Dock, each with data of its own. The conversation
 * model opens them with open_app and learns from the renderer's report which one is open and what it
 * shows, so the report carries the ids the model's tools take.
 */

export const MINI_APPS = ['notes', 'tasks', 'mail', 'calendar', 'jobs', 'memory', 'settings'] as const
export type MiniApp = (typeof MINI_APPS)[number]

/** Whether this machine has the mini app: the calendar needs the calendar of the OS. */
export const miniAppAvailable = (app: MiniApp, capabilities: Pick<PlatformCapabilities, 'calendar'>): boolean =>
  app !== 'calendar' || capabilities.calendar

/** The pages of the settings mini app, in the order the list on the left shows them. */
export const SETTINGS_PAGES = ['conversation', 'persona', 'voice', 'appearance', 'memory', 'agent', 'integrations', 'models', 'usage', 'about'] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]

export const MAIL_BOXES = [...MAIL_VIEWS, 'drafts'] as const
export type MailBox = (typeof MAIL_BOXES)[number]

export const CALENDAR_VIEWS = ['month', 'week', 'list'] as const
export type CalendarViewMode = (typeof CALENDAR_VIEWS)[number]

export const TASK_VIEWS = ['board', 'list'] as const
export type TaskViewMode = (typeof TASK_VIEWS)[number]

const id = z.string().min(1)
/**
 * A local calendar day that exists. open_app checks the day it is given with this, so that it never
 * places the calendar on a day the report of the view then refuses.
 */
export const localDate = z.iso.date()

const mailPane = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), id }),
  z.strictObject({ kind: z.literal('draft'), id }),
  z.strictObject({ kind: z.literal('compose') })
])

/** What the open mini app shows, as the renderer reports it. Every id is one the model's tools accept. */
export const miniAppViewSchema = z.discriminatedUnion('app', [
  /** `noteId` is the note on screen; `editing` is true while it, or a new note, is being edited. */
  z.strictObject({ app: z.literal('notes'), noteId: id.nullable(), editing: z.boolean() }),
  z.strictObject({ app: z.literal('tasks'), view: z.enum(TASK_VIEWS), taskId: id.nullable() }),
  z.strictObject({ app: z.literal('mail'), box: z.enum(MAIL_BOXES), accountId: id.nullable(), query: z.string(), pane: mailPane.nullable() }),
  /** `date` is the day the view is placed on, and `eventId` the event whose details are open. */
  z.strictObject({ app: z.literal('calendar'), view: z.enum(CALENDAR_VIEWS), date: localDate, eventId: id.nullable() }),
  z.strictObject({ app: z.literal('jobs'), jobId: id.nullable() }),
  /** `file` is the memory document's path relative to the memory folder. */
  z.strictObject({ app: z.literal('memory'), file: id.nullable() }),
  z.strictObject({ app: z.literal('settings'), page: z.enum(SETTINGS_PAGES) })
])
export type MiniAppView = z.infer<typeof miniAppViewSchema>

/** The report of the renderer: the open mini app, or null while only the conversation is shown. */
export const openMiniAppSchema = miniAppViewSchema.nullable()

/** Where open_app opens a mini app. A field left out keeps what the mini app would show by itself. */
export type MiniAppTarget =
  | { app: 'notes'; noteId?: string }
  | { app: 'tasks'; view?: TaskViewMode; taskId?: string }
  | { app: 'mail'; box?: MailBox; messageId?: string; draftId?: string }
  | { app: 'calendar'; view?: CalendarViewMode; date?: string; eventId?: string }
  | { app: 'jobs'; jobId?: string }
  | { app: 'memory'; file?: string }
  | { app: 'settings'; page?: SettingsPage }

/**
 * Where a target places a mini app. A field the target leaves out keeps what the open mini app shows,
 * or what the mini app shows by itself when it is not open yet. A calendar moved to another day or
 * view closes the event it showed, whose card would point at a chip no longer drawn, and a mail box
 * changed without a message or draft closes the pane. The renderer places a mini app with it, and
 * open_app works out from it what the renderer should report once the mini app is open.
 */
export function placeMiniApp(current: MiniAppView | null, target: MiniAppTarget, today = new Date()): MiniAppView {
  switch (target.app) {
    case 'notes': {
      const base = current?.app === 'notes' ? current : { app: 'notes' as const, noteId: null, editing: false }
      return target.noteId === undefined ? base : { app: 'notes', noteId: target.noteId, editing: false }
    }
    case 'tasks': {
      const base = current?.app === 'tasks' ? current : { app: 'tasks' as const, view: 'board' as const, taskId: null }
      return { app: 'tasks', view: target.view ?? base.view, taskId: target.taskId ?? base.taskId }
    }
    case 'mail': {
      const base = current?.app === 'mail' ? current : { app: 'mail' as const, box: 'inbox' as const, accountId: null, query: '', pane: null }
      const box = target.box ?? (target.draftId !== undefined ? 'drafts' : base.box)
      const pane =
        target.messageId !== undefined
          ? { kind: 'message' as const, id: target.messageId }
          : target.draftId !== undefined
            ? { kind: 'draft' as const, id: target.draftId }
            : box === base.box
              ? base.pane
              : null
      return { app: 'mail', box, accountId: base.accountId, query: base.query, pane }
    }
    case 'calendar': {
      const base = current?.app === 'calendar' ? current : { app: 'calendar' as const, view: 'month' as const, date: dayKey(today), eventId: null }
      const view = target.view ?? base.view
      const date = target.date ?? base.date
      const eventId = target.eventId ?? (view === base.view && date === base.date ? base.eventId : null)
      return { app: 'calendar', view, date, eventId }
    }
    case 'jobs': {
      const base = current?.app === 'jobs' ? current : { app: 'jobs' as const, jobId: null }
      return { app: 'jobs', jobId: target.jobId ?? base.jobId }
    }
    case 'memory': {
      const base = current?.app === 'memory' ? current : { app: 'memory' as const, file: null }
      return { app: 'memory', file: target.file ?? base.file }
    }
    case 'settings': {
      const base = current?.app === 'settings' ? current : { app: 'settings' as const, page: 'conversation' as const }
      return { app: 'settings', page: target.page ?? base.page }
    }
  }
}

/** Whether two views show the same thing. Parsing puts the keys of both in the schema's order. */
export const sameMiniAppView = (a: MiniAppView | null, b: MiniAppView | null): boolean =>
  JSON.stringify(openMiniAppSchema.parse(a)) === JSON.stringify(openMiniAppSchema.parse(b))
