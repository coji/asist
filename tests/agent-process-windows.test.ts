import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJob, AgentProcessIdentity } from '@shared/ipc'
import { setCapabilities, WINDOWS } from './helpers/platform'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ agentEngine: 'codex', uiLocale: 'ja-JP' }) }))
// Node stands in for the CLI, so the launcher runs a real program with a real grandchild.
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: async () => ({ path: process.execPath, env: {} }) }))

const { launchAgentProcess, recoverAgentProcess } = await import('../src/main/services/agent-process')

const runs: Array<ReturnType<typeof launchAgentProcess>> = []

// A failed test would otherwise leave its CLI and grandchild running on the machine.
afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.stop()
    await run.completion.catch(() => {})
  }
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A CLI that starts a grandchild outside its own lifetime, writes the grandchild's pid, and keeps running or exits. */
const cli = (keepRunning: boolean): string[] => [
  '-e',
  `const { spawn } = require('node:child_process');
   const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
   grandchild.unref();
   process.stderr.write('grandchild ' + grandchild.pid + '\\n');
   ${keepRunning ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 200);'}`
]

function launch(keepRunning: boolean) {
  setCapabilities(WINDOWS)
  const job: AgentJob = { id: 'job', title: 't', prompt: 'the prompt', cwd: process.cwd(), readonly: true, engine: 'codex', status: 'running', startedAt: 1 }
  let identity: AgentProcessIdentity | undefined
  let reportGrandchild!: (pid: number) => void
  const grandchild = new Promise<number>((resolve) => (reportGrandchild = resolve))
  const exits: Array<number | null> = []
  const run = launchAgentProcess(job, cli(keepRunning), {
    onSpawn: (spawned) => (identity = spawned),
    onEvent: () => {},
    onStderr: (text) => {
      const match = /^grandchild (\d+)$/.exec(text)
      if (match) reportGrandchild(Number(match[1]))
    },
    onError: (error) => {
      throw error
    },
    onExit: (code) => exits.push(code)
  })
  runs.push(run)
  return { run, grandchild, exits, identity: () => identity }
}

describe.runIf(process.platform === 'win32')('an agent on Windows', { timeout: 20_000 }, () => {
  it('stops the CLI and a grandchild it started when the job is stopped, and settles only then', async () => {
    const started = launch(true)
    const grandchild = await started.grandchild
    expect(started.identity()?.token).toMatch(/^[0-9a-f-]{36}$/)
    started.run.stop()
    await started.run.completion
    expect(started.exits).toHaveLength(1)
    expect(alive(grandchild)).toBe(false)
  })

  it('settles a CLI that exits on its own only once the grandchild it left is gone', async () => {
    const started = launch(false)
    const grandchild = await started.grandchild
    await started.run.completion
    expect(started.exits).toEqual([0])
    expect(alive(grandchild)).toBe(false)
  })

  it('settles the job of an earlier run whose agent is gone', async () => {
    const stopped = vi.fn()
    const recovered = recoverAgentProcess({ pid: 1, startedAt: '', token: randomUUID() }, stopped)
    recovered.stop()
    await recovered.completion
    expect(stopped).toHaveBeenCalledOnce()
  })
})
