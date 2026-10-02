// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteMatches, summarizeNote, type NoteChange, type NoteSummary } from '@shared/notes'
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
/** Main tells the store the changes of each save once they are written; the fake does the same. */
const tell = (change: NoteChange): void => useNoteStore.getState().apply([change])
const save = (id: string, markdown: string): NoteSummary => {
  bodies.set(id, { markdown, updatedAt: ++clock })
  const note = summarizeNote(id, markdown, clock)
  tell({ type: 'saved', note })
  return note
}
const api = {
  notesList: vi.fn(async () => list()),
  notesSearch: vi.fn(async (query: string) => list().filter((note) => noteMatches({ ...note, markdown: bodies.get(note.id)!.markdown }, query))),
  noteRead: vi.fn(async (id: string) => bodies.get(id)!.markdown),
  noteCreate: vi.fn(async (markdown: string) => save('20260923-100000-aaaa', markdown)),
  noteWrite: vi.fn(async (id: string, markdown: string) => save(id, markdown)),
  noteRemove: vi.fn(async (id: string) => {
    bodies.delete(id)
    tell({ type: 'removed', id })
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

  it('shows every note when a change arrives before the list has been read, not that note alone', async () => {
    save('20260923-100000-aaaa', '# 買い物\n\n牛乳\n')
    const view = await render()
    expect(titles(view)).toEqual(['買い物', '提案書の構成', '旅行の持ち物'])
  })

  it('shows the changes main saw outside ASIST: the open note read again, and a note deleted there gone from the list', async () => {
    useViewStore.getState().openApp({ app: 'notes', noteId: TRIP })
    const view = await render()
    bodies.set(TRIP, { markdown: '# 旅行の持ち物\n\nパスポート\n', updatedAt: ++clock })
    bodies.delete(PLAN)
    const edited = summarizeNote(TRIP, bodies.get(TRIP)!.markdown, clock)
    await act(async () => useNoteStore.getState().apply([{ type: 'saved', note: edited }, { type: 'removed', id: PLAN }]))
    await settle()
    expect(titles(view)).toEqual(['旅行の持ち物'])
    expect(view.querySelector('.nv-doc p')?.textContent).toBe('パスポート')
  })

  describe('a note being edited that changes or is deleted outside ASIST', () => {
    const changeOutside = async (id: string, markdown: string): Promise<void> => {
      bodies.set(id, { markdown, updatedAt: ++clock })
      await act(async () => tell({ type: 'saved', note: summarizeNote(id, markdown, clock) }))
      await settle()
    }
    const deleteOutside = async (id: string): Promise<void> => {
      bodies.delete(id)
      await act(async () => tell({ type: 'removed', id }))
      await settle()
    }
    const editTrip = async (): Promise<HTMLElement> => {
      useViewStore.getState().openApp({ app: 'notes', noteId: TRIP })
      const view = await render()
      await act(async () => button(view, t('notes.edit')).click())
      return view
    }
    const editor = (view: HTMLElement): HTMLTextAreaElement => view.querySelector<HTMLTextAreaElement>('textarea')!
    const notice = (view: HTMLElement): string | null | undefined => view.querySelector('.nv-notice')?.textContent

    it('takes the new text into the editor when nothing was typed, and has nothing to save', async () => {
      const view = await editTrip()
      await changeOutside(TRIP, '# 旅行の持ち物\n\n外で足したパスポート\n')
      expect(editor(view).value).toBe('# 旅行の持ち物\n\n外で足したパスポート\n')
      expect(notice(view)).toBeUndefined()
      expect(button(view, t('common.save')).disabled).toBe(true)
      await act(async () => editor(view).dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
      expect(api.noteWrite).not.toHaveBeenCalled()
    })

    it('keeps unsaved edits and writes them over the other change only when the user chooses to', async () => {
      const view = await editTrip()
      await act(async () => setValue(editor(view), '# 旅行の持ち物\n\n充電器と傘と地図\n'))
      await changeOutside(TRIP, '# 旅行の持ち物\n\n外で足したパスポート\n')
      expect(editor(view).value).toBe('# 旅行の持ち物\n\n充電器と傘と地図\n')
      expect(notice(view)).toContain(t('notes.changedOutside.message'))
      expect(button(view, t('common.save')).disabled).toBe(true)
      await act(async () => editor(view).dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
      expect(api.noteWrite).not.toHaveBeenCalled()
      await act(async () => button(view, t('notes.changedOutside.overwrite')).click())
      await settle()
      expect(api.noteWrite).toHaveBeenCalledWith(TRIP, '# 旅行の持ち物\n\n充電器と傘と地図\n')
      expect(view.querySelector('textarea')).toBeNull()
      expect(notice(view)).toBeUndefined()
    })

    it('loads the new version when the user chooses it, giving up the edits without asking again', async () => {
      const view = await editTrip()
      await act(async () => setValue(editor(view), '# 旅行の持ち物\n\n充電器と傘と地図\n'))
      await changeOutside(TRIP, '# 旅行の持ち物\n\n外で足したパスポート\n')
      await act(async () => button(view, t('notes.changedOutside.load')).click())
      await settle()
      expect(useConfirmStore.getState().queue).toEqual([])
      expect(editor(view).value).toBe('# 旅行の持ち物\n\n外で足したパスポート\n')
      expect(notice(view)).toBeUndefined()
      expect(button(view, t('common.save')).disabled).toBe(true)
    })

    it('keeps unsaved edits of a note deleted outside as a new note, which saving creates, and asks before they are thrown away', async () => {
      const view = await editTrip()
      await act(async () => setValue(editor(view), '# 旅行の持ち物\n\n充電器と傘と地図\n'))
      await deleteOutside(TRIP)
      expect(editor(view).value).toBe('# 旅行の持ち物\n\n充電器と傘と地図\n')
      expect(notice(view)).toBe(t('notes.deletedOutside'))
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      await answerConfirm(false)
      expect(editor(view).value).toBe('# 旅行の持ち物\n\n充電器と傘と地図\n')
      await act(async () => button(view, t('common.save')).click())
      await settle()
      expect(api.noteCreate).toHaveBeenCalledWith('# 旅行の持ち物\n\n充電器と傘と地図\n')
      expect(view.querySelector('textarea')).toBeNull()
      expect(titles(view)).toEqual(['旅行の持ち物', '提案書の構成'])
    })

    it('closes the editor and shows the newest note when the note is deleted outside with nothing typed', async () => {
      const view = await editTrip()
      await deleteOutside(TRIP)
      expect(view.querySelector('textarea')).toBeNull()
      expect(heading(view)).toBe('提案書の構成')
    })
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
