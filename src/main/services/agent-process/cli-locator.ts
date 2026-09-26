import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentCliState, AgentEngine } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { AGENT_CLI_UNAVAILABLE_TEXT } from '@shared/agent-cli'
import { errorText } from '@shared/i18n/error-text'
import { platformCapabilities } from '../platform'
import { childEnv } from '../child-env'

/**
 * Finding the CLI of an agent engine. A GUI app inherits a thin PATH, so the CLI's absolute path is
 * what gets launched. A CLI can be installed or removed while the app runs, so a result, "not found"
 * included, is kept only until the settings screen looks again.
 */

/** Where an engine's CLI is, or why there is none to launch. */
export type CliSearch = { state: 'found'; path: string } | { state: Exclude<AgentCliState, 'found'> }

/** A path in this variable is tried before any other place. */
const OVERRIDE_VARIABLE: Record<AgentEngine, string> = {
  codex: 'CODEX_CLI_PATH',
  claude: 'CLAUDE_CLI_PATH'
}

/** The places each OS's installers put the CLI, tried in order after the override. */
const INSTALL_LOCATIONS: Record<OsFamily, Record<AgentEngine, () => Array<string | undefined>>> = {
  macos: {
    codex: () => ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', `${homedir()}/.local/bin/codex`],
    claude: () => [`${homedir()}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${homedir()}/.local/bin/claude`]
  },
  windows: {
    codex: () => {
      const local = process.env.LOCALAPPDATA
      return [local && path.win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')]
    },
    claude: () => [path.win32.join(homedir(), '.local', 'bin', 'claude.exe')]
  }
}

/**
 * Whether codex's own Windows sandbox, which every codex job there runs in, is set up. The setup creates
 * local users, so it needs administrator rights, and codex's interactive CLI offers it when it starts.
 * Once it is done codex writes this marker, a file of codex's own, under its home (CODEX_HOME, which the
 * CLI started from ASIST inherits). The marker is the check because a job must not be the first to meet
 * the missing setup: what `codex exec` does then has not been measured, and a curation job that starts
 * on a timer must never ask for administrator rights.
 */
function codexSandboxSetUp(): boolean {
  const home = process.env.CODEX_HOME || path.win32.join(homedir(), '.codex')
  return fs.existsSync(path.win32.join(home, '.sandbox', 'setup_marker.json'))
}

const listed = (engine: AgentEngine, os: OsFamily): Array<string | undefined> => [process.env[OVERRIDE_VARIABLE[engine]], ...INSTALL_LOCATIONS[os][engine]()]

const SEARCH: Record<OsFamily, (engine: AgentEngine) => CliSearch> = {
  macos: (engine) => {
    const found = listed(engine, 'macos').find((file): file is string => typeof file === 'string' && fs.existsSync(file))
    if (found) return { state: 'found', path: found }
    // A login shell sees the PATH the user's shell profile builds, which the app did not inherit.
    let onPath: string
    try {
      onPath = execFileSync('/bin/zsh', ['-lc', `whence -p ${engine}`], { encoding: 'utf8', env: childEnv(), windowsHide: true }).trim()
    } catch {
      return { state: 'missing' }
    }
    return onPath && fs.existsSync(onPath) ? { state: 'found', path: onPath } : { state: 'missing' }
  },
  // Only an .exe is launched. A .cmd or .bat runs only through cmd.exe, which parses the quotes and
  // parentheses in the arguments again, and Node refuses to spawn one without a shell since CVE-2024-27980.
  // A GUI app on Windows inherits the user's whole Path, so it is read directly rather than through a
  // shell; process.env there ignores the case of a name, so PATH reads the variable Windows writes as Path.
  windows: (engine) => {
    const isFile = (file: string | undefined, extensions: string[]): file is string =>
      file !== undefined && extensions.includes(path.win32.extname(file).toLowerCase()) && fs.existsSync(file)
    const folders = (process.env.PATH ?? '').split(';').filter((folder) => folder !== '')
    const executables = [...listed(engine, 'windows'), ...folders.map((folder) => path.win32.join(folder, `${engine}.exe`))]
    const found = executables.find((file) => isFile(file, ['.exe']))
    if (found) return engine === 'codex' && !codexSandboxSetUp() ? { state: 'sandbox-not-set-up' } : { state: 'found', path: found }
    const scripts = [
      process.env[OVERRIDE_VARIABLE[engine]],
      ...folders.flatMap((folder) => [path.win32.join(folder, `${engine}.cmd`), path.win32.join(folder, `${engine}.bat`)])
    ]
    const script = scripts.some((file) => isFile(file, ['.cmd', '.bat']))
    return { state: script ? 'script-only' : 'missing' }
  }
}

const kept = new Map<AgentEngine, CliSearch>()

/** Where the engine's CLI is, searched once and then kept until `forgetCliSearches`. */
export function locateCli(engine: AgentEngine): CliSearch {
  let search = kept.get(engine)
  if (!search) {
    search = SEARCH[platformCapabilities().os](engine)
    kept.set(engine, search)
  }
  return search
}

/** Drops the kept results, so that the next question searches again for a CLI installed or removed since. */
export function forgetCliSearches(): void {
  kept.clear()
}

/** The path of the engine's CLI, or an error that says why it cannot be launched. */
export function requireCli(engine: AgentEngine): string {
  const search = locateCli(engine)
  if (search.state !== 'found') throw new Error(errorText(AGENT_CLI_UNAVAILABLE_TEXT[search.state], { engine }))
  return search.path
}

/** The engines whose CLI was found. */
export const availableEngines = (): AgentEngine[] =>
  (Object.keys(OVERRIDE_VARIABLE) as AgentEngine[]).filter((engine) => locateCli(engine).state === 'found')
