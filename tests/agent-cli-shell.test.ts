import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import type { AgentJob } from '@shared/ipc'
import { longTempFolder } from './helpers/temp'

/**
 * The user's shell, really started: an app opened from Finder or the Dock inherits launchd's PATH,
 * /usr/bin:/bin:/usr/sbin:/sbin, while nvm, bun and pnpm add their folders to PATH in ~/.zshrc, which zsh
 * reads only when it is interactive. HOME and ZDOTDIR point at a folder of the test, so the shell reads its
 * startup files from there and not the files of whoever runs the tests.
 */

vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ agentEngine: 'codex', uiLocale: 'ja-JP' }) }))

/** What launchd gives an app opened from Finder, the Dock or Spotlight. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let home: string

beforeEach(() => {
  vi.resetModules()
  home = longTempFolder('asist-shell-home-')
  vi.stubEnv('HOME', home)
  vi.stubEnv('ZDOTDIR', home)
  vi.stubEnv('SHELL', '/bin/zsh')
  vi.stubEnv('PATH', LAUNCHD_PATH)
  vi.stubEnv('CODEX_CLI_PATH', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

/** A folder that only the user's ~/.zshrc puts on PATH, as nvm's installer does. */
function folderOnZshrcPath(): string {
  const bin = path.join(home, '.nvm', 'versions', 'node', 'v22.19.0', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(home, '.zshrc'), `echo 'Welcome back'\nexport PATH="${bin}:$PATH"\n`)
  return bin
}

describe.runIf(process.platform === 'darwin')('the agent CLI on the PATH of the user\'s shell', () => {
  it('finds a CLI that the user\'s shell puts on PATH in its interactive startup file alone', async () => {
    const bin = folderOnZshrcPath()
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const { locateCli } = await import('../src/main/services/agent-process/cli-locator')
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: path.join(bin, 'codex') })
  })

  it.each(['/bin/tcsh', '/bin/csh'])('finds a CLI that %s puts on PATH, asking the shell in the form it accepts', async (shell) => {
    const bin = path.join(home, 'tools', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // tcsh reads ~/.cshrc when there is no ~/.tcshrc, and csh on macOS is tcsh.
    fs.writeFileSync(path.join(home, '.cshrc'), `setenv PATH "${bin}:$PATH"\n`)
    vi.stubEnv('SHELL', shell)
    const { locateCli } = await import('../src/main/services/agent-process/cli-locator')
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: path.join(bin, 'codex') })
  })

  it('runs a CLI installed by npm, whose node is on the user\'s PATH and not on the PATH the app was opened with', { timeout: 15_000 }, async () => {
    const bin = folderOnZshrcPath()
    // npm writes the CLI as a Node script that `env` runs with the first node on PATH; this node answers like `codex exec --json`.
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho \'{"type":"thread.started","thread_id":"thread-1"}\'\ncat >/dev/null\n', { mode: 0o755 })
    const cli = path.join(home, 'npm-global', 'codex')
    fs.mkdirSync(path.dirname(cli))
    fs.writeFileSync(cli, '#!/usr/bin/env node\n', { mode: 0o755 })
    vi.stubEnv('CODEX_CLI_PATH', cli)
    const { launchAgentProcess } = await import('../src/main/services/agent-process')
    const job: AgentJob = { id: 'job', title: 't', prompt: 'p', cwd: home, readonly: true, engine: 'codex', status: 'running', startedAt: 1 }
    const events: unknown[] = []
    const stderr: string[] = []
    const exit = new Promise<number | null>((resolve) => {
      launchAgentProcess(job, ['exec', '--json', '-'], {
        onSpawn: () => {},
        onEvent: (event) => events.push(event),
        onStderr: (text) => stderr.push(text),
        onError: (error) => stderr.push(error.message),
        onExit: resolve
      })
    })
    expect({ code: await exit, stderr }).toEqual({ code: 0, stderr: [] })
    expect(events).toEqual([{ kind: 'init', model: 'codex', sessionId: 'thread-1' }])
  })

  it('reports a shell that ends without giving its PATH, rather than offering a CLI that would run on the PATH the app was opened with', async () => {
    const cli = path.join(home, 'codex')
    fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    vi.stubEnv('CODEX_CLI_PATH', cli)
    vi.stubEnv('SHELL', '/usr/bin/false')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { locateCli, requireCli } = await import('../src/main/services/agent-process/cli-locator')
    expect(await locateCli('codex')).toEqual({ state: 'shell-unreadable' })
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliShellUnreadable', { engine: 'codex' }))
  })

  it('stops waiting for a shell that does not answer in time, and stops the shell and what it started', async () => {
    fs.writeFileSync(path.join(home, '.zshrc'), `print $$ > "${path.join(home, 'shell.pid')}"\nsleep 100\n`)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { locateCli } = await import('../src/main/services/agent-process/cli-locator')
      const { SHELL_ANSWER_TIMEOUT_MS } = await import('../src/main/services/agent-process/shell-path')
      const search = locateCli('codex')
      const pidFile = path.join(home, 'shell.pid')
      await vi.waitFor(() => expect(fs.readFileSync(pidFile, 'utf8')).toMatch(/^\d+\n$/), { timeout: 5_000 })
      const shell = Number(fs.readFileSync(pidFile, 'utf8'))
      vi.advanceTimersByTime(SHELL_ANSWER_TIMEOUT_MS)
      expect(await search).toEqual({ state: 'shell-unreadable' })
      await vi.waitFor(() => expect(() => process.kill(-shell, 0)).toThrow(), { timeout: 5_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})
