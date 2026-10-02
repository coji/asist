import { cardView, isHtmlPage, type FileItem, type ViewedKind } from '@shared/files'
import { CodeViewer } from './CodeViewer'
import { DataViewer } from './DataViewer'
import { AudioViewer } from './AudioViewer'
import { DirectoryViewer } from './DirectoryViewer'
import { DocxViewer } from './DocxViewer'
import { HtmlViewer } from './HtmlViewer'
import { PptxViewer } from './PptxViewer'
import { XlsxViewer } from './XlsxViewer'
import { ImageViewer } from './ImageViewer'
import { MarkdownViewer } from './MarkdownViewer'
import { PdfViewer } from './PdfViewer'
import { NotebookViewer } from './NotebookViewer'
import { StubViewer, TooLargeViewer } from './StubViewer'
import { TableViewer } from './TableViewer'
import { TextViewer } from './TextViewer'
import { VideoViewer } from './VideoViewer'
import type { Viewer, ViewerProps } from './types'
import './viewers.css'

const VIEWERS: Record<ViewedKind, Viewer> = {
  markdown: MarkdownViewer,
  text: TextViewer,
  table: TableViewer,
  image: ImageViewer,
  pdf: PdfViewer,
  directory: DirectoryViewer,
  code: CodeViewer,
  data: DataViewer,
  notebook: NotebookViewer,
  video: VideoViewer,
  audio: AudioViewer,
  docx: DocxViewer,
  xlsx: XlsxViewer,
  pptx: PptxViewer
}

export function viewerFor(item: FileItem): Viewer {
  const view = cardView(item)
  if (view.shows === 'nothing') return view.why === 'tooLarge' ? TooLargeViewer : StubViewer
  if (view.kind === 'code' && isHtmlPage(item.path)) return HtmlViewer
  return VIEWERS[view.kind]
}

/**
 * A viewer keeps what it found out about its file, such as a video that cannot be played, the sheet that is
 * open or the links it blocked, so each file gets a viewer of its own.
 */
export function FileViewer(props: ViewerProps): React.JSX.Element {
  const Component = viewerFor(props.item)
  return <Component key={props.item.path} {...props} />
}

export type { Viewer, ViewerProps } from './types'
