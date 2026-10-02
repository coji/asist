import { recoverAgentJob } from '@shared/job-recovery'
import { isBackgroundJob, isJobExecuting, isJobTerminal } from '@shared/job-status'
import { homedir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import mitt, { type Emitter } from 'mitt'
import type { AgentJob, DiscardPreview, JobDiff, JobEvent, JobLogEvent, JobLogLine, ReviewedMerge } from '@shared/ipc'
import { artifactPaths, type AgentStreamEvent } from '@shared/agent-stream'
import { buildResumeArgs, buildStartArgs, displayCommand, type AgentCliJob } from '@shared/agent-cli'
import { formatJobContextBlock, resolveJobAccess, workspaceDirName, worktreeBranchName } from '@shared/job-workspace'
import { errorText } from '@shared/i18n/error-text'
import { promptLanguage, type PromptLanguage, type PromptText } from '@shared/conversation-locale'
import { getSettings } from './settings'
import { conversationLocale } from './conversation-locale'
import { errorMessage, t } from './i18n'
import { memoryDir } from './memory-store'
import { launchAgentProcess, recoverAgentProcess } from './agent-process'
import { platformCapabilities } from './platform'
import type { AgentProcess } from './agent-process/owner'
import {
  assertMergeable,
  assertWorktreePresent,
  assertWorktreeReview,
  captureWorktree,
  discardStat,
  leftOutAtDiscard,
  mergedArtifacts,
  readWorktreeDiff,
  submodulesAtRisk,
  unsettled
} from './job-worktree'
import { isFullPath } from './full-path'
import * as projectIndex from './project-index'
import { installSkill } from './memory-curation-skill'
import * as git from './git'
import { appendJsonl, readJsonl } from './store'
import { recordUsage } from './usage-ledger'
import { jobLogFile as logFile, readJobHistory, writeJobHistory } from './job-history'

/**
 * The agent job runner. It spawns codex (`exec --json`) or claude (`-p --output-format stream-json`)
 * headless and normalizes their output into common events. Talking to the CLI belongs to agent-process;
 * this module owns history, worktrees, and job state.
 */

type Events = { event: JobEvent }
export const events: Emitter<Events> = mitt<Events>()

interface JobEntry {
  job: AgentJob
  process: AgentProcess | null
  recovering?: boolean
  result?: Extract<AgentStreamEvent, { kind: 'result' }>
  processError?: string
  /** The codex completion event carries no summary, so the last assistant text stands in for one. */
  lastAssistantText?: string
}

/**
 * The job summaries and the title suffix below are read by the LLM as well as shown on the card, and
 * the job carries nothing else that says what happened to it, so they are written in the language of
 * the conversation.
 */
const MODEL_TEXTS: Record<'stoppedOldAgent' | 'mergeConflict' | 'continued', PromptText> = {
  stoppedOldAgent: {
    ja: 'アプリ再起動前のAgentを停止し、残った成果物を確認しました',
    en: 'Stopped the Agent left over from before the app restarted and looked over what it produced'
  },
  mergeConflict: {
    ja: '(取り込みで衝突。解消は続きのジョブで)',
    en: ' (the merge conflicted; resolve it in a follow-up job)'
  },
  continued: { ja: '(続き)', en: ' (continued)' }
}

const language = (): PromptLanguage => promptLanguage(conversationLocale())
const say = (text: PromptText): string => text[language()]

const jobs = new Map<string, JobEntry>()
let shuttingDown = false

let jobsLoaded = false

function ensureLoaded(): void {
  if (jobsLoaded) return
  const restored = readJobHistory().map((job) =>
    recoverAgentJob(job, Date.now(), language())
  )
  for (const job of restored) jobs.set(job.id, { job, process: null })
  jobsLoaded = true
  try {
    for (const { job } of jobs.values()) {
      if (job.worktree && isJobTerminal(job.status) && !job.mergeState) {
        Object.assign(job, settleWorktree(job))
      }
    }
    if (restored.length > 0) persistJobs()
    for (const entry of jobs.values()) {
      if (entry.job.processIdentity) startRecovery(entry)
    }
  } catch (error) {
    jobsLoaded = false
    jobs.clear()
    throw error
  }
}

/** Keeps the job state and its worktree until the recovered writer is gone; a cancel retries the check. */
function startRecovery(entry: JobEntry): void {
  if (!entry.job.processIdentity || entry.process) return
  entry.recovering = true
  const process = recoverAgentProcess(entry.job.processIdentity, () => {
    entry.process = null
    entry.recovering = false
    update(entry.job.id, {
      status: 'error', processIdentity: undefined, endedAt: Date.now(),
      summary: say(MODEL_TEXTS.stoppedOldAgent)
    })
  })
  entry.process = process
  void process.completion.catch((error) => {
    entry.process = null
    // A process that cannot be confirmed is neither killed as if it were another PID nor settled.
    const message = t('jobs.log.recoveryPending', { detail: errorMessage(error) })
    pushLog(entry.job.id, 'stderr', message)
    try { update(entry.job.id, { summary: message }) } catch (saveError) {
      console.error('failed to save the agent recovery error:', saveError)
    }
  })
  void process.stop()
}

function assertWriterStopped(job: AgentJob): void {
  if (job.processIdentity) throw new Error(errorText('jobs.worktree.writerRunning'))
}

function persistJobs(): void {
  ensureLoaded()
  const removed = writeJobHistory([...jobs.values()].map(({ job }) => job))
  for (const id of removed) jobs.delete(id)
}

export function list(): AgentJob[] {
  ensureLoaded()
  return [...jobs.values()].map((j) => j.job).sort((a, b) => b.startedAt - a.startedAt)
}

/** The jobs the user and the conversation model deal with, which leaves out the background ones. */
export function userJobs(): AgentJob[] {
  return list().filter((job) => !isBackgroundJob(job))
}

export function userJob(id: string): AgentJob | undefined {
  const job = get(id)
  return job && !isBackgroundJob(job) ? job : undefined
}

/** The last 2000 lines of the job's log, read from its file, which is the only place that holds all of them. */
export function getLog(id: string): JobLogLine[] {
  ensureLoaded()
  return jobs.has(id) ? readJsonl<JobLogLine>(logFile(id), 2000) : []
}

export function get(id: string): AgentJob | undefined {
  ensureLoaded()
  return jobs.get(id)?.job
}

/** ASIST's own records (system) and the CLI's standard error (stderr). The CLI's own events go through pushEvent. */
function pushLog(id: string, kind: 'system' | 'stderr', text: string): void {
  pushEvent(id, { kind, text })
}

/** The jobs whose log file has already failed a write, so a full disk is not reported once per line. */
const unwritableLogs = new Set<string>()

function pushEvent(id: string, event: JobLogEvent): void {
  if (!jobs.has(id)) return
  const line: JobLogLine = { t: Date.now(), event }
  try {
    appendJsonl(logFile(id), line)
  } catch (error) {
    // The job goes on and the screen still gets the line; the log says once per job that its file is incomplete.
    if (!unwritableLogs.has(id)) {
      unwritableLogs.add(id)
      console.error(`job ${id} log could not be written:`, error)
    }
  }
  events.emit('event', { type: 'log', id, line })
}

function update(id: string, patch: Partial<AgentJob>): void {
  const entry = jobs.get(id)
  if (!entry) return
  // A job in an auto-created workspace scans its directory on completion, because a file written
  // through a shell redirection never shows up in a tool call.
  if (
    patch.status === 'done' &&
    entry.job.status !== 'done' &&
    path.basename(path.dirname(entry.job.cwd)) === WORKSPACES &&
    !entry.job.worktree
  ) {
    for (const file of scanWorkspaceFiles(entry.job.cwd)) addArtifact(entry, file)
  }
  const terminal = patch.status !== undefined && isJobTerminal(patch.status)
  if (terminal && entry.job.status !== patch.status && entry.job.worktree && !entry.job.mergeState) {
    Object.assign(patch, settleWorktree({ ...entry.job, ...patch }))
  }
  Object.assign(entry.job, patch)
  persistJobs()
  events.emit('event', { type: 'update', job: { ...entry.job } })
}

function addArtifact(entry: { job: AgentJob }, filePath: string): boolean {
  const list = (entry.job.artifacts ??= [])
  if (list.includes(filePath)) return false
  list.push(filePath)
  if (list.length > 50) list.splice(0, list.length - 50)
  return true
}

function scanWorkspaceFiles(root: string, depth = 3): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number): void => {
    if (d < 0 || out.length >= 30) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= 30) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, d - 1)
      else if (e.isFile()) out.push(full)
    }
  }
  walk(root, depth)
  return out
}

export interface StartOptions {
  /** The day the memory curation covers. It is stored with the job before the agent starts. */
  memoryCuration?: { through: string | null }
  /** The parent directory the worktree is created in. It defaults to `<agentCwd>/asist-jobs`. */
  worktreeRoot?: string
  /** Whether an explicit cwd is recorded in the project index. It defaults to true; the memory directory is not recorded. */
  noteProject?: boolean
  /** Runs right after the worktree is created, to drop in files such as a skill or AGENTS.md that git does not track. */
  prepareWorktree?: (worktreeDir: string) => void
  title?: string
  cwd?: string
  readonly?: boolean
}

/**
 * Finds a running job with the very same prompt, which guards against a literal double call
 * within one turn. It makes no semantic judgement about whether two requests are about the same thing:
 * the LLM decides that from the job status block injected into its system prompt. A similarity
 * threshold is not used, because it also blocks a legitimate repeated request.
 */
export function findActive(prompt: string): AgentJob | undefined {
  ensureLoaded()
  const trimmed = prompt.trim()
  return [...jobs.values()]
    .map((j) => j.job)
    .find((j) => isJobExecuting(j.status) && j.prompt.trim() === trimmed)
}

/**
 * The status block injected into the LLM system prompt on every turn: running jobs, jobs
 * that finished within the last 30 minutes, and recently used projects.
 */
export function contextBlock(): string | null {
  ensureLoaded()
  return formatJobContextBlock(
    userJobs().map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      engine: job.engine,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      summary: job.summary,
      mergeState: job.mergeState
    })),
    Date.now(),
    language(),
    projectIndex.recent().map((p) => ({ name: p.name, path: p.path }))
  )
}

/** The name of the folder in agentCwd that holds the workspace of every job naming no cwd, and the worktrees. */
const WORKSPACES = 'asist-jobs'

/** The folder `<agentCwd>/asist-jobs` that holds the workspace of every job naming no cwd, and the worktrees. */
export function workspaceRoot(): string {
  return path.join(getSettings().agentCwd || homedir(), WORKSPACES)
}

/** Creates the workspace `<agentCwd>/asist-jobs/<timestamp>-<name>/` for a job that names no cwd. */
function createWorkspace(title: string): string {
  const parent = workspaceRoot()
  fs.mkdirSync(parent, { recursive: true })
  return fs.mkdtempSync(path.join(parent, `${workspaceDirName(title, new Date())}-`))
}

/** Where the worktree goes, named like a workspace. The directory itself is created by git. */
function worktreePath(title: string, parentDir?: string): string {
  const parent = parentDir ?? workspaceRoot()
  fs.mkdirSync(parent, { recursive: true })
  return path.join(parent, `${workspaceDirName(title, new Date())}-${crypto.randomUUID().slice(0, 8)}`)
}

/** Appends one line to the job's log, such as why a curation job passed its check or was merged. */
export function note(id: string, text: string): void {
  pushLog(id, 'system', text)
}

/**
 * Refuses a folder to start a job in that is not written in full, which would be read against the app's own
 * folder or the current drive, and one that is gone, by name, since git cannot even start in it.
 */
function assertJobFolder(cwd: string): void {
  if (!isFullPath(cwd)) throw new Error(errorText('app.storage.folderNotFull', { path: cwd }))
  if (!fs.existsSync(cwd)) throw new Error(errorText('jobs.start.cwdMissing', { path: cwd }))
}

/** Whether cwd is inside a git repository, which decides whether the job can be isolated in a worktree. */
export function isGitRepo(cwd: string): boolean {
  assertJobFolder(cwd)
  return git.toplevel(cwd) !== null
}

/**
 * The files the job and every job it continues reported writing. A continuation works on in the worktree its
 * parent left, so what the parent reported there is in it as well.
 */
function reportedFiles(job: AgentJob): string[] {
  const files: string[] = []
  for (let current: AgentJob | undefined = job; current; current = current.parentId ? jobs.get(current.parentId)?.job : undefined) {
    files.push(...(current.artifacts ?? []))
  }
  return files
}

/**
 * Tidies the worktree once a job ends. Uncommitted changes are committed and left waiting to be merged, or,
 * when the job touched a submodule or the agent switched the worktree to another branch, left for the user to
 * merge or discard; a worktree with no change and no reported file outside the commit is removed. A failure
 * is recorded as `error` so that the work survives.
 */
function settleWorktree(job: AgentJob): Partial<AgentJob> {
  assertWriterStopped(job)
  try {
    const { settled, leftOut } = captureWorktree(job, reportedFiles(job))
    const worktree = settled.worktree!
    pushLog(job.id, 'system', worktree.movedTo
      ? t('jobs.merging.movedTo', { branch: worktree.movedTo, dir: worktree.dir })
      : worktree.submodules
        ? t('jobs.merging.submodules', { paths: worktree.submodules.join(', '), branch: worktree.branch, dir: worktree.dir })
        : t(settled.mergeState === 'unchanged' ? 'jobs.worktree.unchanged' : 'jobs.worktree.committed'))
    if (leftOut.length > 0) pushLog(job.id, 'system', t('jobs.merging.leftOut', { paths: leftOut.join(', ') }))
    return settled
  } catch (err) {
    pushLog(job.id, 'stderr', t('jobs.worktree.settleFailed', { detail: errorMessage(err) }))
    return { worktree: unsettled(job.worktree!), mergeState: 'error' }
  }
}

/** How far the job may write, as the line the log opens with names it. */
function accessLabel(job: AgentJob): string {
  if (job.readonly) return t('jobs.log.access.readOnly')
  return job.worktree
    ? t('jobs.log.access.worktree', { branch: job.worktree.branch })
    : t('jobs.log.access.approved')
}

/** Adds a job about to start to the history. A job whose record cannot be saved is dropped again, since nothing was started for it. */
function register(job: AgentJob): void {
  jobs.set(job.id, { job, process: null })
  try {
    persistJobs()
  } catch (error) {
    jobs.delete(job.id)
    throw error
  }
}

/** Removes the worktree cut for a job that failed to start. The error that stopped the start is the one the caller throws. */
function removeUnstartedWorktree(repo: string, dir: string, branch: string): void {
  try {
    git.worktreeRemove(repo, dir, branch)
  } catch (error) {
    console.error('cannot remove the worktree of a job that did not start:', dir, error)
  }
}

/**
 * The folder at the same place inside a new worktree as `folder` in the repository. A folder that is not
 * committed does not exist in the worktree, and the job is not started somewhere else instead.
 */
function folderInWorktree(dir: string, folder: string, named: string): string {
  const cwd = path.join(dir, folder)
  if (!fs.existsSync(cwd)) throw new Error(errorText('jobs.start.folderNotCommitted', { path: named }))
  return cwd
}

/** Creates and registers the job record without spawning anything. With `isolate`, it runs in a git worktree. */
function createJob(prompt: string, options: StartOptions, isolate = false): AgentJob {
  ensureLoaded()
  if (shuttingDown) throw new Error(errorText('jobs.start.shuttingDown'))
  const settings = getSettings()
  const engine = settings.agentEngine
  const title = options.title || prompt.slice(0, 40)
  const cwd = options.cwd || createWorkspace(title)
  assertJobFolder(cwd)
  // Only a job isolated in a worktree asks git about its folder: a read-only job runs in a repository that
  // ASIST's git refuses to open as it runs in any folder.
  const repo = isolate ? git.toplevel(cwd) : null
  if (isolate && !repo) throw new Error(errorText('jobs.start.notGitRepo', { path: cwd }))
  // An explicit location is recorded in the index, so that the more a place is used the more places
  // the user can name by voice.
  if (options.cwd && options.noteProject !== false) projectIndex.noteUsed(repo ?? cwd)
  // An isolated workspace is always writable, because the job has to write its output somewhere, and
  // the writes stay inside that throwaway directory.
  const { readonly } = resolveJobAccess({
    explicitCwd: Boolean(options.cwd),
    readonlyInput: options.readonly,
    defaultReadonly: settings.agentMode === 'readonly',
    gitRepo: isolate
  })
  const job: AgentJob = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    prompt,
    cwd,
    readonly: isolate ? false : readonly,
    engine,
    status: 'running',
    startedAt: Date.now(),
    ...(options.memoryCuration ? { memoryCuration: { ...options.memoryCuration, applied: false } } : {})
  }
  if (repo) {
    const folder = git.pathInRepo(cwd)
    const dir = worktreePath(title, options.worktreeRoot)
    const branch = worktreeBranchName(path.basename(dir))
    git.worktreeAdd(repo, dir, branch)
    try {
      options.prepareWorktree?.(dir)
      job.worktree = { repo, dir, branch, base: git.headCommit(repo) }
      job.cwd = folderInWorktree(dir, folder, cwd)
      register(job)
    } catch (error) {
      removeUnstartedWorktree(repo, dir, branch)
      throw error
    }
  } else {
    register(job)
  }
  events.emit('event', { type: 'update', job: { ...job } })
  pushLog(job.id, 'system', displayCommand(job))
  pushLog(job.id, 'system', t('jobs.log.start', { engine, cwd: job.cwd, access: accessLabel(job) }))
  return job
}

/** A job as the argument builder reads it, on the OS this process runs on. */
const cliJob = (job: AgentJob): AgentCliJob => ({ ...job, os: platformCapabilities().os })

/** Spawns the CLI and folds its output and its exit into the job's state. */
function launch(job: AgentJob, args: string[] = buildStartArgs(cliJob(job))): void {
  const entry = jobs.get(job.id)
  if (!entry) return
  const id = job.id
  const onError = (err: Error): void => {
    // The text becomes the job's summary, which a card shows as it is, so it is written for the user here.
    entry.processError = t('jobs.log.startFailed', { detail: errorMessage(err) })
    pushLog(id, 'stderr', entry.processError)
  }
  try {
    entry.process = launchAgentProcess(job, args, {
      onSpawn: (processIdentity) => update(id, { processIdentity }),
      onEvent: (event) => handleEvent(id, event),
      onStderr: (text) => pushLog(id, 'stderr', text),
      onError,
      onExit: (code) => {
        entry.process = null
        if (!isJobExecuting(entry.job.status)) return
        const stopped = entry.job.status === 'stopping'
        const failed = !stopped && (code !== 0 || Boolean(entry.processError) || entry.result?.ok === false)
        // A CLI that handles the SIGTERM of a stop exits with a code of its own, which says nothing more
        // than the cancellation the card already shows.
        update(id, {
          status: stopped ? 'cancelled' : failed ? 'error' : 'done',
          processIdentity: undefined,
          endedAt: Date.now(),
          summary: entry.processError ?? entry.job.summary ??
            (failed && code !== null ? t('jobs.log.exitCode', { code }) : undefined)
        })
      },
      onStopFailed: (error) => pushLog(id, 'stderr', errorMessage(error))
    })
    void entry.process.completion.catch((error) => pushLog(id, 'stderr', errorMessage(error)))
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)))
    update(id, { status: 'error', endedAt: Date.now(), summary: entry.processError })
  }
}

/**
 * Spawns the job at once. The caller has already asked the user: the conversation model's tools go
 * through the confirmation sheet first, and the memory curation checks its diff before merging.
 */
export function start(prompt: string, options: StartOptions = {}): AgentJob {
  const job = createJob(prompt, options)
  launch(job)
  return { ...job }
}

/**
 * A writing job inside a git repository, isolated in a worktree. Its changes reach the user's
 * repository only through merge, and the user's own working tree is never touched.
 */
export function startIsolated(prompt: string, options: StartOptions & { cwd: string }): AgentJob {
  const job = createJob(prompt, { ...options, readonly: false }, true)
  launch(job)
  return { ...job }
}

/**
 * Merges the worktree's changes into the user's repository. A conflict aborts the merge and keeps the
 * worktree. It asks nobody: the caller has shown the review and had it approved, or, for the memory
 * curation, checked that the diff stays inside the memory folder.
 */
export function merge(id: string, reviewed: ReviewedMerge): AgentJob {
  ensureLoaded()
  const entry = jobs.get(id)
  if (!entry?.job.worktree) throw new Error(errorText('jobs.merging.noChanges', { id }))
  assertWriterStopped(entry.job)
  assertWorktreeReview(entry.job, reviewed.commit)
  const wt = entry.job.worktree
  assertMergeable(entry.job, reviewed)
  const outcome = git.mergeNoFf(wt.repo, reviewed.commit, `asist: ${entry.job.title} (${id})`)
  if (outcome.ok) {
    pushLog(id, 'system', t('jobs.merging.done', { repo: wt.repo }))
    // The worktree is about to be removed, so artifact paths inside it are moved to the merge target
    // and stay openable from the completion card and from show_files. The paths are saved before the
    // removal, because the merge is already done even if the removal fails.
    update(id, { mergeState: 'merged', artifacts: mergedArtifacts(entry.job, reportedFiles(entry.job)) })
    try {
      git.worktreeRemove(wt.repo, wt.dir, wt.branch)
    } catch (error) {
      const detail = errorMessage(error)
      pushLog(id, 'stderr', t('jobs.merging.removeFailed', { detail }))
      throw new Error(errorText('jobs.merging.removeFailed', { detail }))
    }
    return { ...entry.job }
  }
  if (outcome.conflict) {
    pushLog(id, 'stderr', t('jobs.merging.conflict', { detail: outcome.message }))
    // The LLM sees no mergeState for a job that is no longer awaiting a merge, so the suffix says it.
    update(id, { mergeState: 'conflict', summary: `${entry.job.summary ?? ''}${say(MODEL_TEXTS.mergeConflict)}` })
    return { ...entry.job }
  }
  throw new Error(errorText('jobs.merging.failed', { detail: outcome.message }))
}

/**
 * The worktree a discard removes. It refuses a job with nothing left to throw away, whose changes were
 * merged, discarded or never made, and one whose agent may still write to it.
 */
function discardableWorktree(id: string): NonNullable<AgentJob['worktree']> {
  ensureLoaded()
  const job = jobs.get(id)?.job
  if (!job?.worktree || job.mergeState === 'merged' || job.mergeState === 'discarded' || job.mergeState === 'unchanged') {
    throw new Error(errorText('jobs.discard.noChanges', { id }))
  }
  assertWriterStopped(job)
  if (!isJobTerminal(job.status)) throw new Error(errorText('jobs.discard.jobRunning'))
  return job.worktree
}

/**
 * What a discard of a job would delete, which the card and discard_agent_job show the user before asking. It
 * refuses as discard does, so that the user is never asked about a discard that cannot happen. The
 * submodules are looked into now rather than read from the job, since work can appear in them after it
 * settled and a job whose settling failed has none recorded.
 */
export function discardPreview(id: string): DiscardPreview {
  const worktree = discardableWorktree(id)
  return {
    repo: worktree.repo,
    dir: worktree.dir,
    branch: worktree.branch,
    stat: discardStat(worktree),
    submodules: submodulesAtRisk(worktree),
    leftOut: leftOutAtDiscard(worktree, reportedFiles(jobs.get(id)!.job))
  }
}

/** Throws the worktree's changes away by deleting both the worktree and its branch. */
export function discard(id: string): AgentJob {
  const worktree = discardableWorktree(id)
  git.worktreeRemove(worktree.repo, worktree.dir, worktree.branch)
  pushLog(id, 'system', t('jobs.discard.done'))
  update(id, { mergeState: 'discarded' })
  return { ...jobs.get(id)!.job }
}

export function diff(id: string): JobDiff {
  ensureLoaded()
  const entry = jobs.get(id)
  if (!entry?.job.worktree) throw new Error(errorText('jobs.diff.none', { id }))
  assertWriterStopped(entry.job)
  if (!isJobTerminal(entry.job.status)) throw new Error(errorText('jobs.worktree.jobRunning'))
  if (entry.job.mergeState === 'error') {
    // A worktree that is gone cannot be settled, and trying again on every look would only log it again.
    assertWorktreePresent(entry.job.worktree)
    update(id, settleWorktree(entry.job))
  }
  return readWorktreeDiff(entry.job, reportedFiles(entry.job))
}

/**
 * Creates a new job that resumes the original one's session in the same place with the same permissions.
 * A running original is stopped first, so that a correction such as "actually, do it this other way" is a
 * single operation. The write permission carries over from the original job; asking the user whether to
 * carry on belongs to the caller. The caller's signal counts only until the original is stopped: after
 * that the continuation goes ahead, since dropping it would leave the user's job stopped for nothing.
 */
export async function continueJob(parentId: string, prompt: string, signal?: AbortSignal): Promise<AgentJob> {
  ensureLoaded()
  signal?.throwIfAborted()
  if (shuttingDown) throw new Error(errorText('jobs.start.shuttingDown'))
  const parent = jobs.get(parentId)?.job
  if (!parent) throw new Error(errorText('jobs.continue.jobMissing', { id: parentId }))
  if (jobs.get(parentId)?.recovering) assertWriterStopped(parent)
  const assertNoContinuation = (): void => {
    const next = [...jobs.values()].find(({ job }) => job.parentId === parentId)?.job
    if (next) throw new Error(errorText('jobs.continue.alreadyContinued', { id: next.id }))
  }
  assertNoContinuation()
  if (!parent.sessionId) throw new Error(errorText('jobs.continue.noSession'))
  if (parent.status === 'stopping') throw new Error(errorText('jobs.continue.stopping'))
  if (parent.status === 'running') await stopJob(parentId)
  if (shuttingDown) throw new Error(errorText('jobs.start.shuttingDown'))
  assertNoContinuation()
  const transferWorktree = Boolean(parent.worktree &&
    (parent.mergeState === 'pending' || parent.mergeState === 'conflict' || parent.mergeState === 'error'))
  const job: AgentJob = {
    id: crypto.randomUUID().slice(0, 8),
    // The title names the worktree directory and the commit message git writes, so it is data.
    title: `${parent.title}${say(MODEL_TEXTS.continued)}`,
    prompt,
    cwd: parent.cwd,
    readonly: parent.readonly,
    engine: parent.engine,
    status: 'running',
    startedAt: Date.now(),
    sessionId: parent.sessionId,
    parentId,
    ...(parent.memoryCuration ? { memoryCuration: { through: parent.memoryCuration.through, applied: false } } : {}),
    ...(transferWorktree ? { worktree: unsettled(parent.worktree!) } : {})
  }
  // A worktree job whose changes are already merged or cleaned up continues in a fresh worktree cut
  // from the repository, in the same folder inside it.
  let fresh: { repo: string; dir: string; branch: string } | undefined
  if (parent.worktree && !transferWorktree) {
    const repo = parent.worktree.repo
    if (!fs.existsSync(repo)) throw new Error(errorText('jobs.start.repoMissing', { path: repo }))
    const dir = worktreePath(parent.title)
    fresh = { repo, dir, branch: worktreeBranchName(path.basename(dir)) }
    git.worktreeAdd(repo, dir, fresh.branch)
  }
  const parentWorktree = parent.worktree
  const parentMergeState = parent.mergeState
  try {
    if (fresh) {
      const folder = path.relative(parentWorktree!.dir, parent.cwd)
      job.worktree = { ...fresh, base: git.headCommit(fresh.repo) }
      job.cwd = folderInWorktree(fresh.dir, folder, path.join(fresh.repo, folder))
    } else if (!fs.existsSync(job.cwd)) {
      throw new Error(errorText('jobs.start.cwdMissing', { path: job.cwd }))
    }
    if (parent.memoryCuration) installSkill(job.worktree?.dir ?? job.cwd)
    if (transferWorktree) {
      delete parent.worktree
      delete parent.mergeState
    }
    register(job)
  } catch (error) {
    if (transferWorktree) {
      parent.worktree = parentWorktree
      parent.mergeState = parentMergeState
    }
    if (fresh) removeUnstartedWorktree(fresh.repo, fresh.dir, fresh.branch)
    throw error
  }
  if (transferWorktree) events.emit('event', { type: 'update', job: { ...parent } })
  events.emit('event', { type: 'update', job: { ...job } })
  pushLog(job.id, 'system', displayCommand(parent, prompt))
  pushLog(job.id, 'system', t('jobs.log.startContinued', {
    engine: job.engine, cwd: job.cwd, access: accessLabel(job), parentId
  }))
  launch(job, buildResumeArgs(cliJob({ ...parent, cwd: job.cwd })))
  return { ...job }
}

/** Finishes a curation job's history entry only once its index and its processed day are stored. */
export function completeMemoryCuration(id: string): void {
  const job = get(id)
  if (!job?.memoryCuration || job.status !== 'done' ||
      (job.mergeState !== 'merged' && job.mergeState !== 'unchanged')) {
    throw new Error(errorText('memory.curation.notFinished'))
  }
  const previous = job.memoryCuration
  job.memoryCuration = { ...previous, applied: true }
  try {
    persistJobs()
  } catch (error) {
    job.memoryCuration = previous
    throw error
  }
  events.emit('event', { type: 'update', job: { ...job } })
}

/**
 * Folds an engine-independent event into the log and the job state. Formatting belongs to the view. The
 * events arrive in a listener on the CLI's output, where a throw would become an uncaught exception of
 * the main process, so a job state that cannot be saved is reported in the job's log instead.
 */
function handleEvent(id: string, event: AgentStreamEvent): void {
  const entry = jobs.get(id)
  if (!entry) return
  if (event.kind === 'result' && !isJobExecuting(entry.job.status)) return
  if (event.kind === 'raw' && !event.text.trim()) return
  pushEvent(id, event)
  try {
    switch (event.kind) {
      case 'init':
        if (event.sessionId) update(id, { sessionId: event.sessionId })
        break
      case 'assistant-text':
        entry.lastAssistantText = event.text
        break
      case 'file-change': {
        let changed = false
        for (const p of artifactPaths(event)) if (addArtifact(entry, p)) changed = true
        if (changed) {
          persistJobs()
          events.emit('event', { type: 'update', job: { ...entry.job } })
        }
        break
      }
      case 'result': {
        entry.result = event
        const summary = event.summary || entry.lastAssistantText || ''
        update(id, {
          summary: summary.slice(0, 300) || undefined,
          numTurns: event.numTurns,
          costUsd: event.costUsd
        })
        if (event.costUsd !== undefined && entry.job.engine === 'claude') {
          recordUsage({ kind: 'agent', engine: 'claude', jobs: 1, costUsd: event.costUsd })
        }
        break
      }
    }
  } catch (error) {
    console.error('cannot save the state of agent job', id, error)
    pushLog(id, 'stderr', t('jobs.log.saveFailed', { detail: errorMessage(error) }))
  }
}

/**
 * The roots the files card (show_files) and the Finder view are allowed to read: every job's folder, the
 * workspace, the memory directory, and the folders named in the settings. A job in a worktree may write
 * anywhere in it, as under dist/ at its top while it works in packages/web, so its folder is the whole
 * worktree, and once merged, the repository, where the merge moved its artifacts as well.
 */
export function allowedFileRoots(): string[] {
  ensureLoaded()
  const roots = new Set<string>()
  const settings = getSettings()
  if (settings.agentCwd) roots.add(path.join(settings.agentCwd, WORKSPACES))
  // Once a curation job is merged, its output lives in the memory directory.
  roots.add(memoryDir())
  for (const root of settings.fileRoots) if (root.trim()) roots.add(root.trim())
  for (const { job } of jobs.values()) {
    const { worktree } = job
    roots.add(!worktree ? job.cwd : job.mergeState === 'merged' ? worktree.repo : worktree.dir)
  }
  return [...roots]
}

/** Asks the job's agent to stop. A stop that fails is written to the job's log where the agent's owner reports it. */
export function cancel(id: string): void {
  void stopJob(id).catch(() => {})
}

/**
 * Asks the job's agent to stop and settles once it is gone, or rejects when the stop does not see it gone by
 * its deadline. A job of this run that is still stopping is asked again, which sends the stop again once an
 * earlier one failed; a job restored after a restart has its agent checked again.
 */
function stopJob(id: string): Promise<void> {
  ensureLoaded()
  const entry = jobs.get(id)
  if (!entry) return Promise.resolve()
  if (entry.recovering) {
    startRecovery(entry)
  } else if (isJobExecuting(entry.job.status)) {
    if (entry.job.status === 'running') update(id, { status: 'stopping' })
    pushLog(id, 'system', t('jobs.log.stopRequested'))
  }
  const process = entry.process
  if (!process || !isJobExecuting(entry.job.status)) return Promise.resolve()
  return Promise.all([process.stop(), process.completion]).then(() => {})
}

/** Whether a new job may start, which none may once the app has begun to quit. */
export function acceptsJobs(): boolean {
  return !shuttingDown
}

/**
 * Stops accepting new jobs and waits for every agent the app owns to close and for its worktree to settle.
 * When an agent cannot be stopped the quit is cancelled, and new jobs are accepted again.
 */
export async function shutdown(): Promise<void> {
  shuttingDown = true
  try {
    const stops: Promise<void>[] = []
    for (const { job, process } of jobs.values()) {
      if (process) stops.push(stopJob(job.id))
    }
    await Promise.all(stops)
  } catch (error) {
    shuttingDown = false
    throw error
  }
}
