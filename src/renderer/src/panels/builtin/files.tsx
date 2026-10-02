import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { filesLayout, formatBytes, type FileItem, type FilesProps } from '@shared/files'
import type { Translate } from '@shared/i18n'
import { usePanelStore, useToastStore } from '@/state/stores'
import { displayError } from '@/display-error'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, More } from '../primitives/Card'
import { relativeTime } from '../primitives/format'
import { FileViewer } from '../viewers'
import './files.css'
import { useT } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * files card. The layout follows the items themselves: one item shows its viewer, several images become a
 * thumbnail grid, and a mixed set becomes a list. The selected item lives in the panel's props, so that the
 * card and the focus view share it.
 */

const GALLERY_LIMIT: Record<CardContext['size'], number> = { l: 6, m: 4, s: 2, focus: Infinity }
const LIST_LIMIT: Record<CardContext['size'], number> = { l: 8, m: 6, s: 4, focus: Infinity }

const propsOf = (spec: PanelSpec): FilesProps => spec.props as unknown as FilesProps

function itemMeta(item: FileItem, t: Translate): string {
  const parts = [t(`files.kind.${item.kind}`)]
  if (item.kind === 'directory') parts.push(t('files.entries', { count: item.entryCount ?? 0 }))
  else if (item.sizeBytes > 0) parts.push(formatBytes(item.sizeBytes))
  if (item.modifiedAt) parts.push(relativeTime(item.modifiedAt))
  return parts.join(' · ')
}

function useSelect(spec: PanelSpec): (index: number, focus: boolean) => void {
  const apply = usePanelStore((s) => s.apply)
  const setFocused = usePanelStore((s) => s.setFocused)
  return (index, focus) => {
    apply({ op: 'patch', key: spec.key, props: { selected: index } })
    if (focus) setFocused(spec.key)
  }
}

/**
 * Shows the item in Finder or File Explorer. An item that could not be read is not offered, since main reveals
 * only a path it can resolve under a root. One read earlier can still be refused, when its folder is no longer
 * allowed or the file is gone, and the reason is shown.
 */
function Reveal({ item }: { item: FileItem }): React.JSX.Element | null {
  const t = useT()
  const toast = useToastStore((state) => state.push)
  if (item.error) return null
  const os = platformCapabilities().os
  const reveal = (): void => {
    void window.api.revealPath(item.path).catch((error: unknown) => toast({ kind: 'error', title: t(osMessageKey('files.revealFailed', os)), body: displayError(error) }))
  }
  return (
    <Actions>
      <Action leadsTo="outside" onClick={reveal}>{t(osMessageKey('files.reveal', os))}</Action>
    </Actions>
  )
}

function Single({ spec, size, item }: { spec: PanelSpec; size: CardContext['size']; item: FileItem }): React.JSX.Element {
  const t = useT()
  const { title } = propsOf(spec)
  return (
    <div className="card fl" data-size={size} data-layout="single">
      <div className="card-hero">
        <h3 title={item.path}>{title || item.name}</h3>
        <p>
          {title && <b>{item.name} · </b>}
          {itemMeta(item, t)}
        </p>
      </div>
      <FileViewer item={item} mode={size === 'focus' ? 'focus' : 'card'} size={size} />
      <Reveal item={item} />
    </div>
  )
}

function Gallery({ spec, size, items }: { spec: PanelSpec; size: CardContext['size']; items: FileItem[] }): React.JSX.Element {
  const t = useT()
  const { title } = propsOf(spec)
  const select = useSelect(spec)
  const setFocused = usePanelStore((s) => s.setFocused)
  const images = items.filter((item) => !item.error)
  const shown = images.slice(0, GALLERY_LIMIT[size])
  const rest = images.length - shown.length
  return (
    <div className="card fl" data-size={size} data-layout="gallery">
      <div className="card-hero">
        <h3>{title || t('files.gallery.title', { count: images.length })}</h3>
        <p>{title ? t('files.gallery.title', { count: images.length }) : images.map((item) => item.name).slice(0, 3).join(' · ')}</p>
      </div>
      <Box title={t('files.gallery.box')} note={t('files.gallery.boxNote')}>
        <ul className="fl-grid">
          {shown.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                className="fl-thumb"
                onClick={() => select(items.indexOf(item), true)}
                title={item.name}
                aria-label={t('files.gallery.open', { name: item.name })}
              >
                <img src={item.url} alt={item.name} loading="lazy" />
                <span>{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('files.gallery.more')}>
            {t('files.gallery.moreCount', { count: rest })}
          </More>
        )}
      </Box>
    </div>
  )
}

function List({ spec, size, items }: { spec: PanelSpec; size: CardContext['size']; items: FileItem[] }): React.JSX.Element {
  const t = useT()
  const { title } = propsOf(spec)
  const select = useSelect(spec)
  const setFocused = usePanelStore((s) => s.setFocused)
  const shown = items.slice(0, LIST_LIMIT[size])
  const rest = items.length - shown.length
  const failed = items.filter((item) => item.error).length
  return (
    <div className="card fl" data-size={size} data-layout="list">
      <div className="card-hero">
        <h3>{title || t('files.list.title', { count: items.length })}</h3>
        <p>{failed ? t('files.list.countFailed', { count: items.length, failed }) : t('files.list.count', { count: items.length })}</p>
      </div>
      <Box title={t('files.list.box')} note={t('files.list.boxNote')}>
        <ul className="card-rows">
          {shown.map((item, i) => (
            <li key={item.path} className="card-row fl-item" data-error={item.error ? 'true' : undefined}>
              <button type="button" className="card-row-link" onClick={() => select(items.indexOf(item), true)} title={item.path}>
                <span className="card-row-title">{item.name}</span>
                <span className="card-row-meta">{item.error ?? itemMeta(item, t)}</span>
              </button>
              {item.kind === 'image' && item.url && !item.error && <img className="fl-item-thumb" src={item.url} alt="" loading="lazy" aria-hidden />}
              {i === 0 && null}
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('files.list.more')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
    </div>
  )
}

function Focus({ spec, items }: { spec: PanelSpec; items: FileItem[] }): React.JSX.Element {
  const t = useT()
  const { title, selected = 0 } = propsOf(spec)
  const select = useSelect(spec)
  const index = Math.min(Math.max(0, selected), items.length - 1)
  const item = items[index]
  return (
    <div className="card fl" data-size="focus" data-layout="focus">
      <div className="card-hero">
        <h3 title={item.path}>{item.name}</h3>
        <p>
          {title && <b>{title} · </b>}
          {itemMeta(item, t)}
        </p>
      </div>
      <div className="fl-pager">
        <button
          type="button"
          className="fl-pager-button"
          disabled={index === 0}
          onClick={() => select(index - 1, false)}
          aria-label={t('files.focus.previous')}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="fl-pager-count">
          {index + 1} / {items.length}
        </span>
        <button
          type="button"
          className="fl-pager-button"
          disabled={index === items.length - 1}
          onClick={() => select(index + 1, false)}
          aria-label={t('files.focus.next')}
        >
          <ChevronRight size={16} />
        </button>
        <ul className="fl-pager-names">
          {items.map((entry, i) => (
            <li key={entry.path}>
              <button type="button" data-current={i === index ? 'true' : undefined} onClick={() => select(i, false)} title={entry.path}>
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <FileViewer item={item} mode="focus" size="focus" />
      <Reveal item={item} />
    </div>
  )
}

function FilesBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const { items } = propsOf(spec)
  if (!items || items.length === 0) {
    return (
      <div className="card fl" data-size={size}>
        <p className="card-missing" role="status">
          {t('files.loading')}
        </p>
      </div>
    )
  }
  if (items.length === 1) return <Single spec={spec} size={size} item={items[0]} />
  if (size === 'focus') return <Focus spec={spec} items={items} />
  return filesLayout(items) === 'gallery' ? <Gallery spec={spec} size={size} items={items} /> : <List spec={spec} size={size} items={items} />
}

export const filesCard: CardDefinition = {
  Body: FilesBody,
  kicker: 'FILES',
  className: 'fl-card'
}
