// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'
import { Feed } from '../src/renderer/src/ui/Feed'
import { useSettingsStore } from '../src/renderer/src/state/stores'

const mocks = vi.hoisted(() => ({ sendTypedMessage: vi.fn(async () => {}), fits: true }))
vi.mock('@/conversation', () => ({ sendTypedMessage: mocks.sendTypedMessage, typedTextFits: () => mocks.fits }))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { karaoke: () => null } }))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  mocks.sendTypedMessage.mockClear()
})

async function typeAndPressEnter(text: string): Promise<HTMLInputElement> {
  useSettingsStore.setState({ settings: { uiLocale: 'ja-JP' } as unknown as AppSettings })
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(React.createElement(Feed)))
  const input = container.querySelector('input')!
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return input
}

describe('the typed text box', () => {
  it('keeps text the conversation refuses in the box, unsent', async () => {
    mocks.fits = false
    const input = await typeAndPressEnter('長すぎる文')
    expect(mocks.sendTypedMessage).not.toHaveBeenCalled()
    expect(input.value).toBe('長すぎる文')
  })

  it('sends text the conversation takes and empties the box', async () => {
    mocks.fits = true
    const input = await typeAndPressEnter('こんにちは')
    expect(mocks.sendTypedMessage).toHaveBeenCalledWith('こんにちは')
    expect(input.value).toBe('')
  })
})
