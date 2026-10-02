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
const URL_KINDS: ReadonlySet<FileKind> = new Set(['image', 'pdf', 'docx', 'pptx', 'xlsx', 'video', 'audio'])

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

const MB = 1024 * 1024

/**
 * The largest file, by its size on disk, that each viewer reads whole into the page and parses there. A larger one
 * is not read: the viewer says it is too large to show here, above the card's button that shows it in Finder or File
 * Explorer. Audio still plays, since <audio> reads it by ranges, and only its waveform, which decodes the whole file,
 * is left out. The kinds not listed travel as text up to MAX_TEXT_BYTES, or are loaded by the page's own image,
 * media and frame elements. A notebook travels as text too, but its viewer parses the whole of it as JSON, which no
 * beginning of it is, so its limit is MAX_TEXT_BYTES.
 *
 * Measured on 2026-10-02 in the demo under headless Chrome on an Apple M5 with 32 GB, opening generated files in a card
 * and in the focus view, the slower of the two given. Most limits sit where the costliest likely file of the kind took
 * about a second to show and grew the page by less than a gigabyte, so that a machine two or three times slower still
 * shows it within a few seconds. audio is set higher, for the files it most often is.
 * - xlsx, 8 MB: sales records took 1.2 s for 9.3 MB and 4.9 s for 37 MB, and a grid of small numbers 1.1 s for 5.8 MB
 *   and 2.0 s for 11.6 MB, all of it holding the page's thread.
 * - pptx, 32 MB: a photo on every slide took 0.9 s for 36 MB and 1.8 s for 69 MB, holding the thread at most 0.1 s.
 * - pdf, 256 MB: scanned pages took 0.7 s for 281 MB and grew the page by 0.6 GB, and 1.7 s for 1.1 GB by 2.3 GB.
 *   Little of it holds the thread, so the memory sets the limit.
 * - audio, 8 MB: an ordinary song keeps its waveform. 9.2 MB of 128 kbps stereo (10 minutes) grew the page by 0.68 GB
 *   while it decoded off the thread; speech at 32 kbps mono costs twice as much for its size, 9.2 MB (40 minutes)
 *   growing it by 1.3 GB.
 */
export const WHOLE_READ_LIMIT: Partial<Record<FileKind, number>> = {
  xlsx: 8 * MB,
  pptx: 32 * MB,
  pdf: 256 * MB,
  audio: 8 * MB,
  notebook: MAX_TEXT_BYTES
}

/** Whether the item's file is larger than its viewer reads whole (WHOLE_READ_LIMIT). */
export function tooLargeToRead(item: Pick<FileItem, 'kind' | 'sizeBytes'>): boolean {
  const limit = WHOLE_READ_LIMIT[item.kind]
  return limit !== undefined && item.sizeBytes > limit
}

/**
 * The kinds the files card has no viewer for, shown by their name and size alone: a zip, and every kind classifyFile
 * does not know, such as an older Office file (.doc, .xls, .ppt) or an iWork file.
 */
const KINDS_WITHOUT_VIEWER = ['archive', 'binary'] as const satisfies readonly FileKind[]

type KindWithoutViewer = (typeof KINDS_WITHOUT_VIEWER)[number]

/** A kind the files card has a viewer for. */
export type ViewedKind = Exclude<FileKind, KindWithoutViewer>

const hasNoViewer = (kind: FileKind): kind is KindWithoutViewer => (KINDS_WITHOUT_VIEWER as readonly FileKind[]).includes(kind)

/**
 * What the files card shows of an item: all of it; only its first part (the text carried up to MAX_TEXT_BYTES, or the
 * first entries of a large folder) with a note that says so; or, in its place, why it could not be read, or a placard
 * saying that it is too large to show here or that its kind cannot be shown. The card's viewers and the result
 * show_files gives the model both read it, so that the model is told what the card did. Audio is shown at any size,
 * since <audio> plays it by ranges and only its waveform asks tooLargeToRead, and an HTML page is shown whole, since
 * its frame loads the page itself and only its source is cut short.
 */
export type CardView =
  | { shows: 'all' | 'firstPart'; kind: ViewedKind }
  | { shows: 'nothing'; why: 'unreadable'; error: string }
  | { shows: 'nothing'; why: 'tooLarge' | 'noViewer' }

export function cardView(item: FileItem): CardView {
  if (item.error) return { shows: 'nothing', why: 'unreadable', error: item.error }
  const kind = item.kind
  if (hasNoViewer(kind)) return { shows: 'nothing', why: 'noViewer' }
  if (kind !== 'audio' && tooLargeToRead(item)) return { shows: 'nothing', why: 'tooLarge' }
  const textCut = item.truncated === true && !(kind === 'code' && isHtmlPage(item.path))
  const listCut = (item.entryCount ?? 0) > (item.entries?.length ?? 0)
  return { shows: textCut || listCut ? 'firstPart' : 'all', kind }
}

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
  /** The contents of a directory, folders first and by name, without hidden files; only the first of a large one. */
  entries?: FileEntry[]
  /** How many entries the directory holds, which is more than `entries` carries when its list was cut short. */
  entryCount?: number
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

