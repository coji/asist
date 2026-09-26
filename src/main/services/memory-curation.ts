import { isJobExecuting } from '@shared/job-status'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import type { AgentJob, ReviewedMerge } from '@shared/ipc'
import { localDateKey } from '@shared/local-date'
import { pageNameError } from '@shared/memory-page'
import {
  buildCurationPrompt,
  curationDue,
  hasUserSpeech,
  pendingDays,
  renderTranscript
} from '@shared/memory-curation'
import * as agentRunner from './agent'
import * as git from './git'
import { mergeBase } from './job-worktree'
import { conversationLocale } from './conversation-locale'
import { installSkill } from './memory-curation-skill'
import { conversationLog } from './brain/session'
import * as memory from './memory'
import * as store from './memory-store'
import { errorMessage, t } from './i18n'
import { getSettings } from './settings'
import { readState, writeState, type CurationState } from './memory-curation-state'

/**
 * Once the curation Agent has run, the result goes through validation, merge, reindex and the saving of
 * the day it covered, in that order. Each step is restartable from the state saved by the previous one.
 */

/** How often the daily curation checks whether it is due. The check reads only a small state file. */
const DUE_CHECK_MS = 60_000
const processing = new Set<string>()
let initialized = false

export function curatedThrough(): string | null {
  return readState().curatedThrough
}

export function lastFailure(): CurationState['lastFailure'] {
  return readState().lastFailure
}

/** A curation job that is still running or waiting to be merged. */
export function pendingJob(): AgentJob | null {
  return (
    agentRunner
      .list()
      .find(
        (job) =>
          job.memoryCuration && !job.memoryCuration.applied &&
          (isJobExecuting(job.status) || ['pending', 'conflict', 'error'].includes(job.mergeState ?? '') ||
            (job.status === 'done' && ['merged', 'unchanged'].includes(job.mergeState ?? '')))
      ) ?? null
  )
}

const worktreeRoot = (): string => path.join(app.getPath('userData'), 'memory-worktrees')

/**
 * The days a curation job covers, as the job list shows them. `formatRange` writes the two days the
 * way the language of the interface joins a range, and collapses them into one date when the job
 * covers a single day.
 */
function dayRangeLabel(from: string, until: string): string {
  const locale = getSettings().uiLocale
  const day = (date: string): Date => {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).formatRange(day(from), day(until))
}

/**
 * Starts a curation job right away. When there is no conversation on any unprocessed day, it only
 * advances the processed day and returns null. It throws when an earlier job is still unfinished.
 */
export function curateNow(now = Date.now()): AgentJob | null {
  const reason = memory.unavailableReason()
  if (reason) throw new Error(reason)
  reconcileMemoryCuration()
  const pending = pendingJob()
  if (pending) {
    throw new Error(errorText('memory.errors.jobUnfinished', { job: pending.id }))
  }
  memory.ensureLoaded()
  store.ensureRepo()
  let state = readState()
  if (!state.curatedThrough && !state.pendingFrom) {
    const today = new Date(now)
    state = {
      ...state,
      pendingFrom: localDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))
    }
    // The first day to curate is fixed before the Agent starts, so that a failure, a discarded job or a
    // deleted history does not silently move it to the next day.
    writeState(state)
  }
  const locale = conversationLocale()
  const days = pendingDays(state, now).map((day) => {
    const records = conversationLog.readDay(day).filter((r) => r.kind !== 'checkpoint')
    return { date: localDateKey(day), transcript: renderTranscript(records, locale), spoken: hasUserSpeech(records) }
  })
  const spoken = days.filter((day) => day.spoken)
  const through = days.length > 0 ? days[days.length - 1].date : state.curatedThrough
  if (spoken.length === 0) {
    if (through !== state.curatedThrough) writeState({ curatedThrough: through, pendingFrom: null })
    return null
  }
  const prompt = buildCurationPrompt({
    days: spoken,
    today: localDateKey(new Date(now)),
    locale,
    persona: getSettings().persona
  })
  const label = dayRangeLabel(spoken[0].date, spoken[spoken.length - 1].date)
  const job = agentRunner.startIsolated(prompt, {
    cwd: store.memoryDir(),
    title: t('memory.curation.jobTitle', { label }),
    memoryCuration: { through },
    worktreeRoot: worktreeRoot(),
    noteProject: false,
    readonly: false,
    prepareWorktree: (dir) => installSkill(dir)
  })
  return job
}

function advanceThrough(through: string | null): void {
  const state = readState()
  if (through && (!state.curatedThrough || through > state.curatedThrough)) {
    writeState({ curatedThrough: through, pendingFrom: null })
  }
}

/** A regular file, an executable one, or a deletion. A symbolic link (120000) or a submodule (160000) is none of these. */
const MEMORY_FILE_MODES = new Set(['100644', '100755', '000000'])

/**
 * The curation merges without asking anyone, and its prompt holds the day's transcript, which can carry
 * text from a mail or a web page written to steer the agent. So the merge takes only plain files of the
 * memory repository itself. A symbolic link counts as outside, because the reindex and the memory screen
 * would read the file it points to after the merge. This sees only what git shows; a named pipe, or a link
 * in a path the Agent added to .gitignore, reaches the check that follows, whose reader refuses anything
 * but a regular file.
 */
function assertInsideMemory(job: AgentJob): ReviewedMerge {
  const worktree = job.worktree
  if (!worktree?.commit) throw new Error(errorText('memory.errors.commitMissing'))
  if (fs.realpathSync(worktree.repo) !== fs.realpathSync(store.memoryDir())) {
    throw new Error(errorText('memory.errors.outsideMemory', { files: worktree.repo }))
  }
  const base = mergeBase(worktree, worktree.commit)
  const entries = git.diffEntries(worktree.repo, base, worktree.commit)
  const outside = entries.filter((entry) => !MEMORY_FILE_MODES.has(entry.mode)).map((entry) => entry.path)
  if (outside.length > 0) {
    throw new Error(errorText('memory.errors.outsideMemory', { files: outside.slice(0, 10).join('\n') }))
  }
  // A page added under a name that macOS or Windows cannot give a file would keep the memory folder from
  // being checked out there. A page already in the memory keeps its name, so that it goes on loading.
  const unusable = entries
    .filter((entry) => entry.added && entry.mode !== '000000')
    .map((entry) => entry.path)
    .filter((file) => {
      const page = /^pages\/([^/]+)\.md$/.exec(file)
      return page !== null && pageNameError(page[1]) !== null
    })
  if (unusable.length > 0) {
    throw new Error(errorText('memory.errors.pageNamesRefused', { files: unusable.slice(0, 10).join('\n') }))
  }
  return { commit: worktree.commit, base, into: git.checkedOut(worktree.repo) }
}

/** Events overlap, so a job is locked only while it is being processed. A failure is retried from the last saved step. */
function processJob(job: AgentJob): void {
  if (!job.memoryCuration || job.memoryCuration.applied || job.status !== 'done' || processing.has(job.id)) return
  if (!['pending', 'merged', 'unchanged'].includes(job.mergeState ?? '')) return
  processing.add(job.id)
  try {
    if (job.mergeState === 'pending') {
      const checked = assertInsideMemory(job)
      const { errors } = store.readAll(job.cwd)
      if (errors.length > 0) throw new Error(errorText('memory.errors.checkFailed', { errors: errors.slice(0, 10).join('\n') }))
      agentRunner.merge(job.id, checked)
      // The update that merge emits is synchronous, so the job in hand is already stale and is read again.
      job = agentRunner.get(job.id)!
    }
    if (job.mergeState !== 'merged' && job.mergeState !== 'unchanged') return
    const result = memory.reindex()
    if (result.errors.length > 0)
      throw new Error(errorText('memory.errors.indexCheckFailed', { errors: result.errors.slice(0, 10).join('\n') }))
    memory.invalidateBlock()
    // The day is saved before the job is marked complete. Stopping in between is safe, because rebuilding
    // the index and saving the same day can both be run again.
    advanceThrough(job.memoryCuration!.through)
    agentRunner.completeMemoryCuration(job.id)
    writeState({ lastFailure: null })
    agentRunner.note(job.id, t('memory.curation.done', { count: result.units }))
  } catch (error) {
    agentRunner.note(job.id, t('memory.curation.unfinished', { message: errorMessage(error) }))
    fail(job, errorMessage(error))
  } finally {
    processing.delete(job.id)
  }
}

/**
 * Records a failed curation for the settings screen. A job whose changes were never merged is
 * discarded, because nobody sees it to decide on it; the same days are curated again on the next day.
 * A job that was already merged stays, and the next start resumes it from the reindex.
 */
function fail(job: AgentJob, message: string): void {
  console.error('memory curation failed:', job.id, message)
  // This runs inside the job event handler, where a throw would break the agent runner's own update.
  try {
    writeState({ lastFailure: { at: Date.now(), message } })
  } catch (error) {
    console.error('memory curation: the failure could not be recorded:', errorMessage(error))
  }
  const current = agentRunner.get(job.id)
  if (current?.worktree && ['pending', 'conflict', 'error'].includes(current.mergeState ?? '')) {
    try {
      agentRunner.discard(job.id)
    } catch (error) {
      console.error('memory curation: the failed job could not be discarded:', job.id, errorMessage(error))
    }
  }
}

/** A curation job the Agent ended without success, or whose merge could not be made. */
function observeFailure(job: AgentJob): void {
  if (!job.memoryCuration || job.memoryCuration.applied || processing.has(job.id)) return
  if (job.status === 'error' || job.status === 'cancelled') {
    if (job.mergeState !== 'discarded') fail(job, job.summary ?? job.status)
    return
  }
  if (job.mergeState === 'conflict' || job.mergeState === 'error') fail(job, job.summary ?? job.mergeState)
}

/**
 * Starts the curation when curationDue says so. A failure to start is recorded like a failed curation.
 * A merged job whose reindex failed is resumed first, because it would otherwise hold every later day
 * back until the next start. The check runs at startup and from a timer, where a throw, such as the
 * one a broken state file raises, would stop the startup or show an error dialog every minute; the
 * settings screen reports that file through curatedThrough instead.
 */
function startIfDue(): void {
  try {
    if (memory.unavailableReason()) return
    const state = readState()
    if (!curationDue({ curatedThrough: state.curatedThrough, lastFailureAt: state.lastFailure?.at ?? null }, Date.now())) return
    reconcileMemoryCuration()
    if (pendingJob()) return
    try {
      const job = curateNow()
      console.log('memory curation:', job ? `started ${job.id} ${job.title}` : 'nothing to do')
    } catch (error) {
      console.error('memory curation not started:', errMessage(error))
      writeState({ lastFailure: { at: Date.now(), message: errorMessage(error) } })
    }
  } catch (error) {
    console.error('memory curation: the due check failed:', errMessage(error))
  }
}

/** Resumes from the saved jobs. A job that was already merged is not merged again and continues from the reindex. */
export function reconcileMemoryCuration(): void {
  for (const job of agentRunner.list()) processJob(job)
}

export function initMemoryCuration(): void {
  if (initialized) return
  initialized = true
  agentRunner.events.on('event', (event) => {
    if (event.type !== 'update') return
    processJob(event.job)
    // processJob can merge, and a conflict it meets arrives in a nested update while the job is still
    // locked, so the failure is judged on the job as it stands afterwards rather than on this copy.
    observeFailure(agentRunner.get(event.job.id) ?? event.job)
  })
  reconcileMemoryCuration()
  startIfDue()
  setInterval(startIfDue, DUE_CHECK_MS)
}
