// @vitest-environment happy-dom
import { createTranslator } from '@shared/i18n'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarSettings } from '../src/renderer/src/ui/settings/CalendarSettings'
import { useSettingsStore } from '../src/renderer/src/state/stores'
import type { AppSettings } from '../src/shared/settings'
import { MACOS, setCapabilities } from './helpers/platform'

vi.mock('@/platform', () => import('./helpers/platform'))

let container: HTMLDivElement, root: Root
const status = {
  authorization: 'fullAccess',
  calendars: [
    { id: 'google', source: 'Google', title: '仕事', writable: true },
    { id: 'holidays', source: '購読', title: '祝日', writable: false }
  ],
  account: null
}
const requestAccess = vi.fn(),
  saveSettings = vi.fn(),
  signOut = vi.fn(),
  calendarStatus = vi.fn()
const settings = {
  calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null }
} as unknown as AppSettings
function Harness(): React.JSX.Element {
  const current = useSettingsStore((state) => state.settings)!
  return React.createElement(CalendarSettings, { settings: current })
}
beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  requestAccess.mockReset()
  saveSettings.mockReset()
  signOut.mockReset()
  calendarStatus.mockReset()
  calendarStatus.mockResolvedValue(status)
  setCapabilities(MACOS)
  window.api = {
    calendarStatus,
    calendarRequestAccess: requestAccess,
    calendarSignOut: signOut,
    saveSettings
  } as unknown as typeof window.api
  saveSettings.mockImplementation(async (patch) => ({ ...settings, ...patch }))
  useSettingsStore.setState({ settings })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it('permission denial does not enable integration and is shown as an error', async () => {
  requestAccess.mockResolvedValue({ authorization: 'denied', calendars: [] })
  await act(async () => root.render(React.createElement(Harness)))
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        `[aria-label="${createTranslator('ja-JP')('settingsCalendar.enable')}"]`
      )!
      .click()
  )
  expect(saveSettings).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(createTranslator('ja-JP')('settingsCalendar.authorization.denied'))
})
it('keeps reading and writing selections separate and excludes read-only destinations', async () => {
  requestAccess.mockResolvedValue(status)
  await act(async () => root.render(React.createElement(Harness)))
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        `[aria-label="${createTranslator('ja-JP')('settingsCalendar.enable')}"]`
      )!
      .click()
  )
  expect(saveSettings.mock.calls[0][0].calendar).toEqual({
    enabled: true,
    readCalendarIds: [],
    writeCalendarId: null
  })
  const select = container.querySelector<HTMLSelectElement>('select')!
  expect([...select.options].map((option) => option.value)).toEqual([
    '',
    'google'
  ])
  const read = container.querySelectorAll<HTMLInputElement>('fieldset input')[1]
  await act(async () => read.click())
  expect(saveSettings.mock.calls.at(-1)[0].calendar).toMatchObject({
    readCalendarIds: ['holidays'],
    writeCalendarId: null
  })
})

describe('with Google Calendar', () => {
  const t = createTranslator('ja-JP')
  const signedOut = { authorization: 'notDetermined', calendars: [], account: null }
  const signedIn = {
    authorization: 'fullAccess',
    calendars: [{ id: 'me@example.com', source: 'Google', title: '仕事', writable: true }],
    account: 'me@example.com'
  }
  const button = (label: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!
  beforeEach(() => setCapabilities({ ...MACOS, calendar: 'google' }))

  it('keeps the switch off until the account is signed in, then shows the account and its calendars', async () => {
    calendarStatus.mockResolvedValue(signedOut)
    requestAccess.mockResolvedValue(signedIn)
    await act(async () => root.render(React.createElement(Harness)))
    expect(container.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsCalendar.enable')}"]`)!.disabled).toBe(true)
    await act(async () => button(t('settingsCalendar.google.signIn')).click())
    expect(requestAccess).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('me@example.com')
    expect(container.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsCalendar.enable')}"]`)!.disabled).toBe(false)
    expect([...container.querySelectorAll('fieldset label span')].map((el) => el.textContent)).toEqual(['仕事'])
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('signs out and goes back to the sign-in button without touching the chosen calendars', async () => {
    calendarStatus.mockResolvedValue(signedIn)
    signOut.mockResolvedValue(signedOut)
    await act(async () => root.render(React.createElement(Harness)))
    await act(async () => button(t('settingsCalendar.google.signOut')).click())
    expect(signOut).toHaveBeenCalledOnce()
    expect(button(t('settingsCalendar.google.signIn'))).toBeDefined()
    expect(container.querySelector('fieldset')).toBeNull()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('offers both a sign-out and a new sign-in for a saved sign-in this build cannot read', async () => {
    calendarStatus.mockResolvedValue({ authorization: 'unreadable', calendars: [], account: null })
    signOut.mockResolvedValue(signedOut)
    await act(async () => root.render(React.createElement(Harness)))
    expect(container.textContent).toContain(t('settingsCalendar.authorization.unreadable'))
    expect(button(t('settingsCalendar.google.signIn')).disabled).toBe(false)
    await act(async () => button(t('settingsCalendar.google.signOut')).click())
    expect(signOut).toHaveBeenCalledOnce()
    expect(container.textContent).toContain(t('settingsCalendar.google.signedOutHint'))
  })

  it('shows only the latest of two sign-ins when the first is replaced', async () => {
    calendarStatus.mockResolvedValue(signedOut)
    let finishFirst!: (value: unknown) => void
    requestAccess.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve))).mockResolvedValueOnce(signedIn)
    await act(async () => root.render(React.createElement(Harness)))
    await act(async () => button(t('settingsCalendar.google.signIn')).click())
    expect(container.textContent).toContain(t('settingsCalendar.google.signingIn'))
    await act(async () => button(t('settingsCalendar.google.signIn')).click())
    // Main answers the replaced sign-in with the status it had, signed out.
    await act(async () => finishFirst(signedOut))
    expect(container.textContent).toContain('me@example.com')
    expect(button(t('settingsCalendar.google.signOut'))).toBeDefined()
  })
})
