import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import type { NoteSummary } from '@shared/notes'
import { useNoteStore, useToastStore } from '@/state/stores'
import { useLeaveGuard, useMiniApp, useViewStore } from '@/state/view'
import { askConfirm } from '@/state/confirm'
import { MarkdownContent } from '@/panels/viewers/MarkdownViewer'
import { relativeTime } from '@/panels/primitives/format'
import { displayError } from '@/display-error'
import { SaveShortcutKey, isSaveShortcut } from '@/ui/save-shortcut'
import { useFormatLocale, useT } from '@/i18n'
import '@/panels/viewers/viewers.css'
import '@/assets/notes.css'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * The notes screen, with the notes on the left, the most recently changed first, and the chosen note
 * on the right. A note is read as rendered markdown and edited as markdown source. It shares the
 * layout of the memory screen. A delete asks first and moves the file to the macOS Trash.
 */

const fullDate = (at: number, locale: string): string =>
  new Date(at).toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function NotesView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const update = useViewStore((s) => s.update)
  const { noteId: selected, editing } = useMiniApp('notes')
  const notes = useNoteStore((s) => s.notes)
  const loaded = useNoteStore((s) => s.loaded)
  const loadError = useNoteStore((s) => s.error)
  const load = useNoteStore((s) => s.load)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [readError, setReadError] = useState('')
  const [draft, setDraft] = useState('')
  // A new note has no id until it is saved, and cancelling it goes back to the note shown before.
  const beforeCreate = useRef<string | null>(null)
  const creating = editing && selected === null
  const [filter, setFilter] = useState('')
  const [matched, setMatched] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && !loaded) void load()
  }, [open, loaded, load])

  // With no choice made yet, or once the chosen note is gone or was never there, the newest note is shown.
  useEffect(() => {
    if (!loaded || creating) return
    if (selected && notes.some((note) => note.id === selected)) return
    update('notes', { noteId: notes[0]?.id ?? null, editing: false })
  }, [loaded, notes, selected, creating, update])

  const note = notes.find((candidate) => candidate.id === selected) ?? null
  // A change written elsewhere, by add_note or by another editor, moves updatedAt and loads the body again.
  const revision = note?.updatedAt ?? 0
  useEffect(() => {
    if (!open || !selected) return
    let active = true
    setMarkdown(null)
    setReadError('')
    window.api
      .noteRead(selected)
      .then((text) => active && setMarkdown(text))
      .catch((err: unknown) => active && setReadError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, selected, revision])

  useEffect(() => {
    const query = filter.trim()
    if (!query) {
      setMatched(null)
      return
    }
    let active = true
    const timer = setTimeout(() => {
      window.api
        .notesSearch(query)
        .then((found) => active && setMatched(new Set(found.map((candidate) => candidate.id))))
        .catch((err: unknown) => active && setReadError(displayError(err)))
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [filter, notes])

  const dirty = creating ? draft.trim() !== '' : editing && draft !== (markdown ?? '')
  const leaveEditing = async (): Promise<boolean> => {
    if (dirty && !(await askConfirm({ message: t('common.confirmDiscard'), confirmLabel: t('common.discardChanges'), destructive: true }))) return false
    update('notes', { noteId: creating ? beforeCreate.current : selected, editing: false })
    return true
  }
  useLeaveGuard(dirty, leaveEditing)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!editing) closeApp()
      else void leaveEditing()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // leaveEditing follows from the selection, the draft and markdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected, editing, draft, markdown, closeApp])

  if (!open) return <></>

  const shown = matched ? notes.filter((candidate) => matched.has(candidate.id)) : notes
  const titleOf = (candidate: NoteSummary): string => candidate.title || t('notes.untitled')

  const select = async (id: string): Promise<void> => {
    if (id === selected && !editing) return
    if (editing && !(await leaveEditing())) return
    update('notes', { noteId: id, editing: false })
  }
  const startCreate = async (): Promise<void> => {
    if (editing && !(await leaveEditing())) return
    beforeCreate.current = selected
    setDraft('')
    update('notes', { noteId: null, editing: true })
  }
  const startEdit = (): void => {
    setDraft(markdown ?? '')
    update('notes', { editing: true })
  }
  const save = (): void => {
    if (!editing || busy || !dirty) return
    const text = draft
    setBusy(true)
    const request = creating ? window.api.noteCreate(text) : window.api.noteWrite(selected ?? '', text)
    void request
      .then((saved) => {
        update('notes', { noteId: saved.id, editing: false })
        setMarkdown(text)
        toast({ kind: 'ok', title: t('notes.saved'), body: titleOf(saved) })
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('notes.saveFailed'), body: displayError(err) }))
      .finally(() => setBusy(false))
  }
  const remove = async (): Promise<void> => {
    if (!note) return
    const approved = await askConfirm({
      message: t('notes.confirmDelete', { title: titleOf(note) }),
      detail: t(osMessageKey('notes.deleteDetail', platformCapabilities().os)),
      confirmLabel: t('notes.deleteNote'),
      destructive: true
    })
    if (!approved) return
    setBusy(true)
    void window.api
      .noteRemove(note.id)
      .then(() => {
        toast({ kind: 'ok', title: t(osMessageKey('notes.deleted', platformCapabilities().os)), body: titleOf(note) })
        update('notes', { noteId: null, editing: false })
      })
      .catch((err: unknown) => toast({ kind: 'error', title: t('notes.deleteFailed'), body: displayError(err) }))
      .finally(() => setBusy(false))
  }

  const editor = (value: string): React.JSX.Element => (
    <textarea
      className="my-editor"
      aria-label={t('notes.body')}
      value={value}
      placeholder={t('notes.placeholder')}
      spellCheck={false}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (isSaveShortcut(e)) {
          e.preventDefault()
          save()
        }
      }}
    />
  )
  const editActions = (
    <>
      <button type="button" className="my-btn" data-tone="primary" disabled={busy || !dirty} onClick={save}>
        {t('common.save')}
        <SaveShortcutKey />
      </button>
      <button type="button" className="my-btn" disabled={busy} onClick={() => void leaveEditing()}>
        {t('common.cancel')}
      </button>
    </>
  )

  return (
    <section className="builtin-focus glass my-focus" aria-label="NOTES">
      <header>
        <h2>NOTES</h2>
        <button onClick={closeApp}>
          {t('common.backToConversation')} <X size={16} />
        </button>
      </header>
      <div className="my-root">
        <aside className="my-side" aria-label={t('notes.list')}>
          <label className="my-search">
            <Search size={14} />
            <input
              value={filter}
              placeholder={t('notes.filterPlaceholder')}
              aria-label={t('notes.filter')}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <section className="my-group" aria-label={t('notes.list')}>
            <h3>
              {t('notes.list')}
              <b>{shown.length}</b>
              <button type="button" className="my-side-action" disabled={busy} onClick={() => void startCreate()}>
                <Plus size={13} />
                {t('notes.newNote')}
              </button>
            </h3>
            {shown.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="my-item"
                aria-pressed={selected === candidate.id}
                onClick={() => void select(candidate.id)}
              >
                <span className="my-item-title">{titleOf(candidate)}</span>
                <span className="my-item-sub">{relativeTime(candidate.updatedAt)}{candidate.excerpt ? ` · ${candidate.excerpt}` : ''}</span>
              </button>
            ))}
            {loaded && shown.length === 0 && <p className="my-side-empty">{filter ? t('notes.noMatch') : t('notes.noNotes')}</p>}
          </section>
        </aside>
        <div className="my-main">
          {loadError ? (
            <div className="my-empty" role="alert">
              <p>{loadError}</p>
              <button type="button" className="cal-btn" onClick={() => void load()}>
                {t('common.retry')}
              </button>
            </div>
          ) : !loaded ? (
            <div className="my-empty">{t('common.loading')}</div>
          ) : creating ? (
            <article className="my-doc" aria-label={t('notes.newNote')}>
              <header className="my-doc-head">
                <div className="my-doc-title">
                  <h2>{t('notes.newNote')}</h2>
                </div>
                <div className="my-doc-actions">{editActions}</div>
              </header>
              {editor(draft)}
            </article>
          ) : note ? (
            <article className="my-doc" aria-label={titleOf(note)}>
              <header className="my-doc-head">
                <div className="my-doc-title">
                  <h2>{titleOf(note)}</h2>
                  <p>
                    {t('notes.meta', { updated: fullDate(note.updatedAt, locale), created: fullDate(note.createdAt, locale) })}
                  </p>
                </div>
                <div className="my-doc-actions">
                  {editing ? (
                    editActions
                  ) : (
                    <>
                      <button
                        type="button"
                        className="my-btn"
                        disabled={markdown === null || busy}
                        onClick={startEdit}
                      >
                        <Pencil size={13} />
                        {t('notes.edit')}
                      </button>
                      <button type="button" className="my-btn" data-tone="danger" disabled={busy} onClick={() => void remove()}>
                        <Trash2 size={13} />
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                </div>
              </header>
              {editing ? (
                editor(draft)
              ) : readError ? (
                <p className="my-loading" role="alert">{readError}</p>
              ) : markdown === null ? (
                <p className="my-loading">{t('common.loading')}</p>
              ) : (
                <div className="fv-doc nv-doc">
                  <MarkdownContent text={markdown} />
                </div>
              )}
            </article>
          ) : (
            <div className="my-empty">
              <p>{t('notes.empty.title')}</p>
              <small>{t('notes.empty.hint')}</small>
              <div className="my-empty-actions">
                <button type="button" className="cal-btn" onClick={() => void startCreate()}>
                  {t('notes.newNote')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
