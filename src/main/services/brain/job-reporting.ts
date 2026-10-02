import { isBackgroundJob, isJobTerminal } from '@shared/job-status'
import type { AgentJob, TurnPlaybackAckStatus } from '@shared/ipc'
import { errMessage } from '@shared/api-errors'
import { PlaybackDeliveryTracker, type PlaybackDeliveryOutcome } from '@shared/playback-delivery'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import type { TurnHandle } from '@shared/turn-scheduler'
import { sliceCodePoints } from '@shared/text-slice'
import { conversationLocale } from '../conversation-locale'
import * as agentRunner from '../agent'
import { beginTurn } from './index'
import { conversationOwner, currentSpeechRoute, history, record, turnScheduler } from './session'
import type { NoticeKind } from './conversation-log'
import type { SpeechRoute } from './speech-route'

/**
 * Automatic reporting of finished jobs. The end of an agent job is handed to a turn as a system
 * notice, and the LLM reports it in the flow of the conversation. A report never takes a turn away
 * from the user: it starts only while idle. It counts as delivered once it reached the user, and is
 * queued again when it did not.
 */

const JOB_REPORT_PLAYBACK_TIMEOUT_MS = 3 * 60_000
const MAX_JOB_REPORT_ATTEMPTS = 5
/** How often a report held at the hard limit looks again whether the history has room, which only reads a number in memory. */
const HISTORY_ROOM_POLL_MS = 5_000
/** How often a report held by a conversation log that cannot be read tries the read again, which reads the files of several days. */
const HISTORY_LOAD_RETRY_MS = 30_000

/** What the model is told about a job that ended. It reads it and reports it in its own words. */
const REPORT: Readonly<
  Record<
    | 'done' | 'error' | 'artifacts' | 'mergePending' | 'submodules' | 'movedTo' | 'keptFor' | 'mergeUnchanged' | 'merged' | 'discarded'
    | 'noSummary' | 'noReason',
    PromptText
  >
> = {
  done: {
    ja: `{notice} ジョブ「{title}」(jobId: {jobId})が完了した。結果の要約: {summary}{artifactNote}{mergeNote}`,
    en: `{notice} The job "{title}" (jobId: {jobId}) is done. A summary of the result: {summary}{artifactNote}{mergeNote}`
  },
  error: {
    ja: `{notice} ジョブ「{title}」(jobId: {jobId})がエラーで停止した。理由: {summary}{mergeNote}`,
    en: `{notice} The job "{title}" (jobId: {jobId}) stopped with an error. The reason: {summary}{mergeNote}`
  },
  artifacts: { ja: ` 成果物: {artifacts}`, en: ` What it produced: {artifacts}` },
  mergePending: {
    ja: ` 変更はworktreeにあり取り込み待ち。差分は画面のジョブパネルで見られる。取り込むか捨てるかを聞くこと(「取り込んで」でmerge_agent_job、「捨てて」でdiscard_agent_job)。`,
    en: ` The changes are in a worktree, waiting to be taken in. The diff is on the job panel on screen. Ask whether to take them in or throw them away: merge_agent_job takes them in, discard_agent_job throws them away.`
  },
  submodules: {
    ja: ` このジョブはサブモジュールか.gitmodules({paths})に触れたので、ASISTでは取り込めない。変更はworktreeのブランチ{branch}にある。サブモジュールの中で作ったコミットはworktree({dir})の中の複製にしかないことがあり、その場合はユーザーのチェックアウトでgit submodule updateをしても取ってこられない。ユーザー自身が必要ならそこからpushしてブランチを取り込むか、捨てる(discard_agent_job)かを伝えること。捨てるとその複製も消える。`,
    en: ` This job touched submodules or .gitmodules ({paths}), so ASIST cannot merge it. The changes are on the branch {branch} of its worktree. Commits made inside a submodule may exist only in the copy in the worktree ({dir}), and if so git submodule update in the user's checkout cannot fetch them. Tell the user they can push them from there if needed and merge the branch themselves, or throw the job away with discard_agent_job, which deletes that copy too.`
  },
  movedTo: {
    ja: ` エージェントがworktree({dir})をASISTのブランチから{branch}に切り替えて作業したので、ASISTでは取り込めない。作業は{branch}にある。ユーザー自身がそれを取り込むか、捨てる(discard_agent_job)かを伝えること。捨てるとworktreeと、そこにしかない変更も消える。`,
    en: ` The agent switched the worktree ({dir}) from ASIST's branch to {branch} and worked there, so ASIST cannot merge it. The work is on {branch}. Tell the user they can take it in themselves, or throw the job away with discard_agent_job, which deletes the worktree and any change that exists only there.`
  },
  keptFor: {
    ja: ` このジョブはgitが無視する場所にファイル({paths})を書いただけで、取り込める変更は無い。それらはworktree({dir})にあり、捨てると一緒に消える。必要なら開いて別の場所へ移すようユーザーに伝え、そのあとで捨てる(discard_agent_job)かを聞くこと。`,
    en: ` This job only wrote files where git ignores them ({paths}), so there is nothing to merge. They are in the worktree ({dir}) and go with it when it is thrown away. Tell the user to open them and move them elsewhere if they need them, and then ask whether to throw the job away with discard_agent_job.`
  },
  mergeUnchanged: { ja: ` 変更は無かったのでworktreeは片付けた。`, en: ` Nothing changed, so the worktree has been cleared away.` },
  merged: { ja: ` 変更はすでに取り込んだ。`, en: ` The changes have already been taken in.` },
  discarded: { ja: ` 変更は取り込まずに捨てた。`, en: ` The changes were thrown away without being taken in.` },
  noSummary: { ja: `要約なし`, en: `no summary` },
  noReason: { ja: `不明`, en: `unknown` }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const reportedJobs = new Set<string>()
const reportingJobs = new Set<string>()
const playbackDeliveries = new PlaybackDeliveryTracker()
let reportQueue: Promise<void> = Promise.resolve()

/** Receives from the renderer whether the interjected audio actually started or was discarded before it did. */
export function acknowledgePlayback(turnId: number, status: TurnPlaybackAckStatus): void {
  playbackDeliveries.acknowledge(turnId, status)
}

/** Waits for the running turn and its speech to finish, for at most two minutes. */
async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (turnScheduler.activeTurnId === null) return
    await sleep(500)
  }
}

/**
 * Waits until a turn can answer a report, which uses up none of the report's attempts. At the hard
 * limit a turn only says that the history is being summarized, and that would pass for the report, so
 * the report waits for a summary that succeeds. It starts none itself: the turns and the idle
 * compaction do, and a report that did would call a summary that keeps failing, as while offline, back
 * to back. An engine that owns the conversation takes the report without the history, so the wait ends
 * when one starts.
 */
async function waitForRoomInHistory(): Promise<void> {
  // A report can come before any turn has read the history, which looks empty until then. A log that
  // cannot be read holds the report the same way, rather than drop it, until a read succeeds.
  for (let logged = false; ; ) {
    try {
      history.ensureLoaded()
      break
    } catch (error) {
      if (!logged) console.error('job report waits for the conversation log:', errMessage(error))
      logged = true
      await sleep(HISTORY_LOAD_RETRY_MS)
    }
  }
  while (!conversationOwner() && history.needsCompaction() === 'block') await sleep(HISTORY_ROOM_POLL_MS)
}

/**
 * Whether the report of a turn reached the user. Only the TTS route plays segments in the renderer,
 * so only there does delivery wait for the renderer to say that the body started playing. Without
 * speech there is no segment to wait for: the report reaches the user as text on screen, so a turn that
 * ran to its end without an abort has delivered it.
 */
async function reportDelivery(handle: TurnHandle, route: SpeechRoute): Promise<PlaybackDeliveryOutcome> {
  if (route.kind === 'silent') {
    try {
      await handle.completion
    } catch (error) {
      console.error('job report turn failed:', errMessage(error))
      return 'interrupted'
    }
    return handle.signal.aborted ? 'interrupted' : 'started'
  }
  // The run of beginTurn starts on a microtask, so the tracking is always registered before started or
  // segment reaches the renderer. An abort on the main side counts as not played and is queued again.
  const delivery = playbackDeliveries.expect(handle.turnId)
  const interrupted = (): void => {
    playbackDeliveries.acknowledge(handle.turnId, 'interrupted')
  }
  handle.signal.addEventListener('abort', interrupted, { once: true })
  if (handle.signal.aborted) interrupted()
  try {
    await handle.completion
  } catch (error) {
    interrupted()
    console.error('job report turn failed:', errMessage(error))
  } finally {
    handle.signal.removeEventListener('abort', interrupted)
  }
  // The renderer answers when the turn is done, or when the report it queued starts playing, so the
  // wait for it starts here. Started with the turn, it could run out while the turn is still going to
  // speak, and the report would be said again.
  playbackDeliveries.expire(handle.turnId, JOB_REPORT_PLAYBACK_TIMEOUT_MS)
  return delivery
}

/** What the report says about where the changes of a job stand, and which of merging and discarding it offers. */
function mergeNote(job: AgentJob): string {
  const locale = conversationLocale()
  const worktree = job.worktree
  if (job.mergeState === 'pending' && worktree) {
    if (worktree.movedTo) return fillPrompt(promptText(locale, REPORT.movedTo), { branch: worktree.movedTo, dir: worktree.dir })
    if (worktree.keptFor) return fillPrompt(promptText(locale, REPORT.keptFor), { paths: worktree.keptFor.join(', '), dir: worktree.dir })
    if (worktree.submodules) {
      return fillPrompt(promptText(locale, REPORT.submodules), { paths: worktree.submodules.join(', '), branch: worktree.branch, dir: worktree.dir })
    }
  }
  if (job.mergeState === 'pending') return promptText(locale, REPORT.mergePending)
  if (job.mergeState === 'merged') return promptText(locale, REPORT.merged)
  if (job.mergeState === 'discarded') return promptText(locale, REPORT.discarded)
  return worktree && job.mergeState === 'unchanged' ? promptText(locale, REPORT.mergeUnchanged) : ''
}

/** The notice a turn is given for a finished job, written from the job as it is and in the language the conversation is held in now. */
export function reportNotice(job: AgentJob): { notice: NoticeKind; text: string } {
  const locale = conversationLocale()
  const artifacts = (job.artifacts ?? []).slice(-5)
  const artifactNote = artifacts.length > 0 ? fillPrompt(promptText(locale, REPORT.artifacts), { artifacts: artifacts.join(', ') }) : ''
  const values = { notice: marker(locale, 'systemNotice'), title: job.title, jobId: job.id, artifactNote, mergeNote: mergeNote(job) }
  return job.status === 'done'
    ? {
        notice: 'job-done',
        text: fillPrompt(promptText(locale, REPORT.done), {
          ...values,
          summary: sliceCodePoints(job.summary ?? promptText(locale, REPORT.noSummary), 0, 500)
        })
      }
    : {
        notice: 'job-error',
        text: fillPrompt(promptText(locale, REPORT.error), {
          ...values,
          summary: sliceCodePoints(job.summary ?? promptText(locale, REPORT.noReason), 0, 200)
        })
      }
}

/**
 * Reports a finished job once a turn can take it, and queues it again while it did not reach the
 * user. User input can arrive between the wait and the start, and must not be taken over, so the loop
 * keeps waiting until an idle-only start succeeds.
 */
async function deliverReport(jobId: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_JOB_REPORT_ATTEMPTS; attempt++) {
    await waitForIdle()
    await waitForRoomInHistory()
    // The report is written only now, after waits that can be long: the job may have been merged or
    // discarded meanwhile, and an engine may have taken the conversation over.
    const job = agentRunner.get(jobId)
    if (!job) {
      console.warn(`job report dropped, the job is gone: ${jobId}`)
      reportedJobs.add(jobId)
      return
    }
    const notice = reportNotice(job)
    // An engine that owns the conversation, such as Gemini Live, is handed the notice and reports it in
    // context. The notice is written to the conversation log here, while the wording of the report is
    // recorded on that side from the output transcript.
    const owner = conversationOwner()
    if (owner) {
      record({ kind: 'notice', turnId: turnScheduler.allocateTurnId(), notice: notice.notice, text: notice.text })
      await owner.notify(notice.text)
      reportedJobs.add(jobId)
      return
    }
    const route = currentSpeechRoute()
    const handle = beginTurn(notice, {}, 'interject', true, { route })
    if (!handle) {
      attempt--
      continue
    }
    const outcome = await reportDelivery(handle, route)
    if (outcome === 'started') {
      reportedJobs.add(jobId)
      return
    }
    console.warn(`job report was not played (${outcome}); retrying ${attempt}/${MAX_JOB_REPORT_ATTEMPTS}`)
  }
  console.error(`job report could not be delivered after retries: ${jobId}`)
}

export function initJobReporting(): void {
  agentRunner.events.on('event', (event) => {
    if (event.type !== 'update') return
    const job = event.job
    if (
      !isJobTerminal(job.status) ||
      reportedJobs.has(job.id) ||
      reportingJobs.has(job.id)
    ) return
    if (isBackgroundJob(job)) {
      reportedJobs.add(job.id)
      return
    }
    // A cancellation the user made in the UI needs no spoken report, because it already happened on screen.
    if (job.status === 'cancelled') {
      reportedJobs.add(job.id)
      return
    }
    reportingJobs.add(job.id)
    // The notice is not read out verbatim: the LLM reports it in the flow of the conversation, and waits if speech is in progress.
    reportQueue = reportQueue
      .catch((error) => console.error('previous job report failed:', errMessage(error)))
      .then(() => deliverReport(job.id))
      .catch((error) => console.error('job report failed:', errMessage(error)))
      .finally(() => {
        reportingJobs.delete(job.id)
      })
  })
}
