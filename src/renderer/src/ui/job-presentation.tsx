import type { MessageKey } from '@shared/i18n'
import type { JobStatus } from '@shared/ipc'

/** The one place that words and colors a job's status and log, shared by the cards and by JobsView. */

export const JOB_STATUS_KEY = {
  running: 'jobs.status.running',
  stopping: 'jobs.status.stopping',
  done: 'jobs.status.done',
  error: 'jobs.status.error',
  cancelled: 'jobs.status.cancelled'
} as const satisfies Record<JobStatus, MessageKey>

/** For the text color in the job list. */
export const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  running: 'text-holo-peach',
  stopping: 'text-holo-dim',
  done: 'text-holo-mint',
  error: 'text-holo-red',
  cancelled: 'text-holo-dim'
}
