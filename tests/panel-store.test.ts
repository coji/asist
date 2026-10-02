import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advancePanelLifecycle,
  PANEL_STALE_GRACE_MS,
  usePanelStore
} from '@/state/stores'

const store = (): ReturnType<typeof usePanelStore.getState> => usePanelStore.getState()

const create = (key: string, opts?: { slot?: 'left' | 'right' }): void =>
  store().apply({
    op: 'create',
    key,
    type: 'weather',
    slot: opts?.slot ?? 'right',
    props: { location: key },
    state: 'skeleton'
  })

beforeEach(() => {
  usePanelStore.setState({ panels: [], focusedKey: null })
})

describe('usePanelStore', () => {
  it('replaces only the corrected card, in the slot it already had, and closes the focus overlay', () => {
    create('calendar', { slot: 'left' })
    create('old-weather', { slot: 'right' })
    store().setFocused('old-weather')
    store().apply({ op: 'create', key: 'new-weather', replacesKey: 'old-weather', type: 'weather', slot: 'left', props: {}, state: 'ready' })
    expect(store().panels.map(p => [p.key, p.slot])).toEqual([['calendar','left'],['new-weather','right']])
    expect(store().focusedKey).toBeNull()
  })

  it('adds a card on create and treats a second create for the same key as a patch, so that one card remains', () => {
    create('weather:東京')
    store().apply({
      op: 'create',
      key: 'weather:東京',
      type: 'weather',
      slot: 'right',
      props: { extra: 1 },
      state: 'ready'
    })
    const panels = store().panels
    expect(panels).toHaveLength(1)
    expect(panels[0].state).toBe('ready')
    expect(panels[0].props).toMatchObject({ location: 'weather:東京', extra: 1 })
  })

  it('merges props and state on a patch, and turns the card ready when props arrive without a state', () => {
    create('a')
    store().apply({ op: 'patch', key: 'a', props: { temp: 20 } })
    expect(store().panels[0].state).toBe('ready')
    expect(store().panels[0].props).toMatchObject({ temp: 20, location: 'a' })
  })

  it.each(['left', 'right'] as const)('puts the second card in the free slot on the other side, whichever side the first asked for: %s', (slot) => {
    create('a', { slot })
    create('b', { slot })
    expect(store().panels.map(p => [p.key, p.slot])).toEqual([
      ['a', slot], ['b', slot === 'left' ? 'right' : 'left']
    ])
  })

  it('leaves the creation time untouched on an update or an upsert, and gives the third card the slot of the first', () => {
    create('a')
    create('b')
    const createdAt = store().panels[0].createdAt
    const survivor = store().panels[1]
    store().apply({ op: 'patch', key: 'a', props: { temp: 25 } })
    create('a', { slot: 'left' })
    expect(store().panels[0]).toMatchObject({ key: 'a', slot: 'right', createdAt })
    store().setFocused('a')
    create('c', { slot: 'left' })
    expect(store().panels).toEqual([survivor, expect.objectContaining({ key: 'c', slot: 'right' })])
    expect(store().focusedKey).toBeNull()
    // A fetch result that arrives after the card has left does not bring it back.
    store().apply({ op: 'patch', key: 'a', props: { temp: 30 } })
    expect(store().panels.map(p => p.key)).toEqual(['b', 'c'])
  })

  it('leaves the remaining card and the focus where they are when one side is closed, and fills the free slot with the new card', () => {
    create('a')
    create('b')
    store().setFocused('b')
    store().dismiss('a')
    create('c', { slot: 'left' })
    expect(store().panels.map(p => [p.key, p.slot])).toEqual([['b', 'left'], ['c', 'right']])
    expect(store().focusedKey).toBe('b')
  })

  it('keeps one card per side and replaces them in turn, even when they are created in the same millisecond', () => {
    for (let i = 0; i < 10; i++) {
      create(`p${i}`)
      expect(store().panels.length).toBeLessThanOrEqual(2)
      expect(new Set(store().panels.map(p => p.slot)).size).toBe(store().panels.length)
    }
    expect(store().panels.map(p => [p.key, p.slot])).toEqual([['p8', 'right'], ['p9', 'left']])
  })

  it('clears the focus when the focused panel is dismissed', () => {
    create('focused')
    store().setFocused('focused')
    store().dismiss('focused')
    expect(store().panels).toHaveLength(0)
    expect(store().focusedKey).toBeNull()
  })

  it('removes a panel through the dismiss operation as well', () => {
    create('x')
    store().apply({ op: 'dismiss', key: 'x' })
    expect(store().panels).toHaveLength(0)
  })

  it('moves a card from ready to stale at the default TTL of the catalog and removes it after the grace period', () => {
    store().apply({
      op: 'create',
      key: 'weather:大阪',
      type: 'weather',
      slot: 'right',
      props: { location: '大阪' },
      state: 'ready'
    })
    const fresh = store().panels[0]
    expect(fresh.ttl).toBe(15 * 60_000)

    advancePanelLifecycle(fresh.updatedAt + fresh.ttl! - 1)
    expect(store().panels[0].state).toBe('ready')

    const staleAt = fresh.updatedAt + fresh.ttl!
    advancePanelLifecycle(staleAt)
    expect(store().panels[0]).toMatchObject({ state: 'stale', staleAt })

    advancePanelLifecycle(staleAt + PANEL_STALE_GRACE_MS - 1)
    expect(store().panels).toHaveLength(1)
    advancePanelLifecycle(staleAt + PANEL_STALE_GRACE_MS)
    expect(store().panels).toHaveLength(0)
  })

  it('puts a patched panel back to ready and restarts its TTL', () => {
    store().apply({
      op: 'create',
      key: 'fx:USD:JPY',
      type: 'fx',
      slot: 'left',
      props: { base: 'USD', quote: 'JPY' },
      state: 'ready',
      ttl: 100
    })
    const first = store().panels[0]
    advancePanelLifecycle(first.updatedAt + 100)
    expect(store().panels[0].state).toBe('stale')

    store().apply({ op: 'patch', key: 'fx:USD:JPY', props: { rate: 162.35 } })
    const refreshed = store().panels[0]
    expect(refreshed.state).toBe('ready')
    expect(refreshed.staleAt).toBeUndefined()
    expect(refreshed.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    advancePanelLifecycle(refreshed.updatedAt + 99)
    expect(store().panels[0].state).toBe('ready')
  })

  it('keeps a card that failed on its error past the TTL, having no data to go out of date, and removes it after the grace period', () => {
    vi.useFakeTimers()
    try {
      store().apply({ op: 'create', key: 'fx:USD:JPY', type: 'fx', slot: 'left', props: { base: 'USD', quote: 'JPY' }, state: 'loading' })
      store().apply({ op: 'patch', key: 'fx:USD:JPY', state: 'error', error: 'fetch failed' })
      const failed = store().panels[0]
      vi.advanceTimersByTime(failed.ttl!)
      expect(store().panels[0]).toMatchObject({ state: 'error', error: 'fetch failed' })
      vi.advanceTimersByTime(PANEL_STALE_GRACE_MS)
      expect(store().panels).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never removes a panel that has no TTL, however much time passes', () => {
    store().apply({
      op: 'create',
      key: 'todo',
      type: 'todo',
      slot: 'right',
      props: {},
      state: 'ready'
    })
    const panel = store().panels[0]
    expect(panel.ttl).toBeUndefined()
    advancePanelLifecycle(panel.updatedAt + 365 * 24 * 60 * 60_000)
    expect(store().panels).toHaveLength(1)
    expect(store().panels[0].state).toBe('ready')
  })

  it('removes only the loading panels of the superseded turn, keeping the ready ones and those of another turn', () => {
    store().apply(
      { op: 'create', key: 'old-loading', type: 'todo', slot: 'right', props: {}, state: 'loading' },
      { ownerTurnId: 10 }
    )
    store().apply(
      { op: 'create', key: 'old-ready', type: 'notes', slot: 'right', props: {}, state: 'ready' },
      { ownerTurnId: 10 }
    )
    store().apply(
      { op: 'create', key: 'new-loading', type: 'news', slot: 'right', props: {}, state: 'loading' },
      { ownerTurnId: 11 }
    )

    store().dismissLoadingOwnedBy(10)

    expect(store().panels.map((panel) => panel.key).sort()).toEqual(['new-loading', 'old-ready'])
  })

  it('puts a card a later turn was fetching again back as it was when that turn is abandoned, and removes a card the turn was making', () => {
    // Turn 3 showed the exchange rate, and the card is complete.
    store().apply({ op: 'create', key: 'fx:USD:JPY', type: 'fx', slot: 'left', props: { base: 'USD', quote: 'JPY' }, state: 'loading' }, { ownerTurnId: 3 })
    store().apply({ op: 'patch', key: 'fx:USD:JPY', props: { rate: 147.2 }, state: 'ready', source: 'open.er-api.com' }, { ownerTurnId: 3 })
    const shown = store().panels[0]
    // Turn 9 asks for the same pair again, and for the news, and is cut off before either fetch ends.
    store().apply({ op: 'create', key: 'fx:USD:JPY', type: 'fx', slot: 'left', props: { base: 'USD', quote: 'JPY' }, state: 'loading' }, { ownerTurnId: 9 })
    store().apply({ op: 'create', key: 'news', type: 'news', slot: 'right', props: {}, state: 'loading' }, { ownerTurnId: 9 })
    expect(store().panels[0].state).toBe('loading')

    store().dismissLoadingOwnedBy(9)

    expect(store().panels).toEqual([shown])
  })

  it('forgets what a refreshed card showed once the new fetch has ended', () => {
    store().apply({ op: 'create', key: 'fx:USD:JPY', type: 'fx', slot: 'left', props: { base: 'USD', quote: 'JPY', rate: 147.2 }, state: 'ready' }, { ownerTurnId: 3 })
    store().apply({ op: 'create', key: 'fx:USD:JPY', type: 'fx', slot: 'left', props: { base: 'USD', quote: 'JPY' }, state: 'loading' }, { ownerTurnId: 9 })
    store().apply({ op: 'patch', key: 'fx:USD:JPY', state: 'error', error: 'fetch failed' }, { ownerTurnId: 9 })
    store().dismissLoadingOwnedBy(9)
    expect(store().panels).toEqual([expect.objectContaining({ key: 'fx:USD:JPY', state: 'error', error: 'fetch failed' })])
  })

  it('clears the focus when the focused panel expires', () => {
    store().apply({
      op: 'create',
      key: 'volatile',
      type: 'weather',
      slot: 'right',
      props: {},
      state: 'ready',
      ttl: 1
    })
    store().setFocused('volatile')
    const panel = store().panels[0]
    advancePanelLifecycle(panel.updatedAt + 1 + PANEL_STALE_GRACE_MS)
    expect(store().panels).toHaveLength(0)
    expect(store().focusedKey).toBeNull()
  })
})
