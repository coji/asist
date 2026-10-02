// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NavigationDock } from '@/ui/NavigationDock'
import { useMailStore, useSettingsStore, useTaskStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import type { AppSettings } from '@shared/ipc'
import { dayKeyOf } from '@shared/tasks'
import { createTranslator } from '@shared/i18n'

const t = createTranslator('ja-JP')

it('lists the conversation, Agent, tasks, notes, mail, memory, calendar and settings in that order, opens one at a time, and closes it on Escape', async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({ tasks: [], loaded: true, error: '' })
    await act(async () => root.render(React.createElement(NavigationDock)))
    const [home, agent, tasks, notes, mail, diary, calendar, settings] = container.querySelectorAll('button')
    expect([...container.querySelectorAll('button span')].map((el) => el.textContent)).toEqual(['ASIST', t('navigation.items.jobs'), t('navigation.items.tasks'), t('navigation.items.notes'), t('navigation.items.mail'), t('navigation.items.memory'), t('navigation.items.calendar'), t('navigation.items.settings')])
    await act(async () => agent.click())
    expect(useViewStore.getState().open?.app).toBe('jobs')
    await act(async () => tasks.click())
    expect(useViewStore.getState().open?.app).toBe('tasks')
    await act(async () => notes.click())
    expect(useViewStore.getState().open?.app).toBe('notes')
    await act(async () => mail.click())
    expect(useViewStore.getState().open?.app).toBe('mail')
    await act(async () => diary.click())
    expect(useViewStore.getState().open?.app).toBe('memory')
    await act(async () => calendar.click())
    expect(useViewStore.getState().open?.app).toBe('calendar')
    await act(async () => settings.click())
    expect(useViewStore.getState().open?.app).toBe('settings')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('settings')
    await act(async () => calendar.click())
    await act(async () => home.click())
    expect(useViewStore.getState().open?.app).not.toBe('calendar')
    expect(home.getAttribute('aria-pressed')).toBe('true')
    await act(async () => agent.click())
    await act(async () => agent.click())
    expect(useViewStore.getState().open?.app).not.toBe('jobs')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('counts on the task badge the unfinished tasks due today or overdue, and neither the finished ones nor the later due dates', async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const today = dayKeyOf(new Date())
  const base = { notes: '', order: 0, createdAt: 1, updatedAt: 1, completedAt: null }
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({
      loaded: true,
      error: '',
      tasks: [
        { ...base, id: 'a', title: '今日が締め切りの見積もり', status: 'todo', due: today },
        { ...base, id: 'b', title: '先月出すはずだった書類', status: 'doing', due: '2000-01-01' },
        { ...base, id: 'c', title: '先', status: 'todo', due: '2999-01-01' },
        { ...base, id: 'd', title: '済ませた振り込み', status: 'done', due: today, completedAt: 1 },
        { ...base, id: 'e', title: 'いつか読む本', status: 'todo', due: null }
      ]
    })
    await act(async () => root.render(React.createElement(NavigationDock)))
    const tasks = container.querySelectorAll('button')[2]
    expect(tasks.querySelector('.dock-badge')?.textContent).toBe('2')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('counts on the task badge a task due the next day once midnight passes', async () => {
  vi.useFakeTimers({ now: new Date(2026, 9, 2, 23, 59, 30) })
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({
      loaded: true,
      error: '',
      tasks: [{ id: 'a', title: '経費精算', notes: '', status: 'todo', due: '2026-10-03', order: 0, createdAt: 1, updatedAt: 1, completedAt: null }]
    })
    await act(async () => root.render(React.createElement(NavigationDock)))
    const tasks = container.querySelector<HTMLButtonElement>('button[data-item="tasks"]')!
    expect(tasks.querySelector('.dock-badge')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000)
    })
    expect(tasks.querySelector('.dock-badge')?.textContent).toBe('1')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it('counts on the mail badge the unread messages of the last 24 hours and not the older unread ones', async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({ tasks: [], loaded: true, error: '' })
    useMailStore.setState({ status: { enabled: true, accounts: [], unread: 12, unreadRecent: 3 } })
    await act(async () => root.render(React.createElement(NavigationDock)))
    const mail = container.querySelector<HTMLButtonElement>('button[data-item="mail"]')!
    expect(mail.getAttribute('aria-label')).toBe(t('navigation.items.mail'))
    expect(mail.querySelector('.dock-badge')?.textContent).toBe('3')
  } finally {
    useMailStore.setState({ status: null })
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('follows the stored dockOrder and keeps ASIST pinned to the left end', async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({ tasks: [], loaded: true, error: '' })
    useSettingsStore.setState({ settings: { dockOrder: ['settings', 'calendar', 'memory', 'mail', 'notes', 'tasks', 'jobs'] } as AppSettings })
    await act(async () => root.render(React.createElement(NavigationDock)))
    expect([...container.querySelectorAll('button span')].map((el) => el.textContent)).toEqual(['ASIST', t('navigation.items.settings'), t('navigation.items.calendar'), t('navigation.items.memory'), t('navigation.items.mail'), t('navigation.items.notes'), t('navigation.items.tasks'), t('navigation.items.jobs')])
    expect([...container.querySelectorAll('button[data-item]')].map((el) => el.getAttribute('data-item'))).toEqual(['settings', 'calendar', 'memory', 'mail', 'notes', 'tasks', 'jobs'])
  } finally {
    useSettingsStore.setState({ settings: null })
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('leaves the settings open on the Escape that cancels an IME conversion in one of their fields, and closes them on the next Escape', async () => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const field = document.body.appendChild(document.createElement('textarea'))
  try {
    useViewStore.getState().closeApp()
    useTaskStore.setState({ tasks: [], loaded: true, error: '' })
    await act(async () => root.render(React.createElement(NavigationDock)))
    await act(async () => useViewStore.getState().openApp({ app: 'settings' }))
    field.focus()
    // Chromium on macOS sends the Escape that cancels an IME conversion with isComposing set.
    await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
    expect(useViewStore.getState().open?.app).toBe('settings')
    await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(useViewStore.getState().open?.app).not.toBe('settings')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    field.remove()
    vi.unstubAllGlobals()
  }
})
