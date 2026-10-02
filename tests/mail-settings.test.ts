// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mergeSettings, type AppSettings, type SettingsPatch } from '@shared/settings'
import { createTranslator } from '@shared/i18n'
import { MailSettings } from '../src/renderer/src/ui/settings/MailSettings'
import type { SettingsContext } from '../src/renderer/src/ui/settings/context'
import { useMailStore, useSettingsStore, useToastStore } from '../src/renderer/src/state/stores'
import { DEMO_MAIL_ACCOUNTS, DEMO_MAIL_MESSAGES, demoMailStatus } from '../src/renderer/src/demo/fixtures/mail'
import { answerConfirm } from './helpers/confirm'

const api = {
  mailStatus: vi.fn(async () => demoMailStatus(DEMO_MAIL_MESSAGES)),
  mailProbe: vi.fn(async () => ({ folders: { sent: 'Sent', archive: null, trash: 'Trash' }, gmail: false, mailboxes: ['INBOX', 'Sent', 'Trash'] })),
  mailAccountAdd: vi.fn(async () => ({ ...DEMO_MAIL_ACCOUNTS[1], id: 'added' })),
  mailAccountRemove: vi.fn(async () => {}),
  mailAccountUpdate: vi.fn(async () => DEMO_MAIL_ACCOUNTS[0]),
  mailOpenGuide: vi.fn(async () => {}),
  getSettings: vi.fn(async () => settings())
}
const settings = (): AppSettings =>
  ({ mail: { enabled: true, accounts: [DEMO_MAIL_ACCOUNTS[0]], defaultAccountId: 'demo-work', syncDays: 30, notifyNewMail: true } }) as AppSettings
/** The settings' set, which resolves to whether the patch was saved. */
const set = vi.fn(async (_patch: SettingsPatch): Promise<boolean> => true)
const t = createTranslator('ja-JP')
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  set.mockReset().mockImplementation(async () => true)
  useSettingsStore.setState({ settings: settings() })
  useMailStore.setState({ status: null, revision: 0 })
  useToastStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  const ctx = { settings: settings(), set } as unknown as SettingsContext
  await act(async () => root.render(React.createElement(MailSettings, { ctx })))
  await act(async () => {})
  return container.querySelector<HTMLElement>(`[aria-label="${t('settingsMail.title')}"]`)!
}
const setValue = (input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void => {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

it('shows the connection state and the unread count of a registered account, and asks main to remove it only after the confirmation', async () => {
  const group = await render()
  const row = group.querySelector('[data-account="demo-work"]')!
  expect(row.querySelector('.st-chip')?.textContent).toBe(t('settingsMail.state.connected'))
  expect(group.textContent).toContain(t('settingsMail.account.unread', { count: 2 }))
  await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('common.delete'))!.click())
  await answerConfirm(false)
  expect(api.mailAccountRemove).not.toHaveBeenCalled()
  await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('common.delete'))!.click())
  await answerConfirm(true)
  expect(api.mailAccountRemove).toHaveBeenCalledWith('demo-work')
  expect(api.getSettings).toHaveBeenCalled()
})

it('fills the host presets from the chosen provider and adds the account to main only after the connection has been probed', async () => {
  const group = await render()
  await act(async () => [...group.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('settingsMail.add'))!.click())
  const form = group.querySelector<HTMLFormElement>(`[aria-label="${t('settingsMail.form.title')}"]`)!
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.provider')}"]`)!, 'icloud'))
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.label')}"]`)!, '個人'))
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.email')}"]`)!, 'me@example.com'))
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.password')}"]`)!, 'app-pass'))
  await act(async () => [...form.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('settingsMail.form.probe'))!.click())
  expect(api.mailProbe).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'icloud', label: '個人', email: 'me@example.com', password: 'app-pass', imap: { host: 'imap.mail.me.com', port: 993, secure: true } })
  )
  expect(form.querySelector('[role="status"]')?.textContent).toContain(`アーカイブ: ${t('settingsMail.form.probeNoFolder')}`)
  await act(async () => form.requestSubmit())
  expect(api.mailAccountAdd).toHaveBeenCalledWith(expect.objectContaining({ email: 'me@example.com', smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } }))
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('settingsMail.added') })
  expect(group.querySelector(`[aria-label="${t('settingsMail.form.title')}"]`)).toBeNull()
})

it('shows the other addresses an account sends from and saves the ones typed, one per line or separated by commas', async () => {
  const group = await render()
  const row = group.querySelector('[data-account="demo-work"]')!
  await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('settingsMail.account.otherAddresses'))!.click())
  const field = group.querySelector<HTMLTextAreaElement>(`[aria-label="${t('settingsMail.account.otherAddressesLabel', { label: DEMO_MAIL_ACCOUNTS[0].label })}"]`)!
  expect(field.value.split('\n')).toEqual(DEMO_MAIL_ACCOUNTS[0].otherAddresses)
  await act(async () => setValue(field, 'press@example.co.jp\n\nsales@example.co.jp, info@example.co.jp \n'))
  await act(async () => field.form!.requestSubmit())
  expect(api.mailAccountUpdate).toHaveBeenCalledWith('demo-work', { otherAddresses: ['press@example.co.jp', 'sales@example.co.jp', 'info@example.co.jp'] })
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('settingsMail.account.otherAddressesSaved') })
})

it('reopens the other addresses on what is saved after a save that main refused', async () => {
  api.mailAccountUpdate.mockRejectedValueOnce(new Error('refused'))
  const group = await render()
  const row = group.querySelector('[data-account="demo-work"]')!
  const toggle = () => act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('settingsMail.account.otherAddresses'))!.click())
  const field = () => group.querySelector<HTMLTextAreaElement>(`[aria-label="${t('settingsMail.account.otherAddressesLabel', { label: DEMO_MAIL_ACCOUNTS[0].label })}"]`)
  await toggle()
  await act(async () => setValue(field()!, DEMO_MAIL_ACCOUNTS[0].email))
  await act(async () => field()!.form!.requestSubmit())
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: t('settingsMail.account.otherAddressesSaveFailed') })
  expect(field()!.value).toBe(DEMO_MAIL_ACCOUNTS[0].email)
  await toggle()
  expect(field()).toBeNull()
  await toggle()
  expect(field()!.value.split('\n')).toEqual(DEMO_MAIL_ACCOUNTS[0].otherAddresses)
})

it('saves only the option that changed, and ignores a day count outside the allowed range', async () => {
  const group = await render()
  await act(async () => group.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsMail.notify')}"]`)!.click())
  expect(set).toHaveBeenLastCalledWith({ mail: { notifyNewMail: false } })
  const days = group.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMail.syncDays')}"]`)!
  await act(async () => setValue(days, '3'))
  await act(async () => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(set).toHaveBeenCalledTimes(1)
  await act(async () => setValue(days, '60'))
  await act(async () => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(set).toHaveBeenLastCalledWith({ mail: { syncDays: 60 } })
})

it('marks a day count that could not be saved as not saved, and saves it again when the field is left again', async () => {
  set.mockResolvedValueOnce(false)
  const group = await render()
  const days = group.querySelector<HTMLInputElement>(`[aria-label="${t('settingsMail.syncDays')}"]`)!
  await act(async () => setValue(days, '60'))
  await act(async () => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(days.value).toBe('60')
  expect(days.getAttribute('aria-invalid')).toBe('true')
  await act(async () => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(set.mock.calls).toEqual([[{ mail: { syncDays: 60 } }], [{ mail: { syncDays: 60 } }]])
})

it('keeps an account that main adds while an option is switched on the same page', async () => {
  // Main adds the account and saves the settings one after the other, each onto the settings it holds.
  let held = settings()
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }
  const added = { ...DEMO_MAIL_ACCOUNTS[1], id: 'added' }
  let connected!: () => void
  api.mailAccountAdd.mockImplementationOnce(() =>
    inTurn(async () => {
      // The connection check takes seconds on a real server.
      await new Promise<void>((resolve) => (connected = resolve))
      held = mergeSettings(held, { mail: { ...held.mail, accounts: [...held.mail.accounts, added] } })
      return added
    })
  )
  set.mockImplementation((patch: SettingsPatch) => inTurn(() => (held = mergeSettings(held, patch))).then(() => true))
  const group = await render()
  await act(async () => [...group.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === t('settingsMail.add'))!.click())
  const form = group.querySelector<HTMLFormElement>(`[aria-label="${t('settingsMail.form.title')}"]`)!
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.label')}"]`)!, '個人'))
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.email')}"]`)!, 'me@example.com'))
  await act(async () => setValue(form.querySelector(`[aria-label="${t('settingsMail.form.password')}"]`)!, 'app-pass'))
  await act(async () => form.requestSubmit())
  await act(async () => group.querySelector<HTMLButtonElement>(`[aria-label="${t('settingsMail.notify')}"]`)!.click())
  await act(async () => {
    connected()
    await queue
  })
  expect(held.mail.accounts.map((account) => account.id)).toEqual([DEMO_MAIL_ACCOUNTS[0].id, 'added'])
  expect(held.mail.notifyNewMail).toBe(false)
})
