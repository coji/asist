import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import fs from 'node:fs'
import type { AgentEngine, AgentJob, AgentProcessIdentity } from '@shared/ipc'
import { createClaudeStreamParser, createCodexStreamParser, type AgentStreamEvent, type AgentStreamParser } from '@shared/agent-stream'
import { errorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'
import { t } from './i18n'
import { AGENT_PROCESS_TOKEN, captureProcessIdentity } from './agent-process-identity'
import { manageAgentProcess, type AgentProcess } from './agent-process-lifetime'
import { childEnv } from './child-env'

/** Finding, launching and parsing the output of the CLI. Approving a job and updating its state is agent.ts. */

interface EngineSpec {
  /** Where to look for the CLI binary, in order. An environment variable overrides the list. */
  candidates: (home: string) => Array<string | undefined>
  /** The command name to look up with `whence -p`. */
  which: string
  env?: NodeJS.ProcessEnv
  /**
   * Turns one JSONL line into common events. A parser is made per process, because claude ties tool_use
   * and tool_result together by id.
   */
  createParser: () => AgentStreamParser
}

const ENGINES: Record<AgentEngine, EngineSpec> = {
  codex: {
    which: 'codex',
    candidates: (home) => [
      process.env.CODEX_CLI_PATH,
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      `${home}/.local/bin/codex`
    ],
    createParser: createCodexStreamParser
  },
  claude: {
    which: 'claude',
    candidates: (home) => [
      process.env.CLAUDE_CLI_PATH,
      `${home}/.claude/local/claude`,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      `${home}/.local/bin/claude`
    ],
    env: { CLAUDE_CODE_ENTRYPOINT: 'asist' },
    createParser: createClaudeStreamParser
  }
}

const currentEngine = (): AgentEngine => getSettings().agentEngine

const cliPathCache = new Map<AgentEngine, string | null>()

/** Resolves the CLI's real path. A GUI app inherits a thin PATH, so the absolute path is kept. */
export function findCli(engine: AgentEngine = currentEngine()): string | null {
  const cached = cliPathCache.get(engine)
  if (cached !== undefined) return cached
  const spec = ENGINES[engine]
  let resolved =
    spec
      .candidates(homedir())
      .filter((p): p is string => typeof p === 'string')
      .find((p) => fs.existsSync(p)) ?? null
  if (!resolved) {
    try {
      const out = execFileSync('/bin/zsh', ['-lc', `whence -p ${spec.which}`], {
        encoding: 'utf8',
        env: childEnv(),
        windowsHide: true
      }).trim()
      if (out && fs.existsSync(out)) resolved = out
    } catch {
      resolved = null
    }
  }
  cliPathCache.set(engine, resolved)
  return resolved
}

export const available = (engine: AgentEngine = currentEngine()): boolean => findCli(engine) !== null

/** The engines that are installed, as the settings screen lists them. */
export function availableEngines(): AgentEngine[] {
  return (Object.keys(ENGINES) as AgentEngine[]).filter((e) => findCli(e) !== null)
}

interface ProcessHandlers {
  onSpawn: (identity: AgentProcessIdentity) => void
  onEvent: (event: AgentStreamEvent) => void
  onStderr: (text: string) => void
  onError: (error: Error) => void
  onExit: (code: number | null) => void
}

export function launchAgentProcess(job: AgentJob, args: string[], handlers: ProcessHandlers): AgentProcess {
  const cli = findCli(job.engine)
  if (!cli) throw new Error(errorText('jobs.start.cliMissing', { engine: job.engine }))
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
