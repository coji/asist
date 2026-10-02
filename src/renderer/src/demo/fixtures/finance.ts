/** Invented exchange rates per pair. A pair that is not listed here is quoted at 100. */
const DEMO_FX_RATES: Record<string, number> = {
  'USD/JPY': 162.35,
  'EUR/JPY': 171.2,
  'GBP/JPY': 198.4,
  'USD/EUR': 0.948,
  'JPY/USD': 1 / 162.35,
  'VND/USD': 0.00003835
}
export function demoFx(base = 'USD', quote = 'JPY', amount: number | null = 1000): Record<string, unknown> {
  return { base, quote, rate: DEMO_FX_RATES[`${base}/${quote}`] ?? 100, amount, asOf: '2026-09-15T00:02:31.000Z' }
}
export const DEMO_FX = demoFx()
