import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import type { AgentEngine } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { availableEngines, cliStatus, forgetCliSearches, locateCli, onCliSearched, requireCli } from '../src/main/services/agent-process/cli-locator'

const mocks = vi.hoisted(() => ({
  os: 'windows' as OsFamily,
  exists: (_file: string): boolean => false,
  readShellPath: vi.fn<() => Promise<string>>(),
  home: '/Users/me'
}))
vi.mock('node:fs', () => {
  const missing = (file: string): void => {
    if (!mocks.exists(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
  }
  return {
    default: {
      constants: { X_OK: 1 },
      existsSync: (file: string) => mocks.exists(file),
      accessSync: missing,
      statSync: (file: string) => {
        missing(file)
        return { isFile: () => true }
      }
    }
  }
})
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => mocks.home }))
vi.mock('../src/main/services/agent-process/shell-path', () => ({ readShellPath: mocks.readShellPath }))
vi.mock('../src/main/services/platform', () => ({ platformCapabilities: () => ({ os: mocks.os }) }))

const OVERRIDE: Record<AgentEngine, string> = { codex: 'CODEX_CLI_PATH', claude: 'CLAUDE_CLI_PATH' }
/** The file codex leaves once its Windows sandbox is set up, under the default CODEX_HOME. */
const MARKER = 'C:\\Users\\me\\.codex\\.sandbox\\setup_marker.json'

beforeEach(() => {
  mocks.readShellPath.mockReset()
  vi.stubEnv('CODEX_CLI_PATH', undefined)
  vi.stubEnv('CLAUDE_CLI_PATH', undefined)
  forgetCliSearches()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('finding the CLI on Windows', () => {
  beforeEach(() => {
    mocks.os = 'windows'
    mocks.home = 'C:\\Users\\me'
    vi.stubEnv('CODEX_HOME', undefined)
    vi.stubEnv('PATH', 'C:\\first;C:\\npm')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local')
  })

  it.each(['codex', 'claude'] as const)('takes the override first, then the install location, then an .exe on the Path (%s)', async (engine) => {
    const override = `D:\\tools\\${engine}.exe`
    vi.stubEnv(OVERRIDE[engine], override)
    mocks.exists = () => true
    expect(await locateCli(engine)).toEqual({ state: 'found', path: override, env: {} })

    forgetCliSearches()
    mocks.exists = (file) => file !== override
    const installed = await locateCli(engine)
    expect(installed.state).toBe('found')
    const installedPath = installed.state === 'found' ? installed.path : ''
    expect(path.win32.basename(installedPath)).toBe(`${engine}.exe`)
    expect([override, `C:\\first\\${engine}.exe`, `C:\\npm\\${engine}.exe`]).not.toContain(installedPath)

    forgetCliSearches()
    mocks.exists = (file) => file === `C:\\npm\\${engine}.exe` || file === MARKER
    expect(await locateCli(engine)).toEqual({ state: 'found', path: `C:\\npm\\${engine}.exe`, env: {} })
  })

  it('looks through the Path folders in order for the .exe alone, without a shell', async () => {
    vi.stubEnv('PATH', 'C:\\a;;C:\\b\\;C:\\c')
    const files = new Set(['C:\\a\\codex', 'C:\\a\\codex.cmd', 'C:\\b\\codex.exe', 'C:\\c\\codex.exe', MARKER])
    mocks.exists = (file) => files.has(file)
    expect(await locateCli('codex')).toEqual({ state: 'found', path: 'C:\\b\\codex.exe', env: {} })
    expect(mocks.readShellPath).not.toHaveBeenCalled()
  })

  it('finds the .exe in a Path folder written in quotes', async () => {
    vi.stubEnv('PATH', 'relative;"C:\\Program Files\\a;b";C:\\c')
    const files = new Set(['C:\\Program Files\\a;b\\codex.exe', 'C:\\c\\codex.exe', 'relative\\codex.exe', MARKER])
    mocks.exists = (file) => files.has(file)
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: 'C:\\Program Files\\a;b\\codex.exe' })
  })

  it.each(['.cmd', '.bat'])('refuses a CLI that npm left only as a %s script, and says to use the official installer', async (extension) => {
    mocks.exists = (file) => file === `C:\\npm\\claude${extension}`
    expect(await locateCli('claude')).toEqual({ state: 'script-only' })
    await expect(requireCli('claude')).rejects.toThrow(errorText('jobs.start.cliScriptOnly', { engine: 'claude' }))
  })

  it('refuses an override that names a .cmd script', async () => {
    vi.stubEnv('CODEX_CLI_PATH', 'D:\\tools\\codex.cmd')
    mocks.exists = (file) => file === 'D:\\tools\\codex.cmd'
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliScriptOnly', { engine: 'codex' }))
  })

  it('reports a CLI that is nowhere as missing, not as a script', async () => {
    mocks.exists = () => false
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliMissing', { engine: 'codex' }))
  })

  it('refuses codex until its Windows sandbox is set up, and finds it once codex has left its marker', async () => {
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe'
    expect(await locateCli('codex')).toEqual({ state: 'sandbox-not-set-up' })
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliSandboxNotSetUp', { engine: 'codex' }))

    forgetCliSearches()
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect((await requireCli('codex')).path).toBe('C:\\npm\\codex.exe')
  })

  it('looks for the marker in CODEX_HOME when it is set, where codex keeps it then', async () => {
    vi.stubEnv('CODEX_HOME', 'D:\\codex-home')
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect(await locateCli('codex')).toEqual({ state: 'sandbox-not-set-up' })

    forgetCliSearches()
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === 'D:\\codex-home\\.sandbox\\setup_marker.json'
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: 'C:\\npm\\codex.exe' })
  })

  it('asks no sandbox setup of claude, which confines a job on its own', async () => {
    mocks.exists = (file) => file === 'C:\\npm\\claude.exe'
    expect(await locateCli('claude')).toMatchObject({ state: 'found', path: 'C:\\npm\\claude.exe' })
  })

  it('keeps a result, not found included, until the kept results are dropped for a fresh search', async () => {
    mocks.exists = () => false
    expect(await locateCli('codex')).toEqual({ state: 'missing' })
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect(await locateCli('codex')).toEqual({ state: 'missing' })
    forgetCliSearches()
    expect((await requireCli('codex')).path).toBe('C:\\npm\\codex.exe')
    mocks.exists = () => false
    expect((await requireCli('codex')).path).toBe('C:\\npm\\codex.exe')
    forgetCliSearches()
    expect(await locateCli('codex')).toEqual({ state: 'missing' })
  })
})

describe('finding the CLI on macOS', () => {
  /** What the user's shell answers, with the folders nvm and Volta add in its startup files. */
  const SHELL_PATH = '/Users/me/.nvm/versions/node/v22.19.0/bin:relative:/Users/me/.volta/bin:/usr/bin:/bin'

  beforeEach(() => {
    mocks.os = 'macos'
    mocks.home = '/Users/me'
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')
    mocks.readShellPath.mockResolvedValue(SHELL_PATH)
  })

  it('takes the override first, then an install location, then the folders of the shell\'s PATH in order', async () => {
    const override = '/opt/tools/codex'
    vi.stubEnv('CODEX_CLI_PATH', override)
    mocks.exists = () => true
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: override })

    forgetCliSearches()
    mocks.exists = (file) => file !== override
    const installed = await locateCli('codex')
    expect(installed.state === 'found' && installed.path).not.toBe(override)
    expect(installed.state === 'found' && path.posix.dirname(installed.path)).not.toBe('/Users/me/.nvm/versions/node/v22.19.0/bin')

    forgetCliSearches()
    const onPath = new Set(['relative/codex', '/Users/me/.volta/bin/codex', '/usr/bin/codex'])
    mocks.exists = (file) => onPath.has(file)
    expect(await locateCli('codex')).toMatchObject({ state: 'found', path: '/Users/me/.volta/bin/codex' })
  })

  it('runs the CLI it found, wherever it found it, with the PATH the shell answered', async () => {
    mocks.exists = (file) => file === '/opt/homebrew/bin/codex'
    expect(await requireCli('codex')).toEqual({ path: '/opt/homebrew/bin/codex', env: { PATH: SHELL_PATH } })
  })

  it('reports the CLI missing when no folder of the shell\'s PATH holds it', async () => {
    mocks.exists = () => false
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliMissing', { engine: 'codex' }))
  })

  it('reports a shell that did not answer, even for a CLI in an install location, which would run on the thin PATH', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.readShellPath.mockRejectedValue(new Error(errorText('jobs.start.shellPathUnread', { shell: '/bin/zsh' })))
    mocks.exists = (file) => file === '/opt/homebrew/bin/codex'
    expect(await locateCli('codex')).toEqual({ state: 'shell-unreadable' })
    await expect(requireCli('codex')).rejects.toThrow(errorText('jobs.start.cliShellUnreadable', { engine: 'codex' }))
  })

  it('reports the CLI as being checked, without waiting for the shell, and tells when the search has ended', async () => {
    let answer!: (path: string) => void
    mocks.readShellPath.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    mocks.exists = (file) => file === '/Users/me/.volta/bin/codex'
    const searched = vi.fn()
    const stopListening = onCliSearched(searched)
    try {
      expect(cliStatus('codex')).toBe('checking')
      expect(cliStatus('codex')).toBe('checking')
      expect(mocks.readShellPath).toHaveBeenCalledOnce()
      answer(SHELL_PATH)
      await vi.waitFor(() => expect(searched).toHaveBeenCalledOnce())
      expect(cliStatus('codex')).toBe('found')
    } finally {
      stopListening()
    }
  })

  it('asks the shell once for every engine, and again once the kept results are dropped', async () => {
    mocks.exists = (file) => file === '/Users/me/.volta/bin/claude'
    expect(await availableEngines()).toEqual(['claude'])
    expect(await locateCli('codex')).toEqual({ state: 'missing' })
    expect(mocks.readShellPath).toHaveBeenCalledOnce()

    forgetCliSearches()
    mocks.readShellPath.mockResolvedValue('/Users/me/.bun/bin:/usr/bin:/bin')
    mocks.exists = (file) => file === '/Users/me/.bun/bin/codex'
    expect(await requireCli('codex')).toEqual({ path: '/Users/me/.bun/bin/codex', env: { PATH: '/Users/me/.bun/bin:/usr/bin:/bin' } })
    expect(mocks.readShellPath).toHaveBeenCalledTimes(2)
  })
})
