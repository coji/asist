import { useEffect, useRef, useState } from 'react'
import { isExternalLink } from '@shared/external-link'
import { CodeBlock, languageFor } from './CodeViewer'
import { Frame } from './Frame'
import { Action, Actions } from '../primitives/Card'
import type { Viewer, ViewerProps } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import './HtmlViewer.css'
import { useT } from '@/i18n'
import { openLink } from '@/open-link'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * An HTML page, rendered by default and switchable to its highlighted source. The page is loaded from its
 * own URL rather than from srcdoc: a srcdoc document inherits the app's policy, which blocks inline
 * scripts, and it has no address for its relative links to resolve against. The main process serves the
 * page with a policy of its own (HTML_PAGE_POLICY in file-protocol.ts), and the app's frame-src lets a
 * frame show asist-file:// and Google Maps only, so a link to a remote site is blocked instead of opening
 * inside the app; the note then offers it to the default browser.
 */

/**
 * The iframe's sandbox. Without allow-same-origin the page has an opaque origin and cannot touch the app's
 * page or window.api; without allow-top-navigation it cannot move the app's window; without allow-popups,
 * allow-forms and allow-modals it opens no window, submits nothing and cannot block the app with a dialog.
 */
export const PAGE_SANDBOX = 'allow-scripts'

/** The URL is fetched once before the frame is shown, because a frame reports no failure to its parent. */
const reachable = async (): Promise<true> => true

/**
 * How soon after a frame-src violation the frame's next load counts as the error page of the blocked
 * navigation. The two arrive within a few milliseconds of each other.
 */
const VIOLATION_TO_LOAD_MS = 2000

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
  const [blocked, setBlocked] = useState<string | null>(null)
  const violation = useRef<{ url: string; at: number } | null>(null)

  // The app's frame-src violation is reported to the whole document with no frame attached, so it is
  // matched to this frame by the error page the blocked navigation then loads into it.
  useEffect(() => {
    const onViolation = (event: SecurityPolicyViolationEvent): void => {
      if (event.effectiveDirective === 'frame-src') violation.current = { url: event.blockedURI, at: performance.now() }
    }
    document.addEventListener('securitypolicyviolation', onViolation)
    return () => document.removeEventListener('securitypolicyviolation', onViolation)
  }, [])
  const onLoad = (): void => {
    const last = violation.current
    violation.current = null
    if (last && performance.now() - last.at < VIOLATION_TO_LOAD_MS) setBlocked(last.url)
  }

  if (checked.status === 'loading') return <p className="fv-note">{t('files.viewer.loading')}</p>
  if (checked.status === 'error') {
    return (
      <p className="fv-note" data-tone="error">
        {checked.message}
      </p>
    )
  }
  if (blocked !== null) {
    return (
      <div className="fv-html-blocked">
        <p className="fv-note">{t('files.viewer.htmlLinkBlocked', { url: blocked })}</p>
        <Actions>
          {isExternalLink(blocked) && (
            <Action leadsTo="outside" onClick={() => openLink(blocked)}>
              {t('files.viewer.htmlOpenLink')}
            </Action>
          )}
          <Action onClick={() => setBlocked(null)}>{t('files.viewer.htmlBack')}</Action>
        </Actions>
      </div>
    )
  }
  return <iframe className="fv-html-page" src={item.url} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" title={item.name} onLoad={onLoad} />
}
