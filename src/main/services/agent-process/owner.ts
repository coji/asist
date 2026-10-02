import type { ChildProcess } from 'node:child_process'
import type { AgentProcessIdentity } from '@shared/ipc'

/** A stop that has not seen the agent gone by then is reported as failed. */
export const STOP_DEADLINE_MS = 5_000

/** An agent ASIST owns until the CLI and every process it started are gone. */
export interface AgentProcess {
  /**
   * Settles once the agent is gone and its end has been reported. It rejects when that can no longer be
   * confirmed, such as when the process table cannot be read; a recovered agent's also rejects when its stop
   * does not see it gone by the deadline.
   */
  completion: Promise<void>
  /**
   * Stops the agent and settles once it is gone. It rejects when this stop has not seen the agent gone by its
   * deadline, and the agent stays owned: asking again sends the stop again. Asking while a stop is under way
   * joins it.
   */
  stop(): Promise<void>
}

/** What an owner reports about an agent it started. */
export interface AgentEvents {
  /** The agent is gone, with the CLI's exit code. */
  onClose: (code: number | null) => void
  /** A stop, asked for or begun by the owner for processes the CLI left behind, did not see the agent gone by its deadline. */
  onStopFailed: (error: Error) => void
}

/** An agent CLI started so that it runs only once the line "start" has been written to its standard input. */
export interface StartedAgent {
  child: ChildProcess
  /** What a later run of ASIST needs to find the agent and stop it, read once the process has started. */
  identity(): AgentProcessIdentity
  lifetime: AgentProcess
}

export interface StartOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** A random id of this one launch, which names the agent's process group or job. */
  token: string
}

/** How ASIST starts an agent on one OS, owns it, and after a restart stops one a previous run left behind. */
export interface AgentOwner {
  start(cli: string, args: string[], options: StartOptions, events: AgentEvents): StartedAgent
  recover(identity: AgentProcessIdentity, onStopped: () => void): AgentProcess
}
