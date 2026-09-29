import type { SetupProgress } from '@shared/ipc'

/**
 * The label under a preparation's progress bar: what is happening, and how much of the download has
 * arrived once its size is known. A step that reports neither shows the percentage. The amount always has
 * its tenth, so that the label does not shorten each time the amount reaches a whole megabyte.
 */
export function progressLabel(progress: SetupProgress): string {
  const amount = progress.totalMb > 0 ? `${progress.downloadedMb.toFixed(1)} / ${progress.totalMb} MB` : ''
  return [progress.message, amount].filter(Boolean).join(' · ') || `${progress.pct}%`
}
