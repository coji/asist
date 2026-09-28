import { errMessage } from '@shared/api-errors'
import { isQuiet, type QuietConditions } from '@shared/quiet-trigger'
import { history, lastActivity, turnScheduler } from './brain/session'

/**
 * The trigger for the work that runs in the gaps of a conversation, which is compaction. The conditions
 * are checked every minute and the jobs that qualify run one at a time.
 */

export interface MaintenanceJob {
  name: string
  conditions: QuietConditions
  /** Whether there is actually work to do once the conditions hold, such as a threshold being exceeded. Omitting it means there always is. */
  due?: () => boolean
  run: () => Promise<void>
}

const POLL_MS = 60_000
const QUIET_MS = 5 * 60_000

/** Compacts in the background once the context has passed the compaction threshold and the conversation has been quiet for 5 minutes. */
export const compactionJob: MaintenanceJob = {
  name: 'compaction',
  conditions: { quietMs: QUIET_MS },
  // After a start no turn may have read the log yet, and an unread history looks empty.
  due: () => {
    history.ensureLoaded()
    return history.needsCompaction() !== 'none'
  },
  run: () => history.compact('quiet')
}

export function initMaintenance(jobs: MaintenanceJob[]): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (const job of jobs) {
        try {
          if (job.due && !job.due()) continue
          const quiet = isQuiet({ now: Date.now(), lastActivityAt: lastActivity(), turnActive: turnScheduler.activeTurnId !== null }, job.conditions)
          if (!quiet) continue
          await job.run()
        } catch (err) {
          console.error(`maintenance ${job.name} failed:`, errMessage(err))
        }
      }
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), POLL_MS)
  void tick()
  return () => clearInterval(timer)
}
