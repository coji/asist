import { isExternalLink } from '@shared/external-link'
import { CodeBlock } from './CodeViewer'
import { Frame } from './Frame'
import { MarkdownContent } from './MarkdownViewer'
import type { Viewer } from './types'
import './NotebookViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { openLink } from '@/open-link'

/**
 * A Jupyter notebook (.ipynb, nbformat 4), drawn cell by cell.
 * - A markdown cell is drawn as MarkdownViewer draws it, inside .fv-doc.
 * - A code cell gets highlighted code with its execution count, and its output below (text, an HTML table,
 *   an image or an error).
 * HTML output passes through an allowlist of tags, because reading a pandas table is enough, and ANSI color
 * codes are stripped. A card shows the first 3 cells and the focus view shows all of them.
 */
const CARD_CELLS = 3

export type NotebookOutput =
  | { kind: 'stream'; name: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'error'; ename: string; evalue: string; traceback: string }

export interface NotebookCell {
  type: 'markdown' | 'code' | 'raw'
  source: string
  executionCount: number | null
  outputs: NotebookOutput[]
}

/** A failure carries the JSON parser's own message, or null when the JSON is sound but holds no cells. */
export type ParsedNotebook = { ok: true; language: string; cells: NotebookCell[] } | { ok: false; error: string | null }

const joinSource = (source: unknown): string => (Array.isArray(source) ? source.map(String).join('') : typeof source === 'string' ? source : '')

/** Removes the terminal color codes (ESC[…m) that turn up in traceback and stream output. */
export const stripAnsi = (text: string): string => text.replace(/\[[0-9;]*[A-Za-z]/g, '')

const LANGUAGE_BY_KERNEL: Record<string, string> = { python: 'python', python3: 'python', r: 'r', julia: 'julia', bash: 'bash', javascript: 'javascript', typescript: 'typescript' }

function parseOutput(raw: Record<string, unknown>): NotebookOutput | null {
  switch (raw.output_type) {
    case 'stream':
      return { kind: 'stream', name: String(raw.name ?? 'stdout'), text: stripAnsi(joinSource(raw.text)) }
    case 'error':
      return {
        kind: 'error',
        ename: String(raw.ename ?? ''),
        evalue: String(raw.evalue ?? ''),
        traceback: stripAnsi(Array.isArray(raw.traceback) ? raw.traceback.map(String).join('\n') : '')
      }
    case 'execute_result':
    case 'display_data': {
      const data = (raw.data ?? {}) as Record<string, unknown>
      for (const mime of ['image/png', 'image/jpeg']) {
        if (typeof data[mime] === 'string' || Array.isArray(data[mime])) return { kind: 'image', mime, data: joinSource(data[mime]).replace(/\s+/g, '') }
      }
      if (data['text/html'] !== undefined) return { kind: 'html', html: joinSource(data['text/html']) }
      if (data['text/plain'] !== undefined) return { kind: 'text', text: stripAnsi(joinSource(data['text/plain'])) }
      return null
    }
    default:
      return null
  }
}

export function parseNotebook(text: string): ParsedNotebook {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: displayError(error) }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { cells?: unknown }).cells)) return { ok: false, error: null }
  const notebook = raw as { cells: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }
  const info = (notebook.metadata?.language_info as { name?: string } | undefined)?.name ?? (notebook.metadata?.kernelspec as { language?: string } | undefined)?.language ?? 'python'
  const language = LANGUAGE_BY_KERNEL[info.toLowerCase()] ?? info.toLowerCase()
  const cells: NotebookCell[] = notebook.cells.map((cell) => ({
    type: cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'code' ? 'code' : 'raw',
    source: joinSource(cell.source),
    executionCount: typeof cell.execution_count === 'number' ? cell.execution_count : null,
    outputs: Array.isArray(cell.outputs) ? cell.outputs.map((o) => parseOutput(o as Record<string, unknown>)).filter((o): o is NotebookOutput => o !== null) : []
  }))
  return { ok: true, language, cells }
}

/** The tags that pass: tables and text decoration only. Of the attributes, only cell spans and an http link target are kept. */
const ALLOWED_TAGS = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 'code', 'pre', 'small', 'sub', 'sup',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote', 'hr'
])
const ALLOWED_ATTRS: Record<string, Set<string>> = { td: new Set(['colspan', 'rowspan']), th: new Set(['colspan', 'rowspan']), a: new Set(['href']) }

/**
 * A tag outside the allowlist is unwrapped and its content kept, while script and style go with their content.
 * A link the app does not open keeps its text but is not drawn as a link.
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out = document.createElement('div')
  const walk = (from: Node, to: Node): void => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style') continue
      if (!ALLOWED_TAGS.has(tag)) {
        walk(el, to)
        continue
      }
      const clean = document.createElement(tag)
      for (const attr of ALLOWED_ATTRS[tag] ?? []) {
        const value = el.getAttribute(attr)
        if (value === null) continue
        if (attr === 'href' && !isExternalLink(value)) continue
        clean.setAttribute(attr, value)
      }
      if (tag === 'a' && !clean.hasAttributes()) {
        walk(el, to)
        continue
      }
      walk(el, clean)
      to.appendChild(clean)
    }
  }
  walk(doc.body, out)
  return out.innerHTML
}

function Output({ output }: { output: NotebookOutput }): React.JSX.Element {
  const t = useT()
  switch (output.kind) {
    case 'stream':
      return (
        <pre className="fv-nb-output fv-mono" data-kind="stream" data-name={output.name}>
          {output.text}
        </pre>
      )
    case 'text':
      return (
        <pre className="fv-nb-output fv-mono" data-kind="text">
          {output.text}
        </pre>
      )
    case 'html':
      return (
        <div
          className="fv-nb-output fv-doc"
          data-kind="html"
          onClick={(event) => {
            const anchor = (event.target as HTMLElement).closest('a[href]')
            if (!anchor) return
            event.preventDefault()
            openLink(anchor.getAttribute('href')!)
          }}
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(output.html) }}
        />
      )
    case 'image':
      return (
        <div className="fv-nb-output" data-kind="image">
          <img src={`data:${output.mime};base64,${output.data}`} alt={t('files.viewer.notebookOutputImage')} />
        </div>
      )
    case 'error':
      return (
        <pre className="fv-nb-output fv-mono" data-kind="error">
          {output.traceback || `${output.ename}: ${output.evalue}`}
        </pre>
      )
  }
}

function Cell({ cell, language }: { cell: NotebookCell; language: string }): React.JSX.Element {
  const t = useT()
  if (cell.type === 'markdown') {
    return (
      <section className="fv-nb-cell fv-doc" data-type="markdown">
        <MarkdownContent text={cell.source} />
      </section>
    )
  }
  if (cell.type === 'raw') {
    return (
      <section className="fv-nb-cell" data-type="raw">
        <pre className="fv-mono">{cell.source}</pre>
      </section>
    )
  }
  return (
    <section className="fv-nb-cell" data-type="code">
      <div className="fv-nb-source">
        <span className="fv-nb-count" title={t('files.viewer.notebookExecutionCount')}>
          [{cell.executionCount ?? ' '}]
        </span>
        <CodeBlock text={cell.source} language={language} />
      </div>
      {cell.outputs.map((output, i) => (
        <Output key={i} output={output} />
      ))}
    </section>
  )
}

export const NotebookViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const parsed = parseNotebook(item.text ?? '')
  if (!parsed.ok) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {parsed.error === null ? t('files.viewer.notebookShape') : t('files.viewer.notebookFailed', { message: parsed.error })}
        </p>
      </Frame>
    )
  }
  const shown = mode === 'card' ? parsed.cells.slice(0, CARD_CELLS) : parsed.cells
  const rest = parsed.cells.length - shown.length
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-nb">
        {shown.map((cell, i) => (
          <Cell key={i} cell={cell} language={parsed.language} />
        ))}
        {rest > 0 && <p className="fv-note">{t('files.viewer.notebookCells', { count: rest })}</p>}
      </div>
    </Frame>
  )
}
