import { randomUUID } from 'node:crypto'
import type { AgentEngine, AgentJob, AgentProcessIdentity } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { createClaudeStreamParser, createCodexStreamParser, type AgentStreamEvent, type AgentStreamParser } from '@shared/agent-stream'
import { errorText } from '@shared/i18n/error-text'
import { t } from '../i18n'
import { requireCli, type FoundCli } from './cli-locator'
import { platformCapabilities } from '../platform'
import { childEnv } from '../child-env'
import { curationScriptEnv, prepareCurationScripts } from '../memory-curation-skill'
import { STOP_DEADLINE_MS, type AgentOwner, type AgentProcess } from './owner'
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
  onStopFailed: (error: Error) => void
}

const OWNERS: Record<OsFamily, AgentOwner> = { macos: posixOwner, windows: windowsOwner }

const owner = (): AgentOwner => OWNERS[platformCapabilities().os]

/** Stops an agent a previous run of ASIST left behind, and only that one. */
export const recoverAgentProcess = (identity: AgentProcessIdentity, onStopped: () => void): AgentProcess =>
  owner().recover(identity, onStopped)

/**
 * Starts the job's CLI once it is located and returns at once, since on macOS the search waits for the
 * user's shell; a memory curation's CLI also waits for the Python of its skill's scripts. A CLI that cannot be
 * located or started is reported through onError and onExit, like one that failed, and a stop asked before it
 * started keeps it from starting.
 */
export function launchAgentProcess(job: AgentJob, args: string[], handlers: ProcessHandlers): AgentProcess {
  let stopped = false
  let running: AgentProcess | undefined
  const notStarted = (error: unknown): void => {
    handlers.onError(error instanceof Error ? error : new Error(String(error)))
    handlers.onExit(null)
  }
  const preparation = new AbortController()
  const ready = Promise.all([requireCli(job.engine), job.memoryCuration ? prepareCurationScripts(preparation.signal) : undefined])
  const completion = ready.then(
    ([cli]) => {
      if (stopped) return handlers.onExit(null)
      try {
        running = startCli(job, cli, args, handlers)
      } catch (error) {
        return notStarted(error)
      }
      return running.completion
    },
    (error: unknown) => {
      // A CLI that cannot be located leaves the Python's download with nothing to wait for.
      preparation.abort()
      // A stop ends the preparation by aborting it, which is the end the stop asked for, not a start that failed.
      return stopped ? handlers.onExit(null) : notStarted(error)
    }
  )
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  // A stop asked before the CLI started ends with the search, which can wait for the user's shell, and fails
  // by the same deadline as a stop of a running CLI.
  let stopping: Promise<void> | undefined
  const stopBeforeStart = (): Promise<void> => {
    stopping ??= new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        stopping = undefined
        const error = new Error(errorText('jobs.process.stopTimedOut'))
        handlers.onStopFailed(error)
        reject(error)
      }, STOP_DEADLINE_MS)
      completion.then(resolve, reject).finally(() => clearTimeout(deadline))
    })
    void stopping.catch(() => {})
    return stopping
  }
  return {
    completion,
    stop: () => {
      stopped = true
      preparation.abort()
      return running ? running.stop() : stopBeforeStart()
    }
  }
}

function startCli(job: AgentJob, cli: FoundCli, args: string[], handlers: ProcessHandlers): AgentProcess {
  const spec = ENGINES[job.engine]
  const parse = spec.createParser()
  // The CLI must not start writing before the job is persisted, so it runs only once "start" is written
  // to its standard input, after onSpawn. The prompt follows on the same input.
  const base = childEnv({ ...cli.env, ...spec.env })
  const env = job.memoryCuration ? curationScriptEnv(base) : base
  const { child, identity, lifetime } = owner().start(cli.path, args, { cwd: job.cwd, env, token: randomUUID() }, {
    onClose: handlers.onExit,
    onStopFailed: handlers.onStopFailed
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
  if (child.pid !== undefined) {
    try {
      handlers.onSpawn(identity())
      child.stdin!.end(`start\n${job.prompt}`)
    } catch (error) {
      child.stdin!.end()
      handlers.onError(error instanceof Error ? error : new Error(String(error)))
      // A stop that fails is reported through onStopFailed, and an error that leaves the end unconfirmed through the completion.
      void lifetime.stop()
    }
  }
  return lifetime
}
