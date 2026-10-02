import { Folder } from 'lucide-react'
import { formatBytes } from '@shared/files'
import { openFiles } from '../open-files'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * The entries of a folder, folders first and then by name. Pressing a row opens a files card for that entry,
 * which for a folder goes one level down. The focus view lists every entry main sent, and says how many more the
 * folder holds when main cut the list short.
 */
const LIMIT = { l: 8, m: 6, s: 3, focus: Infinity } as const

export const DirectoryViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const entries = item.entries ?? []
  const shown = entries.slice(0, LIMIT[size])
  const rest = entries.length - shown.length
  const unlisted = (item.entryCount ?? 0) - entries.length
  return (
    <Frame mode={mode} size={size}>
      {entries.length === 0 ? (
        <p className="fv-note">{t('files.viewer.emptyFolder')}</p>
      ) : (
        <ul className="card-rows">
          {shown.map((entry) => (
            <li key={entry.path} className="card-row fv-entry">
              <button type="button" className="card-row-link" onClick={() => openFiles([entry.path])} title={entry.path}>
                <span className="card-row-title">
                  {entry.kind === 'directory' && <Folder size={12} className="fv-entry-icon" aria-hidden />}
                  {entry.name}
                </span>
                <span className="card-row-meta">
                  {t(`files.kind.${entry.kind}`)}
                  {entry.kind !== 'directory' && ` · ${formatBytes(entry.sizeBytes)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rest > 0 && <p className="fv-note">{t('files.viewer.moreEntries', { count: rest })}</p>}
      {rest === 0 && unlisted > 0 && (
        <p className="fv-note">
          {t(osMessageKey('files.viewer.entriesCut', platformCapabilities().os), { listed: entries.length, count: entries.length + unlisted })}
        </p>
      )}
    </Frame>
  )
}
