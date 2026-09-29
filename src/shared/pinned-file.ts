/** A file of a Hugging Face repository pinned to one commit, which is accepted only with this content. */
export interface PinnedFile {
  repo: string
  revision: string
  file: string
  sha256: string
  bytes: number
}

/** The Hugging Face URL that pins the file to one commit. */
export function pinnedFileUrl(file: PinnedFile): string {
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.file}`
}
