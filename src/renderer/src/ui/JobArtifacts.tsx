import {
  Archive,
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image,
  Music,
  NotebookText,
  Presentation,
  type LucideIcon
} from 'lucide-react'
import type { AgentJob } from '@shared/ipc'
import { baseName, dirName, pathInside } from '@shared/file-path'
import { classifyFile, type FileKind } from '@shared/files'
import { useT } from '@/i18n'
import { openFiles } from '@/panels/open-files'
import { useViewStore } from '@/state/view'
import './job-artifacts.css'

const KIND_ICON: Record<FileKind, LucideIcon> = {
  markdown: FileText,
  text: FileText,
  table: FileSpreadsheet,
  data: FileCode,
  code: FileCode,
  image: Image,
  pdf: FileText,
  docx: FileText,
  pptx: Presentation,
  xlsx: FileSpreadsheet,
  video: Film,
  audio: Music,
  notebook: NotebookText,
  archive: Archive,
  directory: Folder,
  binary: File
}

/** The folder of a file relative to the job's working directory, which is what tells two files of one name apart. */
function folderOf(path: string, cwd: string): string {
  const folder = dirName(path)
  return pathInside(cwd, folder) ?? folder
}

/**
 * The files a job created or edited, as a row of cards under its log. A job with many of them scrolls the
 * row sideways, so the log above keeps its height whatever the count. Pressing a card leaves the jobs
 * screen and opens the files card with every artifact in it and the pressed one selected, as the artifact
 * list of the job card does.
 */
export function JobArtifacts({ job }: { job: AgentJob }): React.JSX.Element | null {
  const t = useT()
  const closeApp = useViewStore((s) => s.closeApp)
  const paths = job.artifacts ?? []
  if (paths.length === 0) return null
  return (
    <section className="ja" aria-label={t('jobs.card.artifacts.title')}>
      <h3>
        {t('jobs.card.artifacts.title')}
        <small>{t('jobs.card.artifacts.note', { count: paths.length })}</small>
      </h3>
      <ul>
        {paths.map((path, index) => {
          const kind = classifyFile(path)
          const Icon = KIND_ICON[kind]
          const folder = folderOf(path, job.cwd)
          return (
            <li key={path}>
              <button
                type="button"
                title={path}
                onClick={() => {
                  openFiles(paths, job.title, index)
                  closeApp()
                }}
              >
                <Icon size={18} aria-hidden />
                <span className="ja-name">{baseName(path)}</span>
                <span className="ja-meta">{folder ? `${t(`files.kind.${kind}`)} · ${folder}` : t(`files.kind.${kind}`)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
