/** A colour as hue in degrees and saturation and lightness in percent, the form the orb blends in. */
export interface Hsl {
  h: number
  s: number
  l: number
}

/** A colour given as red, green and blue from 0 to 255, with the hue of a grey taken as 0. */
export function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === rn ? ((gn - bn) / d + 6) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100 }
}

/**
 * The colour a fraction k of the way from a to b. The hue turns the shorter way round the circle, so two
 * ends either side of red blend through red rather than through green; mixing in RGB instead would grey the
 * middle of a sweep between two saturated hues. A grey has no hue of its own, so it takes the other end's,
 * and the blend only gains saturation instead of sweeping through unrelated hues.
 */
export function mixHsl(a: Hsl, b: Hsl, k: number): Hsl {
  const from = a.s === 0 ? b.h : a.h
  const to = b.s === 0 ? a.h : b.h
  const turn = ((to - from + 540) % 360) - 180
  return { h: (from + turn * k + 360) % 360, s: a.s + (b.s - a.s) * k, l: a.l + (b.l - a.l) * k }
}

/** The colour as a CSS hsl() with the given opacity, which a canvas takes as a stroke or fill. */
export const hslCss = ({ h, s, l }: Hsl, alpha: number): string => `hsl(${h} ${s}% ${l}% / ${alpha})`
