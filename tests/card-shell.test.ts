// @vitest-environment happy-dom
// Without this, the map card's iframe makes happy-dom fetch the Maps Embed URL over the network.
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelSpec } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { usePanelStore } from '@/state/stores'
import { Dock } from '@/ui/Dock'
import { FocusOverlay } from '@/ui/FocusOverlay'
import { CARD_SIZE_MIN_HEIGHT, cardSizeFor } from '@/panels/shell/card'
import { OVERFLOW_SETTLE_MS } from '@/panels/shell/PanelContent'
import { DEMO_WEATHER_NAGANO } from '@/demo/fixtures/weather'

const t = createTranslator('ja-JP')

/**
 * The card shell: the height the dock measures decides the card size, the meta and backdrop of the
 * card definition appear in the shell's own slots, and content that does not fit is reported instead
 * of escaping the card.
 */

vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/conversation', () => ({ sendTypedMessage: vi.fn() }))
vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children),
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(
        ({ initial, animate, exit, transition, layout, ...props }, ref) => createElement('div', { ...props, ref })
      )
    }
  }
})

type Entry = { target: Element; contentRect: { height: number } }
type Observer = { callback: (entries: Entry[]) => void; targets: Element[] }
const observers: Observer[] = []
class FakeResizeObserver {
  private readonly entry: Observer
  constructor(callback: (entries: Entry[]) => void) {
    this.entry = { callback, targets: [] }
    observers.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.targets.push(target)
  }
  disconnect(): void {
    this.entry.targets.length = 0
  }
}
const notify = async (target: Element, height = 0): Promise<void> => {
  await act(async () => {
    for (const observer of observers) {
      if (observer.targets.includes(target)) observer.callback([{ target, contentRect: { height } }])
    }
  })
}

let container: HTMLDivElement
let root: Root
const weather = (patch: Partial<PanelSpec> = {}): PanelSpec => ({
  key: 'weather:25201:today',
  type: 'weather',
  slot: 'right',
  state: 'ready',
  props: { location: '長野県', date: 'today', weather: DEMO_WEATHER_NAGANO },
  createdAt: 1,
  updatedAt: 1,
  ...patch
})

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // The map card refuses to render without the Maps Embed key.
  vi.stubEnv('RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY', 'test-key')
  observers.length = 0
  usePanelStore.setState({ panels: [], focusedKey: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function render(panels: PanelSpec[]): Promise<HTMLElement> {
  await act(async () => {
    usePanelStore.setState({ panels, focusedKey: null })
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Dock, { slot: 'right' }),
        React.createElement('section', { 'data-surface': 'focus' }, React.createElement(FocusOverlay))
      )
    )
  })
  return container.querySelector<HTMLElement>('.dock')!
}

describe('card size', () => {
  it('hands the card the size derived from the dock height, and the weather card folds the weekly forecast at s', async () => {
    const dock = await render([weather()])
    for (const height of [CARD_SIZE_MIN_HEIGHT.l, CARD_SIZE_MIN_HEIGHT.m, 0]) {
      await notify(dock, height)
      const card = dock.querySelector<HTMLElement>('.panel-card')!
      const size = cardSizeFor(height)
      expect(card.dataset.size).toBe(size)
      expect(card.querySelector('[aria-label="週間の天気"]') !== null).toBe(size !== 's')
      expect(card.querySelector('.card-more') !== null).toBe(size === 's')
    }
  })

  it('opens the focus view from an s card and shows the weekly forecast and the forecast area', async () => {
    const dock = await render([weather()])
    await notify(dock, 0)
    await act(async () => dock.querySelector<HTMLButtonElement>('.card-more')!.click())
    expect(usePanelStore.getState().focusedKey).toBe('weather:25201:today')
    const focus = container.querySelector<HTMLElement>('[data-surface="focus"]')!
    expect(focus.querySelector('.panel-focus')?.getAttribute('data-size')).toBe('focus')
    expect(focus.querySelector('[aria-label="週間の天気"]')).not.toBeNull()
    expect(focus.textContent).toContain(
      t('cardsWeather.area', {
        area: DEMO_WEATHER_NAGANO.location.forecastAreaName,
        point: DEMO_WEATHER_NAGANO.temperaturePoint ?? ''
      })
    )
  })
})

describe('meta and backdrop from the card definition', () => {
  it('shows neither before the data arrives, then the shell places the header meta and the backdrop scene', async () => {
    const dock = await render([weather({ state: 'skeleton', props: { location: '長野県', date: 'today' } })])
    expect(dock.querySelector('.panel-meta')).toBeNull()
    expect(dock.querySelector('.panel-backdrop')).toBeNull()

    await render([weather()])
    const card = dock.querySelector<HTMLElement>('.panel-card')!
    expect(card.querySelector('.panel-head .panel-meta')?.textContent).toContain(t('cardsWeather.issued', { time: '17:00' }))
    expect(card.classList.contains('wx-card')).toBe(true)
    const backdrop = card.querySelector('.panel-backdrop')!
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect([...backdrop.querySelectorAll('img')].some((img) => img.src.includes('nagano'))).toBe(true)
    expect(card.querySelector('.panel-body .wx-scene')).toBeNull()
  })
})

describe('content that does not fit', () => {
  const clock = (): PanelSpec => ({
    key: 'clock:大阪', type: 'clock', slot: 'right', state: 'ready',
    props: { city: '大阪', timezone: 'Asia/Tokyo' }, createdAt: 1, updatedAt: 1
  })
  // The map card declares scroll, so that Google's attribution at the bottom of the iframe is never cut off.
  const map = (): PanelSpec => ({
    key: 'map:東京駅', type: 'map', slot: 'right', state: 'ready',
    props: { place: '東京駅', mode: 'place' }, createdAt: 1, updatedAt: 1
  })
  const overflow = async (card: HTMLElement): Promise<void> => {
    const box = card.querySelector<HTMLElement>('.panel-body')!
    const inner = card.querySelector<HTMLElement>('.panel-body-inner')!
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(inner, 'offsetHeight', { value: 320, configurable: true })
    await notify(inner)
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(OVERFLOW_SETTLE_MS + 1)
    })
  }

  it('reports a card without scroll as an error once the layout settles, and lets a scroll card scroll inside', async () => {
    vi.useFakeTimers()
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const dock = await render([clock(), map()])
      const [clockCard, mapCard] = [...dock.querySelectorAll<HTMLElement>('.panel-card')]
      await overflow(mapCard)
      await settle()
      expect(error).not.toHaveBeenCalled()
      expect(mapCard.querySelector('.panel-body')?.getAttribute('data-clipped')).toBe('scroll')

      await overflow(clockCard)
      // A brief overflow while the size is changing is not reported.
      expect(error).not.toHaveBeenCalled()
      await settle()
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0][0])).toContain('clock')
      await notify(clockCard.querySelector('.panel-body-inner')!)
      await settle()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports nothing when a re-render removes the overflow', async () => {
    vi.useFakeTimers()
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const dock = await render([clock()])
      const card = dock.querySelector<HTMLElement>('.panel-card')!
      await overflow(card)
      const inner = card.querySelector<HTMLElement>('.panel-body-inner')!
      Object.defineProperty(inner, 'offsetHeight', { value: 180, configurable: true })
      await notify(inner)
      await settle()
      expect(error).not.toHaveBeenCalled()
      expect(card.querySelector('.panel-body')?.hasAttribute('data-clipped')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a card whose data could not be fetched', () => {
  it('words the error the main process sent in the language of the interface', async () => {
    const error = errorText('panels.errors.placeNotFound', { place: 'Atlantis' })
    const dock = await render([weather({ state: 'error', error })])
    expect(dock.textContent).toContain(t('panels.errors.placeNotFound', { place: 'Atlantis' }))
  })
})
