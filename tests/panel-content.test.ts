// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelSpec } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { usePanelStore } from '@/state/stores'
import { Dock } from '@/ui/Dock'
import { FocusOverlay } from '@/ui/FocusOverlay'

vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/conversation', () => ({ sendTypedMessage: vi.fn() }))
vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children),
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(({ initial, animate, exit, transition, layout, ...props }, ref) => createElement('div', { ...props, ref }))
    }
  }
})

// The tests load no settings, so the interface stays in the source language and the shell's buttons
// carry their Japanese labels.
const t = createTranslator('ja-JP')

let container: HTMLDivElement
let root: Root
const event = { title: '確認する予定', start: new Date(2026, 8, 12, 12).getTime(), allDay: false }
const panel = (state: PanelSpec['state'], patch: Partial<PanelSpec> = {}): PanelSpec => ({
  key: 'calendar:today', type: 'calendar', slot: 'right', state,
  props: { range: 'today', events: [event] }, createdAt: 1, updatedAt: 1,
  source: 'fixture calendar source', ...patch
})

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
})

async function renderPanels(spec: PanelSpec, others: PanelSpec[] = []): Promise<HTMLElement[]> {
  await act(async () => {
    usePanelStore.setState({ panels: [spec, ...others], focusedKey: spec.key })
    root.render(React.createElement(React.Fragment, null,
      React.createElement('section', { 'data-surface': 'dock' }, React.createElement(Dock, { slot: 'right' })),
      React.createElement('section', { 'data-surface': 'focus' }, React.createElement(FocusOverlay))
    ))
  })
  return [...container.querySelectorAll<HTMLElement>('[data-surface]')]
}

describe('the content of the card and of the focus overlay', () => {
  it.each(['skeleton', 'loading'] as const)('shows neither the body nor the source while the data has not arrived: %s', async (state) => {
    for (const surface of await renderPanels(panel(state))) {
      expect(surface.querySelector('[role="status"]')).not.toBeNull()
      expect(surface.textContent).not.toContain(event.title)
      expect(surface.textContent).not.toContain('fixture calendar source')
    }
  })

  it('does not present a fetch error as an empty but valid schedule, not even in the focus overlay', async () => {
    for (const surface of await renderPanels(panel('error', { props: { range: 'today' }, error: 'fixture load failure' }))) {
      expect(surface.querySelector('[role="alert"]')?.textContent).toContain('fixture load failure')
      expect(surface.textContent).not.toContain('fixture calendar source')
    }
  })

  it.each(['ready', 'stale'] as const)('shows the data and the source on both surfaces: %s', async (state) => {
    const surfaces = await renderPanels(panel(state))
    for (const surface of surfaces) {
      expect(surface.textContent).toContain(event.title)
      expect(surface.textContent).toContain('fixture calendar source')
      expect(surface.querySelector('[role="alert"]')).toBeNull()
      expect(surface.querySelector('[role="status"]') !== null).toBe(state === 'stale')
    }
    if (state === 'stale') {
      expect(surfaces[0].querySelector('[role="status"]')?.textContent).toBe(surfaces[1].querySelector('[role="status"]')?.textContent)
    }
  })

  it('keeps an exception thrown by a body inside its own panel, and renders again once the data is updated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = panel('ready', { key: 'other', props: { events: [{ ...event, title: '歯医者の予約' }] } })
    const surfaces = await renderPanels(panel('ready', { props: { events: [null] } }), [other])
    for (const surface of surfaces) expect(surface.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(surfaces[0].textContent).toContain('歯医者の予約')

    for (const surface of await renderPanels(panel('ready', { updatedAt: 2 }), [other])) {
      expect(surface.querySelector('[role="alert"]')).toBeNull()
      expect(surface.textContent).toContain(event.title)
    }
  })
})

describe('one card per side', () => {
  it('replaces the oldest card on its own side even while it is focused, and keeps the DOM and the controls of the other card', async () => {
    const show = (key: string): void => usePanelStore.getState().apply({
      op: 'create', key, type: 'calendar', slot: 'right', state: 'ready',
      props: { range: 'today', events: [{ ...event, title: key }] }
    })
    await act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement('section', { 'data-side': 'left' }, React.createElement(Dock, { slot: 'left' })),
        React.createElement('section', { 'data-side': 'right' }, React.createElement(Dock, { slot: 'right' })),
        React.createElement(FocusOverlay)
      ))
      show('first')
      show('second')
    })
    const left = container.querySelector<HTMLElement>('[data-side="left"]')!
    const right = container.querySelector<HTMLElement>('[data-side="right"]')!
    const survivor = left.querySelector('.panel-card')
    expect(left.textContent).toContain('second')
    expect(right.textContent).toContain('first')
    await act(async () => right.querySelector<HTMLButtonElement>(`[aria-label="${t('panels.expand')}"]`)!.click())
    expect(usePanelStore.getState().focusedKey).toBe('first')
    await act(async () => show('third'))
    expect(usePanelStore.getState().focusedKey).toBeNull()
    expect(left.querySelector('.panel-card')).toBe(survivor)
    expect(right.textContent).toContain('third')
    expect(right.textContent).not.toContain('first')
    expect(container.querySelectorAll('.panel-card')).toHaveLength(2)
    await act(async () => right.querySelector<HTMLButtonElement>(`[aria-label="${t('panels.dismiss')}"]`)!.click())
    expect(right.querySelector('.panel-card')).toBeNull()
    expect(left.querySelector('.panel-card')).toBe(survivor)
  })
})
