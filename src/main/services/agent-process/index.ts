import { randomUUID } from 'node:crypto'
import type { AgentEngine, AgentJob, AgentProcessIdentity } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { createClaudeStreamParser, createCodexStreamParser, type AgentStreamEvent, type AgentStreamParser } from '@shared/agent-stream'
import { t } from '../i18n'
import { requireCli } from './cli-locator'
import { platformCapabilities } from '../platform'
import { childEnv } from '../child-env'
import type { AgentOwner, AgentProcess } from './owner'
import { posixOwner } from './posix'
import { windowsOwner } from './windows'

/** Launching the CLI and parsing its output. Finding it is cli-locator.ts; approving a job and updating its state is agent.ts. */

interface EngineSpec {
  env?: NodeJS.ProcessEnv
  /**
   * Turns one JSONL line into common events. A parser is made per process, because claude ties tool_use
   * and tool_result together by id.
   */
  createParser: () => AgentStreamParser
}

const ENGINES: Record<AgentEngine, EngineSpec> = {
  codex: {
    createParser: createCodexStreamParser
  },
  claude: {
    env: { CLAUDE_CODE_ENTRYPOINT: 'asist' },
    createParser: createClaudeStreamParser
  }
}

interface ProcessHandlers {
  onSpawn: (identity: AgentProcessIdentity) => void
  onEvent: (event: AgentStreamEvent) => void
  onStderr: (text: string) => void
  onError: (error: Error) => void
  onExit: (code: number | null) => void
}

const OWNERS: Record<OsFamily, AgentOwner> = { macos: posixOwner, windows: windowsOwner }

const owner = (): AgentOwner => OWNERS[platformCapabilities().os]

/** Stops an agent a previous run of ASIST left behind, and only that one. */
export const recoverAgentProcess = (identity: AgentProcessIdentity, onStopped: () => void): AgentProcess =>
  owner().recover(identity, onStopped)

export function launchAgentProcess(job: AgentJob, args: string[], handlers: ProcessHandlers): AgentProcess {
  const cli = requireCli(job.engine)
  const spec = ENGINES[job.engine]
  const parse = spec.createParser()
  // The CLI must not start writing before the job is persisted, so it runs only once "start" is written
  // to its standard input, after onSpawn. The prompt follows on the same input.
  const { child, identity, lifetime } = owner().start(cli, args, { cwd: job.cwd, env: childEnv(spec.env), token: randomUUID() }, handlers.onExit)

  // A chunk split in the middle of a UTF-8 sequence is reassembled before the JSONL lines are split out.
  child.stdout!.setEncoding('utf8')
  let buffer = ''
  const handleLine = (line: string): void => {
    if (!line.trim()) return
    for (const event of parse(line.trim())) handlers.onEvent(event)
  }
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  })
  child.stdout!.on('end', () => {
    handleLine(buffer)
    buffer = ''
  })

  // stderr also carries warnings printed at startup, so it is shown truncated to 300 characters and the
  // exit code, not stderr, decides success.
  child.stderr!.setEncoding('utf8')
  let stderrBuffer = ''
  const pushStderrLine = (line: string): void => {
    const text = line.trim()
    if (!text) return
    handlers.onStderr(
      text.length > 300
        ? t('jobs.log.stderrTruncated', { text: text.slice(0, 300), count: text.length })
        : text
    )
  }
  child.stderr!.on('data', (chunk: string) => {
    stderrBuffer += chunk
    let nl: number
    while ((nl = stderrBuffer.indexOf('\n')) >= 0) {
      pushStderrLine(stderrBuffer.slice(0, nl))
      stderrBuffer = stderrBuffer.slice(nl + 1)
    }
  })
  child.stderr!.on('end', () => {
    pushStderrLine(stderrBuffer)
    stderrBuffer = ''
  })
  child.on('error', handlers.onError)
  child.stdin?.on('error', handlers.onError)
  if (child.pid !== undefined) {
    try {
      handlers.onSpawn(identity())
      child.stdin!.end(`start\n${job.prompt}`)
    } catch (error) {
      child.stdin!.end()
      handlers.onError(error instanceof Error ? error : new Error(String(error)))
      try { lifetime.stop() } catch (stopError) {
        handlers.onError(stopError instanceof Error ? stopError : new Error(String(stopError)))
      }
    }
  }
  return lifetime
}
