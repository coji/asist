import { WHOLE_READ_LIMIT, type FileKind } from '@shared/files'

/** A file name of each kind whose viewer may have a size limit (WHOLE_READ_LIMIT); audio is shown at any size. */
const LIMITED_FILE_NAMES: Partial<Record<FileKind, string>> = {
  notebook: 'analysis.ipynb',
  docx: 'report.docx',
  pptx: 'deck.pptx',
  pdf: 'scan.pdf'
}

/**
 * A name and the limit of the kind with the smallest limit in the table, so that a file just over it stays small
 * whichever limits are left.
 */
export function smallestLimitedFile(): { name: string; limit: number } {
  const [kind, limit] = (Object.entries(WHOLE_READ_LIMIT) as Array<[FileKind, number]>)
    .filter(([kind]) => LIMITED_FILE_NAMES[kind])
    .sort((a, b) => a[1] - b[1])[0]
  return { name: LIMITED_FILE_NAMES[kind]!, limit }
}
