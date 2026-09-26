import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentEngine, AgentJob, AgentProcessIdentity } from '@shared/ipc'
import { createClaudeStreamParser, createCodexStreamParser, type AgentStreamEvent, type AgentStreamParser } from '@shared/agent-stream'
import { t } from '../i18n'
import { requireCli } from './cli-locator'
import { AGENT_PROCESS_TOKEN, captureProcessIdentity, manageAgentProcess, type AgentProcess } from './posix'
import { childEnv } from '../child-env'

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

export function launchAgentProcess(job: AgentJob, args: string[], handlers: ProcessHandlers): AgentProcess {
  const cli = requireCli(job.engine)
  const spec = ENGINES[job.engine]
  const parse = spec.createParser()
  const token = randomUUID()
  // The CLI must not start writing before the job is persisted, so it waits in a shell of its own process
  // group for permission to start. If the parent exits first, the EOF on stdin ends it before the exec.
  // The prompt follows the permission on the same stdin: the shell's read takes only the first line from a
  // pipe, and the CLI reads the rest (see agent-cli).
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready && [ "$ready" = start ] && exec "$@"', 'asist-agent-launcher', cli, ...args], {
    cwd: job.cwd,
    env: childEnv({ ...spec.env, [AGENT_PROCESS_TOKEN]: token }),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

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
  // stdout can still hold data when exit fires, so the last output is handled before the exit is reported.
  const lifetime = manageAgentProcess(child, handlers.onExit)
  if (child.pid !== undefined) {
    try {
      handlers.onSpawn(captureProcessIdentity(child.pid, token))
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
