import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { AgentJob } from '@shared/ipc'
import { buildStartArgs } from '@shared/agent-cli'
import { AGENT_PROCESS_TOKEN, captureProcessIdentity, inspectProcessIdentity, recoverAgentProcess } from '../src/main/services/agent-process/posix'

const ja = createTranslator('ja-JP')
const writerRunning = errorText('jobs.worktree.writerRunning')

const mocks = vi.hoisted(() => ({ data: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.data, getPreferredSystemLanguages: () => ['ja-JP'] } }))
let root: string
let parent: ChildProcess | undefined
let group: number | undefined
let agent: typeof import('../src/main/services/agent') | undefined
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
/** How long a real process may take to start and write its files. With other test files running in parallel it took longer than vi.waitFor's default of one second (2026-09-23). */
const PROCESS_START = { timeout: 10_000 }

beforeEach(() => {
  vi.resetModules()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-crash-recovery-'))
  mocks.data = path.join(root, 'data')
  fs.mkdirSync(mocks.data)
  parent = undefined
  group = undefined
  agent = undefined
})
afterEach(async () => {
  if (parent?.pid && alive(parent.pid)) parent.kill('SIGKILL')
  if (group) { try { process.kill(-group, 'SIGKILL') } catch { /* fixture already exited */ } }
  if (group) await vi.waitFor(() => expect(alive(-group!)).toBe(false), { timeout: 2_000 })
  fs.writeFileSync(path.join(root, 'release'), '')
  if (agent) await agent.shutdown().catch(() => {})
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function prepareCrashFixture(descendant: boolean): { entry: string; repo: string; env: NodeJS.ProcessEnv } {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'Fixture')
  fs.writeFileSync(path.join(repo, 'original.txt'), 'original\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'initial')
  const writer = path.join(root, 'writer.cjs')
  fs.writeFileSync(writer, `
    const fs = require('node:fs');
    fs.writeFileSync('writer.pid', String(process.pid));
    process.on('SIGTERM', () => { fs.writeFileSync('stop-requested', 'yes'); });
    setInterval(() => {
      fs.writeFileSync('work.txt', String(Date.now()));
      if (fs.existsSync(process.env.ASIST_TEST_RELEASE)) {
        fs.writeFileSync('work.txt', 'finished after stop request'); process.exit(0);
      }
    }, 20);
  `)
  const cli = path.join(root, 'cli.cjs')
  fs.writeFileSync(cli, `#!/usr/bin/env node
    const fs = require('node:fs');
    fs.writeFileSync('leader.pid',String(process.pid));
    process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture-session'})+'\\n');
    ${descendant ? `require('node:child_process').spawn(process.execPath,[${JSON.stringify(writer)}],{stdio:'ignore'}); setInterval(()=>{if(fs.existsSync(process.env.ASIST_TEST_LEADER_EXIT))process.exit(0)},20);` : `require(${JSON.stringify(writer)});`}
  `, { mode: 0o755 })
  const entry = path.join(root, 'parent.cjs')
  // The real agent service runs in a separate Node process, with only Electron's storage path replaced by a temporary directory.
  const electron = path.join(root, 'electron.cjs')
  fs.writeFileSync(electron, `exports.app={isPackaged:false,getAppPath:()=>${JSON.stringify(process.cwd())},getPath:()=>process.env.ASIST_TEST_DATA,getPreferredSystemLanguages:()=>['ja-JP']};`)
  buildSync({
    stdin: { contents: `import * as agent from './src/main/services/agent'; console.log(JSON.stringify(agent.startIsolated('fixture writer',{cwd:process.env.ASIST_TEST_REPO!,worktreeRoot:process.env.ASIST_TEST_WORKTREES!,noteProject:false}))); setInterval(()=>{},1000);`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    alias: { electron }, tsconfig: path.join(process.cwd(), 'tsconfig.node.json'), logLevel: 'silent'
  })
  vi.stubEnv('CODEX_CLI_PATH', cli)
  return { entry, repo, env: {
    ...process.env, ASIST_TEST_DATA: mocks.data, ASIST_TEST_REPO: repo,
    ASIST_TEST_WORKTREES: path.join(root, 'worktrees'), ASIST_TEST_RELEASE: path.join(root, 'release'),
    ASIST_TEST_LEADER_EXIT: path.join(root, 'leader-exit')
  } }
}

async function crashParent(descendant: boolean): Promise<{ job: AgentJob; repo: string; writer: number }> {
  const fixture = prepareCrashFixture(descendant)
  parent = spawn(process.execPath, [fixture.entry], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  parent.stdout!.on('data', (data) => { output += String(data) })
  parent.stderr!.on('data', (data) => { error += String(data) })
  await vi.waitFor(() => { expect(error).toBe(''); expect(output).toContain('\n') }, PROCESS_START)
  const job = JSON.parse(output.split('\n')[0]) as AgentJob
  await vi.waitFor(() => expect(fs.existsSync(path.join(job.cwd, 'writer.pid'))).toBe(true), PROCESS_START)
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(mocks.data, 'jobs.json'), 'utf8')).jobs[0].sessionId).toBe('fixture-session'), PROCESS_START)
  group = Number(fs.readFileSync(path.join(job.cwd, 'leader.pid'), 'utf8'))
  const writer = Number(fs.readFileSync(path.join(job.cwd, 'writer.pid'), 'utf8'))
  const exited = new Promise((resolve) => parent!.once('close', resolve))
  parent.kill('SIGKILL')
  await exited
  expect(alive(writer)).toBe(true)
  if (descendant) {
    fs.writeFileSync(path.join(root, 'leader-exit'), '')
    await vi.waitFor(() => expect(alive(group!)).toBe(false), PROCESS_START)
    expect(alive(writer)).toBe(true)
  }
  return { job, repo: fixture.repo, writer }
}

// The agent starts through /bin/sh in a process group of its own and is found again with /bin/ps, all POSIX only;
// on Windows the agent launcher's Job Object is to take their place, with tests of its own.
describe.runIf(process.platform !== 'win32')('Agent crash recovery with real processes', { timeout: 30_000 }, () => {
  it.each([false, true])('does not finalize the worktree after a crash until the surviving writer stops (descendant only=%s)', async (descendant) => {
    const { job, repo, writer } = await crashParent(descendant)
    agent = await import('../src/main/services/agent')
    expect(agent.get(job.id)).toMatchObject({ status: 'stopping', processIdentity: job.processIdentity })
    expect(fs.existsSync(job.cwd)).toBe(true)
    expect(() => agent!.diff(job.id)).toThrow(writerRunning)
    expect(() => agent!.merge(job.id, { commit: 'unreviewed', base: 'unreviewed', into: 'main' })).toThrow(writerRunning)
    expect(() => agent!.discard(job.id)).toThrow(writerRunning)
    await expect(agent.continueJob(job.id, 'continue')).rejects.toThrow(writerRunning)
    await vi.waitFor(() => expect(fs.existsSync(path.join(job.cwd, 'stop-requested'))).toBe(true), PROCESS_START)
    expect(alive(writer)).toBe(true)
    expect(agent.get(job.id)?.mergeState).toBeUndefined()
    expect(git(repo, 'show', 'HEAD:original.txt')).toBe('original')
    fs.writeFileSync(path.join(root, 'release'), '')
    await vi.waitFor(() => expect(agent!.get(job.id)).toMatchObject({ status: 'error', mergeState: 'pending', processIdentity: undefined }), { timeout: 3_000 })
    const diff = agent.diff(job.id)
    expect(diff.patch).toContain('finished after stop request')
    expect(git(job.cwd, 'status', '--porcelain')).toBe('')
  })

  it('shows the reason while the recovered identity does not match, and re-checks safely when cancelled after the process is gone', async () => {
    const { job, writer } = await crashParent(false)
    const historyFile = path.join(mocks.data, 'jobs.json')
    const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { version: number; jobs: AgentJob[] }
    saved.jobs[0].processIdentity!.token = crypto.randomUUID()
    fs.writeFileSync(historyFile, JSON.stringify(saved))
    agent = await import('../src/main/services/agent')
    agent.list()
    await vi.waitFor(() => expect(agent!.get(job.id)?.summary).toContain(ja('jobs.process.tokenMismatch')), PROCESS_START)
    expect(agent.get(job.id)?.status).toBe('stopping')
    expect(fs.existsSync(path.join(job.cwd, 'stop-requested'))).toBe(false)
    expect(alive(writer)).toBe(true)
    expect(() => agent!.discard(job.id)).toThrow(writerRunning)
    fs.writeFileSync(path.join(root, 'release'), '')
    await vi.waitFor(() => expect(alive(writer)).toBe(false), PROCESS_START)
    agent.cancel(job.id)
    await vi.waitFor(() => expect(agent!.get(job.id)).toMatchObject({ status: 'error', mergeState: 'pending' }), PROCESS_START)
    expect(agent.diff(job.id).patch).toContain('finished after stop request')
  })

  it.each([false, true])('runs the CLI only after the identity is persisted, and exits before starting when persisting fails (save fails=%s)', async (failSave) => {
    vi.stubEnv('CODEX_CLI_PATH', process.execPath)
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const saved = path.join(root, 'identity-saved')
    const touched = path.join(root, 'cli-output')
    const errors: Error[] = []
    let completionNotified = false
    const managed = launchAgentProcess({
      id: 'handshake', title: 'fixture', prompt: 'fixture', cwd: root,
      engine: 'codex', readonly: false, status: 'running', startedAt: Date.now()
    }, ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(touched)},fs.existsSync(${JSON.stringify(saved)})?'saved':'too early')`], {
      onSpawn: (identity) => {
        group = identity.pid
        expect(fs.existsSync(touched)).toBe(false)
        if (failSave) throw new Error('identity persistence failed')
        fs.writeFileSync(saved, 'saved')
      },
      onEvent: () => {}, onStderr: () => {}, onError: (error) => errors.push(error),
      onExit: () => { completionNotified = true }
    })
    await managed.completion
    expect(completionNotified).toBe(true)
    if (failSave) {
      expect(errors.map((error) => error.message)).toContain('identity persistence failed')
      expect(fs.existsSync(touched)).toBe(false)
    } else {
      expect(errors).toEqual([])
      expect(fs.readFileSync(touched, 'utf8')).toBe('saved')
    }
  })

  it.each(['codex', 'claude'] as const)('hands %s a prompt larger than the argument limit of macOS once it may start', async (engine) => {
    // A memory curation prompt with a week of transcripts: 1.2 MB, more than the 1 MB macOS allows all the
    // arguments of a process, which failed the spawn with E2BIG.
    const prompt = `${'あ'.repeat(400_000)}\n-- the last line`
    const cli = path.join(root, 'cli.sh')
    fs.writeFileSync(cli, '#!/bin/sh\necho "read $(wc -c | tr -d \' \') bytes"\n', { mode: 0o755 })
    vi.stubEnv(engine === 'codex' ? 'CODEX_CLI_PATH' : 'CLAUDE_CLI_PATH', cli)
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const job: AgentJob = { id: 'large', title: 'fixture', prompt, cwd: root, engine, readonly: false, status: 'running', startedAt: Date.now() }
    const received: string[] = []
    const errors: Error[] = []
    const managed = launchAgentProcess(job, buildStartArgs({ ...job, os: 'macos' }), {
      onSpawn: (identity) => { group = identity.pid },
      onEvent: (event) => { if (event.kind === 'raw') received.push(event.text) },
      onStderr: () => {}, onError: (error) => errors.push(error), onExit: () => {}
    })
    await managed.completion
    expect(errors).toEqual([])
    expect(received).toEqual([`read ${Buffer.byteLength(prompt)} bytes`])
  })

  it('rejects completion and releases the waiter when the exit callback of a normal exit fails', async () => {
    vi.stubEnv('CODEX_CLI_PATH', process.execPath)
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const managed = launchAgentProcess({
      id: 'save-error', title: 'fixture', prompt: 'fixture', cwd: root,
      engine: 'codex', readonly: true, status: 'running', startedAt: Date.now()
    }, ['-e', 'process.exit(0)'], {
      onSpawn: (identity) => { group = identity.pid }, onEvent: () => {}, onStderr: () => {}, onError: () => {},
      onExit: () => { throw new Error('terminal persistence failed') }
    })
    await expect(managed.completion).rejects.toThrow('terminal persistence failed')
  })

  it('rejects completion when saving the history at the end of recovery fails, rather than waiting silently', async () => {
    const stopped = vi.fn(() => { throw new Error('history persistence failed') })
    const recovery = recoverAgentProcess({ pid: 2_147_483_647, startedAt: 'not running', token: crypto.randomUUID() }, stopped)
    recovery.stop()
    await expect(recovery.completion).rejects.toThrow('history persistence failed')
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('never reports a foreign process while an owned process is exiting', async () => {
    // The process exits only when the test signals it, so that a slow start under load never overlaps
    // the exit. From the signal on, the loop stays synchronous so that every pass between the exit and
    // the zombie state is inspected; Node reaps the child only after the loop returns.
    for (let round = 0; round < 5; round += 1) {
      const token = crypto.randomUUID()
      parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true, stdio: 'ignore', env: { ...process.env, [AGENT_PROCESS_TOKEN]: token }
      })
      group = parent.pid!
      await vi.waitFor(() => expect(captureProcessIdentity(group!, token).pid).toBe(group), PROCESS_START)
      const identity = captureProcessIdentity(group, token)
      let state = inspectProcessIdentity(identity)
      expect(state).toBe('owned')
      process.kill(group, 'SIGTERM')
      const deadline = Date.now() + 5_000
      while (state !== 'gone' && Date.now() < deadline) state = inspectProcessIdentity(identity)
      expect(state).toBe('gone')
    }
  })

  it('sends no signal and does not treat the job as finished when the token differs for the same PID', async () => {
    const token = crypto.randomUUID()
    parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true, stdio: 'ignore', env: { ...process.env, [AGENT_PROCESS_TOKEN]: token }
    })
    group = parent.pid!
    const identity = captureProcessIdentity(group, token)
    const stopped = vi.fn()
    const recovery = recoverAgentProcess({ ...identity, token: crypto.randomUUID() }, stopped)
    recovery.stop()
    await expect(recovery.completion).rejects.toThrow(errorText('jobs.process.tokenMismatch'))
    expect(stopped).not.toHaveBeenCalled()
    expect(alive(group)).toBe(true)
  })

  it('treats the job as ended and sends no signal when its group PID now leads another process started at another time', async () => {
    // Another program of the same user, which carries no token of the app.
    parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env } })
    group = parent.pid!
    const identity = captureProcessIdentity(group, crypto.randomUUID())
    const stopped = vi.fn()
    const recovery = recoverAgentProcess({ ...identity, startedAt: 'Thu Jan  1 09:00:00 2026' }, stopped)
    recovery.stop()
    await recovery.completion
    expect(stopped).toHaveBeenCalledOnce()
    expect(alive(group)).toBe(true)
  })

  it('keeps an agent as its own after the Mac changed time zone, which changes the start time ps prints', async () => {
    const token = crypto.randomUUID()
    vi.stubEnv('TZ', 'Asia/Tokyo')
    parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true, stdio: 'ignore', env: { ...process.env, [AGENT_PROCESS_TOKEN]: token }
    })
    group = parent.pid!
    await vi.waitFor(() => expect(captureProcessIdentity(group!, token).pid).toBe(group), PROCESS_START)
    const identity = captureProcessIdentity(group, token)
    expect(inspectProcessIdentity(identity)).toBe('owned')
    vi.stubEnv('TZ', 'America/New_York')
    expect(captureProcessIdentity(group, token).startedAt).not.toBe(identity.startedAt)
    expect(inspectProcessIdentity(identity)).toBe('owned')
  })

  it('settles a restored job whose group PID was reused and releases its worktree, leaving the other process alone', async () => {
    const { job, writer } = await crashParent(false)
    const historyFile = path.join(mocks.data, 'jobs.json')
    const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { version: number; jobs: AgentJob[] }
    // A process that is not the agent: another start time and none of its token.
    saved.jobs[0].processIdentity = { ...saved.jobs[0].processIdentity!, startedAt: 'Thu Jan  1 09:00:00 2026', token: crypto.randomUUID() }
    fs.writeFileSync(historyFile, JSON.stringify(saved))
    agent = await import('../src/main/services/agent')
    agent.list()
    await vi.waitFor(() => expect(agent!.get(job.id)).toMatchObject({ status: 'error', mergeState: 'pending', processIdentity: undefined }), PROCESS_START)
    // The fixture's writer is the process that now holds the PID, and it keeps writing, so the diff finds
    // new changes; the worktree is no longer held for a running writer.
    expect(() => agent!.diff(job.id)).not.toThrow(writerRunning)
    expect(fs.existsSync(path.join(job.cwd, 'stop-requested'))).toBe(false)
    expect(alive(writer)).toBe(true)
  })
})
