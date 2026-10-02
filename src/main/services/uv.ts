import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import { childEnv, pythonEnv, removeVariables } from './child-env'
import { platformCapabilities } from './platform'
import { resourcePath } from './resource-path'

/**
 * The uv that ships in resources/uv, which builds the Python environments of the local models that run in Python. Python
 * itself is not shipped: the interpreter would be signed with the app's hardened runtime, and library
 * validation would then refuse the torch extension modules installed into it later. uv downloads
 * it instead, and a pinned uv carries the checksums of the builds it downloads.
 *
 * Only a Python that uv downloaded is used, and it and uv's cache live under userData. A Python from
 * pyenv, Homebrew or the system, and the user's own uv configuration, would otherwise decide which
 * interpreter an environment gets and where its packages come from.
 */

/** The Python every environment runs on. The requirement files are compiled for its minor version. */
export const PYTHON_VERSION = '3.12.14'

export function uvPath(): string {
  return resourcePath(path.join('uv', platformCapabilities().os === 'windows' ? 'uv.exe' : 'uv'))
}

/** The Python of the environment in dir, where uv venv puts it on this OS. */
export function venvPython(dir: string): string {
  return platformCapabilities().os === 'windows' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python')
}

/** The environment uv runs with: the child environment without the user's UV_ variables, and ASIST's own directories. */
export function uvEnv(parent: NodeJS.ProcessEnv = process.env, userData = app.getPath('userData')): NodeJS.ProcessEnv {
  const env = childEnv({}, parent)
  removeVariables(env, (key) => key.startsWith('UV_'))
  return {
    ...env,
    UV_NO_CONFIG: '1',
    UV_PYTHON_INSTALL_DIR: path.join(userData, 'python'),
    UV_CACHE_DIR: path.join(userData, 'uv-cache')
  }
}

const running = new Set<ChildProcess>()
let quitHookRegistered = false

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    for (const child of running) child.kill('SIGTERM')
  })
}

/** Runs uv to completion. Aborting the signal kills it, and so does quitting the app. */
export function runUv(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException(errorText('settingsModels.preparation.stopped'), 'AbortError'))
    const spawned = spawn(uvPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: uvEnv(), windowsHide: true })
    running.add(spawned)
    registerQuitHook()
    let stderr = ''
    spawned.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000)
    })
    const abort = (): void => {
      spawned.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })
    // A process that fails to spawn emits only 'error', never 'exit', so both end the run here.
    const finish = (error: Error | null): void => {
      signal.removeEventListener('abort', abort)
      running.delete(spawned)
      if (error) reject(error)
      else resolve()
    }
    spawned.once('error', finish)
    spawned.once('exit', (code) => {
      if (signal.aborted) finish(new DOMException(errorText('settingsModels.preparation.stopped'), 'AbortError'))
      else if (code === 0) finish(null)
      else finish(new Error(stderr.trim() || `uv exited with ${code}`))
    })
  })
}

/**
 * Installs the pinned Python under userData, for scripts uv runs on it without an environment of their own,
 * such as the memory curation's checks. Measured with uv 0.12.18 on 2026-10-02: a plain `uv python install`
 * also put a python3.12 into ~/.local/bin, which --no-bin keeps out, as --no-registry keeps the Windows
 * registry clean. The first install took 67 s over the network and left 66 MB; once installed it returns in
 * 0.06 s, offline too.
 */
export function installPython(signal: AbortSignal): Promise<void> {
  return runUv(['python', 'install', '--no-bin', '--no-registry', PYTHON_VERSION], signal)
}

/**
 * The environment of a process whose commands run scripts through a copy of the bundled uv, such as the
 * curation Agent: pinned to the Python installPython put under userData, never downloading one and keeping no
 * cache, so a command needs no Python, uv or Node of the user's and writes nothing but temporary files. The
 * user's own UV_ and PYTHON variables are left out, as for every Python ASIST runs.
 */
export function uvRunEnv(parent: NodeJS.ProcessEnv = process.env, userData = app.getPath('userData')): NodeJS.ProcessEnv {
  const env = pythonEnv({ PYTHONDONTWRITEBYTECODE: '1' }, parent)
  removeVariables(env, (key) => key.startsWith('UV_'))
  return {
    ...env,
    UV_NO_CONFIG: '1',
    UV_PYTHON_INSTALL_DIR: path.join(userData, 'python'),
    UV_PYTHON: PYTHON_VERSION,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: 'never',
    UV_NO_CACHE: '1'
  }
}

/** Creates the environment in dir from scratch, on the pinned Python, downloading it on first use. */
export async function createEnvironment(dir: string, signal: AbortSignal): Promise<void> {
  await fs.promises.mkdir(path.dirname(dir), { recursive: true })
  await runUv(['venv', '--clear', '--managed-python', '--python', PYTHON_VERSION, dir], signal)
}

/** Installs a hash-pinned requirements file from resources into the environment of python. */
export function installRequirements(python: string, file: string, signal: AbortSignal, extra: string[] = []): Promise<void> {
  return runUv(['pip', 'install', '--require-hashes', '--python', python, ...extra, '-r', resourcePath(file)], signal)
}

/** What an environment was built from, recorded in it once the build finished. */
export interface EnvironmentStamp {
  version: string
  lockVersion: number
}

const stampPath = (dir: string): string => path.join(dir, 'asist-runtime.json')

/** Whether the environment in dir finished building from this stamp on the pinned Python. */
export function environmentCurrent(dir: string, stamp: EnvironmentStamp): boolean {
  try {
    const recorded = JSON.parse(fs.readFileSync(stampPath(dir), 'utf8')) as Partial<EnvironmentStamp> & { python?: string }
    return recorded.version === stamp.version && recorded.lockVersion === stamp.lockVersion && recorded.python === PYTHON_VERSION
  } catch {
    return false
  }
}

export async function recordEnvironment(dir: string, stamp: EnvironmentStamp): Promise<void> {
  await fs.promises.writeFile(stampPath(dir), `${JSON.stringify({ ...stamp, python: PYTHON_VERSION }, null, 2)}\n`, { mode: 0o600 })
}
