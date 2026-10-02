/** Renders "0:03", "12:05" or "1:02:03", and "0:00" while the duration is unknown. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * The heights of the bars a waveform is drawn with, `bars` across a recording `seconds` long, from peaks that each
 * cover `peakSeconds` of it from its start: each bar the largest peak within its stretch of time, scaled so that the
 * largest bar is 1, which keeps a quiet recording visible. While the recording is still being read, only the bars
 * up to what its peaks reach are given. A recording longer than `seconds` said is drawn to the end of its peaks.
 */
export function waveformBars(peaks: Float32Array, peakSeconds: number, seconds: number, bars: number): Float32Array {
  const read = peaks.length * peakSeconds
  const total = Math.max(seconds, read)
  if (peaks.length === 0 || !(total > 0) || bars <= 0) return new Float32Array(0)
  const heights = new Float32Array(Math.min(bars, Math.ceil((read / total) * bars)))
  const perBar = total / bars / peakSeconds
  // A bar's edges are rounded to the peak they fall on when they miss it by a rounding error only.
  const EDGE = 1e-9
  let largest = 0
  for (let b = 0; b < heights.length; b++) {
    const from = Math.floor(b * perBar + EDGE)
    // A bar narrower than a peak takes the peak it starts in.
    const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil((b + 1) * perBar - EDGE)))
    let peak = 0
    for (let i = from; i < to; i++) if (peaks[i] > peak) peak = peaks[i]
    heights[b] = peak
    if (peak > largest) largest = peak
  }
  if (largest > 0) for (let b = 0; b < heights.length; b++) heights[b] /= largest
  return heights
}
