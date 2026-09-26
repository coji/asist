import { useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { baseName } from '@shared/file-path'
import { Frame } from './Frame'
import type { Viewer } from './types'
import './CodeViewer.css'
import { useT } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * Source code with line numbers. Only the languages that are opened often are registered on highlight.js's
 * core, because bundling every language adds several hundred KB to the renderer. The colors are the theme's
 * --code-* tokens (themes.css), not a highlight.js theme. A card shows the first 60 lines and the focus view shows all of them. Data files
 * (json, yaml and so on) and a notebook's code cells use this same CodeBlock.
 */
const CARD_LINES = 60

const LANGUAGES: Record<string, (hljsApi: typeof hljs) => unknown> = {
  bash,
  c,
  cpp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml
}
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition as Parameters<typeof hljs.registerLanguage>[1])

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.zsh': 'bash',
  '.bash': 'bash',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.plist': 'xml',
  '.vue': 'xml',
  '.svelte': 'xml',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.php': 'php',
  '.json': 'json',
  '.jsonl': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.dockerfile': 'dockerfile',
  '.makefile': 'makefile'
}

/** Picks the highlight.js language from the file name. An extension with no entry gives null, which stays plain monospace. */
export function languageFor(fileName: string): string | null {
  const name = baseName(fileName).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return LANGUAGE_BY_EXT[name.slice(dot)] ?? null
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Splits highlighted HTML into lines. A span that runs across lines, such as a comment or a template literal,
 * is closed at the end of a line and opened again at the start of the next, so that each line is HTML that
 * stands on its own.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let current = ''
  const tokens = html.split(/(<span[^>]*>|<\/span>|\n)/)
  for (const token of tokens) {
    if (token === '') continue
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length))
      current = open.join('')
    } else if (token.startsWith('<span')) {
      open.push(token)
      current += token
    } else if (token === '</span>') {
      open.pop()
      current += token
    } else {
      current += token
    }
  }
  lines.push(current + '</span>'.repeat(open.length))
  return lines
}

/** Turns the text into one HTML string per line. Without a language it is only escaped. */
export function highlightLines(text: string, language: string | null): string[] {
  if (!language || !hljs.getLanguage(language)) return text.split('\n').map(escapeHtml)
  return splitHighlightedHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value)
}

export function CodeBlock({ text, language, maxLines = Infinity }: { text: string; language: string | null; maxLines?: number }): React.JSX.Element {
  const t = useT()
  const allLines = text.split('\n')
  const shownText = allLines.length > maxLines ? allLines.slice(0, maxLines).join('\n') : text
  const lines = useMemo(() => highlightLines(shownText, language), [shownText, language])
  const rest = allLines.length - lines.length
  const width = String(allLines.length).length
  return (
    <div className="fv-code" data-language={language ?? undefined} style={{ '--fv-code-gutter': `${width}ch` } as React.CSSProperties}>
      <ol className="fv-code-lines">
        {lines.map((html, i) => (
          <li key={i} className="fv-code-line">
            <span className="fv-code-no" aria-hidden>
              {i + 1}
            </span>
            <span className="fv-code-text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
          </li>
        ))}
      </ol>
      {rest > 0 && <p className="fv-note">{t('files.viewer.moreLines', { count: rest })}</p>}
    </div>
  )
}

export const CodeViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  return (
    <Frame mode={mode} size={size}>
      <CodeBlock text={item.text ?? ''} language={languageFor(item.name)} maxLines={mode === 'card' ? CARD_LINES : Infinity} />
      {item.truncated && <p className="fv-note">{t(osMessageKey('files.viewer.truncatedOpen', platformCapabilities().os))}</p>}
    </Frame>
  )
}
