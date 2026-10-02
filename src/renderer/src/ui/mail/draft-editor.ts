import { useEffect, useRef, useState } from 'react'
import { errorText } from '@shared/i18n/error-text'
import type { MailDraft, MailDraftPatch } from '@shared/mail'
import { splitRecipients } from './format'
import { displayError } from '@/display-error'
import { translate } from '@/i18n'
import { useMailStore, useToastStore } from '@/state/stores'

/**
 * Editing a draft, which behaves the same in the card and in the composer of the mail view. Input is
 * saved to main a short while after the typing, so that nothing travels while the user types, and
 * sending saves first. A change still waiting for that save when the editor goes away is saved at
 * once. What the Agent changed through update_mail_draft is taken over here as long as nothing is
 * half typed on this side.
 */

export interface DraftFields {
  to: string
  cc: string
  subject: string
  body: string
}

const SAVE_DELAY_MS = 600

export const fieldsOf = (draft: MailDraft): DraftFields => ({ to: draft.to.join(', '), cc: draft.cc.join(', '), subject: draft.subject, body: draft.body })
const patchOf = (fields: DraftFields): MailDraftPatch => ({ to: splitRecipients(fields.to), cc: splitRecipients(fields.cc), subject: fields.subject, body: fields.body })

export function useDraftEditor(draft: MailDraft | null): {
  fields: DraftFields
  set: (patch: Partial<DraftFields>) => void
  dirty: boolean
  busy: 'save' | 'send' | 'discard' | null
  /** A send of the draft is under way, from this editor or from another one open on the same draft. */
  sending: boolean
  /**
   * A send of the draft started and neither finished nor failed while this window waited for it, as when the
   * mail went out and the draft could not be removed, or the app stopped in the middle of sending. The mail
   * may have gone out, and the draft can only be discarded.
   */
  sendStarted: boolean
  error: string
  /** A typed change is not saved and the last attempt failed, as when main refuses an address it cannot read. */
  refused: boolean
  /** Gives up the change main refused, so that nothing of it is saved when the editor goes. */
  abandon: () => void
  /** The summary once the draft has been sent, or null on failure, with the reason in `error`. */
  send: () => Promise<string | null>
  discard: () => Promise<boolean>
} {
  const [fields, setFields] = useState<DraftFields>(() => (draft ? fieldsOf(draft) : { to: '', cc: '', subject: '', body: '' }))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'send' | 'discard' | null>(null)
  const [error, setError] = useState('')
  const latest = useRef(fields)
  latest.current = fields
  const id = draft?.id ?? null
  const updatedAt = draft?.updatedAt ?? 0
  const sending = useMailStore((s) => id !== null && s.sending.includes(id))
  const setSending = useMailStore((s) => s.setSending)

  // A draft changed from outside, by the Agent, is taken over unless something is half typed here.
  useEffect(() => {
    if (draft && !dirty) setFields(fieldsOf(draft))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, updatedAt])

  const save = async (): Promise<void> => {
    if (!id) return
    const current = latest.current
    await window.api.mailDraftUpdate(id, patchOf(current))
    if (latest.current === current) setDirty(false)
  }

  const unsaved = useRef<{ id: string; fields: DraftFields } | null>(null)
  unsaved.current = dirty && id ? { id, fields } : null
  // Set before a send or a discard starts, since main can report the draft gone and the editor can go
  // before either returns, and when the user gives up a refused change. Nothing is saved on unmount then.
  const released = useRef(false)
  useEffect(
    () => () => {
      const left = unsaved.current
      if (!left || released.current) return
      // The editor that would show a failure is gone, so a toast says it.
      window.api.mailDraftUpdate(left.id, patchOf(left.fields)).catch((err: unknown) => {
        useToastStore.getState().push({ kind: 'error', title: translate('mail.composer.draftSaveFailed'), body: displayError(err) })
      })
    },
    []
  )

  useEffect(() => {
    if (!dirty || !id) return
    const timer = setTimeout(() => {
      setBusy((current) => current ?? 'save')
      void save()
        .then(() => setError(''))
        .catch((err: unknown) => setError(displayError(err)))
        .finally(() => setBusy((current) => (current === 'save' ? null : current)))
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, dirty, id])

  const set = (patch: Partial<DraftFields>): void => {
    setFields((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  const send = async (): Promise<string | null> => {
    if (!id || sending || busy === 'discard') return null
    setBusy('send')
    setSending(id, true)
    released.current = true
    try {
      if (dirty) await save()
      const result = await window.api.mailDraftSend(id)
      if (!result.saved) throw new Error(errorText('mail.composer.notSent'))
      setError('')
      return result.summary
    } catch (err) {
      released.current = false
      setError(displayError(err))
      return null
    } finally {
      setSending(id, false)
      setBusy(null)
    }
  }

  const discard = async (): Promise<boolean> => {
    if (!id || sending) return false
    setBusy('discard')
    released.current = true
    try {
      await window.api.mailDraftRemove(id)
      return true
    } catch (err) {
      released.current = false
      setError(displayError(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  const abandon = (): void => {
    released.current = true
  }

  const sendStarted = (draft?.sendStartedAt ?? null) !== null && !sending
  return { fields, set, dirty, busy, sending, sendStarted, error, refused: dirty && error !== '', abandon, send, discard }
}

