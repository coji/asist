import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import { replaceFileAtomic } from './atomic-json'
import { t } from './i18n'
import { userAgent } from './user-agent'
import { createEnvironment, environmentCurrent, installRequirements, recordEnvironment } from './uv'

/**
 * The Python environment shared by the ONNX sidecars, the memory embedding worker and the aizuchi
 * classifier worker, and the fetching of pinned model files, which the VAP worker's preparation uses too.
 *
 * uv builds the environment in userData/embedding-runtime and installs only onnxruntime and tokenizers.
 * The directory is named after embedding because that was the first sidecar to use it, and it serves
 * both. A requirements change means raising RUNTIME_VERSION and RUNTIME_LOCK_VERSION, which rebuilds the
 * environment. A fetched file is verified by sha256 before a rename puts it in place.
 */

/** The generation of the Python environment. Raising it after a requirements change rebuilds the environment. */
const RUNTIME_LOCK_VERSION = 2
const RUNTIME_VERSION = 'onnxruntime-1.29/tokenizers-0.23'
const STAMP = { version: RUNTIME_VERSION, lockVersion: RUNTIME_LOCK_VERSION }

export interface PinnedFile {
  repo: string
  revision: string
  file: string
  sha256: string
  bytes: number
}

export function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'embedding-runtime')
}

export function pythonPath(): string {
  const configured = process.env.ASIST_EMBEDDING_PYTHON?.trim()
  return configured || path.join(runtimeDir(), 'bin', 'python')
}

export function supportedPlatform(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

export function runtimeInstalled(): boolean {
  if (!supportedPlatform()) return false
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

/** The Hugging Face URL that pins the file to one commit. */
export function pinnedFileUrl(file: PinnedFile): string {
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.file}`
}

/** A file at a URL that serves fixed content, which is accepted only when it hashes to `sha256`. `file` names it in messages. */
export interface VerifiedSource {
  url: string
  file: string
  sha256: string
}

/** Streams one file to a temporary path and renames it into place only after its sha256 has been verified. */
export async function downloadPinnedFile(
  source: VerifiedSource,
  target: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void
): Promise<void> {
  const response = await fetch(source.url, { signal, headers: { 'user-agent': userAgent() } })
  if (!response.ok || !response.body) {
    throw new Error(errorText('settingsModels.preparation.downloadFailed', { file: source.file, status: response.status }))
  }
  const body = response.body
  await replaceFileAtomic(target, async (temporary) => {
    const hash = crypto.createHash('sha256')
    // pipeline settles only after the file has been flushed and closed, and a failure in any stage
    // rejects it and cancels the response. A failed write has to end the download here: the hash covers
    // the bytes received, not the bytes written, so the check below would accept a truncated file.
    await pipeline(
      Readable.fromWeb(body),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          onBytes(chunk.length)
          yield chunk
        }
      },
      fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx', flush: true })
    )
    const digest = hash.digest('hex')
    if (digest !== source.sha256) throw new Error(errorText('settingsModels.preparation.checksumMismatch', { file: source.file, digest }))
  })
}

/**
 * Fetches the files one after another and reports the progress as a percentage of the whole set. A file
 * that is already present is skipped and does not count towards the total.
 */
export async function downloadMissing(
  files: ReadonlyArray<{ file: PinnedFile; target: string }>,
  signal: AbortSignal,
  onProgress: (progress: { pct: number; downloadedMb: number; totalMb: number; file: string }) => void
): Promise<void> {
  const missing = files.filter(({ target }) => !fs.existsSync(target))
  const totalBytes = missing.reduce((sum, { file }) => sum + file.bytes, 0)
  let downloaded = 0
  for (const { file, target } of missing) {
    await downloadPinnedFile({ url: pinnedFileUrl(file), file: file.file, sha256: file.sha256 }, target, signal, (bytes) => {
      downloaded += bytes
      onProgress({
        pct: Math.min(99, Math.round((downloaded / totalBytes) * 100)),
        downloadedMb: Math.round(downloaded / 1e5) / 10,
        totalMb: Math.round(totalBytes / 1e6),
        file: path.basename(file.file)
      })
    })
  }
}
