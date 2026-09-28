import { describe, expect, it } from 'vitest'
import { mixHsl, rgbToHsl } from '@/ui/orb-colors'

describe('the orb colours', () => {
  it('reads a theme colour drawn on a pixel back as its hue, saturation and lightness', () => {
    // hsl(190 95% 72%), future's idle start, is drawn on a pixel as rgb(116, 229, 251); the rounding to
    // 8 bits moves each part by less than one.
    const { h, s, l } = rgbToHsl([116, 229, 251])
    expect(h).toBeCloseTo(189.78, 1)
    expect(s).toBeCloseTo(94.41, 1)
    expect(l).toBeCloseTo(71.96, 1)
  })

  it('gives a grey no saturation', () => {
    expect(rgbToHsl([128, 128, 128])).toMatchObject({ s: 0 })
  })

  it('sweeps between two ends along the hue, keeping the saturation of both', () => {
    const middle = mixHsl({ h: 190, s: 95, l: 72 }, { h: 270, s: 95, l: 72 }, 0.5)
    expect(middle).toEqual({ h: 230, s: 95, l: 72 })
  })

  it('blends a grey towards a colour in that colour\'s hue, without sweeping through others', () => {
    const grey = rgbToHsl([224, 224, 224])
    const blue = rgbToHsl([47, 111, 168])
    for (const k of [0.25, 0.5, 0.75]) expect(mixHsl(grey, blue, k).h).toBeCloseTo(blue.h, 6)
    expect(mixHsl(blue, grey, 0.5).h).toBeCloseTo(blue.h, 6)
  })

  it('turns the shorter way round the hue circle, so two ends either side of red blend through red', () => {
    expect(mixHsl({ h: 340, s: 80, l: 50 }, { h: 20, s: 80, l: 50 }, 0.5).h).toBeCloseTo(0, 6)
    expect(mixHsl({ h: 20, s: 80, l: 50 }, { h: 340, s: 80, l: 50 }, 0.25).h).toBeCloseTo(10, 6)
  })
})
