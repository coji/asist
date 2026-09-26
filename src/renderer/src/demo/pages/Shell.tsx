import { UI_LOCALES, UI_LOCALE_NAMES, type UiLocale } from '@shared/i18n'
import type { OsFamily } from '@shared/platform'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_THEME, isThemeName, THEMES, type ThemeName } from '@/themes'
import { CATALOG, findEntry, type CatalogEntry } from '../catalog'
import { DEFAULT_DEMO_OS, DEMO_OSES, demoOs } from '../platform'
import { previewPath, resolveDemoRoute, I18N_PATH } from '../routes'
import WINDOW_SIZES from '../window-sizes.json'
import './shell.css'

/**
 * The shell of the demo: the list of samples on the left, and on the right an iframe showing the
 * selected one.
 *
 * - Choosing from the list changes the URL through pushState and rebuilds only the iframe; the shell
 *   itself is not reloaded.
 * - Every choice loads the sample as a fresh page. Some samples, such as the first-run setup, write to
 *   the mock API and to the stores, so switching inside one page would leave the previous sample's
 *   state behind.
 * - A screen can be shown at one of the app's window sizes (l / m / s), scaled down when it does not
 *   fit into the frame.
 */

type SizeName = keyof typeof WINDOW_SIZES
type Size = SizeName | 'fit'
const SIZE_NAMES = Object.keys(WINDOW_SIZES) as SizeName[]

const SOURCE_LOCALE: UiLocale = 'ja-JP'

interface Selection {
  entry: CatalogEntry
  size: Size
  /** The interface language the sample is drawn in. */
  locale: UiLocale
  theme: ThemeName
  /** The OS whose capabilities the sample is drawn with. */
  os: OsFamily
}

/** Reads the selection from the current URL. An unknown path or size throws rather than quietly showing another sample. */
function readSelection(): Selection {
  const route = resolveDemoRoute(location.pathname)
  const entry = route.kind === 'shell' ? findEntry(route.entry) : undefined
  if (!entry) throw new Error(`demo に ${location.pathname} という見本はありません`)
  const params = new URLSearchParams(location.search)
  const size = params.get('size') ?? 'fit'
  const lang = params.get('lang') ?? SOURCE_LOCALE
  if (!UI_LOCALES.includes(lang as UiLocale)) throw new Error(`画面の言語は ${UI_LOCALES.join(' / ')} で指定します: ${lang}`)
  const theme = params.get('theme') ?? DEFAULT_THEME
  if (!isThemeName(theme)) throw new Error(`テーマは ${THEMES.join(' / ')} で指定します: ${theme}`)
  if (size !== 'fit' && !SIZE_NAMES.includes(size as SizeName)) throw new Error(`ウィンドウの大きさは ${SIZE_NAMES.join(' / ')} で指定します: ${size}`)
  return { entry, size: entry.sized ? (size as Size) : 'fit', locale: lang as UiLocale, theme, os: demoOs(location.search) }
}

/** The query of a selection. The defaults are left out, so the URL of the usual view stays a plain path. */
function queryOf({ size, locale, theme, os }: Selection): string {
  const params = new URLSearchParams()
  if (size !== 'fit') params.set('size', size)
  if (locale !== SOURCE_LOCALE) params.set('lang', locale)
  if (theme !== DEFAULT_THEME) params.set('theme', theme)
  if (os !== DEFAULT_DEMO_OS) params.set('os', os)
  return params.size > 0 ? `?${params}` : ''
}

/** The query the sample in the iframe is opened with. The window size belongs to the frame, not to the sample. */
const previewQueryOf = (selection: Selection): string => queryOf({ ...selection, size: 'fit' })

const urlOf = (selection: Selection): string => `${selection.entry.path}${queryOf(selection)}`

export function Shell(): React.JSX.Element {
  const [selection, setSelection] = useState(readSelection)
  const [filter, setFilter] = useState('')
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    const onPop = (): void => setSelection(readSelection())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // The list is long, so it is scrolled until the row of the open sample is visible.
  useEffect(() => {
    document.querySelector('.demo-side a[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [selection.entry])

  const select = (next: Selection): void => {
    history.pushState(null, '', urlOf(next))
    setSelection(next)
  }
  /** A click with a modifier key, such as one that opens a new tab, is left to the browser. */
  const onLink = (event: React.MouseEvent, next: Selection): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    select(next)
  }

  const query = filter.trim().toLowerCase()
  const groups = CATALOG.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => !query || `${group.label} ${entry.label} ${entry.note ?? ''} ${entry.path}`.toLowerCase().includes(query))
  })).filter((group) => group.entries.length > 0)
  const src = `${previewPath(selection.entry.path)}${previewQueryOf(selection)}`

  return (
    <div className="demo-shell">
      <aside className="demo-side">
        <h1>ASIST · DEMO</h1>
        <a className="demo-i18n" href={I18N_PATH}>文言の一覧</a>
        <input className="demo-filter" type="search" placeholder="絞り込む" aria-label="見本を絞り込む" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <nav aria-label="見本">
          {groups.map((group) => (
            <section key={group.label}>
              <h2>{group.label}</h2>
              {group.entries.map((entry) => {
                const next = { ...selection, entry }
                return (
                  <a key={entry.path} href={urlOf(next)} aria-current={entry.path === selection.entry.path ? 'page' : undefined} onClick={(event) => onLink(event, next)}>
                    {entry.label}
                    {entry.note && <small>{entry.note}</small>}
                  </a>
                )
              })}
            </section>
          ))}
          {groups.length === 0 && <p className="demo-empty">当てはまる見本がありません</p>}
        </nav>
      </aside>

      <div className="demo-main">
        <header className="demo-bar">
          <code>{selection.entry.path}</code>
          {selection.entry.sized && (
            <div className="demo-sizes" role="group" aria-label="ウィンドウの大きさ">
              {(['fit', ...SIZE_NAMES] as Size[]).map((size) => (
                <button key={size} type="button" aria-pressed={selection.size === size} onClick={() => select({ ...selection, size })}>
                  {size === 'fit' ? '枠に合わせる' : `${size} ${WINDOW_SIZES[size].join('×')}`}
                </button>
              ))}
            </div>
          )}
          <select className="demo-locale" aria-label="画面の言語" value={selection.locale} onChange={(event) => select({ ...selection, locale: event.target.value as UiLocale })}>
            {UI_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {UI_LOCALE_NAMES[locale]}
              </option>
            ))}
          </select>
          <select className="demo-locale" aria-label="テーマ" value={selection.theme} onChange={(event) => select({ ...selection, theme: event.target.value as ThemeName })}>
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {theme}
              </option>
            ))}
          </select>
          <select className="demo-locale" aria-label="OS" value={selection.os} onChange={(event) => select({ ...selection, os: event.target.value as OsFamily })}>
            {DEMO_OSES.map((os) => (
              <option key={os} value={os}>
                {os}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setReloads((count) => count + 1)}>
            読み込み直す
          </button>
          <a href={src} target="_blank" rel="noreferrer">
            単体で開く ↗
          </a>
        </header>
        {/* Changing the key rebuilds the iframe. Changing only src would push the iframe's navigation onto
            the history, and going back would then take two presses. */}
        <Stage key={`${src}:${reloads}`} src={src} title={selection.entry.label} size={selection.size} />
      </div>
    </div>
  )
}

/** The frame that shows a sample. At a fixed window size it is scaled down until it fits the frame. */
function Stage({ src, title, size }: { src: string; title: string; size: Size }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const fixed = size === 'fit' ? null : WINDOW_SIZES[size]
  const [width, height] = fixed ?? [0, 0]

  useLayoutEffect(() => {
    const stage = ref.current
    if (!stage || !fixed) return
    const fit = (): void => setScale(Math.min(1, stage.clientWidth / width, stage.clientHeight / height))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [fixed, width, height])

  if (!fixed) {
    return (
      <div className="demo-stage" ref={ref}>
        <iframe src={src} title={title} />
      </div>
    )
  }
  return (
    <div className="demo-stage is-fixed" ref={ref}>
      <div className="demo-frame" style={{ width: width * scale, height: height * scale }}>
        <iframe src={src} title={title} style={{ width, height, transform: `scale(${scale})` }} />
      </div>
      <p className="demo-scale">
        {width}×{height}
        {scale < 1 && ` を ${Math.round(scale * 100)}% に縮めて映しています`}
      </p>
    </div>
  )
}
