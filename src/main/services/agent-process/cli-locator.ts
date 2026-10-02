import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentCliState, AgentCliStatus, AgentEngine } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'
import { AGENT_CLI_UNAVAILABLE_TEXT } from '@shared/agent-cli'
import { errorText } from '@shared/i18n/error-text'
import { platformCapabilities } from '../platform'
import { windowsPathFolders } from '../windows-search-path'
import { readShellPath } from './shell-path'

/**
 * Finding the CLI of an agent engine and the PATH it runs with. The CLI's absolute path is what gets
 * launched. A CLI can be installed or removed while the app runs, so a result, "not found" included, is
 * kept only until the settings screen looks again.
 */

/** A CLI that was found: its absolute path, and the variables it runs with on top of the child environment. */
export interface FoundCli {
  path: string
  env: NodeJS.ProcessEnv
}

/** Where an engine's CLI is, or why there is none to launch. */
export type CliSearch = ({ state: 'found' } & FoundCli) | { state: Exclude<AgentCliState, 'found'> }

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

/** A file this user may run, which is what a shell looks for in each PATH folder. */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The user's shell is asked once for all the engines a round of searches looks for. */
let shellAnswer: Promise<string> | undefined

const SEARCH: Record<OsFamily, (engine: AgentEngine) => Promise<CliSearch>> = {
  // A GUI app on macOS inherits launchd's /usr/bin:/bin:/usr/sbin:/sbin. The CLI is looked for on the PATH
  // of the user's shell and runs with that same PATH: npm installs a CLI as a Node script that `env` runs
  // with the first node on PATH, and the commands the agent runs need the user's tools as well. Without
  // the shell's answer no CLI is reported found, since one started on the thin PATH would fail.
  macos: async (engine) => {
    let PATH: string
    try {
      PATH = await (shellAnswer ??= readShellPath())
    } catch (error) {
      console.error(`the ${engine} CLI cannot be looked for:`, error)
      return { state: 'shell-unreadable' }
    }
    const folders = PATH.split(path.posix.delimiter).filter((folder) => path.posix.isAbsolute(folder))
    const candidates = [...listed(engine, 'macos'), ...folders.map((folder) => path.posix.join(folder, engine))]
    const found = candidates.find((file): file is string => file !== undefined && isExecutable(file))
    return found ? { state: 'found', path: found, env: { PATH } } : { state: 'missing' }
  },
  // Only an .exe is launched. A .cmd or .bat runs only through cmd.exe, which parses the quotes and
  // parentheses in the arguments again, and Node refuses to spawn one without a shell since CVE-2024-27980.
  // A GUI app on Windows inherits the user's whole Path, so it is read directly rather than through a
  // shell, and the CLI runs with it; process.env there ignores the case of a name, so PATH reads the
  // variable Windows writes as Path.
  windows: async (engine) => {
    const isFile = (file: string | undefined, extensions: string[]): file is string =>
      file !== undefined && extensions.includes(path.win32.extname(file).toLowerCase()) && fs.existsSync(file)
    const folders = windowsPathFolders(process.env.PATH ?? '')
    const executables = [...listed(engine, 'windows'), ...folders.map((folder) => path.win32.join(folder, `${engine}.exe`))]
    const found = executables.find((file) => isFile(file, ['.exe']))
    if (found) return engine === 'codex' && !codexSandboxSetUp() ? { state: 'sandbox-not-set-up' } : { state: 'found', path: found, env: {} }
    const scripts = [
      process.env[OVERRIDE_VARIABLE[engine]],
      ...folders.flatMap((folder) => [path.win32.join(folder, `${engine}.cmd`), path.win32.join(folder, `${engine}.bat`)])
    ]
    const script = scripts.some((file) => isFile(file, ['.cmd', '.bat']))
    return { state: script ? 'script-only' : 'missing' }
  }
}

const kept = new Map<AgentEngine, Promise<CliSearch>>()
/** The searches that have ended, which the status reads without waiting. */
const settled = new Map<AgentEngine, CliSearch>()
const searchListeners = new Set<() => void>()

/** Where the engine's CLI is, searched once and then kept until `forgetCliSearches`. */
export function locateCli(engine: AgentEngine): Promise<CliSearch> {
  const existing = kept.get(engine)
  if (existing) return existing
  const search: Promise<CliSearch> = SEARCH[platformCapabilities().os](engine).then((found) => {
    // A search that started before forgetCliSearches leaves the newer one alone.
    if (kept.get(engine) === search) {
      settled.set(engine, found)
      for (const listener of searchListeners) listener()
    }
    return found
  })
  kept.set(engine, search)
  return search
}

/**
 * The engine's CLI as the status reports it, without waiting for the user's shell: 'checking' until a search
 * has ended, which this starts when none has.
 */
export function cliStatus(engine: AgentEngine): AgentCliStatus {
  const found = settled.get(engine)
  if (found) return found.state
  // A search that fails is reported where a job needs the CLI; the status goes on saying it is being checked.
  void locateCli(engine).catch(() => {})
  return 'checking'
}

/** Calls the listener whenever a search ends, so that the status can be sent again. Returns the unsubscribe. */
export function onCliSearched(listener: () => void): () => void {
  searchListeners.add(listener)
  return () => {
    searchListeners.delete(listener)
  }
}

/**
 * Drops the kept results and the shell's answer, so that the next question searches again for a CLI
 * installed or removed since, on a PATH the user may have changed since.
 */
export function forgetCliSearches(): void {
  kept.clear()
  settled.clear()
  shellAnswer = undefined
}

/** The engine's CLI, or an error that says why it cannot be launched. */
export async function requireCli(engine: AgentEngine): Promise<FoundCli> {
  const search = await locateCli(engine)
  if (search.state !== 'found') throw new Error(errorText(AGENT_CLI_UNAVAILABLE_TEXT[search.state], { engine }))
  return { path: search.path, env: search.env }
}

/** The engines whose CLI was found. */
export async function availableEngines(): Promise<AgentEngine[]> {
  const engines = Object.keys(OVERRIDE_VARIABLE) as AgentEngine[]
  const searches = await Promise.all(engines.map(locateCli))
  return engines.filter((_engine, index) => searches[index].state === 'found')
}
