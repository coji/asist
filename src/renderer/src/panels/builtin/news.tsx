import { MessageCircle } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'
import { sendTypedMessage } from '@/conversation'
import { tConversation, useT } from '@/i18n'
import { openLink } from '@/open-link'
import { usePanelStore } from '@/state/stores'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, More, Row } from '../primitives/Card'
import { relativeTime } from '../primitives/format'
import './news.css'

interface NewsItem {
  title: string
  url: string
  date?: string
  source?: string
}
interface NewsProps {
  topic: string
  items: NewsItem[]
}

const LIMIT: Record<CardContext['size'], number> = { l: 6, m: 5, s: 4, focus: Infinity }
const propsOf = (spec: PanelSpec): NewsProps => spec.props as unknown as NewsProps
const publishedAt = (item: NewsItem): number | null => {
  const at = item.date ? Date.parse(item.date) : NaN
  return Number.isNaN(at) ? null : at
}

function NewsBody({ spec, size }: CardContext): React.JSX.Element {
  const { topic, items } = propsOf(spec)
  const setFocused = usePanelStore((s) => s.setFocused)
  const t = useT()
  const shown = items.slice(0, LIMIT[size])
  const rest = items.length - shown.length
  const latest = items.map(publishedAt).filter((at): at is number => at !== null).sort((a, b) => b - a)[0]
  return (
    <div className="card nw" data-size={size}>
      <div className="card-hero">
        <h3>{topic && topic !== NEWS_TOP_TOPIC ? t('cardsInfo.news.heading', { topic }) : t('cardsInfo.news.topHeading')}</h3>
        <p>
          {latest === undefined
            ? t('cardsInfo.news.count', { count: items.length })
            : t('cardsInfo.news.countWithLatest', { count: items.length, latest: relativeTime(latest) })}
        </p>
      </div>
      <Box title={t('cardsInfo.news.headlines')} note={t('cardsInfo.opensInBrowser')}>
        <ul className="card-rows">
          {shown.map((item, i) => {
            const at = publishedAt(item)
            const meta = [item.source, at === null ? null : relativeTime(at)].filter(Boolean).join(' · ')
            return (
              <Row
                key={item.url + i}
                index={i + 1}
                aside={
                  <button
                    type="button"
                    className="card-icon-button"
                    onClick={(event) => {
                      // The second click of a double click asks nothing more.
                      if (event.detail <= 1) void sendTypedMessage(tConversation('spoken.ask.news', { title: item.title }))
                    }}
                    title={t('cardsInfo.news.ask')}
                    aria-label={t('cardsInfo.news.ask')}
                  >
                    <MessageCircle size={13} />
                  </button>
                }
              >
                <button type="button" className="card-row-link" onClick={() => openLink(item.url)}>
                  <span className="card-row-title">{item.title}</span>
                  {meta && <span className="card-row-meta">{meta}</span>}
                </button>
              </Row>
            )
          })}
        </ul>
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('cardsInfo.news.showRest')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
    </div>
  )
}

export const newsCard: CardDefinition = {
  Body: NewsBody,
  kicker: 'NEWS',
  className: 'nw-card'
}
