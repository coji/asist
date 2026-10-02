import fs from 'node:fs'
import path from 'node:path'
import type { AgentJob, JobDiff, MergeVerdict, ReviewedMerge } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isBackgroundJob, isJobTerminal } from '@shared/job-status'
import * as git from './git'

type Worktree = NonNullable<AgentJob['worktree']>

const sortedUnique = (paths: string[]): string[] => [...new Set(paths)].sort()

/** The worktree of a job as it was before the job settled, for a job that is to settle again. */
export function unsettled({ repo, dir, branch, base }: Worktree): Worktree {
  return { repo, dir, branch, base }
}

/**
 * Where file lies in the worktree, written as git names a path there, or null when it lies outside. Both are
 * compared as resolvedAsFarAsExists spells them, since a CLI names a file by the path with its links resolved.
 */
function inWorktree(worktree: Worktree, file: string): string | null {
  const inside = path.relative(git.resolvedAsFarAsExists(worktree.dir), git.resolvedAsFarAsExists(file))
  if (inside.split(path.sep)[0] === '..' || path.isAbsolute(inside)) return null
  return inside.split(path.sep).join('/')
}

/**
 * Where a path in the worktree lies once a merge has removed the worktree: at the same place in the
 * repository. A path outside the worktree stays as it is.
 */
function inRepository(worktree: Worktree, file: string): string {
  const inside = inWorktree(worktree, file)
  return inside === null ? file : path.join(worktree.repo, inside)
}

/**
 * Those of the reported files that lie in the worktree and that commit does not hold, by their paths there.
 * The reported files are those the job and every job it continues reported writing, since a continuation
 * works in the worktree its parent left. The commit holds everything else in the worktree, so these are files
 * git ignores, such as a report under dist/: a merge leaves them behind, and the removal of the worktree
 * deletes them. A folder or a file that is gone holds nothing to lose.
 */
function leftOutOf(worktree: Worktree, commit: string, reported: readonly string[]): string[] {
  const files: string[] = []
  for (const file of reported) {
    const inside = inWorktree(worktree, file)
    if (inside !== null && git.lstatOrNull(file)?.isDirectory() === false) files.push(inside)
  }
  const held = git.heldIn(worktree.dir, commit, files)
  return sortedUnique(files.filter((file) => !held.has(file)))
}

/**
 * The reported files a discard deletes with the worktree although no branch holds them; none while the job
 * has no commit or its folder is gone.
 */
export function leftOutAtDiscard(worktree: Worktree, reported: readonly string[]): string[] {
  return worktree.commit && fs.existsSync(worktree.dir) ? leftOutOf(worktree, worktree.commit, reported) : []
}

/**
 * What the worktree has checked out in place of the job's own branch: a branch the agent switched to, or the
 * commit of a detached HEAD. Null while the job's branch is checked out.
 */
function checkedOutElsewhere(worktree: Worktree): string | null {
  const checkedOut = git.checkedOut(worktree.dir)
  if (checkedOut === worktree.branch) return null
  return checkedOut ?? git.headCommit(worktree.dir)
}

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

/** What the job's record keeps once its worktree settled, and the files it reported that the commit does not hold. */
export interface Capture {
  settled: Pick<AgentJob, 'worktree' | 'mergeState'>
  leftOut: string[]
}

/**
 * Settles the output after the process has ended. On failure the caller keeps the worktree. The commit holds
 * the worktree as the agent left it, and the submodules it touched or holds work in are recorded: a job with
 * any is never merged by ASIST, and its worktree stays until the user discards it, since a commit made inside
 * a submodule of the worktree has no other copy. An agent that switched the worktree to a branch of its own,
 * or detached its HEAD, left its work where ASIST commits nothing: the branch may be one of the user's, and a
 * commit on a detached HEAD would be lost with the worktree. Such a job is recorded with what is checked out,
 * is never merged by ASIST, and waits for the user as well.
 *
 * The worktree is removed without asking only when neither the diff nor its submodules hold anything that
 * could be lost, and no reported file lies outside the commit, as one written where git ignores it does. A
 * job kept for such files alone has nothing to merge, and records them as what it is kept for. A background
 * job is removed all the same, since no user is shown its worktree, and the files git ignores there are those
 * ASIST copied in.
 */
export function captureWorktree(job: AgentJob, reported: readonly string[]): Capture {
  const worktree = unsettled(job.worktree!)
  assertWorktreePresent(worktree)
  const movedTo = checkedOutElsewhere(worktree)
  if (movedTo !== null) {
    return { settled: { worktree: { ...worktree, commit: git.headCommit(worktree.dir), movedTo }, mergeState: 'pending' }, leftOut: [] }
  }
  git.commitAll(worktree.dir, `asist: ${job.title}`)
  const commit = git.headCommit(worktree.dir)
  const base = jobBase(worktree, commit)
  const submodules = sortedUnique([...git.submoduleEntryChanges(worktree.repo, base, commit), ...git.submodulesWithWork(worktree.dir)])
  const leftOut = leftOutOf(worktree, commit, reported)
  const settled = { ...worktree, commit, ...(submodules.length > 0 ? { submodules } : {}) }
  if (submodules.length > 0 || git.hasChanges(worktree.repo, base, commit)) {
    return { settled: { worktree: settled, mergeState: 'pending' }, leftOut }
  }
  if (leftOut.length > 0 && !isBackgroundJob(job)) {
    return { settled: { worktree: { ...settled, keptFor: leftOut }, mergeState: 'pending' }, leftOut }
  }
  git.worktreeRemove(worktree.repo, worktree.dir, worktree.branch)
  return { settled: { worktree: settled, mergeState: 'unchanged' }, leftOut }
}

/**
 * The job's artifacts once its worktree is merged: a file in the worktree lies at the same place in the
 * repository, unless the merge left it behind to be deleted with the worktree, and a path outside it stays.
 */
export function mergedArtifacts(job: AgentJob, reported: readonly string[]): string[] | undefined {
  const worktree = job.worktree!
  const behind = new Set(leftOutOf(worktree, worktree.commit!, reported))
  return job.artifacts
    ?.filter((file) => {
      const inside = inWorktree(worktree, file)
      return inside === null || !behind.has(inside)
    })
    .map((file) => inRepository(worktree, file))
}

/** The submodules whose work in the worktree a discard may delete; none when its folder is gone. */
export function submodulesAtRisk(worktree: Worktree): string[] {
  return fs.existsSync(worktree.dir) ? git.submodulesWithWork(worktree.dir) : []
}

/**
 * What a discard of the worktree's branch would throw away, counted as a settled job's changes are. Nothing,
 * once an agent renamed the branch away.
 */
export function discardStat(worktree: Worktree): string {
  if (!git.hasBranch(worktree.repo, worktree.branch)) return ''
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
  const movedTo = checkedOutElsewhere(worktree)
  if (movedTo !== null) throw new Error(errorText('jobs.merging.movedTo', { branch: movedTo, dir: worktree.dir }))
  if (!git.isSettled(worktree.dir)) throw new Error(errorText('jobs.worktree.uncommitted'))
  if (git.headCommit(worktree.dir) !== commit || git.headCommit(worktree.repo, worktree.branch) !== commit) {
    throw new Error(errorText('jobs.worktree.commitChanged'))
  }
}

/**
 * Whether ASIST merges the job's commit into the branch checked out in `into` from `base`, decided the same
 * way for a review and for the merge itself, so that nothing shown as mergeable is refused once the user has
 * approved it. It refuses a detached HEAD; a job that touched submodules, which the user merges or discards;
 * one with nothing to merge; a repository with uncommitted changes, which the merge would mix with the job's;
 * and one with a file git does not track where the merge would write one. The submodules are those the
 * changes a merge counted from `base` would bring in touch, and those whose folders in the worktree may hold
 * work, looked into on every call: the merge removes the worktree and whatever work appeared in them since
 * the job settled.
 *
 * The branch's history already holds the job's commit when that commit is the merge base, and the job moved
 * its branch from where it started: ASIST ended after git had merged the job and before the job's record said
 * so, or the user merged the job's branch. A job that committed nothing has the commit it started from, which
 * the branch can hold as well, and has nothing to merge; so has one kept only for files git ignores, whose
 * branch moved, if at all, only onto commits of the user's. Such a merge writes nothing into the working tree,
 * so it needs neither a clean one nor a free place for the files; it only records the job as merged.
 */
function mergeVerdict(
  job: AgentJob, into: string | null, base: string, commit: string
): MergeVerdict & { submodules: string[]; alreadyMerged: boolean } {
  const worktree = job.worktree!
  const submodules = sortedUnique([
    ...(worktree.submodules ?? []),
    ...git.submoduleEntryChanges(worktree.repo, base, commit),
    ...git.submodulesWithWork(worktree.dir)
  ])
  const alreadyMerged = base === commit && commit !== worktree.base && !worktree.keptFor
  const found = { submodules, alreadyMerged }
  // A merge into a detached HEAD moves only HEAD: the work is left to a reflog once the branch is checked
  // out again, as after a bisect, while the job's branch and worktree are already deleted.
  if (into === null) return { ...found, into, blocked: errorText('jobs.merging.detached') }
  if (submodules.length > 0) {
    const blocked = errorText('jobs.merging.submodules', { paths: submodules.join(', '), branch: worktree.branch, dir: worktree.dir })
    return { ...found, into, blocked }
  }
  if (alreadyMerged) return { ...found, into, blocked: null }
  if (!git.hasChanges(worktree.repo, base, commit)) return { ...found, into, blocked: errorText('jobs.merging.noChanges', { id: job.id }) }
  if (!git.isClean(worktree.repo)) return { ...found, into, blocked: errorText('jobs.merging.dirtyRepo') }
  const inTheWay = git.untrackedInTheWay(worktree.repo, base, commit)
  if (inTheWay.length > 0) return { ...found, into, blocked: errorText('jobs.merging.untrackedInTheWay', { paths: git.named(inTheWay) }) }
  return { ...found, into, blocked: null }
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
 * from being merged by ASIST, the reported files it leaves behind, and why ASIST would refuse to merge it, if
 * it would.
 */
export function readWorktreeDiff(job: AgentJob, reported: readonly string[]): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  const base = mergeBase(worktree, commit)
  return {
    commit,
    base,
    stat: git.diffStat(worktree.repo, base, commit),
    patch: git.diffPatch(worktree.repo, base, commit),
    leftOut: leftOutOf(worktree, commit, reported),
    ...mergeVerdict(job, git.checkedOut(worktree.repo), base, commit)
  }
}
