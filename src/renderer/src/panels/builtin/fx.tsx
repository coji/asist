import { useLayoutEffect, useRef } from 'react'
import type { PanelSpec } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import { useT, useFormatLocale } from '@/i18n'
import type { CardContext, CardDefinition } from '../shell/card'
import { Box, Facts } from '../primitives/Card'
import { timeFields } from '../primitives/format'
import './fx.css'

interface FxProps {
  base: string
  quote: string
  rate: number
  amount?: number | null
  /** When the provider last updated the rate, as RFC 1123 or ISO 8601. */
  asOf?: string
}

/** The currencies whose short unit the dictionary carries. Any other code is shown as the code itself. */
const UNIT_CODES = [
  'USD', 'JPY', 'EUR', 'GBP', 'CNY', 'KRW', 'AUD', 'CAD', 'CHF', 'HKD',
  'TWD', 'SGD', 'THB', 'INR', 'NZD', 'MXN', 'BRL', 'PHP', 'VND', 'IDR'
] as const
type UnitCode = (typeof UNIT_CODES)[number]
const hasUnit = (code: string): code is UnitCode => (UNIT_CODES as readonly string[]).includes(code)
/** Currencies whose single unit is small, for which the quick table starts at a larger amount. */
const SMALL_UNIT = new Set(['JPY', 'KRW', 'VND', 'IDR'])
const ROWS: Record<CardContext['size'], number> = { l: 5, m: 4, s: 3, focus: 5 }

const propsOf = (spec: PanelSpec): FxProps => spec.props as unknown as FxProps
const currencyName = (code: string, locale: string): string =>
  new Intl.DisplayNames(locale, { type: 'currency' }).of(code) ?? code
const currencyUnit = (code: string, count: number, t: Translate): string =>
  hasUnit(code) ? t(`cardsFinance.fx.units.${code}`, { count }) : code
/** Drops decimals as the value grows: four below 1, two below 100, none above that. */
const amountText = (value: number, locale: string): string =>
  value.toLocaleString(locale, { maximumFractionDigits: value < 1 ? 4 : value < 100 ? 2 : 0 })
/**
 * A rate below 1 keeps up to four significant digits, since a fixed count of decimals would round a rate such as
 * one dong in dollars (about 0.000038) to zero.
 */
const rateText = (rate: number, locale: string): string =>
  rate.toLocaleString(
    locale,
    rate < 1
      ? { minimumSignificantDigits: 2, maximumSignificantDigits: 4 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 3 }
  )
const asOfText = (asOf: string | undefined, locale: string): string | null => {
  const at = asOf ? Date.parse(asOf) : NaN
  return Number.isNaN(at)
    ? null
    : new Date(at).toLocaleString(locale, { ...timeFields(locale), month: 'numeric', day: 'numeric' })
}

/** The amounts the quick table lists. An amount asked for goes first. */
export function tableAmounts(base: string, amount: number | null | undefined, rows: number): number[] {
  const steps = SMALL_UNIT.has(base) ? [100, 1000, 10000, 100000, 1000000] : [1, 10, 100, 1000, 10000]
  if (amount === null || amount === undefined) return steps.slice(0, rows)
  return [amount, ...steps.filter((v) => v !== amount)].slice(0, rows)
}

function AsOf({ spec }: CardContext): React.JSX.Element | null {
  const t = useT()
  const locale = useFormatLocale()
  const text = asOfText(propsOf(spec).asOf, locale)
  return text ? <span className="fx-asof">{t('cardsFinance.fx.updated', { time: text })}</span> : null
}

/**
 * The rate and its unit on one line, scaled down when they are wider than the card. A rate written with many
 * characters, such as 0.00003835 or 26,315.789, is wider at the type size of l, m and s than the card is.
 */
function Rate({ text, unit, size }: { text: string; unit: string; size: CardContext['size'] }): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const strong = ref.current
    const row = strong?.parentElement
    if (!strong || !row) return
    const fit = (): void => {
      strong.style.zoom = ''
      const room = row.clientWidth / strong.offsetWidth
      // Rounded down, since layout rounds the scaled width and a share of a pixel would still pass the edge.
      if (room < 1) strong.style.zoom = String(Math.floor(room * 100) / 100)
    }
    fit()
    // The row's width follows the card alone, so scaling the rate inside it never sets the observer off again.
    // A theme brings its own type for the number, which changes the width the rate needs.
    const resize = new ResizeObserver(fit)
    resize.observe(row)
    const theme = new MutationObserver(fit)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      resize.disconnect()
      theme.disconnect()
    }
  }, [text, unit, size])
  return (
    <strong ref={ref}>
      {text}
      <small>{unit}</small>
    </strong>
  )
}

function FxBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const { base, quote, rate, amount, asOf } = propsOf(spec)
  const amounts = tableAmounts(base, amount, ROWS[size])
  return (
    <div className="card fx" data-size={size}>
      <div className="card-hero">
        <h3>
          {currencyName(base, locale)} → {currencyName(quote, locale)}
        </h3>
        <p>
          <b>
            {base}/{quote}
          </b>
        </p>
        <div className="card-big">
          <Rate text={rateText(rate, locale)} unit={currencyUnit(quote, rate, t)} size={size} />
        </div>
        <p className="card-note">{t('cardsFinance.fx.per', { unit: currencyUnit(base, 1, t) })}</p>
      </div>
      <Box title={t('cardsFinance.fx.table')} note={`${base} → ${quote}`}>
        <ul className="card-rows fx-table">
          {amounts.map((value) => (
            <li key={value} className="card-row" aria-current={value === amount ? 'true' : undefined}>
              <span className="fx-from">
                {amountText(value, locale)} {currencyUnit(base, value, t)}
              </span>
              <span className="fx-to">
                {amountText(value * rate, locale)} {currencyUnit(quote, value * rate, t)}
              </span>
            </li>
          ))}
        </ul>
        {size !== 's' && (
          <Facts
            columns={1}
            items={[
              [
                t('cardsFinance.fx.inverse'),
                t('cardsFinance.fx.inverseRate', {
                  quote: currencyUnit(quote, 1, t),
                  amount: rateText(1 / rate, locale),
                  base: currencyUnit(base, 1 / rate, t)
                })
              ],
              [t('cardsFinance.fx.providerUpdated'), asOfText(asOf, locale) ?? t('cardsFinance.fx.updatedUnknown')]
            ]}
          />
        )}
      </Box>
      <footer className="fx-footer">
        <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
          {t('cardsFinance.fx.attribution')}
        </a>
      </footer>
    </div>
  )
}

export const fxCard: CardDefinition = {
  Body: FxBody,
  kicker: 'FX RATE',
  className: 'fx-card',
  meta: AsOf
}
