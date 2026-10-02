// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { AppSettings } from '@shared/ipc'
import { Hud } from '@/ui/Hud'
import { useSettingsStore, useTurnStore } from '@/state/stores'

const t = createTranslator('ja-JP')
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSettingsStore.setState({ settings: null })
  useTurnStore.setState(useTurnStore.getInitialState())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the HUD', () => {
  it('shows the routing as not yet measured before the first turn, like a latency, and the note of the latest turn after it', async () => {
    await act(async () => root.render(<Hud />))
    const router = container.querySelector('.hud-value.is-router')!
    const latency = container.querySelector('.hud-value:not(.is-router)')!
    expect(latency.classList.contains('is-empty')).toBe(true)
    expect(router.classList.contains('is-empty')).toBe(true)
    expect(router.textContent).toBe(latency.textContent)

    await act(async () => useTurnStore.getState().setRouterNote({ kind: 'interrupted' }))
    expect(router.textContent).toBe(t('hud.router.interrupted'))
    expect(router.classList.contains('is-empty')).toBe(false)
  })

  it('names a bridge phrase only beside the measurements of the utterance it played in', async () => {
    await act(async () => root.render(<Hud />))
    const router = container.querySelector('.hud-value.is-router')!
    const turn = useTurnStore.getState()
    await act(async () => {
      turn.setTimings({ vadMs: 350, bridgeMs: 900, bridge: 'played' }, 10)
      turn.setRouterNote({ kind: 'bridge', utterance: 10, outcome: 'played', text: '会議の件ですね。' })
    })
    expect(router.textContent).toBe(t('hud.router.bridge', { text: '会議の件ですね。' }))

    // The next speech ends and the HUD turns to it, before anything of its own bridge is known.
    await act(async () => turn.setTimings({ vadMs: 420 }, 20))
    expect(router.textContent).not.toContain('会議の件ですね。')
    expect(router.classList.contains('is-empty')).toBe(true)

    // That speech yields no turn, and the HUD shows the one before again.
    await act(async () => turn.setTimings({ vadMs: 350, bridgeMs: 900, bridge: 'played' }, 10))
    expect(router.textContent).toBe(t('hud.router.bridge', { text: '会議の件ですね。' }))
  })

  it('words the note of the latest turn again when the interface language changes, an error in it included', async () => {
    const en = createTranslator('en-US')
    useSettingsStore.setState({ settings: { uiLocale: 'ja-JP', voiceEngine: 'gemini-live' } as unknown as AppSettings })
    await act(async () => root.render(<Hud />))
    const router = container.querySelector('.hud-value.is-router')!
    const detail = errorText('voice.live.connectFailed', { detail: 'quota exceeded' })
    await act(async () => useTurnStore.getState().setRouterNote({ kind: 'live', state: 'error', detail }))
    expect(router.textContent).toBe(
      t('hud.router.liveDetail', { state: t('hud.connection.error'), detail: t('voice.live.connectFailed', { detail: 'quota exceeded' }) })
    )

    await act(async () => useSettingsStore.setState({ settings: { uiLocale: 'en-US', voiceEngine: 'gemini-live' } as unknown as AppSettings }))
    expect(router.textContent).toBe(
      en('hud.router.liveDetail', { state: en('hud.connection.error'), detail: en('voice.live.connectFailed', { detail: 'quota exceeded' }) })
    )
    await act(async () => useTurnStore.getState().setRouterNote({ kind: 'tool', name: 'recall', status: 'start' }))
    expect(router.textContent).toBe(en('hud.router.tool', { tool: en('hud.tool.recall'), status: en('hud.toolStatus.start') }))
  })
})
