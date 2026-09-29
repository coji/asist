import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { t } from './i18n'
import { createEnvironment, environmentCurrent, installRequirements, recordEnvironment, venvPython } from './uv'

/**
 * The Python environment shared by the ONNX sidecars, the memory embedding worker and the aizuchi
 * classifier worker.
 *
 * uv builds the environment in userData/embedding-runtime and installs only onnxruntime and tokenizers.
 * The directory is named after embedding because that was the first sidecar to use it, and it serves
 * both. A requirements change means raising RUNTIME_VERSION and RUNTIME_LOCK_VERSION, which rebuilds the
 * environment.
 */

/** The generation of the Python environment. Raising it after a requirements change rebuilds the environment. */
const RUNTIME_LOCK_VERSION = 2
const RUNTIME_VERSION = 'onnxruntime-1.29/tokenizers-0.23'
const STAMP = { version: RUNTIME_VERSION, lockVersion: RUNTIME_LOCK_VERSION }

export function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'embedding-runtime')
}

export function pythonPath(): string {
  const configured = process.env.ASIST_EMBEDDING_PYTHON?.trim()
  return configured || venvPython(runtimeDir())
}

export function runtimeInstalled(): boolean {
  if (!fs.existsSync(pythonPath())) return false
  if (process.env.ASIST_EMBEDDING_PYTHON?.trim()) return true
  return environmentCurrent(runtimeDir(), STAMP)
}

let installInFlight: Promise<void> | null = null

/**
 * Builds the Python environment when it is missing or from an older generation. `purpose` names the
 * feature in the progress text and arrives already in the interface language. Two features preparing at
 * once share one build, which the first caller's signal cancels: the build starts with `uv venv --clear`,
 * which would empty the folder a second build is installing into.
 */
export function ensureRuntime(
  signal: AbortSignal,
  progress: (message: string) => void,
  purpose: string
): Promise<void> {
  if (runtimeInstalled()) return Promise.resolve()
  progress(t('settingsModels.preparation.python', { feature: purpose }))
  if (installInFlight) return installInFlight
  const operation = install(signal, progress).finally(() => {
    if (installInFlight === operation) installInFlight = null
  })
  installInFlight = operation
  return operation
}

async function install(signal: AbortSignal, progress: (message: string) => void): Promise<void> {
  // The environment is rebuilt from scratch whenever its recorded version does not match the current
  // requirements.
  await createEnvironment(runtimeDir(), signal)
  progress(t('settingsModels.preparation.onnxPackages'))
  await installRequirements(pythonPath(), 'embedding-requirements.txt', signal)
  await recordEnvironment(runtimeDir(), STAMP)
}
