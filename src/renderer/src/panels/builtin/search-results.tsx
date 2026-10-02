import { MessageCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { PanelSpec } from '@shared/ipc'
import { sendTypedMessage } from '@/conversation'
import { tConversation, useT } from '@/i18n'
import { openLink } from '@/open-link'
import { usePanelStore } from '@/state/stores'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, More, Row } from '../primitives/Card'
import { hostOf } from '../primitives/format'
import './search-results.css'

/** Web search results card. The shell puts it up by itself after a web_search. */

interface SearchResult {
  title: string
  url: string
  site?: string
  cited?: boolean
  snippet?: string
}
interface SearchProps {
  query: string
  results: SearchResult[]
  suggestions?: string
}

/** At l the rows carry an excerpt, so four of them stay within 720px; five would make a body of about 690px. */
const LIMIT: Record<CardContext['size'], number> = { l: 4, m: 4, s: 3, focus: Infinity }
const propsOf = (spec: PanelSpec): SearchProps => spec.props as unknown as SearchProps

/**
 * Google's Search Suggestions, exactly as the Gemini API returned them. The Gemini API terms allow no
 * change to the block, so it is put into a shadow root, where its own stylesheet applies and the
 * card's does not. A chip is a plain link, which would navigate the app's window, so the click goes
 * to the browser instead.
 */
function SearchSuggestions({ html }: { html: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    root.innerHTML = html
    const onClick = (event: Event): void => {
      const link = (event.target as Element | null)?.closest('a[href]')
      if (!(link instanceof HTMLAnchorElement)) return
      event.preventDefault()
      openLink(link.href)
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [html])
  return <div ref={host} className="sr-suggestions" />
}

function SearchResultsBody({ spec, size }: CardContext): React.JSX.Element {
  const { query, results, suggestions } = propsOf(spec)
  const setFocused = usePanelStore((s) => s.setFocused)
  const t = useT()
  const shown = results.slice(0, LIMIT[size])
  const rest = results.length - shown.length
  const withSnippet = size === 'l' || size === 'focus'
  const metaOf = (result: SearchResult): string => {
    const site = result.site ?? hostOf(result.url)
    return [...(site === result.title ? [] : [site]), ...(result.cited ? [t('cardsInfo.search.cited')] : [])].join(' · ')
  }
  return (
    <div className="card sr" data-size={size}>
      <div className="card-hero">
        <h3>{query ? t('cardsInfo.search.heading', { query }) : t('cardsInfo.search.results')}</h3>
        <p>{t('cardsInfo.search.count', { count: results.length })}</p>
      </div>
      <Box title={t('cardsInfo.search.results')} note={t('cardsInfo.opensInBrowser')}>
        <ul className="card-rows">
          {shown.map((result, i) => (
            <Row
              key={result.url + i}
              index={i + 1}
              className={result.cited ? 'is-cited' : undefined}
              aside={
                <button
                  type="button"
                  className="card-icon-button"
                  onClick={(event) => {
                    // The second click of a double click asks nothing more.
                    if (event.detail <= 1) void sendTypedMessage(tConversation('spoken.ask.searchResult', { title: result.title }))
                  }}
                  title={t('cardsInfo.search.ask')}
                  aria-label={t('cardsInfo.search.ask')}
                >
                  <MessageCircle size={13} />
                </button>
              }
            >
              <button type="button" className="card-row-link" onClick={() => openLink(result.url)}>
                <span className="card-row-title">{result.title}</span>
                {metaOf(result) && <span className="card-row-meta">{metaOf(result)}</span>}
                {withSnippet && result.snippet && <span className="sr-snippet">{result.snippet}</span>}
              </button>
            </Row>
          ))}
        </ul>
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('cardsInfo.search.showRest')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
      {suggestions && <SearchSuggestions html={suggestions} />}
    </div>
  )
}

export const searchResultsCard: CardDefinition = {
  Body: SearchResultsBody,
  kicker: 'WEB SEARCH',
  className: 'sr-card'
}
