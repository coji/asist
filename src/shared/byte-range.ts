/**
 * Turns a Range header of the form `bytes=a-b`, `bytes=a-` or `bytes=-n` (the last n bytes) into [start, end]
 * within the file, or null when no byte of the file is in it, which is answered with the whole file. The
 * asist-file scheme and the files the demo serves to demo:viewer-budgets both answer by it, so that a viewer
 * reading by ranges meets the same answers in the measurements as in the app.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  const suffix = m[1] === ''
  const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1])
  const end = suffix || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start > end ? null : { start, end }
}
