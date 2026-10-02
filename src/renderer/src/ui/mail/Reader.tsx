import { useEffect, useRef, useState } from 'react'
import { Archive, ChevronDown, ChevronRight, CornerUpLeft, MailOpen, Paperclip, Reply, ReplyAll, Star, Trash2, X } from 'lucide-react'
import { errorText } from '@shared/i18n/error-text'
import { displayName, formatAddress, type MailAccount, type MailChangeInput, type MailMessage, type MailReply } from '@shared/mail'
import { useMailStore, useToastStore } from '@/state/stores'
import { keyForApp } from '@/ui/key-for-app'
import { fullTime, sizeLabel } from './format'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * The reader. It lays out the thread of the selected message oldest first and shows the selected one
 * expanded. That message carries reply, reply to all, archive, trash, star and mark as unread. A
 * reply is written below it in the same pane, and pressing send is itself the approval, so no
 * confirm sheet appears; the form shows the To and Cc of the reply main settled, and that same reply
 * is what is sent. A message that is unread when it opens is marked as read.
 */

interface Loaded {
  message: MailMessage
  thread: MailMessage[]
}
type ReplyMode = 'reply' | 'all'
/** The reply being written. `settled` is the reply main settled for this mode, null until it arrives or when it failed. */
interface ReplyForm {
  id: string
  mode: ReplyMode
  text: string
  settled: MailReply | null
  error: string
}

export function Reader({
  id,
  accounts,
  onChange,
  onClose
}: {
  id: string
  accounts: MailAccount[]
  /** Sends a change to main and answers whether it went through; a cancellation and a failure both give false. */
  onChange: (change: MailChangeInput) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const revision = useMailStore((s) => s.revision)
  const t = useT()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [bodies, setBodies] = useState<Map<string, string>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([id]))
  const [error, setError] = useState('')
  const [reply, setReply] = useState<ReplyForm | null>(null)
  const [busy, setBusy] = useState(false)
  const marked = useRef<string | null>(null)
  const settling = useRef(0)
  const toast = useToastStore((s) => s.push)

  useEffect(() => {
    let active = true
    setError('')
    window.api
      .mailRead(id)
      .then(async ({ message, text }) => {
        const thread = await window.api.mailThread(message.accountId, message.threadId)
        if (!active) return
        const list = thread.some((item) => item.id === message.id) ? thread : [...thread, message].sort((a, b) => a.date - b.date)
        setLoaded({ message, thread: list })
        setBodies((current) => new Map(current).set(message.id, text))
        setExpanded((current) => (current.has(message.id) ? current : new Set(current).add(message.id)))
        if (message.unread && marked.current !== message.id) {
          marked.current = message.id
          void onChange({ operation: 'markRead', ids: [message.id], read: true })
        }
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [id, revision]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setExpanded(new Set([id]))
    setReply(null)
  }, [id])

  const toggle = (message: MailMessage): void => {
    const next = new Set(expanded)
    if (next.has(message.id)) next.delete(message.id)
    else {
      next.add(message.id)
      if (!bodies.has(message.id)) {
        window.api
          .mailRead(message.id)
          .then(({ text }) => setBodies((current) => new Map(current).set(message.id, text)))
          .catch((err: unknown) => setError(displayError(err)))
      }
    }
    setExpanded(next)
  }
  const patch = (target: string, flags: Partial<Pick<MailMessage, 'unread' | 'starred'>>): void =>
    setLoaded((current) => current && { ...current, thread: current.thread.map((item) => (item.id === target ? { ...item, ...flags } : item)) })
  /** A flag change is shown in the thread first and taken back when it does not go through; MailView does the same for the list. */
  const act = async (change: MailChangeInput, closeAfter = false): Promise<void> => {
    const target = change.operation === 'star' ? change.id : change.operation === 'markRead' ? change.ids[0] : ''
    const before = loaded?.thread.find((item) => item.id === target)
    const flagged = before && (change.operation === 'star' || change.operation === 'markRead')
    if (flagged) patch(before.id, change.operation === 'star' ? { starred: change.starred } : { unread: !change.read })
    setBusy(true)
    try {
      const ok = await onChange(change)
      if (!ok && flagged) patch(before.id, { starred: before.starred, unread: before.unread })
      if (ok && closeAfter) onClose()
    } finally {
      setBusy(false)
    }
  }
  /**
   * Opens the reply form, or switches it between reply and reply-all while keeping what was typed. Only
   * the answer to the latest request is taken, so the form never shows the recipients of the other mode.
   */
  const openReply = (target: string, mode: ReplyMode): void => {
    const request = ++settling.current
    setReply((current) => ({ id: target, mode, text: current?.id === target ? current.text : '', settled: null, error: '' }))
    const settle = (patch: Partial<ReplyForm>): void => setReply((current) => (current && settling.current === request ? { ...current, ...patch } : current))
    window.api
      .mailReplySettle(target, mode === 'all')
      .then((settled) => settle({ settled }))
      .catch((err: unknown) => settle({ error: displayError(err) }))
  }
  const sendReply = async (form: ReplyForm): Promise<void> => {
    if (!form.settled || !form.text.trim() || busy) return
    setBusy(true)
    try {
      const result = await window.api.mailReplySend({ reply: form.settled, body: form.text })
      if (!result.saved) throw new Error(errorText('mail.composer.notSent'))
      toast({ kind: 'ok', title: t('mail.done.reply'), body: result.summary })
      setReply(null)
    } catch (err) {
      toast({ kind: 'error', title: t('mail.changeFailed.reply'), body: displayError(err) })
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="ml-reader">
        <div className="ml-reader-head">
          <button type="button" className="ml-icon" aria-label={t('common.close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ml-notice" role="alert">
          <p>{error}</p>
        </div>
      </div>
    )
  }
  if (!loaded) return <div className="ml-reader ml-notice">{t('common.loading')}</div>
  const { message, thread } = loaded
  const account = accounts.find((item) => item.id === message.accountId)
  return (
    <article className="ml-reader" aria-label={message.subject || t('mail.noSubject')}>
      <div className="ml-reader-head">
        <h2>{message.subject || t('mail.noSubject')}</h2>
        <span className="ml-reader-account">{account?.label ?? message.accountId}</span>
        {thread.length > 1 && <span className="ml-reader-count">{t('mail.reader.threadCount', { count: thread.length })}</span>}
        <button type="button" className="ml-icon" aria-label={t('common.close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="ml-thread">
        {thread.map((item) => {
          const open = expanded.has(item.id)
          const body = bodies.get(item.id)
          return (
            <section key={item.id} className="ml-message" data-open={open || undefined} data-unread={item.unread || undefined} aria-label={`${displayName(item.from)} ${fullTime(item.date)}`}>
              <button type="button" className="ml-message-head" onClick={() => toggle(item)} aria-expanded={open}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="ml-message-from">
                  <b>{displayName(item.from)}</b>
                  {open && item.from.name && <small>{item.from.address}</small>}
                </span>
                {!open && <span className="ml-message-snippet">{item.snippet}</span>}
                <span className="ml-message-meta">
                  {item.attachments.length > 0 && <Paperclip size={12} aria-label={t('mail.hasAttachment')} />}
                  {item.starred && <Star size={12} className="is-on" aria-label={t('mail.starred')} />}
                  <time>{fullTime(item.date)}</time>
                </span>
              </button>
              {open && (
                <div className="ml-message-body">
                  <dl className="ml-recipients">
                    <div>
                      <dt>{t('mail.fields.to')}</dt>
                      <dd>{item.to.map(formatAddress).join(', ') || t('mail.none')}</dd>
                    </div>
                    {item.cc.length > 0 && (
                      <div>
                        <dt>Cc</dt>
                        <dd>{item.cc.map(formatAddress).join(', ')}</dd>
                      </div>
                    )}
                  </dl>
                  {item.attachments.length > 0 && (
                    <ul className="ml-attachments" aria-label={t('mail.fields.attachments')}>
                      {item.attachments.map((attachment, index) => (
                        <li key={`${attachment.filename}-${index}`}>
                          <Paperclip size={12} />
                          {attachment.filename || attachment.contentType}
                          <small>{sizeLabel(attachment.size)}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                  <pre className="ml-text">{body === undefined ? t('common.loading') : body || t('mail.noBody')}</pre>
                  <div className="ml-actions" role="group" aria-label={t('mail.reader.actions')}>
                    <button type="button" className="cal-btn" disabled={busy} onClick={() => openReply(item.id, 'reply')}>
                      <Reply size={14} /> {t('mail.reply')}
                    </button>
                    <button type="button" className="cal-btn" disabled={busy} onClick={() => openReply(item.id, 'all')}>
                      <ReplyAll size={14} /> {t('mail.replyAll')}
                    </button>
                    {item.folder === 'inbox' && (
                      <button type="button" className="cal-btn" disabled={busy} onClick={() => void act({ operation: 'archive', id: item.id }, item.id === id)}>
                        <Archive size={14} /> {t('mail.archive')}
                      </button>
                    )}
                    <button type="button" className="cal-btn" disabled={busy} onClick={() => void act({ operation: 'star', id: item.id, starred: !item.starred })}>
                      <Star size={14} /> {item.starred ? t('mail.star.remove') : t('mail.star.add')}
                    </button>
                    <button type="button" className="cal-btn" disabled={busy} onClick={() => void act({ operation: 'markRead', ids: [item.id], read: false }, item.id === id)}>
                      <MailOpen size={14} /> {t('mail.markUnread')}
                    </button>
                    <button type="button" className="cal-btn is-danger" disabled={busy} onClick={() => void act({ operation: 'trash', id: item.id }, item.id === id)}>
                      <Trash2 size={14} /> {t('mail.trash')}
                    </button>
                  </div>
                  {reply?.id === item.id && (
                    <form
                      className="ml-reply"
                      aria-label={t('mail.reply')}
                      onSubmit={(event) => {
                        event.preventDefault()
                        void sendReply(reply)
                      }}
                    >
                      <div className="ml-reply-to">
                        <CornerUpLeft size={13} />
                        {reply.mode === 'all' ? t('mail.replyAll') : t('mail.reply')}
                      </div>
                      {reply.settled ? (
                        <>
                          <div className="ml-field">
                            <span>{t('mail.fields.to')}</span>
                            <span className="ml-static">{reply.settled.to.map(formatAddress).join(', ')}</span>
                          </div>
                          {reply.settled.cc.length > 0 && (
                            <div className="ml-field">
                              <span>Cc</span>
                              <span className="ml-static">{reply.settled.cc.map(formatAddress).join(', ')}</span>
                            </div>
                          )}
                        </>
                      ) : reply.error ? (
                        <p className="ml-form-error" role="alert">
                          {reply.error}
                        </p>
                      ) : (
                        <p className="ml-reply-to">{t('common.loading')}</p>
                      )}
                      <textarea
                        autoFocus
                        aria-label={t('mail.reader.replyBody')}
                        placeholder={t('mail.fields.body')}
                        value={reply.text}
                        onChange={(event) => setReply({ ...reply, text: event.target.value })}
                        onKeyDown={(event) => {
                          if (keyForApp(event) === 'Escape') {
                            event.stopPropagation()
                            setReply(null)
                          }
                        }}
                      />
                      <div className="cal-pop-actions">
                        <span className="cal-pop-hint">{t('mail.reader.sendHint')}</span>
                        <button type="button" className="cal-btn" onClick={() => setReply(null)}>
                          {t('common.cancel')}
                        </button>
                        <button type="submit" className="cal-primary" disabled={busy || !reply.settled || !reply.text.trim()}>
                          {busy ? t('mail.sending') : t('mail.send')}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </article>
  )
}
