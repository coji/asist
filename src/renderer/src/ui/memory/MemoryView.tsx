import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import type { MemoryDocument } from '@shared/ipc'
import type { Translate } from '@shared/i18n'
import { JOURNAL_SELF_HEADINGS } from '@shared/memory-page'
import { SaveShortcutKey, isSaveShortcut } from '@/ui/save-shortcut'
import { keyForApp } from '@/ui/key-for-app'
import { useToastStore } from '@/state/stores'
import { useLeaveGuard, useMiniApp, useViewStore } from '@/state/view'
import { askConfirm } from '@/state/confirm'
import { Markdown } from './Markdown'
import { displayError } from '@/display-error'
import { useT, useFormatLocale } from '@/i18n'

/**
 * The memory view, with the list of documents on the left, covering what ASIST knows about itself
 * and about the user, the diary and the pages, and the chosen document on the right. A document can
 * be read and also edited as markdown and saved, and main commits the save. Pages can be created
 * from a template, and pages and diary entries can be deleted. Main refuses a save that breaks the
 * writing rules and gives the reason.
 */

const parseDate = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const dayLabel = (date: string, locale: string): string =>
  parseDate(date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric', weekday: 'short' })
const monthLabel = (date: string, locale: string): string => parseDate(date).toLocaleDateString(locale, { year: 'numeric', month: 'long' })
const fullDate = (date: string, locale: string): string =>
  parseDate(date).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })

const kindLabel = (doc: MemoryDocument, t: Translate): string => t(`memory.kind.${doc.kind}`)
/** The diary is titled by its date, a page by its own name, and the two fixed documents by what they hold. */
const titleOf = (doc: MemoryDocument, t: Translate, locale: string): string =>
  doc.kind === 'journal' ? fullDate(doc.title, locale) : doc.kind === 'page' ? doc.title : t(`memory.kind.${doc.kind}`)
const metaOf = (doc: MemoryDocument, t: Translate): string => {
  if (doc.kind === 'journal') return t('memory.meta.topics', { count: doc.headings.length })
  if (doc.kind === 'me') return t('memory.meta.me')
  if (doc.kind === 'user') return t('memory.meta.user')
  const parts = [
    doc.updated ? t('memory.meta.updated', { date: doc.updated }) : null,
    doc.aliases.length > 0 ? t('memory.meta.aliases', { names: doc.aliases.join(t('memory.meta.nameSeparator')) }) : null,
    t('memory.meta.headings', { count: doc.headings.length })
  ]
  return parts.filter(Boolean).join(' · ')
}
const matches = (doc: MemoryDocument, filter: string): boolean => {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  return [doc.title, doc.summary, ...doc.aliases, ...doc.headings].some((text) => text.toLowerCase().includes(needle))
}

/**
 * An edit keeps the document it edits and the text it started from, which a save hands to main as the
 * version it replaces. It ends only through leaveEditing or a save, so the draft stays even when the
 * document leaves the list, as when a curation removes it.
 */
type Mode = { kind: 'read' } | { kind: 'edit'; doc: MemoryDocument; draft: string; base: string } | { kind: 'create' }

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function MemoryView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const update = useViewStore((s) => s.update)
  const { file: selected } = useMiniApp('memory')
  const setSelected = (file: string | null): void => update('memory', { file })
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const [documents, setDocuments] = useState<MemoryDocument[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'read' })
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  // A page that has just been created goes straight into editing once it has loaded.
  const editOnLoad = useRef<MemoryDocument | null>(null)

  const reload = async (): Promise<MemoryDocument[]> => {
    const list = await window.api.memoryDocuments()
    setDocuments(list)
    setLoaded(true)
    return list
  }

  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    reload().catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, revision])

  const editing = mode.kind === 'edit'
  // With no document chosen, or one the list does not have, the newest diary entry is shown, or the
  // first document when there is no diary. An edit keeps its document chosen until it ends.
  useEffect(() => {
    if (!loaded || editing || (selected && documents.some((doc) => doc.file === selected))) return
    update('memory', { file: (documents.find((doc) => doc.kind === 'journal') ?? documents[0])?.file ?? null })
  }, [loaded, editing, documents, selected, update])

  useEffect(() => {
    if (!open || !selected) return
    let active = true
    setMarkdown(null)
    setMode((current) => (current.kind === 'edit' ? current : { kind: 'read' }))
    window.api
      .memoryDocumentRead(selected)
      .then((text) => {
        if (!active) return
        const value = text ?? ''
        setMarkdown(value)
        const created = editOnLoad.current
        if (created?.file === selected) {
          editOnLoad.current = null
          setMode({ kind: 'edit', doc: created, draft: value, base: value })
        }
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, selected, revision])

  const dirty = mode.kind === 'edit' && mode.draft !== mode.base
  const leaveEditing = async (): Promise<boolean> => {
    if (dirty && !(await askConfirm({ message: t('common.confirmDiscard'), confirmLabel: t('common.discardChanges'), destructive: true }))) return false
    setMode({ kind: 'read' })
    return true
  }
  useLeaveGuard(dirty, leaveEditing)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (keyForApp(event) !== 'Escape' || event.defaultPrevented) return
      if (mode.kind === 'read') closeApp()
      else void leaveEditing()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // leaveEditing follows from mode and markdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, markdown, closeApp])

  const doc = mode.kind === 'edit' ? mode.doc : (documents.find((candidate) => candidate.file === selected) ?? null)
  const shown = useMemo(() => documents.filter((candidate) => matches(candidate, filter)), [documents, filter])
  const self = shown.filter((candidate) => candidate.kind === 'me' || candidate.kind === 'user')
  const journals = shown.filter((candidate) => candidate.kind === 'journal')
  const pages = shown.filter((candidate) => candidate.kind === 'page')
  const months: Array<{ label: string; docs: MemoryDocument[] }> = []
  for (const entry of journals) {
    const label = monthLabel(entry.title, locale)
    const last = months.at(-1)
    if (last && last.label === label) last.docs.push(entry)
    else months.push({ label, docs: [entry] })
  }

  if (!open) return <></>

  const select = async (file: string): Promise<void> => {
    if (file === selected && mode.kind !== 'create') return
    if (mode.kind === 'edit' && !(await leaveEditing())) return
    setMode({ kind: 'read' })
    setSelected(file)
  }
  const startCreate = async (): Promise<void> => {
    if (mode.kind === 'edit' && !(await leaveEditing())) return
    setMode({ kind: 'create' })
  }
  const save = (): void => {
    if (mode.kind !== 'edit' || busy) return
    const { doc: edited, draft, base } = mode
    setBusy(true)
    void window.api
      .memoryDocumentWrite(edited.file, draft, base)
      .then(
        () => {
          toast({ kind: 'ok', title: t('memory.saved'), body: titleOf(edited, t, locale) })
          setMode({ kind: 'read' })
          // Main may have written the draft with a final newline added, so the next edit starts from the file.
          setRevision((v) => v + 1)
        },
        async (err: unknown) => {
          toast({ kind: 'error', title: t('memory.saveFailed'), body: displayError(err) })
          // The draft stays in the editor. The document and the list are read again for the view the editor
          // leaves to, because a save is refused when a curation has changed or removed the document since
          // the editor opened.
          const text = await window.api.memoryDocumentRead(edited.file)
          setMarkdown(text ?? '')
          await reload()
        }
      )
      .catch((err: unknown) => setError(displayError(err)))
      .finally(() => setBusy(false))
  }
  const create = (name: string): void => {
    setBusy(true)
    void window.api
      .memoryDocumentCreate({ name })
      .then(async (created) => {
        await reload()
        editOnLoad.current = created
        setSelected(created.file)
        toast({ kind: 'ok', title: t('memory.created'), body: created.title })
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('memory.createFailed'), body: displayError(err) }))
      .finally(() => setBusy(false))
  }
  const remove = async (): Promise<void> => {
    if (!doc) return
    const approved = await askConfirm({
      message: t('memory.confirmDelete', { title: titleOf(doc, t, locale) }),
      detail: t('memory.confirmDeleteDetail'),
      confirmLabel: t(doc.kind === 'journal' ? 'memory.deleteJournal' : 'memory.deletePage'),
      destructive: true
    })
    if (!approved) return
    setBusy(true)
    void window.api
      .memoryDocumentDelete(doc.file)
      .then(() => {
        toast({ kind: 'ok', title: t('memory.deleted'), body: titleOf(doc, t, locale) })
        // The deleted document leaves the list before the reload, or the newest entry chosen in its
        // place could be the deleted one itself.
        setDocuments((current) => current.filter((candidate) => candidate.file !== doc.file))
        setSelected(null)
        setRevision((v) => v + 1)
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('memory.deleteFailed'), body: displayError(err) }))
      .finally(() => setBusy(false))
  }
  const curate = (): void => {
    setBusy(true)
    void window.api
      .memoryCurate()
      .then((job) =>
        toast(
          job
            ? { kind: 'ok', title: t('memory.curateStarted'), body: t('memory.curateStartedBody') }
            : { kind: 'info', title: t('memory.curateNothing'), body: t('memory.curateNothingBody') }
        )
      )
      .catch((err: unknown) => toast({ kind: 'error', title: t('memory.curateFailed'), body: displayError(err) }))
      .finally(() => setBusy(false))
  }

  const item = (candidate: MemoryDocument): React.JSX.Element => {
    const title = candidate.kind === 'journal' ? dayLabel(candidate.title, locale) : titleOf(candidate, t, locale)
    // The two documents about ASIST itself and about the user are always the same ones, so the
    // list shows their names alone and leaves the room to the diary and the pages.
    const sub =
      candidate.kind === 'journal'
        ? candidate.headings.filter((h) => !JOURNAL_SELF_HEADINGS.includes(h)).slice(0, 2).join(' · ') || t('memory.kind.journal')
        : candidate.kind === 'page'
          ? candidate.summary || candidate.headings.slice(0, 2).join(' · ') || candidate.file
          : null
    return (
      <button
        key={candidate.file}
        type="button"
        className="my-item"
        data-kind={candidate.kind}
        aria-pressed={selected === candidate.file && mode.kind !== 'create'}
        onClick={() => void select(candidate.file)}
      >
        <span className="my-item-title">{title}</span>
        {sub !== null && <span className="my-item-sub">{sub}</span>}
      </button>
    )
  }

  return (
    <section className="builtin-focus glass my-focus" aria-label="MEMORY">
      <header>
        <h2>MEMORY</h2>
        <button onClick={closeApp}>
          {t('common.backToConversation')} <X size={16} />
        </button>
      </header>
      <div className="my-root">
        <aside className="my-side" aria-label={t('memory.documents')}>
          <label className="my-search">
            <Search size={14} />
            <input
              value={filter}
              placeholder={t('memory.filterPlaceholder')}
              aria-label={t('memory.filter')}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          {self.length > 0 && (
            <section className="my-group" aria-label={t('memory.self')}>
              <h3>{t('memory.self')}</h3>
              {self.map(item)}
            </section>
          )}
          <section className="my-group" aria-label={t('memory.journals')}>
            <h3>
              {t('memory.journals')}
              <b>{journals.length}</b>
            </h3>
            {months.map((month) => (
              <div key={month.label} className="my-month">
                <h4>{month.label}</h4>
                {month.docs.map(item)}
              </div>
            ))}
            {journals.length === 0 && <p className="my-side-empty">{filter ? t('memory.noJournalMatch') : t('memory.noJournals')}</p>}
          </section>
          <section className="my-group" aria-label={t('memory.pages')}>
            <h3>
              {t('memory.pages')}
              <b>{pages.length}</b>
              <button type="button" className="my-side-action" disabled={busy} onClick={() => void startCreate()}>
                <Plus size={13} />
                {t('memory.newPage')}
              </button>
            </h3>
            {pages.map(item)}
            {pages.length === 0 && <p className="my-side-empty">{filter ? t('memory.noPageMatch') : t('memory.noPages')}</p>}
          </section>
        </aside>
        <div className="my-main">
          {error ? (
            <div className="my-empty" role="alert">
              <p>{error}</p>
              <button type="button" className="cal-btn" onClick={() => setRevision((v) => v + 1)}>
                {t('common.retry')}
              </button>
            </div>
          ) : !loaded ? (
            <div className="my-empty">{t('common.loading')}</div>
          ) : mode.kind === 'create' ? (
            <CreatePage busy={busy} onCreate={create} onCancel={() => setMode({ kind: 'read' })} />
          ) : doc ? (
            <article className="my-doc" aria-label={titleOf(doc, t, locale)}>
              <header className="my-doc-head">
                <div className="my-doc-title">
                  <span className="my-kind" data-kind={doc.kind}>
                    {kindLabel(doc, t)}
                  </span>
                  <h2>{titleOf(doc, t, locale)}</h2>
                  <p>{metaOf(doc, t)}</p>
                </div>
                <div className="my-doc-actions">
                  {mode.kind === 'edit' ? (
                    <>
                      <button type="button" className="my-btn" data-tone="primary" disabled={busy || !dirty} onClick={save}>
                        {t('common.save')}
                        <SaveShortcutKey />
                      </button>
                      <button type="button" className="my-btn" disabled={busy} onClick={() => void leaveEditing()}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="my-btn"
                        disabled={markdown === null || busy}
                        onClick={() => setMode({ kind: 'edit', doc, draft: markdown ?? '', base: markdown ?? '' })}
                      >
                        <Pencil size={13} />
                        {t('memory.doc.edit')}
                      </button>
                      {(doc.kind === 'page' || doc.kind === 'journal') && (
                        <button type="button" className="my-btn" data-tone="danger" disabled={busy} onClick={() => void remove()}>
                          <Trash2 size={13} />
                          {t('common.delete')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </header>
              {mode.kind === 'edit' ? (
                <textarea
                  className="my-editor"
                  aria-label={t('memory.doc.body')}
                  value={mode.draft}
                  spellCheck={false}
                  onChange={(e) => setMode({ ...mode, draft: e.target.value })}
                  onKeyDown={(e) => {
                    if (isSaveShortcut(e)) {
                      e.preventDefault()
                      save()
                    }
                  }}
                />
              ) : markdown === null ? (
                <p className="my-loading">{t('common.loading')}</p>
              ) : (
                <Markdown text={markdown} skipTitle />
              )}
            </article>
          ) : (
            <div className="my-empty">
              <p>{t('memory.empty.title')}</p>
              <small>{t('memory.empty.hint')}</small>
              <div className="my-empty-actions">
                <button type="button" className="cal-btn" disabled={busy} onClick={curate}>
                  {t('memory.empty.curate')}
                </button>
                <button type="button" className="cal-btn" disabled={busy} onClick={() => void startCreate()}>
                  {t('memory.newPage')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** A new page. A name creates it from the template and opens it for editing. */
function CreatePage({
  busy,
  onCreate,
  onCancel
}: {
  busy: boolean
  onCreate: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (name.trim() && !busy) onCreate(name.trim())
  }
  return (
    <form className="my-create" onSubmit={submit} aria-label={t('memory.newPage')}>
      <h2>{t('memory.newPage')}</h2>
      <p>{t('memory.create.description')}</p>
      <div className="my-create-row">
        <input
          className="st-input"
          aria-label={t('memory.create.name')}
          autoFocus
          value={name}
          placeholder={t('memory.create.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="my-create-actions">
        <button type="submit" className="my-btn" data-tone="primary" disabled={busy || !name.trim()}>
          {t('memory.create.submit')}
        </button>
        <button type="button" className="my-btn" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
