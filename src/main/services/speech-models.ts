import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import type { PinnedFile } from '@shared/pinned-file'
import { errorMessage, t } from './i18n'
import { platformCapabilities } from './platform'
import { downloadMissing } from './pinned-download'

/**
 * The GGUF files of the local speech models, under userData/speech-models, one folder per repository and
 * revision. A file is fetched to a temporary name and renamed into place once its sha256 matches, so a file
 * at its path is whole, and a set of files counts as installed when every one of them is there.
 */

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'speech-models')
}

export function modelFilePath(file: PinnedFile): string {
  return path.join(modelsDir(), file.repo.replace('/', '--'), file.revision, file.file)
}

export function fileInstalled(file: PinnedFile): boolean {
  return fs.existsSync(modelFilePath(file))
}

export function filesInstalled(files: readonly PinnedFile[]): boolean {
  return files.every(fileInstalled)
}

export interface PrepareOptions {
  files: readonly PinnedFile[]
  /** The model's name in the messages. */
  label: string
  /** What the feature is called in the messages, already in the interface language. */
  feature: string
  signal: AbortSignal
  onProgress: (progress: SetupProgress) => void
  /** Starts the service on the downloaded files and resolves to whether it became ready. */
  start: () => Promise<boolean>
}

/**
 * Downloads the files that are missing, then starts the service on them, reporting each step as setup
 * progress. The download has no time limit, because the service's ready timeout would otherwise have to
 * cover 2.5 GB on a slow line.
 */
export async function prepareModelFiles(options: PrepareOptions): Promise<{ ok: boolean; message: string }> {
  const { files, label, feature, signal, onProgress, start } = options
  if (platformCapabilities().localSpeech.backend === null) {
    return { ok: false, message: t('settingsModels.preparation.unsupported', { feature }) }
  }
  try {
    if (!filesInstalled(files)) {
      const message = t('settingsModels.preparation.downloading', { model: label })
      onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
      await downloadMissing(files.map((file) => ({ file, target: modelFilePath(file) })), signal, (progress) =>
        onProgress({ status: 'downloading', pct: progress.pct, downloadedMb: progress.downloadedMb, totalMb: progress.totalMb, message }))
    }
    signal.throwIfAborted()
    onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message: t('settingsModels.preparation.loading', { model: label }) })
    if (!(await start())) throw new Error(errorText('settingsModels.preparation.startFailed', { model: label }))
    onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
    return { ok: true, message: t('settingsModels.preparation.done', { model: label }) }
  } catch (error) {
    const cancelled = signal.aborted
    const message = cancelled ? t('settingsModels.preparation.cancelled', { feature }) : errorMessage(error)
    onProgress({ status: cancelled ? 'cancelled' : 'error', pct: 0, downloadedMb: 0, totalMb: 0, message })
    return { ok: false, message }
  }
}
