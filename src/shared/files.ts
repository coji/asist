import { baseName } from './file-path'

/**
 * The types behind the files card (show_files). The main process only validates the path and reads the
 * file; interpreting and drawing the content is the renderer's viewer. A text kind travels as the body
 * inside the props, and a binary kind travels as a URL, which is asist-file:// in the app and a static
 * path in the demo.
 */

export type FileKind =
  | 'markdown'
  | 'text'
  | 'table'
  | 'data'
  | 'code'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'video'
  | 'audio'
  | 'notebook'
  | 'archive'
  | 'directory'
  | 'binary'

const KIND_BY_EXT: Record<string, FileKind> = {
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'table',
  '.tsv': 'table',
  '.json': 'data',
  '.jsonl': 'data',
  '.yaml': 'data',
  '.yml': 'data',
  '.toml': 'data',
  '.ini': 'data',
  '.env': 'data',
  '.xml': 'data',
  '.plist': 'data',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.heic': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.mp4': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.ipynb': 'notebook',
  '.zip': 'archive'
}

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.sh', '.zsh', '.bash', '.sql', '.css', '.scss',
  '.html', '.htm', '.c', '.cpp', '.cc', '.h', '.hpp', '.java', '.kt', '.swift', '.m', '.php', '.lua', '.r', '.dart', '.vue', '.svelte',
  '.makefile', '.dockerfile', '.gradle', '.proto', '.graphql', '.tf'
])

export function classifyFile(filePath: string): FileKind {
  const name = baseName(filePath).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return 'code'
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext]
  if (CODE_EXT.has(ext)) return 'code'
  return 'binary'
}

/** The kinds whose body travels in the props as a string. */
export const TEXT_KINDS: ReadonlySet<FileKind> = new Set(['markdown', 'text', 'table', 'data', 'code', 'notebook'])

/** The kinds the viewer fetches by URL instead. */
const URL_KINDS: ReadonlySet<FileKind> = new Set(['image', 'pdf', 'docx', 'pptx', 'xlsx', 'video', 'audio', 'archive'])

const PAGE_EXT = new Set(['.html', '.htm'])

/**
 * Whether the file is an HTML page, which the viewer renders as a page and can also show as source. It
 * stays a code file in every other respect, so it carries its text like any code file and a URL besides,
 * which the rendered page is loaded from so that the files next to it resolve.
 */
export function isHtmlPage(filePath: string): boolean {
  const name = baseName(filePath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 && PAGE_EXT.has(name.slice(dot))
}

/** Whether an item of this kind and path carries a URL. */
export function carriesUrl(kind: FileKind, filePath: string): boolean {
  return URL_KINDS.has(kind) || (kind === 'code' && isHtmlPage(filePath))
}

/**
 * The limit on text carried in the props. Above it only the beginning is carried and `truncated` is
 * set, which the viewer shows as an invitation to open the file.
 */
export const MAX_TEXT_BYTES = 512 * 1024

export interface FileEntry {
  name: string
  path: string
  kind: FileKind
  sizeBytes: number
}

export interface FileItem {
  path: string
  name: string
  kind: FileKind
  sizeBytes: number
  modifiedAt?: number
  /** Why the file could not be read. When it is present, none of the other fields are. */
  error?: string
  /** The body of a text kind, up to MAX_TEXT_BYTES. */
  text?: string
  truncated?: boolean
  /** The URL a binary kind is fetched from. */
  url?: string
  /** The contents of a directory, by name and without hidden files. */
  entries?: FileEntry[]
}

/** The props of show_files: `paths` is the input and `items` is what the main process read. */
export interface FilesProps {
  title?: string
  paths: string[]
  items?: FileItem[]
  /** The item selected in the card. The focus overlay shares this selection. */
  selected?: number
}

/** Formats a size like "2.3MB", "48KB" or "120B". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** The shape of the card: a single file gets the viewer, images alone get a grid, and anything else gets a list. */
export type FilesLayout = 'single' | 'gallery' | 'list'

export function filesLayout(items: readonly FileItem[]): FilesLayout {
  if (items.length === 1) return 'single'
  const shown = items.filter((item) => !item.error)
  if (shown.length >= 2 && shown.every((item) => item.kind === 'image')) return 'gallery'
  return 'list'
}

