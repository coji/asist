import fs from 'node:fs'
import { z } from 'zod'
import type { AgentJob } from '@shared/ipc'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import { storedContent, type StoredFormat } from '@shared/stored-format'
import { dataPath, removeData, writeJson } from './store'
import { openStoredFileSync } from './stored-file'

const JOBS_FILE = 'jobs.json'
const MAX_COMPLETED_JOBS = 50
/** Each line is a JobLogLine carrying an event. The name differs from the older string log's, so those files are never read. */
export const jobLogFile = (id: string): string => `joblogs/${id}.events.jsonl`

const jobSchema: z.ZodType<AgentJob> = z.object({
  id: z.string().regex(/^[\w-]+$/),
  title: z.string(),
  prompt: z.string(),
  cwd: z.string().min(1),
  readonly: z.boolean(),
  engine: z.enum(['codex', 'claude']),
  status: z.enum(['running', 'stopping', 'done', 'error', 'cancelled']),
  processIdentity: z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1), token: z.string().uuid() }).optional(),
  startedAt: z.number().nonnegative(),
  endedAt: z.number().nonnegative().optional(),
  summary: z.string().optional(),
  numTurns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  artifacts: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  parentId: z.string().optional(),
  worktree: z.object({
    repo: z.string().min(1), dir: z.string().min(1), branch: z.string().min(1), base: z.string().min(1), commit: z.string().optional(),
    submodules: z.array(z.string().min(1)).optional(), movedTo: z.string().min(1).optional(),
    keptFor: z.array(z.string().min(1)).optional()
  }).passthrough().optional(),
  mergeState: z.enum(['pending', 'merged', 'discarded', 'unchanged', 'conflict', 'error']).optional(),
  memoryCuration: z.object({ through: z.iso.date().nullable(), applied: z.boolean() }).optional()
}).passthrough()

const historySchema = z.array(jobSchema).superRefine((jobs, context) => {
  const ids = new Set<string>()
  jobs.forEach((job, index) => {
    // The issue is only ever read inside the text of the error below, which never reaches a screen on its own.
    if (ids.has(job.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'duplicate job id' })
    ids.add(job.id)
  })
})

export const JOBS_FORMAT: StoredFormat<AgentJob[]> = {
  name: JOBS_FILE,
  version: 5,
  upgrades: {
    // Version 1 was the bare list of jobs; version 2 is an object, which is what can carry the version.
    1: (content) => ({ jobs: content }),
    // Version 3 keeps the worktree's path apart from the job's cwd, which can be a folder inside it.
    // Until then every worktree job ran at the top of its worktree.
    2: (content) => {
      const { jobs, ...rest } = content as { jobs?: unknown }
      if (!Array.isArray(jobs)) return content
      return {
        ...rest,
        jobs: jobs.map((job: { cwd?: unknown; worktree?: object }) =>
          job?.worktree ? { ...job, worktree: { ...job.worktree, dir: job.cwd } } : job)
      }
    },
    // Version 4 records the submodules a job touched, and ASIST does not merge a job that touched any. A job
    // of version 3 waiting to be merged was settled without that check, and its commit can point a submodule
    // at a commit that only its worktree holds, so it loses its merge state and is settled again when the
    // history is read.
    3: (content) => {
      const { jobs, ...rest } = content as { jobs?: unknown }
      if (!Array.isArray(jobs)) return content
      return {
        ...rest,
        jobs: jobs.map((job: { worktree?: object; mergeState?: unknown }) => {
          if (!job?.worktree || job.mergeState !== 'pending') return job
          const { mergeState: _unsettled, ...unsettled } = job
          return unsettled
        })
      }
    },
    // Version 5 records the branch an agent left its worktree on instead of the job's own, which ASIST does
    // not merge, and the files git ignores that alone keep a job with nothing to merge. No job of version 4
    // has either recorded: a review of the first looks at the worktree itself and refuses it all the same, and
    // version 4 removed the worktree of the second when it settled.
    4: (content) => content
  },
  parse: (content) => historySchema.parse((content as { jobs?: unknown } | null)?.jobs),
  serialize: (jobs) => ({ jobs })
}

/** Only a missing file counts as an empty history, so that an invalid one is never replaced by a fresh save. */
export function readJobHistory(): AgentJob[] {
  const file = dataPath(JOBS_FILE)
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(errorText('jobs.history.unreadable', { file, detail: errMessage(error) }))
  }
  try {
    return openStoredFileSync(file, JSON.parse(source) as unknown, JOBS_FORMAT)
  } catch (error) {
    throw new Error(errorText('jobs.history.invalid', { file, detail: errMessage(error) }))
  }
}

function canPrune(job: AgentJob): boolean {
  if (!isJobTerminal(job.status)) return false
  if (job.memoryCuration && !job.memoryCuration.applied && job.status === 'done' &&
      (job.mergeState === 'merged' || job.mergeState === 'unchanged')) return false
  if (!job.worktree) return true
  if (job.mergeState !== 'merged' && job.mergeState !== 'discarded' && job.mergeState !== 'unchanged') return false
  // Even after a merge, the record that owns a worktree whose removal failed is kept.
  try {
    fs.statSync(job.worktree.dir)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** Deletes the logs no longer needed only after the save is committed, and returns the ids the caller may drop. */
export function writeJobHistory(jobs: AgentJob[]): string[] {
  // The order is by end time, so that a job that ran for a long time can still be read right after it ends.
  const ordered = [...jobs].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  const retained: AgentJob[] = []
  const removed: string[] = []
  let completed = 0
  for (const job of ordered) {
    if (canPrune(job) && ++completed > MAX_COMPLETED_JOBS) removed.push(job.id)
    else retained.push(job)
  }
  writeJson(JOBS_FILE, storedContent(JOBS_FORMAT, retained))
  for (const id of removed) {
    try {
      removeData(jobLogFile(id))
    } catch (error) {
      // The history itself is saved; only the failure to delete the log is reported.
      console.error(`cannot delete the stale job log: ${jobLogFile(id)}`, error)
    }
  }
  return removed
}
