import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { childEnv, removeVariables } from './child-env'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'

/**
 * The settings of the user's own git that ASIST's git takes over: those that decide how a file of a
 * repository is written into a working tree and read back from it, and nothing else. With a different
 * core.autocrlf, a checkout of the user's reads as changed in every line, and a job's CRLF enters the
 * user's history without the normalisation the user's git applies; with a different core.symlinks, a link
 * is checked out into a job's worktree as a plain file.
 */
const WORKING_TREE_SETTINGS = ['autocrlf', 'eol', 'symlinks']

/**
 * The user's values of the working-tree settings in the core section, by name. A null value is a key
 * written without `=`, which git reads as true.
 */
export type WorkingTreeSettings = ReadonlyMap<string, string | null>

/**
 * The working-tree settings the user's git reads outside any repository: the system and global levels of
 * the first git.exe on PATH on Windows, and nothing when there is none. On macOS the git in /usr/bin opens
 * a dialog to install the Command Line Tools when they are missing, so the user's git is never run there:
 * the bundled git reads the global level, which every git reads from the same files, and the system
 * configuration of Apple's git and of Homebrew's sets none of these settings.
 */
export function userGitSettings(bundledGit: string): WorkingTreeSettings {
  const env = childEnv()
  removeVariables(env, (key) => key.startsWith('GIT_'))
  if (platformCapabilities().os !== 'windows') return settingsSeenBy(bundledGit, { ...env, GIT_CONFIG_NOSYSTEM: '1' })
  const userGit = userGitOnPath(process.env.PATH ?? '', resourcePath('git'))
  return userGit ? settingsSeenBy(userGit, env) : new Map()
}

/**
 * The first git.exe in the folders of searchPath that lies outside bundledRoot, which is the git the user
 * runs from a terminal. ASIST's own git, should its folder be on PATH, is not the user's: its system
 * configuration is the one MinGit ships, with core.autocrlf and core.symlinks that no user chose.
 */
export function userGitOnPath(searchPath: string, bundledRoot: string): string | null {
  const bundled = fs.realpathSync.native(bundledRoot)
  for (const entry of searchPath.split(path.delimiter)) {
    // Windows keeps a folder on PATH in quotes when its name holds the separator.
    const folder = entry.replace(/^"(.*)"$/, '$1')
    if (!path.isAbsolute(folder)) continue
    const candidate = path.join(folder, 'git.exe')
    if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue
    const relative = path.relative(bundled, fs.realpathSync.native(candidate))
    if (relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) return candidate
  }
  return null
}

/**
 * The working-tree settings that git, started with env, reads from its system and global levels. It runs
 * in the temporary folder and looks no higher for a repository, so no repository's configuration and no
 * includeIf that depends on one takes part.
 */
export function settingsSeenBy(git: string, env: NodeJS.ProcessEnv): WorkingTreeSettings {
  const outside = tmpdir()
  let listed: string
  try {
    listed = execFileSync(git, ['config', '--get-regexp', '--show-scope', '-z', `^core\\.(${WORKING_TREE_SETTINGS.join('|')})$`], {
      cwd: outside,
      encoding: 'utf8',
      env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(outside) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    // config exits with 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return new Map()
    throw error
  }
  const settings = new Map<string, string | null>()
  // With -z and --show-scope each entry is the scope, then the key, a newline and the value, each field
  // ending in NUL; a key written without a value has no newline. The levels come in the order git applies
  // them, so a later value wins.
  const fields = listed.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== 'system' && fields[i] !== 'global') continue
    const entry = fields[i + 1]
    const newline = entry.indexOf('\n')
    const key = newline < 0 ? entry : entry.slice(0, newline)
    settings.set(key.slice('core.'.length), newline < 0 ? null : entry.slice(newline + 1))
  }
  return settings
}

/** The settings as a configuration file of git, with each value quoted as the format requires. */
export function configText(settings: WorkingTreeSettings): string {
  const quoted = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`
  const lines = [...settings].map(([name, value]) => (value === null ? `\t${name}` : `\t${name} = ${quoted(value)}`))
  return ['[core]', ...lines, ''].join('\n')
}
