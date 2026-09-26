import type { ChildProcess } from 'node:child_process'
import type { AgentProcessIdentity } from '@shared/ipc'

/** An agent ASIST owns until the CLI and every process it started are gone. */
export interface AgentProcess {
  completion: Promise<void>
  stop(): void
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
  start(cli: string, args: string[], options: StartOptions, onClose: (code: number | null) => void): StartedAgent
  recover(identity: AgentProcessIdentity, onStopped: () => void): AgentProcess
}
