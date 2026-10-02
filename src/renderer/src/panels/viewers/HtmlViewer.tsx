import { useState } from 'react'
import { CodeBlock, languageFor } from './CodeViewer'
import { Frame } from './Frame'
import { PageView } from './PageView'
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
 * page with a policy of its own (documentPolicy in file-protocol.ts), confined to the page's folder, shows it
 * in a session that reaches no network and refuses any navigation the page starts, so a link in the page
 * opens nothing; a user who wants to follow one opens the page's file in the browser themselves.
 */

/** The URL is fetched once before the page is shown, because a webview's page reports no HTTP error to the app. */
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
  return <PageView url={item.url} title={item.name} />
}
