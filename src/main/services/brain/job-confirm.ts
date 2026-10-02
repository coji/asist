import { AGENT_MODE_NAME } from '@shared/agent-cli'
import type { AgentEngine, DiscardPreview, JobDiff } from '@shared/ipc'
import { requestConfirm, type ConfirmInput } from '../confirm'
import { t } from '../i18n'

/**
 * The confirmation the user answers before an agent job that the conversation model asked for starts,
 * carries on, is merged or has its changes thrown away. The model's context holds text from mail, the
 * web, notes and the calendar, so a request to run a job may come from someone other than the user; the
 * sheet therefore shows the instruction exactly as the agent receives it, where it runs and whether it
 * may write, and only a click on the sheet lets it through.
 */

export type JobPlace =
  | { kind: 'workspace'; root: string }
  | { kind: 'worktree'; repo: string }
  | { kind: 'directory'; path: string }

export interface JobPlan {
  kind: 'start' | 'continue'
  prompt: string
  title?: string
  engine: AgentEngine
  readonly: boolean
  place: JobPlace
  /** The job to carry on is still running and is stopped first. */
  stopsRunning?: boolean
}

function placeText(place: JobPlace): string {
  if (place.kind === 'workspace') return t('jobs.confirm.workspace', { path: place.root })
  if (place.kind === 'worktree') return t('jobs.confirm.worktree', { path: place.repo })
  return place.path
}

export function jobConfirmation(plan: JobPlan): ConfirmInput {
  const mode = AGENT_MODE_NAME[plan.engine][plan.readonly ? 'readonly' : 'auto']
  const detail = [
    ...(plan.title ? [t('jobs.confirm.job', { title: plan.title })] : []),
    t('jobs.confirm.engine', { engine: plan.engine, mode }),
    t('jobs.confirm.place', { place: placeText(plan.place) }),
    t(plan.readonly ? 'jobs.confirm.readOnly' : 'jobs.confirm.writes'),
    ...(plan.stopsRunning ? [t('jobs.confirm.stopsRunning')] : []),
    '',
    t('jobs.confirm.prompt'),
    plan.prompt,
    '',
    t('jobs.confirm.warning')
  ].join('\n')
  const start = plan.kind === 'start'
  return {
    title: t('jobs.confirm.title'),
    message: t(start ? 'jobs.confirm.startMessage' : 'jobs.confirm.continueMessage'),
    detail,
    confirmLabel: t(start ? 'jobs.confirm.start' : 'jobs.confirm.continue'),
    destructive: false
  }
}

/** The job's title, and the repository and the branch the merge goes into. */
type MergeTarget = { title: string; repo: string; into: string }

export function mergeConfirmation(job: MergeTarget, review: JobDiff): ConfirmInput {
  return {
    title: t('jobs.confirm.mergeTitle'),
    message: t('jobs.confirm.mergeMessage'),
    detail: [
      t('jobs.confirm.job', { title: job.title }),
      t('jobs.confirm.mergeInto', { into: job.into, repo: job.repo }),
      '',
      review.alreadyMerged ? t('jobs.merging.alreadyMerged', { into: job.into }) : review.stat,
      ...(review.leftOut.length > 0 ? ['', t('jobs.merging.leftOut', { paths: review.leftOut.join(', ') })] : [])
    ].join('\n'),
    confirmLabel: t('jobs.confirm.merge'),
    destructive: false
  }
}

export function discardConfirmation(title: string, target: DiscardPreview): ConfirmInput {
  return {
    title: t('jobs.confirm.discardTitle'),
    message: t('jobs.confirm.discardMessage'),
    detail: [
      t('jobs.confirm.job', { title }),
      t('jobs.confirm.place', { place: target.dir }),
      t('jobs.confirm.branch', { repo: target.repo, branch: target.branch }),
      ...(target.stat ? ['', target.stat] : []),
      ...(target.leftOut.length > 0 ? ['', t('jobs.merging.leftOut', { paths: target.leftOut.join(', ') })] : []),
      '',
      t('jobs.confirm.discardWarning'),
      ...(target.submodules.length > 0 ? [t('jobs.discard.submoduleWork', { paths: target.submodules.join(', ') })] : [])
    ].join('\n'),
    confirmLabel: t('jobs.confirm.discard'),
    destructive: true
  }
}

export const confirmJob = (plan: JobPlan, signal: AbortSignal): Promise<boolean> =>
  requestConfirm(jobConfirmation(plan), signal)

export const confirmMerge = (job: MergeTarget, review: JobDiff, signal: AbortSignal): Promise<boolean> =>
  requestConfirm(mergeConfirmation(job, review), signal)

export const confirmDiscard = (title: string, target: DiscardPreview, signal: AbortSignal): Promise<boolean> =>
  requestConfirm(discardConfirmation(title, target), signal)
