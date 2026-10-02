import { useState } from 'react'
import { CornerUpLeft, X } from 'lucide-react'
import { displayName, formatAddress, type MailAccount, type MailChangeInput, type MailDraft } from '@shared/mail'
import type { Toast } from '@/state/stores'
import { keyForApp } from '@/ui/key-for-app'
import { useAskBeforeDiscard } from './ask-before-discard'
import { useDraftEditor } from './draft-editor'
import { splitRecipients } from './format'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * The composer. Both a new message and the continuation of a draft, whether the Agent wrote it or it
 * was saved from this screen, are written here. Pressing "送信" is itself the approval, so no confirm
 * sheet appears, and a new message can be left with main through "下書きに保存". A draft is saved a
 * moment after each keystroke and disappears once it has been sent. A reply draft carries the
 * recipients settled from the original message, shown as the addresses it is sent to, and only its
 * body is written.
 *
 * The fields are not a form: Enter in a text field of a form clicks its submit button, and a mail must
 * go out only on a press of "送信". A new message lives here alone until it is sent or saved, and a
 * draft's change lives here alone while main refuses to save it, so leaving either asks first.
 */
export function Composer({
  accounts,
  defaultAccountId,
  draft = null,
  onSend,
  onNotice,
  onClose
}: {
  accounts: MailAccount[]
  defaultAccountId: string | null
  /** The draft being continued, when there is one. */
  draft?: MailDraft | null
  /** Sends a new message through main and answers whether it went out. */
  onSend: (change: MailChangeInput) => Promise<boolean>
  onNotice: (toast: Omit<Toast, 'id'>) => void
  /** Takes the composer away at once; the composer asks first itself when leaving would lose something typed. */
  onClose: () => void
}): React.JSX.Element {
  return draft ? <DraftComposer accounts={accounts} draft={draft} onNotice={onNotice} onClose={onClose} /> : <NewComposer accounts={accounts} defaultAccountId={defaultAccountId} onSend={onSend} onNotice={onNotice} onClose={onClose} />
}

/** Escape while typing closes the composer alone and leaves the mail view open. */
const stopEscapeWith =
  (onClose: () => void) =>
  (event: React.KeyboardEvent): void => {
    if (keyForApp(event) === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

function NewComposer({
  accounts,
  defaultAccountId,
  onSend,
  onNotice,
  onClose
}: {
  accounts: MailAccount[]
  defaultAccountId: string | null
  onSend: (change: MailChangeInput) => Promise<boolean>
  onNotice: (toast: Omit<Toast, 'id'>) => void
  onClose: () => void
}): React.JSX.Element {
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<'send' | 'save' | null>(null)
  const t = useT()
  const recipients = splitRecipients(to)
  const ready = recipients.length > 0 && body.trim().length > 0 && accountId
  const typed = [to, cc, subject, body].some((value) => value.trim() !== '')
  const leave = useAskBeforeDiscard(typed, onClose)
  const stopEscape = stopEscapeWith(() => void leave())
  const send = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy('send')
    try {
      const ok = await onSend({ operation: 'send', accountId, to: recipients, cc: splitRecipients(cc), subject: subject.trim(), body })
      if (ok) onClose()
    } finally {
      setBusy(null)
    }
  }
  const saveDraft = async (): Promise<void> => {
    if (busy) return
    setBusy('save')
    try {
      await window.api.mailDraftCreate({ accountId, to: recipients, cc: splitRecipients(cc), subject: subject.trim(), body })
      onNotice({ kind: 'ok', title: t('mail.composer.draftSaved'), body: t('mail.composer.draftSavedBody') })
      onClose()
    } catch (err) {
      onNotice({ kind: 'error', title: t('mail.composer.draftSaveFailed'), body: displayError(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="ml-reader ml-composer" aria-label={t('mail.composer.formLabel')}>
      <div className="ml-reader-head">
        <h2>{t('mail.composer.newTitle')}</h2>
        <button type="button" className="ml-icon" aria-label={t('common.close')} onClick={() => void leave()}>
          <X size={18} />
        </button>
      </div>
      <label className="ml-field">
        <span>{t('mail.fields.from')}</span>
        <select aria-label={t('mail.fields.from')} className="cal-field" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label} · {account.email}
            </option>
          ))}
        </select>
      </label>
      <label className="ml-field">
        <span>{t('mail.fields.to')}</span>
        <input
          aria-label={t('mail.fields.to')}
          className="cal-field is-wide"
          placeholder={t('mail.composer.recipientsHint')}
          autoFocus
          value={to}
          onChange={(event) => setTo(event.target.value)}
          onKeyDown={stopEscape}
        />
      </label>
      <label className="ml-field">
        <span>Cc</span>
        <input aria-label="Cc" className="cal-field is-wide" value={cc} onChange={(event) => setCc(event.target.value)} onKeyDown={stopEscape} />
      </label>
      <label className="ml-field">
        <span>{t('mail.fields.subject')}</span>
        <input aria-label={t('mail.fields.subject')} className="cal-field is-wide" value={subject} onChange={(event) => setSubject(event.target.value)} onKeyDown={stopEscape} />
      </label>
      <textarea aria-label={t('mail.fields.body')} className="ml-compose-body" placeholder={t('mail.fields.body')} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={stopEscape} />
      <div className="cal-pop-actions">
        <span className="cal-pop-hint">{t('mail.composer.sendHint')}</span>
        <button type="button" className="cal-btn" disabled={busy !== null || (!body.trim() && !to.trim() && !subject.trim())} onClick={() => void saveDraft()}>
          {busy === 'save' ? t('common.saving') : t('mail.composer.saveDraft')}
        </button>
        <button type="button" className="cal-primary" disabled={!ready || busy !== null} onClick={() => void send()}>
          {busy === 'send' ? t('mail.sending') : t('mail.send')}
        </button>
      </div>
    </section>
  )
}

function DraftComposer({ accounts, draft, onNotice, onClose }: { accounts: MailAccount[]; draft: MailDraft; onNotice: (toast: Omit<Toast, 'id'>) => void; onClose: () => void }): React.JSX.Element {
  const editor = useDraftEditor(draft)
  const t = useT()
  const account = accounts.find((item) => item.id === draft.accountId)
  const busy = editor.sending || editor.busy === 'discard'
  const locked = busy || editor.sendStarted
  const ready = editor.fields.body.trim().length > 0 && (draft.reply !== null || splitRecipients(editor.fields.to).length > 0)
  // A change still waiting for its save is saved as the composer goes; only one main refused would be lost.
  const leave = useAskBeforeDiscard(editor.refused, () => {
    if (editor.refused) editor.abandon()
    onClose()
  })
  const stopEscape = stopEscapeWith(() => void leave())
  const send = async (): Promise<void> => {
    if (!ready || locked) return
    const summary = await editor.send()
    if (summary) {
      onNotice({ kind: 'ok', title: draft.reply ? t('mail.done.reply') : t('mail.done.send'), body: summary })
      onClose()
    }
  }
  const discard = async (): Promise<void> => {
    if (await editor.discard()) {
      onNotice({ kind: 'info', title: t('mail.composer.draftDiscarded') })
      onClose()
    }
  }
  const replyValues = draft.reply ? { name: displayName(draft.reply.from), subject: draft.reply.subject || t('mail.noSubject') } : null
  return (
    <section className="ml-reader ml-composer" aria-label={t('mail.composer.draftTitle')}>
      <div className="ml-reader-head">
        <h2>{draft.reply ? t('mail.composer.replyDraft') : t('mail.composer.draftTitle')}</h2>
        <span className="ml-reader-account">{editor.busy === 'save' ? t('common.saving') : editor.dirty ? t('mail.composer.notSaved') : t('mail.composer.saved')}</span>
        <button type="button" className="ml-icon" aria-label={t('common.close')} onClick={() => void leave()}>
          <X size={18} />
        </button>
      </div>
      <label className="ml-field">
        <span>{t('mail.fields.from')}</span>
        <span className="ml-static">{account ? `${account.label} · ${account.email}` : draft.accountId}</span>
      </label>
      {draft.reply && replyValues ? (
        <>
          <div className="ml-reply-to">
            <CornerUpLeft size={13} />
            {draft.reply.replyAll ? t('mail.composer.replyToAll', replyValues) : t('mail.composer.replyTo', replyValues)}
          </div>
          <div className="ml-field">
            <span>{t('mail.fields.to')}</span>
            <span className="ml-static">{draft.reply.to.map(formatAddress).join(', ')}</span>
          </div>
          {draft.reply.cc.length > 0 && (
            <div className="ml-field">
              <span>Cc</span>
              <span className="ml-static">{draft.reply.cc.map(formatAddress).join(', ')}</span>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="ml-field">
            <span>{t('mail.fields.to')}</span>
            <input
              aria-label={t('mail.fields.to')}
              className="cal-field is-wide"
              placeholder={t('mail.composer.recipientsHint')}
              value={editor.fields.to}
              disabled={locked}
              onChange={(event) => editor.set({ to: event.target.value })}
              onKeyDown={stopEscape}
            />
          </label>
          <label className="ml-field">
            <span>Cc</span>
            <input aria-label="Cc" className="cal-field is-wide" value={editor.fields.cc} disabled={locked} onChange={(event) => editor.set({ cc: event.target.value })} onKeyDown={stopEscape} />
          </label>
          <label className="ml-field">
            <span>{t('mail.fields.subject')}</span>
            <input aria-label={t('mail.fields.subject')} className="cal-field is-wide" value={editor.fields.subject} disabled={locked} onChange={(event) => editor.set({ subject: event.target.value })} onKeyDown={stopEscape} />
          </label>
        </>
      )}
      <textarea
        aria-label={t('mail.fields.body')}
        className="ml-compose-body"
        placeholder={t('mail.fields.body')}
        autoFocus
        value={editor.fields.body}
        disabled={locked}
        onChange={(event) => editor.set({ body: event.target.value })}
        onKeyDown={stopEscape}
      />
      {editor.error && (
        <p className="ml-form-error" role="alert">
          {editor.error}
        </p>
      )}
      <div className="cal-pop-actions">
        {editor.sendStarted ? (
          <span className="cal-pop-hint ml-hint-started" role="status">
            {t('mail.drafts.sendStarted')}
          </span>
        ) : (
          <span className="cal-pop-hint">{t('mail.composer.sendHint')}</span>
        )}
        <button type="button" className="cal-btn is-danger" disabled={busy} onClick={() => void discard()}>
          {t('mail.composer.discard')}
        </button>
        {!editor.sendStarted && (
          <button type="button" className="cal-primary" disabled={!ready || busy} onClick={() => void send()}>
            {editor.sending ? t('mail.sending') : t('mail.send')}
          </button>
        )}
      </div>
    </section>
  )
}
