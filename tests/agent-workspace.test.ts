import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { longTempFolder } from './helpers/temp'

const mocks = vi.hoisted(() => ({ launch: vi.fn(), agentCwd: '' }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch, recoverAgentProcess: vi.fn() }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/codex' }))
vi.mock('../src/main/services/store', () => ({ readJsonl: () => [], appendJsonl: vi.fn() }))
vi.mock('../src/main/services/job-history', () => ({
  readJobHistory: () => [], writeJobHistory: () => [], jobLogFile: (id: string) => `joblogs/${id}.events.jsonl`
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'auto', agentCwd: mocks.agentCwd, uiLocale: 'ja-JP' })
}))
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/git', () => ({ toplevel: () => null }))

afterEach(() => {
  fs.rmSync(mocks.agentCwd, { recursive: true, force: true })
})

describe('the workspace of a job that names no folder', () => {
  it('lists what the agent wrote there as the job\'s files when it finishes, a file written from a shell included', async () => {
    mocks.agentCwd = longTempFolder('asist-workspace-')
    mocks.launch.mockReturnValue({ stop: vi.fn(), completion: Promise.resolve() })
    const agent = await import('../src/main/services/agent')
    const job = agent.start('表を作る', { noteProject: false })
    expect(path.dirname(job.cwd)).toBe(agent.workspaceRoot())
    const written = path.join(job.cwd, 'table.csv')
    fs.writeFileSync(written, 'a,b\n')
    const handlers = mocks.launch.mock.calls[0][2]
    handlers.onEvent({ kind: 'result', ok: true, summary: '作りました' })
    handlers.onExit(0)
    expect(agent.get(job.id)?.artifacts).toEqual([written])
  })
})
