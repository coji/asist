import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import type { AgentEngine } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { forgetCliSearches, locateCli, requireCli } from '../src/main/services/agent-process/cli-locator'

const mocks = vi.hoisted(() => ({
  os: 'windows' as OsFamily,
  exists: (_file: string): boolean => false,
  execFileSync: vi.fn(),
  home: '/Users/me'
}))
vi.mock('node:fs', () => ({ default: { existsSync: (file: string) => mocks.exists(file) } }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => mocks.home }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))
vi.mock('../src/main/services/platform', () => ({ platformCapabilities: () => ({ os: mocks.os }) }))

const OVERRIDE: Record<AgentEngine, string> = { codex: 'CODEX_CLI_PATH', claude: 'CLAUDE_CLI_PATH' }
/** The file codex leaves once its Windows sandbox is set up, under the default CODEX_HOME. */
const MARKER = 'C:\\Users\\me\\.codex\\.sandbox\\setup_marker.json'

beforeEach(() => {
  mocks.execFileSync.mockReset()
  vi.stubEnv('CODEX_CLI_PATH', undefined)
  vi.stubEnv('CLAUDE_CLI_PATH', undefined)
  forgetCliSearches()
})
afterEach(() => {
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

  it.each(['codex', 'claude'] as const)('takes the override first, then the install location, then an .exe on the Path (%s)', (engine) => {
    const override = `D:\\tools\\${engine}.exe`
    vi.stubEnv(OVERRIDE[engine], override)
    mocks.exists = () => true
    expect(locateCli(engine)).toEqual({ state: 'found', path: override })

    forgetCliSearches()
    mocks.exists = (file) => file !== override
    const installed = locateCli(engine)
    expect(installed.state).toBe('found')
    const installedPath = installed.state === 'found' ? installed.path : ''
    expect(path.win32.basename(installedPath)).toBe(`${engine}.exe`)
    expect([override, `C:\\first\\${engine}.exe`, `C:\\npm\\${engine}.exe`]).not.toContain(installedPath)

    forgetCliSearches()
    mocks.exists = (file) => file === `C:\\npm\\${engine}.exe` || file === MARKER
    expect(locateCli(engine)).toEqual({ state: 'found', path: `C:\\npm\\${engine}.exe` })
  })

  it('looks through the Path folders in order for the .exe alone, without a shell', () => {
    vi.stubEnv('PATH', 'C:\\a;;C:\\b\\;C:\\c')
    const files = new Set(['C:\\a\\codex', 'C:\\a\\codex.cmd', 'C:\\b\\codex.exe', 'C:\\c\\codex.exe', MARKER])
    mocks.exists = (file) => files.has(file)
    expect(locateCli('codex')).toEqual({ state: 'found', path: 'C:\\b\\codex.exe' })
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it('finds the .exe in a Path folder written in quotes', () => {
    vi.stubEnv('PATH', 'relative;"C:\\Program Files\\a;b";C:\\c')
    const files = new Set(['C:\\Program Files\\a;b\\codex.exe', 'C:\\c\\codex.exe', 'relative\\codex.exe', MARKER])
    mocks.exists = (file) => files.has(file)
    expect(locateCli('codex')).toEqual({ state: 'found', path: 'C:\\Program Files\\a;b\\codex.exe' })
  })

  it.each(['.cmd', '.bat'])('refuses a CLI that npm left only as a %s script, and says to use the official installer', (extension) => {
    mocks.exists = (file) => file === `C:\\npm\\claude${extension}`
    expect(locateCli('claude')).toEqual({ state: 'script-only' })
    expect(() => requireCli('claude')).toThrow(errorText('jobs.start.cliScriptOnly', { engine: 'claude' }))
  })

  it('refuses an override that names a .cmd script', () => {
    vi.stubEnv('CODEX_CLI_PATH', 'D:\\tools\\codex.cmd')
    mocks.exists = (file) => file === 'D:\\tools\\codex.cmd'
    expect(() => requireCli('codex')).toThrow(errorText('jobs.start.cliScriptOnly', { engine: 'codex' }))
  })

  it('reports a CLI that is nowhere as missing, not as a script', () => {
    mocks.exists = () => false
    expect(() => requireCli('codex')).toThrow(errorText('jobs.start.cliMissing', { engine: 'codex' }))
  })

  it('refuses codex until its Windows sandbox is set up, and finds it once codex has left its marker', () => {
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe'
    expect(locateCli('codex')).toEqual({ state: 'sandbox-not-set-up' })
    expect(() => requireCli('codex')).toThrow(errorText('jobs.start.cliSandboxNotSetUp', { engine: 'codex' }))

    forgetCliSearches()
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect(requireCli('codex')).toBe('C:\\npm\\codex.exe')
  })

  it('looks for the marker in CODEX_HOME when it is set, where codex keeps it then', () => {
    vi.stubEnv('CODEX_HOME', 'D:\\codex-home')
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect(locateCli('codex')).toEqual({ state: 'sandbox-not-set-up' })

    forgetCliSearches()
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === 'D:\\codex-home\\.sandbox\\setup_marker.json'
    expect(locateCli('codex')).toEqual({ state: 'found', path: 'C:\\npm\\codex.exe' })
  })

  it('asks no sandbox setup of claude, which confines a job on its own', () => {
    mocks.exists = (file) => file === 'C:\\npm\\claude.exe'
    expect(locateCli('claude')).toEqual({ state: 'found', path: 'C:\\npm\\claude.exe' })
  })

  it('keeps a result, not found included, until the kept results are dropped for a fresh search', () => {
    mocks.exists = () => false
    expect(locateCli('codex')).toEqual({ state: 'missing' })
    mocks.exists = (file) => file === 'C:\\npm\\codex.exe' || file === MARKER
    expect(locateCli('codex')).toEqual({ state: 'missing' })
    forgetCliSearches()
    expect(requireCli('codex')).toBe('C:\\npm\\codex.exe')
    mocks.exists = () => false
    expect(requireCli('codex')).toBe('C:\\npm\\codex.exe')
    forgetCliSearches()
    expect(locateCli('codex')).toEqual({ state: 'missing' })
  })
})

describe('finding the CLI on macOS', () => {
  beforeEach(() => {
    mocks.os = 'macos'
    mocks.home = '/Users/me'
  })

  it('takes the override first, then an install location, and asks the login shell only when neither exists', () => {
    const override = '/opt/tools/codex'
    vi.stubEnv('CODEX_CLI_PATH', override)
    mocks.exists = () => true
    expect(locateCli('codex')).toEqual({ state: 'found', path: override })

    forgetCliSearches()
    mocks.exists = (file) => file !== override
    const installed = locateCli('codex')
    expect(installed.state).toBe('found')
    expect(installed.state === 'found' && installed.path).not.toBe(override)
    expect(mocks.execFileSync).not.toHaveBeenCalled()

    forgetCliSearches()
    mocks.exists = (file) => file === '/Users/me/.volta/bin/codex'
    mocks.execFileSync.mockReturnValue('/Users/me/.volta/bin/codex\n')
    expect(locateCli('codex')).toEqual({ state: 'found', path: '/Users/me/.volta/bin/codex' })
    expect(mocks.execFileSync).toHaveBeenCalledOnce()
  })

  it('reports the CLI missing when the login shell finds nothing or names a file that is not there', () => {
    mocks.exists = () => false
    mocks.execFileSync.mockImplementation(() => { throw new Error('codex not found') })
    expect(() => requireCli('codex')).toThrow(errorText('jobs.start.cliMissing', { engine: 'codex' }))

    forgetCliSearches()
    mocks.execFileSync.mockReturnValue('/gone/codex\n')
    expect(locateCli('codex')).toEqual({ state: 'missing' })
  })
})
