import { useState } from 'react'
import { CodeBlock, languageFor } from './CodeViewer'
import { Frame } from './Frame'
import type { Viewer } from './types'
import './DataViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * Data files. json and jsonl are parsed into a tree that folds, while the other formats (yaml, toml, ini,
 * env, xml, plist) are drawn as highlighted code and not parsed at all, because being readable is enough. In
 * a card the tree folds from depth 2 on and in the focus view it is fully open. A broken json keeps the
 * highlighted code, with the reason above it.
 */
const CARD_COLLAPSE_DEPTH = 2
const CARD_CHILDREN = 100
const FOCUS_CHILDREN = 1000

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ParsedData = { ok: true; value: JsonValue } | { ok: false; error: string }

/** A .json file is parsed whole, while a .jsonl file is parsed line by line into an array. */
export function parseData(text: string, fileName: string): ParsedData {
  try {
    if (fileName.toLowerCase().endsWith('.jsonl')) {
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      return { ok: true, value: lines.map((line) => JSON.parse(line) as JsonValue) }
    }
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch (error) {
    return { ok: false, error: displayError(error) }
  }
}

export type ValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export function typeOf(value: JsonValue): ValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as 'object' | 'string' | 'number' | 'boolean'
}

export const isContainer = (value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } => typeof value === 'object' && value !== null

/** The number of children: the number of keys of an object, or the length of an array. */
export function childCount(value: JsonValue): number {
  if (!isContainer(value)) return 0
  return Array.isArray(value) ? value.length : Object.keys(value).length
}

/** The summary shown while a node is folded: "[3]" for an array and "{2}" for an object. */
export function summaryOf(value: JsonValue): string {
  const count = childCount(value)
  return Array.isArray(value) ? `[${count}]` : `{${count}}`
}

/** Whether a node is open by default: in a card only below depth 2, and in the focus view always. */
export const openByDefault = (depth: number, mode: 'card' | 'focus'): boolean => mode === 'focus' || depth < CARD_COLLAPSE_DEPTH

function Scalar({ value }: { value: JsonValue }): React.JSX.Element {
  const type = typeOf(value)
  return (
    <span className="fv-data-value" data-type={type}>
      {type === 'string' ? JSON.stringify(value) : String(value)}
    </span>
  )
}

function Node({
  name,
  value,
  depth,
  path,
  mode,
  overrides,
  toggle
}: {
  name: string | null
  value: JsonValue
  depth: number
  path: string
  mode: 'card' | 'focus'
  overrides: Record<string, boolean>
  toggle: (path: string) => void
}): React.JSX.Element {
  const t = useT()
  const container = isContainer(value)
  const open = overrides[path] ?? openByDefault(depth, mode)
  const label = name !== null && <span className="fv-data-key">{name}</span>
  if (!container) {
    return (
      <li className="fv-data-node" data-type={typeOf(value)}>
        {label}
        {name !== null && <span className="fv-data-colon">: </span>}
        <Scalar value={value} />
      </li>
    )
  }
  const entries = Array.isArray(value) ? value.map((child, i) => [String(i), child] as const) : Object.entries(value)
  const limit = mode === 'card' ? CARD_CHILDREN : FOCUS_CHILDREN
  const shown = entries.slice(0, limit)
  const rest = entries.length - shown.length
  return (
    <li className="fv-data-node" data-type={typeOf(value)} data-open={open ? 'true' : 'false'}>
      <button type="button" className="fv-data-toggle" onClick={() => toggle(path)} aria-expanded={open}>
        <span className="fv-data-arrow" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {name !== null ? <span className="fv-data-key">{name}</span> : <span className="fv-data-key fv-data-root">{Array.isArray(value) ? '[]' : '{}'}</span>}
        <span className="fv-data-count">{summaryOf(value)}</span>
      </button>
      {open && (
        <ul className="fv-data-children">
          {shown.map(([key, child]) => (
            <Node key={key} name={key} value={child} depth={depth + 1} path={`${path}/${key}`} mode={mode} overrides={overrides} toggle={toggle} />
          ))}
          {rest > 0 && <li className="fv-data-node fv-note">{t('common.more', { count: rest })}</li>}
        </ul>
      )}
    </li>
  )
}

export function JsonTree({ value, mode }: { value: JsonValue; mode: 'card' | 'focus' }): React.JSX.Element {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const toggle = (path: string): void =>
    setOverrides((prev) => {
      const depth = path.split('/').length - 1
      const current = prev[path] ?? openByDefault(depth, mode)
      return { ...prev, [path]: !current }
    })
  return (
    <ul className="fv-data-tree">
      <Node name={null} value={value} depth={0} path="" mode={mode} overrides={overrides} toggle={toggle} />
    </ul>
  )
}

const isJson = (name: string): boolean => /\.jsonl?$/i.test(name)

export const DataViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const text = item.text ?? ''
  const language = languageFor(item.name)
  const truncatedNote = item.truncated && <p className="fv-note">{t(osMessageKey('files.viewer.truncatedOpen', platformCapabilities().os))}</p>
  if (!isJson(item.name)) {
    return (
      <Frame mode={mode} size={size}>
        <CodeBlock text={text} language={language} maxLines={mode === 'card' ? 60 : Infinity} />
        {truncatedNote}
      </Frame>
    )
  }
  const parsed = parseData(text, item.name)
  if (!parsed.ok) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {item.truncated ? t('files.viewer.jsonTruncated') : t('files.viewer.jsonFailed', { message: parsed.error })}
        </p>
        <CodeBlock text={text} language="json" maxLines={mode === 'card' ? 60 : Infinity} />
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size}>
      {/* The default folding differs between card and focus, so the remembered toggles are kept per mode. */}
      <JsonTree key={mode} value={parsed.value} mode={mode} />
    </Frame>
  )
}
