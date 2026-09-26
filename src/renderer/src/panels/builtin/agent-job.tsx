import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MessageKey, Translate } from '@shared/i18n'
import { baseName, dirName } from '@shared/file-path'
import type { AgentJob, JobDiff, JobStatus } from '@shared/ipc'
import { isJobTerminal } from '@shared/job-status'
import { currentStep, foldJobLog } from '@shared/job-log-view'
import { useT } from '@/i18n'
import { askConfirm } from '@/state/confirm'
import { useJobStore, usePanelStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { openFiles } from '../open-files'
import { JOB_STATUS_KEY } from '@/ui/job-presentation'
import { JobLogRowView, JobLogRows, shortPath } from '@/ui/JobLog'
import { JobStopButton } from '@/ui/JobStopButton'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Chip } from '../primitives/Card'
import { clockTime } from '../primitives/format'
import './agent-job.css'
import { displayError } from '@/display-error'

/**
 * Agent job card. jobPhase picks one box, and only that box is on screen at a time, so that there is a single
 * place to look while a job runs.
 */

export type JobPhase = 'merge' | 'running' | 'done' | 'failed'

export function jobPhase(job: AgentJob): JobPhase {
  if (job.mergeState === 'pending' || job.mergeState === 'error' || job.mergeState === 'conflict') return 'merge'
  if (!isJobTerminal(job.status)) return 'running'
  return job.status === 'done' ? 'done' : 'failed'
}

const EMPTY_LOG: never[] = []
const LOG_LINES: Record<CardContext['size'], number> = { l: 14, m: 10, s: 6, focus: 60 }
const FAILED_LOG_LINES: Record<CardContext['size'], number> = { l: 6, m: 4, s: 3, focus: 30 }
const ARTIFACT_LIMIT: Record<CardContext['size'], number> = { l: 6, m: 4, s: 3, focus: 50 }
const STATUS_TONE: Record<JobStatus, 'peach' | 'dim' | 'mint' | 'red'> = {
  running: 'peach',
  stopping: 'dim',
  done: 'mint',
  error: 'red',
  cancelled: 'dim'
}
const MERGE_STATE_KEY = {
  unchanged: 'jobs.merge.unchanged',
  error: 'jobs.merge.error',
  pending: 'jobs.merge.pending',
  merged: 'jobs.merge.merged',
  discarded: 'jobs.merge.discarded',
  conflict: 'jobs.merge.conflict'
} as const satisfies Record<NonNullable<AgentJob['mergeState']>, MessageKey>

/** Renders an elapsed time as "48秒", "3分12秒" or "1時間02分". */
export const elapsedLabel = (t: Translate, ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return t('jobs.elapsed.hours', { hours: h, minutes: String(m).padStart(2, '0') })
  if (m) return t('jobs.elapsed.minutes', { minutes: m, seconds: String(s).padStart(2, '0') })
  return t('jobs.elapsed.seconds', { seconds: s })
}

const cleanError = (err: unknown): string =>
  displayError(err)

/**
 * Merging the changes a job kept isolated in a worktree, once its diff has been reviewed. A job whose
 * merge conflicted can only be discarded or continued, and main gives no diff to merge for it.
 */
function MergeControls({ job }: { job: AgentJob }): React.JSX.Element {
  const t = useT()
  const [diff, setDiff] = useState<JobDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const conflict = job.mergeState === 'conflict'
  const loadDiff = (): void => {
    setDiff(null)
    void window.api
      .jobDiff(job.id)
      .then(setDiff)
      .catch((err: unknown) => setError(cleanError(err)))
  }
  useEffect(() => {
    setError(null)
    if (conflict) {
      setDiff(null)
      return
    }
    loadDiff()
  }, [job.id, conflict, job.mergeState, job.worktree?.commit])
  const worktree = job.worktree!
  const act = (run: () => Promise<void>, onFailure?: () => void): void => {
    setBusy(true)
    setError(null)
    void run()
      .catch((err: unknown) => {
        setError(cleanError(err))
        onFailure?.()
      })
      .finally(() => setBusy(false))
  }
  // Commits made inside a submodule of the worktree may have no other copy and the diff does not show them,
  // so a discard asks first when main finds possible work in a submodule. Every other change is in the diff.
  const discard = (): void =>
    act(async () => {
      const { submodules } = await window.api.jobDiscardPreview(job.id)
      const approved =
        submodules.length === 0 ||
        (await askConfirm({
          message: t('jobs.confirm.discardMessage'),
          detail: t('jobs.discard.submoduleWork', { paths: submodules.join(', ') }),
          confirmLabel: t('jobs.card.merge.discard'),
          destructive: true
        }))
      if (approved) await window.api.jobDiscard(job.id)
    })
  return (
    <Box
      title={t(conflict ? 'jobs.merge.conflict' : 'jobs.card.merge.title')}
      note={t('jobs.card.merge.note')}
      className="aj-merge"
    >
      <p className="aj-text">{t(conflict ? 'jobs.card.merge.conflictText' : 'jobs.card.merge.text')}</p>
      <p className="aj-path">
        {diff?.into
          ? t('jobs.card.merge.path', { branch: worktree.branch, into: diff.into, repo: worktree.repo })
          : `${worktree.branch} → ${worktree.repo}`}
      </p>
      {diff && diff.into === null && <p className="aj-text">{t('jobs.merging.detached')}</p>}
      {diff && diff.submodules.length > 0 && (
        <p className="aj-text">
          {t('jobs.merging.submodules', { paths: diff.submodules.join(', '), branch: worktree.branch, dir: worktree.dir })}
        </p>
      )}
      {diff && (
        <pre className="aj-diff">
          {diff.stat || t('jobs.card.merge.noDiff')}
          {diff.patch ? `\n\n${diff.patch}` : ''}
        </pre>
      )}
      {error && (
        <p className="card-missing" role="alert">
          {error}
        </p>
      )}
      <Actions>
        {!conflict && (
          <Action
            tone="primary"
            disabled={busy || !diff?.stat || diff.submodules.length > 0}
            // The diff on the card is out of date once another branch is checked out or the merge base has
            // moved, and main refuses the merge then, so the card shows the current one beside the reason.
            onClick={() => diff && act(() => window.api.jobMerge(job.id, { commit: diff.commit, base: diff.base, into: diff.into }), loadDiff)}
          >
            {t('jobs.card.merge.merge')}
          </Action>
        )}
        <Action tone="danger" disabled={busy} onClick={discard}>
          {t('jobs.card.merge.discard')}
        </Action>
      </Actions>
    </Box>
  )
}

/** The artifact list. Pressing an entry opens a files card holding every artifact, with the pressed one selected. */
function Artifacts({ job, size }: { job: AgentJob; size: CardContext['size'] }): React.JSX.Element | null {
  const t = useT()
  const setFocused = usePanelStore((s) => s.setFocused)
  const paths = job.artifacts ?? []
  if (paths.length === 0) return null
  const shown = paths.slice(0, ARTIFACT_LIMIT[size])
  return (
    <Box title={t('jobs.card.artifacts.title')} note={t('jobs.card.artifacts.note', { count: paths.length })}>
      <ul className="card-rows">
        {shown.map((path, i) => (
          <li key={path} className="card-row aj-artifact">
            <button type="button" className="card-row-link" onClick={() => openFiles(paths, job.title, i)} title={path}>
              <span className="card-row-title">{baseName(path)}</span>
              <span className="card-row-meta">{shortPath(dirName(path))}</span>
            </button>
          </li>
        ))}
      </ul>
      {paths.length > shown.length && (
        <button
          type="button"
          className="card-more"
          onClick={() => setFocused(`job:${job.id}`)}
          aria-label={t('jobs.card.artifacts.moreLabel')}
        >
          {t('common.more', { count: paths.length - shown.length })}
          <ChevronRight size={12} aria-hidden />
        </button>
      )}
    </Box>
  )
}

function StartedAt({ spec }: CardContext): React.JSX.Element | null {
  const t = useT()
  const jobId = String(spec.props.jobId ?? '')
  const job = useJobStore((s) => s.jobs.find((j) => j.id === jobId))
  return job ? <span className="aj-started">{t('jobs.card.startedAt', { time: clockTime(job.startedAt) })}</span> : null
}

function AgentJobBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const jobId = String(spec.props.jobId ?? '')
  const job = useJobStore((s) => s.jobs.find((j) => j.id === jobId))
  // A `?? []` inside the selector would build a new array on every call and re-render forever, so the
  // reference has to stay stable.
  const log = useJobStore((s) => s.logs[jobId]) ?? EMPTY_LOG
  const loadLog = useJobStore((s) => s.loadLog)
  const openApp = useViewStore((s) => s.openApp)
  const logRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now)
  const live = job !== undefined && !isJobTerminal(job.status)

  // The lines the store received as events are not the whole log, so the log is read from main whenever
  // a card for the job appears.
  useEffect(() => {
    void loadLog(jobId)
  }, [jobId, loadLog])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log.length])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  if (!job) {
    return (
      <div className="card aj" data-size={size}>
        <p className="card-missing" role="status">
          {t('jobs.card.waiting')}
        </p>
      </div>
    )
  }

  const phase = jobPhase(job)
  const rows = foldJobLog(log)
  const elapsed = elapsedLabel(t, (job.endedAt ?? now) - job.startedAt)
  const running = job.status === 'running' || (job.status === 'stopping' && Boolean(job.processIdentity))
  const cost = [
    job.numTurns ? t('jobs.card.turns', { count: job.numTurns }) : '',
    job.costUsd ? `$${job.costUsd.toFixed(3)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const step = phase === 'running' ? currentStep(rows) : null
  const shownRows = rows.slice(-(phase === 'failed' ? FAILED_LOG_LINES[size] : LOG_LINES[size]))

  return (
    <div className="card aj" data-size={size} data-status={job.status} data-phase={phase}>
      <div className="card-hero">
        <h3>{job.title}</h3>
        <p>
          <b>{job.engine}</b> ·{' '}
          {live
            ? t('jobs.card.elapsed', { elapsed })
            : t('jobs.card.ended', { elapsed, status: t(JOB_STATUS_KEY[job.status]) })}
        </p>
        <div className="aj-chips">
          <Chip tone={STATUS_TONE[job.status]}>
            {live && <i className="aj-dot" aria-hidden />}
            {t(JOB_STATUS_KEY[job.status])}
          </Chip>
          {job.mergeState && <Chip tone={job.mergeState === 'pending' ? 'mint' : 'dim'}>{t(MERGE_STATE_KEY[job.mergeState])}</Chip>}
          {job.readonly && <Chip tone="dim">{t('jobs.card.readOnly')}</Chip>}
        </div>
      </div>

      {phase === 'merge' && <MergeControls job={job} />}

      {phase === 'running' && (
        <>
          {step && (
            <div className="aj-step" role="status" aria-label={t('jobs.card.step')}>
              <JobLogRowView row={step} />
            </div>
          )}
          <Box
            title={t('jobs.card.log.title')}
            note={rows.length ? t('jobs.card.log.note', { count: shownRows.length }) : undefined}
          >
            <div ref={logRef} className="aj-log">
              <JobLogRows rows={shownRows} />
              {rows.length === 0 && <span className="aj-waiting">{t('jobs.card.log.waiting')}</span>}
            </div>
          </Box>
        </>
      )}

      {phase === 'done' && (
        <>
          <Box title={t('jobs.card.result.title')}>
            <p className="aj-summary">{job.summary || t('jobs.card.result.none')}</p>
          </Box>
          {size !== 's' && <Artifacts job={job} size={size} />}
        </>
      )}

      {phase === 'failed' && (
        <>
          <Box title={t(job.status === 'error' ? 'jobs.status.error' : 'jobs.status.cancelled')} className="aj-failed">
            <p className="aj-summary">
              {job.summary || t(job.status === 'error' ? 'jobs.card.failed.noReason' : 'jobs.card.failed.cancelled')}
            </p>
          </Box>
          {size !== 's' && rows.length > 0 && (
            <Box title={t('jobs.card.log.tailTitle')} note={t('jobs.card.log.note', { count: shownRows.length })}>
              <div className="aj-log">
                <JobLogRows rows={shownRows} />
              </div>
            </Box>
          )}
        </>
      )}

      <Actions>
        <Action leadsTo="screen" onClick={() => openApp({ app: 'jobs', jobId: job.id })}>
          {t(phase === 'done' || phase === 'failed' ? 'jobs.card.openLog' : 'jobs.card.openJobs')}
        </Action>
        {running ? <JobStopButton job={job} className="card-action aj-stop" /> : cost && <span className="aj-cost">{cost}</span>}
      </Actions>
    </div>
  )
}

export const agentJobCard: CardDefinition = {
  Body: AgentJobBody,
  kicker: 'AGENT',
  className: 'aj-card',
  meta: (context) => <StartedAt {...context} />
}
