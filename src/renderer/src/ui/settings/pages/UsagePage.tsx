import { useEffect, useMemo, useState } from 'react'
import { localDate, usageItemKey, type UsageDay, type UsageItem } from '@shared/api-usage'
import { modelName, type LlmProvider } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import { OTHER_SERIES, modelSeriesId, usageReport, type UsageGrouping } from '@shared/usage-report'
import type { Translate } from '@shared/i18n'
import { useFormatLocale, useT } from '@/i18n'
import { displayError } from '@/display-error'
import { Chip, Group, Page, Row } from '../primitives'
import { UsageChart } from '../UsageChart'
import { usdFormatter } from '../usage-format'
import type { SettingsContext } from '../context'

/** The costs page: what the paid APIs cost per day, as a stacked chart and a table of the same numbers. */

const RANGES = [7, 30, 90] as const
type Range = (typeof RANGES)[number]

const LIVE_MODEL_LABELS = new Map(Object.values(LIVE_ENGINE_INFO).flatMap((info) => info.models.map((m) => [m.id, m.label] as const)))

function seriesLabel(t: Translate, id: string): string {
  if (id === 'llm' || id === 'live' || id === 'agent') return t(`settingsUsage.kinds.${id}`)
  if (id === OTHER_SERIES) return t('settingsUsage.other')
  const [kind, owner, ...rest] = id.split(':')
  const model = rest.join(':')
  if (kind === 'llm') return modelName({ provider: owner as LlmProvider, id: model })
  if (kind === 'live') return LIVE_MODEL_LABELS.get(model) ?? model
  return 'Claude Code'
}

export function UsagePage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const [days, setDays] = useState<UsageDay[] | null>(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState<Range>(30)
  const [grouping, setGrouping] = useState<UsageGrouping>('kind')

  useEffect(() => {
    void window.api
      .apiUsage()
      .then(setDays)
      .catch((err: unknown) => setError(displayError(err)))
  }, [])

  const report = useMemo(() => (days ? usageReport(days, localDate(new Date()), range, grouping) : null), [days, range, grouping])
  const usd = useMemo(() => usdFormatter(locale), [locale])
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }), [locale])
  const integer = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }), [locale])
  const formatDate = (date: string): string => shortDate.format(new Date(`${date}T00:00:00Z`))

  const detail = (item: UsageItem): string => {
    switch (item.kind) {
      case 'llm': {
        const text = t('settingsUsage.detail.llm', {
          calls: integer.format(item.calls),
          input: compact.format(item.input + item.cacheRead + item.cacheCreation),
          output: compact.format(item.output)
        })
        return item.webSearches > 0 ? `${text} · ${t('settingsUsage.detail.searches', { searches: integer.format(item.webSearches) })}` : text
      }
      case 'live':
        return t('settingsUsage.detail.live', { minutes: integer.format(Math.round(item.seconds / 60)) })
      case 'agent':
        return t('settingsUsage.detail.agent', { jobs: integer.format(item.jobs) })
    }
  }
  const lineLabel = (item: UsageItem): string => {
    const name = seriesLabel(t, modelSeriesId(item))
    return item.kind === 'llm' ? `${name} · ${t(`settingsUsage.purposes.${item.purpose}`)}` : name
  }
  const lineNote = (item: UsageItem): string | null =>
    item.kind === 'agent' ? t('settingsUsage.agentNote') : item.kind === 'live' && item.engine === 'gpt-live' ? t('settingsUsage.gptLiveNote') : null

  const today = report ? report.series.reduce((sum, s) => sum + s.values[s.values.length - 1], 0) : 0

  return (
    <Page title={t('settingsUsage.title')} lead={t('settingsUsage.lead')}>
      <p className="st-usage-disclaimer">{t('settingsUsage.disclaimer')}</p>
      <Group
        title={t('settingsUsage.chartTitle')}
        action={
          <div className="st-usage-controls">
            <select className="st-select" aria-label={t('settingsUsage.range')} value={range} onChange={(e) => setRange(Number(e.target.value) as Range)}>
              {RANGES.map((days) => (
                <option key={days} value={days}>
                  {t('settingsUsage.lastDays', { days })}
                </option>
              ))}
            </select>
            <select className="st-select" aria-label={t('settingsUsage.grouping')} value={grouping} onChange={(e) => setGrouping(e.target.value as UsageGrouping)}>
              <option value="kind">{t('settingsUsage.groupings.kind')}</option>
              <option value="model">{t('settingsUsage.groupings.model')}</option>
            </select>
          </div>
        }
      >
        {error ? (
          <Row label={error} />
        ) : !report ? null : report.totalUsd === 0 ? (
          <p className="st-usage-empty">{t('settingsUsage.empty')}</p>
        ) : (
          <div className="st-usage">
            <div className="st-usage-totals">
              <div>
                <span>{t('settingsUsage.total', { days: range })}</span>
                <strong>{usd(report.totalUsd)}</strong>
              </div>
              <div>
                <span>{t('settingsUsage.today')}</span>
                <strong>{usd(today)}</strong>
              </div>
            </div>
            <ul className="st-usage-legend">
              {report.series.map((s) => (
                <li key={s.id}>
                  <i data-slot={s.slot} />
                  {seriesLabel(t, s.id)}
                  <span>{usd(s.total)}</span>
                </li>
              ))}
            </ul>
            <UsageChart report={report} label={(id) => seriesLabel(t, id)} formatUsd={usd} formatDate={formatDate} />
          </div>
        )}
      </Group>
      {report && report.lines.length > 0 && (
        <Group title={t('settingsUsage.breakdownTitle')}>
          {report.lines.map((item) => (
            <Row key={usageItemKey(item)} label={lineLabel(item)} hint={<>{detail(item)}{lineNote(item) && <><br />{lineNote(item)}</>}</>}>
              {item.kind === 'llm' && item.billing === 'chatgpt-plan' ? (
                <Chip>{t('settingsUsage.chatgptPlan')}</Chip>
              ) : item.costUsd === null ? (
                <Chip tone="warn">{t('settingsUsage.unpriced')}</Chip>
              ) : (
                <span className="st-value">{usd(item.costUsd)}</span>
              )}
            </Row>
          ))}
          {ctx.settings.agentEngine === 'codex' && <Row label={t('settingsUsage.codexNote')} />}
        </Group>
      )}
    </Page>
  )
}
