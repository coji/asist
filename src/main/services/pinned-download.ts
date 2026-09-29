import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { errorText } from '@shared/i18n/error-text'
import { pinnedFileUrl, type PinnedFile } from '@shared/pinned-file'
import { replaceFileAtomic } from './atomic-json'
import { userAgent } from './user-agent'

/**
 * Fetching files whose content is fixed in advance. A fetched file is verified by sha256 before a rename
 * puts it in place, so a file at its path is always the whole, right file.
 */

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
