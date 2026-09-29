import { describe, expect, it } from 'vitest'
import { progressLabel } from '../src/renderer/src/ui/progress-label'

describe('the label under a preparation\'s progress bar', () => {
  it('keeps its length when the amount downloaded reaches a whole megabyte', () => {
    const at = (downloadedMb: number): string => progressLabel({ status: 'downloading', pct: 88, downloadedMb, totalMb: 1019, message: 'Qwen3-ASR 0.6B' })
    expect(at(905).length).toBe(at(904.9).length)
  })
})
