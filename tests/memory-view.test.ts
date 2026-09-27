// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentOf } from '@shared/memory-page'
import { errorText } from '@shared/i18n/error-text'
import { Markdown } from '../src/renderer/src/ui/memory/Markdown'
import { MemoryView } from '../src/renderer/src/ui/memory/MemoryView'
import { useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { useConfirmStore } from '../src/renderer/src/state/confirm'
import { answerConfirm } from './helpers/confirm'
import { createTranslator } from '@shared/i18n'

vi.mock('@/platform', () => import('./helpers/platform'))

const t = createTranslator('ja-JP')

const FILES: Record<string, string> = {
  'instruction.md': '# いつも覚えておくこと\n\n## この人について\n最寄り駅は中野。\n',
  'me.md': '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 私は誰か\n落ち着いて話す。\n',
  'user.md': '---\nupdated: 2026-09-09\n---\n# ユーザー\n\n## 好み\nコーヒーは砂糖なし。\n',
  'journal/2026-09-14.md': '# 2026-09-14\n\n## 電気料金の話\n私は記事の筋をなぞって話しすぎた。大川俊介さんとの打ち合わせが近い。\n\n## 今日の私\n**まず何が分かっているか**を言う。\n',
  'journal/2026-09-13.md': '# 2026-09-13\n\n## 天気\n仙台と東京の天気を何度も聞かれた。\n',
  'pages/松葉軒.md': '---\naliases: [松葉軒, ラーメン屋]\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。\n\n## 私の印象\n疲れた日に名前が出る。\n',
  'pages/大川俊介.md': '---\naliases: [大川さん]\nupdated: 2026-09-10\n---\n# 大川俊介\n\n## 要約\n本人の上司。\n'
}
let files: Record<string, string>
/** The order in which main's listDocuments returns the files; a page created later comes after the existing pages. */
const order = ['instruction.md', 'me.md', 'user.md', 'pages/大川俊介.md', 'pages/松葉軒.md', 'journal/2026-09-14.md', 'journal/2026-09-13.md']
const listed = (): string[] => {
  const known = order.filter((file) => files[file] !== undefined)
  const extra = Object.keys(files).filter((file) => !order.includes(file))
  const lastPage = known.findLastIndex((file) => file.startsWith('pages/'))
  return [...known.slice(0, lastPage + 1), ...extra, ...known.slice(lastPage + 1)]
}
const api = {
  memoryDocuments: vi.fn(async () => listed().map((file) => documentOf(file, files[file]))),
  memoryDocumentRead: vi.fn(async (file: string) => files[file] ?? null),
  memoryDocumentWrite: vi.fn(async (file: string, markdown: string, base: string) => {
    if (files[file] === undefined) throw new Error(errorText('memory.errors.removedSinceOpened'))
    if (files[file] !== base) throw new Error(errorText('memory.errors.changedSinceOpened'))
    files[file] = markdown
    return documentOf(file, markdown)
  }),
  memoryDocumentCreate: vi.fn(async ({ name }: { name: string }) => {
    const file = `pages/${name}.md`
    files[file] = `---\naliases: []\nupdated: 2026-09-16\n---\n# ${name}\n\n## 要約\n何者か。\n`
    return documentOf(file, files[file])
  }),
  memoryDocumentDelete: vi.fn(async (file: string) => {
    delete files[file]
  }),
  memoryCurate: vi.fn(async () => ({ id: 'job-1', title: '記憶のまとめ直し' })),
  openExternal: vi.fn(async () => {})
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  files = { ...FILES }
  for (const fn of Object.values(api)) fn.mockClear()
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'memory' })
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
  await act(async () => root.render(React.createElement(MemoryView, { open: true })))
  await act(async () => {})
  await act(async () => {})
  return container.querySelector<HTMLElement>('[aria-label="MEMORY"]')!
}
const itemTitles = (view: HTMLElement, group: string): string[] =>
  [...view.querySelectorAll<HTMLElement>(`.my-group[aria-label="${group}"] .my-item-title`)].map((el) => el.textContent ?? '')
const itemByTitle = (view: HTMLElement, title: string): HTMLButtonElement =>
  [...view.querySelectorAll<HTMLButtonElement>('.my-item')].find((el) => el.querySelector('.my-item-title')?.textContent === title)!
const heading = (view: HTMLElement): string | null | undefined => view.querySelector('.my-doc-head h2')?.textContent
/** Waits until the chain of create, reload and open has settled. */
const settle = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await act(async () => {})
}
const setValue = (input: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('links in a memory page', () => {
  it('opens a web or mail link outside the app, says so when it cannot, and keeps any other link as its text', async () => {
    const text = 'See [the site](https://example.com/a), [mail](mailto:team@example.com) and [a note](pages/other.md).'
    await act(async () => root.render(React.createElement(Markdown, { text })))
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.my-link')]
    expect(buttons.map((button) => button.textContent)).toEqual(['the site', 'mail'])
    expect(container.textContent).toContain('and a note.')

    api.openExternal.mockRejectedValueOnce(new Error(errorText('app.links.refused', { url: 'mailto:team@example.com' })))
    await act(async () => buttons[1].click())
    await act(async () => {})
    expect(api.openExternal).toHaveBeenCalledWith('mailto:team@example.com')
    expect(useToastStore.getState().toasts).toMatchObject([
      { kind: 'error', title: t('app.links.openFailed'), body: t('app.links.refused', { url: 'mailto:team@example.com' }) }
    ])
  })
})

describe('the memory screen', () => {
  it('groups the list into self and user, the journal by month with the newest day first, and the pages in the order main lists them, and opens the latest entry', async () => {
    const view = await render()
    expect(itemTitles(view, t('memory.self'))).toEqual([t('memory.kind.instruction'), t('memory.kind.me'), t('memory.kind.user')])
    expect(itemTitles(view, t('memory.journals'))).toEqual(['9/14(月)', '9/13(日)'])
    expect(view.querySelector(`.my-group[aria-label="${t('memory.journals')}"] h4`)?.textContent).toBe('2026年9月')
    expect(itemTitles(view, t('memory.pages'))).toEqual(['大川俊介', '松葉軒'])
    expect(heading(view)).toBe('2026年9月14日(月)')
    expect(view.querySelector('.my-kind')?.textContent).toBe(t('memory.kind.journal'))
    expect([...view.querySelectorAll('.my-markdown h3')].map((el) => el.textContent)).toEqual(['電気料金の話', '今日の私'])

    await act(async () => itemByTitle(view, '松葉軒').click())
    await act(async () => {})
    expect(heading(view)).toBe('松葉軒')
    expect(view.querySelector('.my-kind')?.textContent).toBe(t('memory.kind.page'))
    expect(view.querySelector('.my-doc-title p')?.textContent).toBe(
      `${t('memory.meta.updated', { date: '2026-09-09' })} · ${t('memory.meta.aliases', { names: `松葉軒${t('memory.meta.nameSeparator')}ラーメン屋` })} · ${t('memory.meta.headings', { count: 2 })}`
    )
    expect(view.textContent).toContain('疲れた日に名前が出る')
  })

  it('filters on the title, the aliases and the headings', async () => {
    const view = await render()
    await act(async () => setValue(view.querySelector<HTMLInputElement>(`input[aria-label="${t('memory.filter')}"]`)!, '大川さん'))
    expect(itemTitles(view, t('memory.pages'))).toEqual(['大川俊介'])
    expect(itemTitles(view, t('memory.journals'))).toEqual([])
    expect(view.querySelector(`.my-group[aria-label="${t('memory.journals')}"] .my-side-empty`)?.textContent).toBe(t('memory.noJournalMatch'))
  })

  it('hands the edited markdown to main on ⌘S, and reports the reason and stays in the editor when the document breaks the rules', async () => {
    const view = await render()
    await act(async () => itemByTitle(view, t('memory.kind.me')).click())
    await act(async () => {})
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    const editor = view.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('memory.doc.body')}"]`)!
    expect(editor.value).toBe(FILES['me.md'])
    const draft = FILES['me.md'].replace('落ち着いて話す。', '落ち着いて、確かめてから話す。')
    await act(async () => setValue(editor, draft))
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })))
    await settle()
    expect(api.memoryDocumentWrite).toHaveBeenCalledWith('me.md', draft, FILES['me.md'])
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe(t('memory.saved'))
    expect(view.querySelector('textarea')).toBeNull()
    expect(view.textContent).toContain('確かめてから話す')

    api.memoryDocumentWrite.mockRejectedValueOnce(new Error(t('memory.check.frontmatterMissing', { file: 'me.md' })))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'broken'))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent?.startsWith(t('common.save')))!.click())
    await act(async () => {})
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', body: t('memory.check.frontmatterMissing', { file: 'me.md' }) })
    expect(view.querySelector('textarea')).not.toBeNull()
  })

  it('does not save over a document a curation changed while it was being edited, keeps the draft, and shows the current version once the editor is left', async () => {
    const view = await render()
    await act(async () => itemByTitle(view, t('memory.kind.instruction')).click())
    await act(async () => {})
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    const curated = FILES['instruction.md'].replace('最寄り駅は中野。', '最寄り駅は中野。\n猫のムギと暮らす。')
    files['instruction.md'] = curated
    const draft = FILES['instruction.md'].replace('最寄り駅は中野。', '最寄り駅は中野。駅から徒歩10分。')
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, draft))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent?.startsWith(t('common.save')))!.click())
    await settle()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      title: t('memory.saveFailed'),
      body: t('memory.errors.changedSinceOpened')
    })
    expect(files['instruction.md']).toBe(curated)
    expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft)

    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('common.cancel'))!.click())
    await answerConfirm(true)
    expect(view.querySelector('textarea')).toBeNull()
    expect(view.textContent).toContain('猫のムギと暮らす。')
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    const redone = curated.replace('最寄り駅は中野。', '最寄り駅は中野。駅から徒歩10分。')
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, redone))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent?.startsWith(t('common.save')))!.click())
    await settle()
    expect(files['instruction.md']).toBe(redone)
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe(t('memory.saved'))
  })

  it('creates a new page from its name, opens the editor on it, and deletes a page only after the confirmation', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.my-side-action')!.click())
    const form = view.querySelector<HTMLFormElement>(`form[aria-label="${t('memory.newPage')}"]`)!
    await act(async () => setValue(form.querySelector<HTMLInputElement>(`input[aria-label="${t('memory.create.name')}"]`)!, '田中さん'))
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await settle()
    expect(api.memoryDocumentCreate).toHaveBeenCalledWith({ name: '田中さん' })
    expect(heading(view)).toBe('田中さん')
    expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('# 田中さん')
    expect(itemTitles(view, t('memory.pages'))).toEqual(['大川俊介', '松葉軒', '田中さん'])

    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('common.cancel'))!.click())
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('common.delete'))!.click())
    await answerConfirm(true)
    await settle()
    expect(api.memoryDocumentDelete).toHaveBeenCalledWith('pages/田中さん.md')
    expect(itemTitles(view, t('memory.pages'))).toEqual(['大川俊介', '松葉軒'])
  })

  it('closes the screen on Escape while reading, and leaves the editor only after the confirmation when there are unsaved changes', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'changed'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await answerConfirm(false)
    expect(view.querySelector('textarea')).not.toBeNull()
    expect(useViewStore.getState().open?.app).toBe('memory')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await answerConfirm(true)
    expect(view.querySelector('textarea')).toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('memory')
  })

  it('keeps the draft of a page a curation removed while it was edited, refuses to save it with the reason, and moves on only once the draft is thrown away', async () => {
    const view = await render()
    await act(async () => itemByTitle(view, '松葉軒').click())
    await act(async () => {})
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    const draft = FILES['pages/松葉軒.md'].replace('疲れた日に名前が出る。', '疲れた日に名前が出る。長い下書き。')
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, draft))
    // A curation moves what the page held into another and removes it.
    delete files['pages/松葉軒.md']
    const saveButton = (): HTMLButtonElement => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent?.startsWith(t('common.save')))!
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => saveButton().click())
      await settle()
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', body: t('memory.errors.removedSinceOpened') })
      expect(files['pages/松葉軒.md']).toBeUndefined()
      expect(useConfirmStore.getState().queue).toEqual([])
      expect(useViewStore.getState().open).toEqual({ app: 'memory', file: 'pages/松葉軒.md' })
      expect(heading(view)).toBe('松葉軒')
      expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft)
    }
    expect(itemTitles(view, t('memory.pages'))).toEqual(['大川俊介'])

    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('common.cancel'))!.click())
    await answerConfirm(true)
    await settle()
    expect(useViewStore.getState().open).toEqual({ app: 'memory', file: 'journal/2026-09-14.md' })
    expect(heading(view)).toBe('2026年9月14日(月)')
  })

  it('asks before "New page" throws an unsaved edit away', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, '書きかけ'))
    await act(async () => view.querySelector<HTMLButtonElement>('.my-side-action')!.click())
    await answerConfirm(false)
    expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('書きかけ')
    await act(async () => view.querySelector<HTMLButtonElement>('.my-side-action')!.click())
    await answerConfirm(true)
    expect(view.querySelector(`form[aria-label="${t('memory.newPage')}"]`)).not.toBeNull()
    expect(view.querySelector('textarea')).toBeNull()
  })

  it('asks before the back button, the Dock, a card or open_app throws an unsaved edit away, and keeps it when the answer is no', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-btn')].find((b) => b.textContent === t('memory.doc.edit'))!.click())
    const draft = FILES['journal/2026-09-14.md'].replace('## 今日の私', '## 書きかけ\n長い下書き。\n\n## 今日の私')
    await act(async () => setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, draft))
    // open_app naming the document already shown leaves the draft where it is without asking.
    await act(async () => void useViewStore.getState().openApp({ app: 'memory', file: 'journal/2026-09-14.md' }))
    expect(useConfirmStore.getState().queue).toEqual([])
    const leaves = [
      () => view.querySelector<HTMLButtonElement>('header > button')!.click(),
      () => void useViewStore.getState().toggleApp('memory'),
      () => void useViewStore.getState().openApp({ app: 'memory', file: 'pages/松葉軒.md' }),
      () => void useViewStore.getState().openApp({ app: 'tasks' })
    ]
    for (const leave of leaves) {
      await act(async () => leave())
      await answerConfirm(false)
      expect(useViewStore.getState().open).toEqual({ app: 'memory', file: 'journal/2026-09-14.md' })
      expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft)
    }
    await act(async () => void useViewStore.getState().openApp({ app: 'tasks' }))
    await answerConfirm(true)
    expect(useViewStore.getState().open).toEqual({ app: 'tasks', view: 'board', taskId: null })
    expect(api.memoryDocumentWrite).not.toHaveBeenCalled()
  })

  it('closes from the back button without asking when nothing is being edited', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('header > button')!.click())
    expect(useConfirmStore.getState().queue).toEqual([])
    expect(useViewStore.getState().open).toBeNull()
  })

  it('opens the address of a link in a document when it is pressed', async () => {
    files['pages/松葉軒.md'] = FILES['pages/松葉軒.md'].replace('疲れた日に名前が出る。', '[地図](https://example.com/map) を見て行く。')
    const view = await render()
    await act(async () => itemByTitle(view, '松葉軒').click())
    await act(async () => {})
    const link = view.querySelector<HTMLButtonElement>('.my-markdown .my-link')!
    expect(link.textContent).toBe('地図')
    await act(async () => link.click())
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/map')
  })

  it('says that there is no memory yet and offers to start a curation', async () => {
    files = {}
    const view = await render()
    expect(view.querySelector('.my-empty')?.textContent).toContain(t('memory.empty.title'))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.my-empty button')].find((b) => b.textContent === t('memory.empty.curate'))!.click())
    expect(api.memoryCurate).toHaveBeenCalled()
  })
})
