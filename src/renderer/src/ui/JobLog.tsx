import { displaySeparator, isAbsolutePath, pathNames } from '@shared/file-path'
import { rowText, type JobLogRow } from '@shared/job-log-view'
import { useT, useFormatLocale } from '@/i18n'
import './job-log.css'

/**
 * Draws a job log row according to its kind, shared by the agent-job card and by JobsView. How rows
 * are folded together, a command's start with its end and a run of calls to the same tool, is
 * decided in shared/job-log-view; this file only holds the appearance.
 */

/** Shows only the last two elements of a path, because long absolute paths under the working directory line up otherwise; the full path stays in the title. */
export function shortPath(path: string): string {
  const names = pathNames(path)
  const separator = displaySeparator(path)
  return names.length > 2 ? `…${separator}${names.slice(-2).join(separator)}` : path
}

const timeLabel = (locale: string, at: number): string =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function JobLogRowView({ row, time }: { row: JobLogRow; time?: boolean }): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const stamp = time ? <span className="jl-time">{timeLabel(locale, row.t)}</span> : null
  switch (row.kind) {
    case 'tool':
      return (
        <div className="jl-row" data-kind="tool">
          {stamp}
          <span className="jl-mark">▸</span>
          <span className="jl-name">
            {row.name}
            {row.count > 1 && <em> ×{row.count}</em>}
          </span>
          <span className="jl-detail" title={row.detail}>
            {isAbsolutePath(row.detail) ? shortPath(row.detail) : row.detail}
          </span>
        </div>
      )
    case 'command':
      return (
        <div className="jl-row" data-kind="command" data-status={row.status}>
          {stamp}
          <span className="jl-mark">$</span>
          <span className="jl-command">{row.command}</span>
          {row.status === 'running' && <i className="jl-dot" aria-label={t('jobs.status.running')} />}
          {row.status === 'error' && <span className="jl-exit">exit {row.exitCode ?? '?'}</span>}
        </div>
      )
    case 'file':
      return (
        <div className="jl-row" data-kind="file">
          {stamp}
          <span className="jl-mark">✎</span>
          <span className="jl-files">
            {row.paths.map((p) => (
              <span key={p} title={p}>
                {shortPath(p)}
              </span>
            ))}
          </span>
        </div>
      )
    case 'result':
      return (
        <div className="jl-row" data-kind="result" data-status={row.ok ? 'ok' : 'error'}>
          {stamp}
          <span className="jl-text">{row.text || t(row.ok ? 'jobs.log.done' : 'jobs.log.failed')}</span>
        </div>
      )
    case 'session':
      return (
        <div className="jl-row" data-kind="system">
          {stamp}
          <span className="jl-text">{rowText(row, t)}</span>
        </div>
      )
    default:
      return (
        <div className="jl-row" data-kind={row.kind}>
          {stamp}
          <span className="jl-text">{row.text}</span>
        </div>
      )
  }
}

export function JobLogRows({ rows, time }: { rows: readonly JobLogRow[]; time?: boolean }): React.JSX.Element {
  return (
    <>
      {rows.map((row, i) => (
        <JobLogRowView key={i} row={row} time={time} />
      ))}
    </>
  )
}
