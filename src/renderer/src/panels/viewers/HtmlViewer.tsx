import { useState } from 'react'
import { CodeBlock, languageFor } from './CodeViewer'
import { Frame } from './Frame'
import type { Viewer, ViewerProps } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import './HtmlViewer.css'
import { useT } from '@/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * An HTML page, rendered by default and switchable to its highlighted source. The page is loaded from its
 * own URL rather than from srcdoc: a srcdoc document inherits the app's policy, which blocks inline
 * scripts, and it has no address for its relative links to resolve against. The main process serves the
 * page with a policy of its own (documentPolicy in file-protocol.ts), confined to the page's folder, and
 * refuses any navigation out of the frame, so a link in the page opens nothing; a user who wants to follow
 * one opens the page's file in the browser themselves.
 */

/**
 * The iframe's sandbox. Without allow-same-origin the page has an opaque origin and cannot touch the app's
 * page or window.api; without allow-top-navigation it cannot move the app's window; without allow-popups,
 * allow-forms and allow-modals it opens no window, submits nothing and cannot block the app with a dialog.
 */
export const PAGE_SANDBOX = 'allow-scripts'

/** The URL is fetched once before the frame is shown, because a frame reports no failure to its parent. */
const reachable = async (): Promise<true> => true

type View = 'page' | 'source'

export const HtmlViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const [view, setView] = useState<View>('page')
  return (
    <Frame mode={mode} size={size} className="fv-html">
      <ul className="fv-html-tabs" role="tablist">
        {(['page', 'source'] as const).map((entry) => (
          <li key={entry}>
            <button type="button" role="tab" aria-selected={entry === view} data-current={entry === view ? 'true' : undefined} onClick={() => setView(entry)}>
              {t(entry === 'page' ? 'files.viewer.htmlPage' : 'files.viewer.htmlSource')}
            </button>
          </li>
        ))}
      </ul>
      {view === 'page' ? (
        <Page item={item} />
      ) : (
        <>
          <CodeBlock text={item.text ?? ''} language={languageFor(item.name)} maxLines={mode === 'card' ? 60 : Infinity} />
          {item.truncated && <p className="fv-note">{t(osMessageKey('files.viewer.truncatedOpen', platformCapabilities().os))}</p>}
        </>
      )}
    </Frame>
  )
}

function Page({ item }: { item: ViewerProps['item'] }): React.JSX.Element {
  const t = useT()
  const checked = useParsedBytes(item, reachable)

  if (checked.status === 'loading') return <p className="fv-note">{t('files.viewer.loading')}</p>
  if (checked.status === 'error') {
    return (
      <p className="fv-note" data-tone="error">
        {checked.message}
      </p>
    )
  }
  return <iframe className="fv-html-page" src={item.url} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" title={item.name} />
}
