import type { ThemeName } from '@shared/themes'

export { DEFAULT_THEME, THEMES, isThemeName, type ThemeName } from '@shared/themes'

/**
 * Draws the UI in a theme. A theme swaps the values of the tokens in assets/themes.css; the components read
 * only those tokens. The window buttons Windows draws over the top bar are not part of the page, so the
 * main process is given their colour.
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  const [r, g, b] = tokenRgb('--ui-text')
  void window.api.paintWindowControls({ symbol: `rgb(${r}, ${g}, ${b})` })
}

/**
 * The red, green and blue of a colour token in the theme on screen, for the main process and for a canvas,
 * which cannot read CSS variables. The computed style keeps the form the theme wrote (an oklch() stays
 * oklch()), so the colour is drawn on a pixel and read back.
 */
export function tokenRgb(token: string): [number, number, number] {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no 2d canvas to resolve a theme colour')
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}
