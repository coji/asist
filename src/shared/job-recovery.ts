import { errorText } from './i18n/error-text'
import type { PromptLanguage, PromptText } from './conversation-locale'
import type { AgentJob } from './ipc'
import { isJobExecuting } from './job-status'

/** What this file says to the model, in both prompt languages. */
const TEXTS: Record<'confirmingStop' | 'neverStarted', PromptText> = {
  confirmingStop: {
    ja: 'アプリ再起動後、Agentの停止を確認しています',
    en: 'The app restarted; waiting for the Agent to confirm it stopped'
  },
  neverStarted: {
    ja: 'Agent開始前にアプリが終了しました',
    en: 'The app quit before the Agent started'
  }
}

/**
 * A saved job that still carries a process identity goes back to waiting for its stop to be
 * confirmed. Only a job that never got permission to start can be settled as interrupted right here.
 * Either was cut off by an end of the app that did not stop it, which the job keeps as `interrupted`.
 *
 * The summaries below are read by the LLM as well as stored, and the job carries nothing else that
 * the LLM reads to learn that a restart interrupted it, so they are written in the language of the
 * conversation.
 */
export function recoverAgentJob(
  saved: AgentJob,
  now: number,
  language: PromptLanguage
): AgentJob {
  if (saved.engine !== 'codex' && saved.engine !== 'claude') {
    throw new Error(errorText('jobs.history.unknownEngine', { engine: String(saved.engine) }))
  }
  const job = { ...saved }
  if (job.processIdentity) {
    job.status = 'stopping'
    job.interrupted = true
    delete job.endedAt
    delete job.mergeState
    if (job.worktree) job.worktree = { ...job.worktree, commit: undefined }
    job.summary = TEXTS.confirmingStop[language]
  } else if (isJobExecuting(job.status)) {
    job.status = job.status === 'stopping' ? 'cancelled' : 'error'
    job.interrupted = true
    job.endedAt ??= now
    job.summary ??= TEXTS.neverStarted[language]
  }
  return job
}
