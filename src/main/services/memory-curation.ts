import { isJobTerminal } from '@shared/job-status'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import type { AgentJob, ReviewedMerge } from '@shared/ipc'
import { localDateKey } from '@shared/local-date'
import { pageNameError } from '@shared/memory-page'
import { personaText } from '@shared/persona'
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

/** A curation job that can still bring its changes into the memory, which holds every later curation back. */
export function pendingJob(): AgentJob | null {
  return agentRunner.list().find((job) => job.memoryCuration && !job.memoryCuration.applied && reachesMemory(job)) ?? null
}

/**
 * Whether the job can still bring its changes into the memory: while its Agent runs, and once it ended well
 * until its merge and its day are done. A job that stops ends cancelled or in error, and neither is merged. A
 * job refused by the check before its merge is discarded, and when that removal fails halfway git counts what
 * is left of its worktree as none, so that the job is neither checked again nor waited for.
 */
function reachesMemory(job: AgentJob): boolean {
  if (job.status === 'running') return true
  if (job.status !== 'done') return false
  if (job.mergeState === 'merged' || job.mergeState === 'unchanged') return true
  return job.mergeState === 'pending' && worktreeIntact(job.worktree!.dir)
}

const worktreeIntact = (dir: string): boolean =>
  fs.existsSync(dir) && git.toplevel(dir) === git.resolvedAsFarAsExists(dir)

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
    persona: personaText(getSettings())
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
 * would read the file it points to after the merge. This sees only what git shows; what it does not show,
 * such as a named pipe or a link in a path the Agent added to .gitignore, is never merged, and the check
 * that follows reads a checkout of the merge rather than the Agent's worktree.
 */
function assertInsideMemory(job: AgentJob): ReviewedMerge {
  const worktree = job.worktree
  if (!worktree?.commit) throw new Error(errorText('memory.errors.commitMissing'))
  // Both sides in the form toplevel gives a repository: fs.realpathSync keeps a Windows short name such as
  // RUNNER~1 in the memory folder, while git names the repository with its long name.
  if (git.resolvedAsFarAsExists(worktree.repo) !== git.resolvedAsFarAsExists(store.memoryDir())) {
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

/**
 * The memory as merging the job's commit would leave it: the tree the merge commits, as agentRunner.merge
 * then makes it from the memory's HEAD, written out to a temporary folder outside the memory. The memory
 * screen can commit while the Agent runs, and two changes that each keep the rules can break them together,
 * as when both add the same heading to user.md or their sections together pass the length of
 * instruction.md. Merged, such a job could be neither discarded nor completed, and no later curation would
 * start. Null when the two conflict, which agentRunner.merge then records as for any job.
 *
 * Nothing but objects goes into the memory repository, so a check that a crash cuts short leaves nothing
 * that stops the next one. The folder is removed afterwards, and a removal that fails, as on Windows while
 * a scanner holds a file just written, is only logged: the check has already been made.
 */
function readMerged(job: AgentJob, commit: string): store.ReadResult | null {
  const repo = job.worktree!.repo
  const merged = git.mergedTree(repo, git.headCommit(repo), commit)
  if ('conflict' in merged) return null
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'asist-memory-merge-'))
  try {
    git.checkoutTree(repo, merged.tree, dir)
    return store.readAll(dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.error('memory curation: the checked copy of the merge could not be removed:', dir, errorMessage(error))
    }
  }
}

/** Events overlap, so a job is locked only while it is being processed. A failure is retried from the last saved step. */
function processJob(job: AgentJob): void {
  if (!job.memoryCuration || job.memoryCuration.applied || job.status !== 'done' || processing.has(job.id)) return
  if (!['pending', 'merged', 'unchanged'].includes(job.mergeState ?? '')) return
  processing.add(job.id)
  try {
    if (job.mergeState === 'pending') {
      if (!reachesMemory(job)) return
      const checked = assertInsideMemory(job)
      const merged = readMerged(job, checked.commit)
      if (merged !== null && merged.errors.length > 0) {
        throw new Error(errorText('memory.errors.checkFailed', { errors: merged.errors.slice(0, 10).join('\n') }))
      }
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
 * Records a failed curation for the settings screen, which holds the curation back until the next day, and
 * discards the job's changes. A job that was already merged stays, and the next start resumes it from the
 * reindex.
 */
function fail(job: AgentJob, message: string): void {
  console.error('memory curation failed:', job.id, message)
  // This runs inside the job event handler, where a throw would break the agent runner's own update.
  try {
    writeState({ lastFailure: { at: Date.now(), message } })
  } catch (error) {
    console.error('memory curation: the failure could not be recorded:', errorMessage(error))
  }
  discardUnmerged(job)
}

/**
 * Throws away the changes of a job that were never merged, because nobody sees the job to decide on it; the
 * same days are curated again. A removal that fails, as on Windows while a scanner holds a file in the
 * worktree, is tried again on every check.
 */
function discardUnmerged(job: AgentJob): void {
  const current = agentRunner.get(job.id)
  if (!current?.worktree || !['pending', 'conflict', 'error'].includes(current.mergeState ?? '')) return
  try {
    agentRunner.discard(job.id)
  } catch (error) {
    console.error('memory curation: the failed job could not be discarded:', job.id, errorMessage(error))
  }
}

/**
 * Whether the end of the app stopped the curation, rather than the curation ending by itself. A quit cancels
 * it, as only the app cancels a curation; a crash or a forced end leaves it to the next start, which finds it
 * interrupted. Neither says anything about the curation.
 */
const stoppedByAppEnd = (job: AgentJob): boolean => job.status === 'cancelled' || job.interrupted === true

/**
 * A curation that the end of the app stopped has its changes discarded without a failure, so that the next start
 * curates the same days rather than waiting for the next midnight, unless the curation before it was stopped so
 * as well.
 */
function judgeStop(job: AgentJob): void {
  if (stoppedAfterStop(job)) fail(job, t('memory.curation.quitTwice'))
  else discardUnmerged(job)
}

/**
 * A curation job that ended without success, or whose merge could not be made. An interrupted one was judged
 * when the start found it, and only its changes are left to discard once its recovery has ended it.
 */
function observeFailure(job: AgentJob): void {
  if (!job.memoryCuration || job.memoryCuration.applied || processing.has(job.id) || job.mergeState === 'discarded') return
  if (!isJobTerminal(job.status)) return
  if (job.interrupted) discardUnmerged(job)
  else if (job.status === 'cancelled') judgeStop(job)
  else if (job.status === 'error') fail(job, job.summary ?? job.status)
  else if (job.mergeState === 'conflict' || job.mergeState === 'error') fail(job, job.summary ?? job.mergeState)
}

/**
 * Whether the end of the app stopped the curation before this one as well, which the job history tells. A
 * curation that cannot end by itself, such as a CLI waiting for an answer, runs until the app ends; tried
 * again at every start, it would spend the Agent's usage each time and give no reason. The second curation
 * in a row stopped so is therefore a failure, and the next curation waits for the next day.
 */
function stoppedAfterStop(job: AgentJob): boolean {
  const before = agentRunner.list().find((other) => other.memoryCuration && other.startedAt < job.startedAt)
  return before !== undefined && stoppedByAppEnd(before)
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
    // A start that the app refuses as it quits is no failure of the curation, and recorded as one it would
    // hold the curation back past the next start.
    if (!agentRunner.acceptsJobs() || memory.unavailableReason()) return
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

/**
 * Resumes from the saved jobs. A job that was already merged is not merged again and continues from the
 * reindex. A job that ended and will never reach the memory has its worktree discarded where an earlier
 * removal failed.
 */
export function reconcileMemoryCuration(): void {
  for (const job of agentRunner.list()) {
    processJob(job)
    if (job.memoryCuration && !job.memoryCuration.applied && isJobTerminal(job.status) && !reachesMemory(job)) discardUnmerged(job)
  }
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
  // A curation that the end of the last run cut off is judged as this start finds it, before a new one may
  // start: its recovery can end only after that, and one whose Agent never started ended as the history was
  // read, which sends no update.
  for (const job of agentRunner.cutOffByLastEnd()) if (job.memoryCuration) judgeStop(job)
  reconcileMemoryCuration()
  startIfDue()
  setInterval(startIfDue, DUE_CHECK_MS)
}
