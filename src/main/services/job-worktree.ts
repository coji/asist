import fs from 'node:fs'
import type { AgentJob, JobDiff, MergeVerdict, ReviewedMerge } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import * as git from './git'

type Worktree = NonNullable<AgentJob['worktree']>

const sortedUnique = (paths: string[]): string[] => [...new Set(paths)].sort()

/**
 * The commit a job's own changes are counted from: its merge base with the repository's current HEAD, since
 * a job that merged or rebased onto the user's branch holds the user's commits as well. A branch that shares
 * no history with the job, made by `checkout --orphan`, has none, and the job's changes are then those since
 * the commit it started from.
 */
function jobBase(worktree: Worktree, commit: string): string {
  return git.mergeBase(worktree.repo, commit) ?? worktree.base
}

/**
 * Refuses to work on a worktree whose folder is gone, deleted by hand, with a reason the user can act on:
 * git would otherwise fail to start in the missing folder, which reads as if git itself were missing.
 */
export function assertWorktreePresent(worktree: Worktree): void {
  if (!fs.existsSync(worktree.dir)) {
    throw new Error(errorText('jobs.worktree.gone', { dir: worktree.dir, branch: worktree.branch }))
  }
}

/**
 * Settles the output after the process has ended. On failure the caller keeps the worktree. The commit holds
 * the worktree as the agent left it, and the submodules it touched or holds work in are recorded: a job with
 * any is never merged by ASIST, and its worktree stays until the user discards it, since a commit made inside
 * a submodule of the worktree has no other copy. The worktree is removed without asking only when neither the
 * diff nor its submodules hold anything that could be lost.
 */
export function captureWorktree(job: AgentJob): Pick<AgentJob, 'worktree' | 'mergeState'> {
  const worktree = job.worktree!
  assertWorktreePresent(worktree)
  git.commitAll(worktree.dir, `asist: ${job.title}`)
  const commit = git.headCommit(worktree.dir)
  const base = jobBase(worktree, commit)
  const submodules = sortedUnique([...git.submoduleEntryChanges(worktree.repo, base, commit), ...git.submodulesWithWork(worktree.dir)])
  const settled = { ...worktree, commit, submodules: submodules.length > 0 ? submodules : undefined }
  if (!git.hasChanges(worktree.repo, base, commit) && submodules.length === 0) {
    git.worktreeRemove(worktree.repo, worktree.dir, worktree.branch)
    return { worktree: settled, mergeState: 'unchanged' }
  }
  return { worktree: settled, mergeState: 'pending' }
}

/** The submodules whose work in the worktree a discard may delete; none when its folder is gone. */
export function submodulesAtRisk(worktree: Worktree): string[] {
  return fs.existsSync(worktree.dir) ? git.submodulesWithWork(worktree.dir) : []
}

/** What a discard of the worktree's branch would throw away, counted as a settled job's changes are. */
export function discardStat(worktree: Worktree): string {
  return git.diffStat(worktree.repo, jobBase(worktree, worktree.branch), worktree.branch)
}

/**
 * The commit a merge of `commit` into the repository's HEAD starts from, which is what a review counts from
 * and what the merge applies the changes since. A branch with no history in common with the job has none,
 * and nothing is merged into it.
 */
export function mergeBase(worktree: Worktree, commit: string): string {
  const base = git.mergeBase(worktree.repo, commit)
  if (base === null) throw new Error(errorText('jobs.merging.noCommonHistory'))
  return base
}

/** Acts only while the commit that was shown still matches the current branch and worktree. */
export function assertWorktreeReview(job: AgentJob, commit: string): void {
  const worktree = job.worktree
  if (!isJobTerminal(job.status)) throw new Error(errorText('jobs.worktree.jobRunning'))
  if (!worktree || job.mergeState !== 'pending' || !commit || commit !== worktree.commit) {
    throw new Error(errorText('jobs.worktree.reviewStale'))
  }
  assertWorktreePresent(worktree)
  if (!git.isSettled(worktree.dir)) throw new Error(errorText('jobs.worktree.uncommitted'))
  if (git.headCommit(worktree.dir) !== commit || git.headCommit(worktree.repo, worktree.branch) !== commit) {
    throw new Error(errorText('jobs.worktree.commitChanged'))
  }
}

/**
 * Whether ASIST merges the job's commit into the branch checked out in `into` from `base`, decided the same
 * way for a review and for the merge itself, so that nothing shown as mergeable is refused once the user has
 * approved it. It refuses a detached HEAD; a job that touched submodules, which the user merges or discards;
 * one with nothing to merge; and a repository with uncommitted changes, which the merge would mix with the
 * job's. The submodules are those the changes a merge counted from `base` would bring in touch, and those
 * whose folders in the worktree may hold work, looked into on every call: the merge removes the worktree and
 * whatever work appeared in them since the job settled.
 */
function mergeVerdict(job: AgentJob, into: string | null, base: string, commit: string): MergeVerdict & { submodules: string[] } {
  const worktree = job.worktree!
  const submodules = sortedUnique([
    ...(worktree.submodules ?? []),
    ...git.submoduleEntryChanges(worktree.repo, base, commit),
    ...git.submodulesWithWork(worktree.dir)
  ])
  // A merge into a detached HEAD moves only HEAD: the work is left to a reflog once the branch is checked
  // out again, as after a bisect, while the job's branch and worktree are already deleted.
  if (into === null) return { into, submodules, blocked: errorText('jobs.merging.detached') }
  if (submodules.length > 0) {
    const blocked = errorText('jobs.merging.submodules', { paths: submodules.join(', '), branch: worktree.branch, dir: worktree.dir })
    return { into, submodules, blocked }
  }
  if (!git.hasChanges(worktree.repo, base, commit)) return { into, submodules, blocked: errorText('jobs.merging.noChanges', { id: job.id }) }
  if (!git.isClean(worktree.repo)) return { into, submodules, blocked: errorText('jobs.merging.dirtyRepo') }
  return { into, submodules, blocked: null }
}

/**
 * Refuses a merge that is not the one the review showed: into another branch or commit than the one checked
 * out then, or of more than the diff counted from its base. A branch cut from the same commit keeps the
 * merge base, so the base alone would let the merge land where the user did not approve it. It also refuses
 * every merge that mergeVerdict blocks.
 */
export function assertMergeable(job: AgentJob, reviewed: ReviewedMerge): void {
  const worktree = job.worktree!
  const { commit, base } = reviewed
  const into = git.checkedOut(worktree.repo)
  if (into !== null && (into !== reviewed.into || mergeBase(worktree, commit) !== base)) {
    throw new Error(errorText('jobs.merging.baseChanged'))
  }
  const { blocked } = mergeVerdict(job, into, base, commit)
  if (blocked !== null) throw new Error(blocked)
}

/**
 * The diff a merge would bring in, counted from the merge base it names, the submodules that keep the job
 * from being merged by ASIST, and why ASIST would refuse to merge it, if it would.
 */
export function readWorktreeDiff(job: AgentJob): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  const base = mergeBase(worktree, commit)
  return {
    commit,
    base,
    stat: git.diffStat(worktree.repo, base, commit),
    patch: git.diffPatch(worktree.repo, base, commit),
    ...mergeVerdict(job, git.checkedOut(worktree.repo), base, commit)
  }
}
