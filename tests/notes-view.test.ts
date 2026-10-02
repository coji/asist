// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteMatches, summarizeNote, type NoteSummary } from '@shared/notes'
import { createTranslator } from '@shared/i18n'
import { NotesView } from '../src/renderer/src/ui/notes/NotesView'
import { useNoteStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { useConfirmStore } from '../src/renderer/src/state/confirm'
import { answerConfirm } from './helpers/confirm'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

vi.mock('@/platform', () => import('./helpers/platform'))

const t = createTranslator('ja-JP')
const TRIP = '20260920-073000-0c9e'
const PLAN = '20260922-181030-b71c'
let bodies: Map<string, { markdown: string; updatedAt: number }>
let clock = 100

const list = (): NoteSummary[] =>
  [...bodies.entries()].map(([id, note]) => summarizeNote(id, note.markdown, note.updatedAt)).sort((a, b) => b.updatedAt - a.updatedAt)
/** Main broadcasts every note once a change is written; the fake does the same through the store. */
const broadcast = (): void => useNoteStore.getState().apply(list())
const api = {
  notesList: vi.fn(async () => list()),
  notesSearch: vi.fn(async (query: string) => list().filter((note) => noteMatches({ ...note, markdown: bodies.get(note.id)!.markdown }, query))),
  noteRead: vi.fn(async (id: string) => bodies.get(id)!.markdown),
  noteCreate: vi.fn(async (markdown: string) => {
    const id = '20260923-100000-aaaa'
    bodies.set(id, { markdown, updatedAt: ++clock })
    broadcast()
    return summarizeNote(id, markdown, clock)
  }),
  noteWrite: vi.fn(async (id: string, markdown: string) => {
    bodies.set(id, { markdown, updatedAt: ++clock })
    broadcast()
    return summarizeNote(id, markdown, clock)
  }),
  noteRemove: vi.fn(async (id: string) => {
    bodies.delete(id)
    broadcast()
  }),
  openExternal: vi.fn(async () => {})
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  bodies = new Map([
    [TRIP, { markdown: '# 旅行の持ち物\n\n充電器と傘\n', updatedAt: 1 }],
    [PLAN, { markdown: '# 提案書の構成\n\n- [ ] 日程の案を作る\n', updatedAt: 2 }]
  ])
  for (const fn of Object.values(api)) fn.mockClear()
  useToastStore.setState({ toasts: [] })
  useNoteStore.setState({ notes: [], loaded: false, error: '' })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'notes' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const settle = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await act(async () => {})
}
async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(NotesView, { open: true })))
  await settle()
  return container.querySelector<HTMLElement>('[aria-label="NOTES"]')!
}
const titles = (view: HTMLElement): string[] => [...view.querySelectorAll('.my-item-title')].map((el) => el.textContent ?? '')
const heading = (view: HTMLElement): string | null | undefined => view.querySelector('.my-doc-head h2')?.textContent
const button = (view: HTMLElement, label: string): HTMLButtonElement =>
  [...view.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(label))!
const setValue = (input: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the notes screen', () => {
  it('lists the most recently changed note first, opens the one a card asked for, and renders its markdown', async () => {
    useViewStore.getState().openApp({ app: 'notes', noteId: TRIP })
    const view = await render()
    expect(titles(view)).toEqual(['提案書の構成', '旅行の持ち物'])
    expect(heading(view)).toBe('旅行の持ち物')
    expect(view.querySelector('.nv-doc p')?.textContent).toBe('充電器と傘')
  })

  it('saves an edit through main, and writes a new note that it then shows', async () => {
    const view = await render()
    await act(async () => button(view, t('notes.edit')).click())
    const editor = view.querySelector<HTMLTextAreaElement>('textarea')!
    expect(editor.value).toBe('# 提案書の構成\n\n- [ ] 日程の案を作る\n')
    await act(async () => setValue(editor, '# 提案書の構成\n\n- [x] 日程の案を作る\n'))
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    await settle()
    expect(api.noteWrite).toHaveBeenCalledWith(PLAN, '# 提案書の構成\n\n- [x] 日程の案を作る\n')
    expect(view.querySelector('textarea')).toBeNull()
    expect(view.querySelector<HTMLInputElement>('.nv-doc input[type="checkbox"]')?.checked).toBe(true)

    await act(async () => button(view, t('notes.newNote')).click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, '# 買い物\n\n牛乳\n'))
    await act(async () => button(view, t('common.save')).click())
    await settle()
    expect(api.noteCreate).toHaveBeenCalledWith('# 買い物\n\n牛乳\n')
    expect(heading(view)).toBe('買い物')
    expect(titles(view)[0]).toBe('買い物')
  })

  it('shows the save key as Windows writes it on Windows, and saves on Ctrl+S there', async () => {
    setCapabilities(WINDOWS)
    const view = await render()
    await act(async () => button(view, t('notes.edit')).click())
    expect(button(view, t('common.save')).querySelector('kbd')?.textContent).toBe('Ctrl+S')
    const editor = view.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => setValue(editor, '# 提案書の構成\n\n- [x] 日程の案を作る\n'))
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    await settle()
    expect(api.noteWrite).toHaveBeenCalledWith(PLAN, '# 提案書の構成\n\n- [x] 日程の案を作る\n')
    setCapabilities(MACOS)
  })

  it('deletes a note only after the confirmation, and then shows the next one', async () => {
    const view = await render()
    await act(async () => button(view, t('common.delete')).click())
    await answerConfirm(false)
    expect(api.noteRemove).not.toHaveBeenCalled()
    await act(async () => button(view, t('common.delete')).click())
    await answerConfirm(true)
    await settle()
    expect(api.noteRemove).toHaveBeenCalledWith(PLAN)
    expect(titles(view)).toEqual(['旅行の持ち物'])
    expect(heading(view)).toBe('旅行の持ち物')
  })

  it("says the note goes to this OS's trash, and names that trash when it is gone", async () => {
    for (const [capabilities, os] of [[MACOS, 'macos'], [WINDOWS, 'windows']] as const) {
      setCapabilities(capabilities)
      const view = await render()
      await act(async () => button(view, t('common.delete')).click())
      expect(useConfirmStore.getState().queue[0].detail).toBe(t(`notes.deleteDetail.${os}`))
      await answerConfirm(true)
      await settle()
      expect(useToastStore.getState().toasts.at(-1)?.title).toBe(t(`notes.deleted.${os}`))
    }
    setCapabilities(MACOS)
  })

  it('searches the body as well as the title', async () => {
    const view = await render()
    await act(async () => setValue(view.querySelector<HTMLInputElement>(`input[aria-label="${t('notes.filter')}"]`)!, '充電器'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    await settle()
    expect(titles(view)).toEqual(['旅行の持ち物'])
  })

  it('leaves the editor on Escape only after the confirmation when there are unsaved changes, and closes the screen on the next Escape', async () => {
    const view = await render()
    await act(async () => button(view, t('notes.edit')).click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'changed'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await answerConfirm(false)
    expect(view.querySelector('textarea')).not.toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await answerConfirm(true)
    expect(view.querySelector('textarea')).toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('notes')
  })

  it('stays open on the Escape that cancels an IME conversion in the filter', async () => {
    const view = await render()
    const filter = view.querySelector<HTMLInputElement>(`input[aria-label="${t('notes.filter')}"]`)!
    await act(async () => setValue(filter, 'じゅうでん'))
    // Chromium on macOS sends the Escape that cancels an IME conversion with isComposing set.
    await act(async () => void filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
    expect(useViewStore.getState().open?.app).toBe('notes')
    await act(async () => void filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(useViewStore.getState().open?.app).not.toBe('notes')
  })

  it('asks before the back button, the Dock, a card or open_app throws an unsaved note away, and keeps it when the answer is no', async () => {
    const view = await render()
    await act(async () => button(view, t('notes.newNote')).click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, '# 買い物\n\n牛乳\n'))
    // open_app naming the screen as it is leaves the draft where it is without asking.
    await act(async () => void useViewStore.getState().openApp({ app: 'notes' }))
    expect(useConfirmStore.getState().queue).toEqual([])
    const leaves = [
      () => view.querySelector<HTMLButtonElement>('header > button')!.click(),
      () => void useViewStore.getState().toggleApp('notes'),
      () => void useViewStore.getState().openApp({ app: 'notes', noteId: TRIP }),
      () => void useViewStore.getState().openApp({ app: 'tasks' })
    ]
    for (const leave of leaves) {
      await act(async () => leave())
      await answerConfirm(false)
      expect(useViewStore.getState().open).toEqual({ app: 'notes', noteId: null, editing: true })
      expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# 買い物\n\n牛乳\n')
    }
    await act(async () => void useViewStore.getState().openApp({ app: 'notes', noteId: TRIP }))
    await answerConfirm(true)
    await settle()
    expect(useViewStore.getState().open).toEqual({ app: 'notes', noteId: TRIP, editing: false })
    expect(heading(view)).toBe('旅行の持ち物')
    expect(api.noteCreate).not.toHaveBeenCalled()
    // Once the draft is thrown away, leaving for another screen asks nothing more, even while the view is
    // still drawn as it closes.
    await act(async () => button(view, t('notes.newNote')).click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, '# 買い物\n\n卵\n'))
    await act(async () => void useViewStore.getState().openApp({ app: 'tasks' }))
    await answerConfirm(true)
    expect(useViewStore.getState().open?.app).toBe('tasks')
    await act(async () => void useViewStore.getState().openApp({ app: 'calendar' }))
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(useViewStore.getState().open?.app).toBe('calendar')
    await act(async () => void useViewStore.getState().openApp({ app: 'notes' }))
    await settle()
    // With nothing left to lose, the back button closes the screen without asking.
    await act(async () => view.querySelector<HTMLButtonElement>('header > button')!.click())
    expect(useViewStore.getState().open).toBeNull()
  })
})
