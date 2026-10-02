import { useEffect, useState, type FormEvent } from 'react'
import {
  MAIL_PROVIDERS,
  MAIL_PRESETS,
  MAX_SYNC_DAYS,
  MIN_SYNC_DAYS,
  presetFor,
  type MailAccount,
  type MailAccountInput,
  type MailAccountStatus,
  type MailEndpoint,
  type MailProbeResult,
  type MailProvider,
  type MailSettings as MailSettingsValue
} from '@shared/mail'
import type { Translate } from '@shared/i18n'
import { HoloSwitch } from '@/components/ui/switch'
import { useMailStore, useSettingsStore, useToastStore } from '@/state/stores'
import { askConfirm } from '@/state/confirm'
import type { SettingsContext } from './context'
import { useFieldDraft } from '@/ui/field-draft'
import { Btn, Chip, Group, NotSavedHint, Row, type ChipTone } from './primitives'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/** Gmail and iCloud are product names; only the generic kind of account is a word to translate. */
const providerLabel = (t: Translate, provider: MailProvider): string =>
  provider === 'custom' ? t('settingsMail.form.providerCustom') : MAIL_PRESETS[provider].label

/**
 * The mail integration settings. Adding an account first connects to verify it, and main stores the
 * password encrypted. The list shows the connection state and the unread count, while changing the
 * password and choosing folders open below the row.
 */

const STATE_TONE: Record<MailAccountStatus['state'], ChipTone> = { off: 'dim', connecting: 'cyan', syncing: 'cyan', connected: 'ok', error: 'warn' }
const FOLDER_KEYS = ['sent', 'archive', 'trash'] as const

export function MailSettings({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const mail = ctx.settings.mail
  const status = useMailStore((s) => s.status)
  const refreshStatus = useMailStore((s) => s.refresh)
  const reloadSettings = useSettingsStore((s) => s.load)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Only the option that changed is sent. The accounts change through their own calls to main, and an
  // account added while this page was drawn is not in `mail`.
  const persist = (patch: Partial<Omit<MailSettingsValue, 'accounts'>>): Promise<boolean> => ctx.set({ mail: patch })
  const syncDays = useFieldDraft(mail.syncDays, {
    format: String,
    parse: (text) => {
      const days = Number(text)
      return Number.isInteger(days) && days >= MIN_SYNC_DAYS && days <= MAX_SYNC_DAYS ? days : null
    },
    save: (days) => persist({ syncDays: days })
  })
  const afterAccountChange = async (): Promise<void> => {
    await reloadSettings()
    await refreshStatus()
  }
  const remove = async (account: MailAccount): Promise<void> => {
    const approved = await askConfirm({
      message: t('settingsMail.removeConfirm', { label: account.label, email: account.email }),
      detail: t('settingsMail.removeConfirmDetail'),
      confirmLabel: t('settingsMail.removeAccount'),
      destructive: true
    })
    if (!approved) return
    void window.api
      .mailAccountRemove(account.id)
      .then(afterAccountChange)
      .then(() => toast({ kind: 'ok', title: t('settingsMail.removed'), body: account.email }))
      .catch((err: unknown) => toast({ kind: 'error', title: t('settingsMail.removeFailed'), body: displayError(err) }))
  }

  return (
    <Group
      title={t('settingsMail.title')}
      description={t('settingsMail.description')}
      action={
        <Btn
          tone="quiet"
          onClick={() =>
            void window.api.mailOpenGuide().catch((err: unknown) => toast({ kind: 'error', title: t('settingsMail.openGuideFailed'), body: displayError(err) }))
          }
        >
          {t('settingsMail.openGuide')}
        </Btn>
      }
    >
      <Row
        label={t('settingsMail.enable')}
        hint={mail.accounts.length ? t('settingsMail.accounts', { count: mail.accounts.length }) : t('settingsMail.noAccounts')}
      >
        <HoloSwitch aria-label={t('settingsMail.enable')} checked={mail.enabled} onCheckedChange={(enabled) => persist({ enabled })} />
      </Row>
      {mail.accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          status={status?.accounts.find((item) => item.id === account.id) ?? null}
          enabled={mail.enabled}
          onChanged={afterAccountChange}
          onRemove={() => void remove(account)}
        />
      ))}
      {mail.accounts.length > 1 && (
        <Row label={t('settingsMail.defaultAccount')} hint={t('settingsMail.defaultAccountHint')}>
          <select
            aria-label={t('settingsMail.defaultAccount')}
            className="st-select"
            value={mail.defaultAccountId ?? ''}
            onChange={(event) => persist({ defaultAccountId: event.target.value || null })}
          >
            {mail.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} · {account.email}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label={t('settingsMail.syncDays')} hint={syncDays.failed ? <NotSavedHint /> : t('settingsMail.syncDaysHint', { min: MIN_SYNC_DAYS, max: MAX_SYNC_DAYS })}>
        <input
          type="number"
          aria-label={t('settingsMail.syncDays')}
          className="st-input"
          style={{ width: 80 }}
          min={MIN_SYNC_DAYS}
          max={MAX_SYNC_DAYS}
          {...syncDays.props}
        />
      </Row>
      <Row label={t('settingsMail.notify')} hint={t('settingsMail.notifyHint')}>
        <HoloSwitch aria-label={t('settingsMail.notify')} checked={mail.notifyNewMail} onCheckedChange={(notifyNewMail) => persist({ notifyNewMail })} />
      </Row>
      <Row label={t('settingsMail.addAccount')} hint={t('settingsMail.addAccountHint')}>
        <Btn tone={adding ? 'quiet' : 'primary'} onClick={() => setAdding((value) => !value)}>
          {adding ? t('common.close') : t('settingsMail.add')}
        </Btn>
      </Row>
      {adding && (
        <AddAccountForm
          onDone={async (account) => {
            setAdding(false)
            await afterAccountChange()
            toast({ kind: 'ok', title: t('settingsMail.added'), body: t('settingsMail.addedBody', { label: account.label, email: account.email }) })
          }}
        />
      )}
    </Group>
  )
}

function AccountRow({
  account,
  status,
  enabled,
  onChanged,
  onRemove
}: {
  account: MailAccount
  status: MailAccountStatus | null
  enabled: boolean
  onChanged: () => Promise<void>
  onRemove: () => void
}): React.JSX.Element {
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [open, setOpen] = useState<'password' | 'folders' | 'otherAddresses' | null>(null)
  const [password, setPassword] = useState('')
  const [folders, setFolders] = useState({ sent: account.folders.sent ?? '', archive: account.folders.archive ?? '', trash: account.folders.trash ?? '' })
  const [otherAddresses, setOtherAddresses] = useState('')
  const [busy, setBusy] = useState(false)
  const state = enabled ? (status?.state ?? 'off') : 'off'
  const hintParts = [account.email, providerLabel(t, account.provider)]
  if (status && enabled) hintParts.push(status.unread ? t('settingsMail.account.unread', { count: status.unread }) : t('settingsMail.account.noUnread'))
  if (state === 'error' && status?.error) hintParts.push(status.error)
  const missing = FOLDER_KEYS.filter((key) => account.folders[key] === null)

  const run = (done: string, failed: string, operation: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true)
    void operation()
      .then(async () => {
        await onChanged()
        after?.()
        toast({ kind: 'ok', title: done })
      })
      .catch((err: unknown) => toast({ kind: 'error', title: failed, body: displayError(err) }))
      .finally(() => setBusy(false))
  }
  const savePassword = (event: FormEvent): void => {
    event.preventDefault()
    if (!password) return
    run(
      t('settingsMail.account.passwordSaved'),
      t('settingsMail.account.passwordSaveFailed'),
      () => window.api.mailAccountUpdate(account.id, undefined, password),
      () => {
        setPassword('')
        setOpen(null)
      }
    )
  }
  const saveFolders = (event: FormEvent): void => {
    event.preventDefault()
    run(
      t('settingsMail.account.foldersSaved'),
      t('settingsMail.account.foldersSaveFailed'),
      () =>
        window.api.mailAccountUpdate(account.id, {
          folders: { sent: folders.sent.trim() || null, archive: folders.archive.trim() || null, trash: folders.trash.trim() || null }
        }),
      () => setOpen(null)
    )
  }
  const saveOtherAddresses = (event: FormEvent): void => {
    event.preventDefault()
    run(
      t('settingsMail.account.otherAddressesSaved'),
      t('settingsMail.account.otherAddressesSaveFailed'),
      () => window.api.mailAccountUpdate(account.id, { otherAddresses: otherAddresses.split(/[\s,]+/).filter(Boolean) }),
      () => setOpen(null)
    )
  }

  return (
    <Row label={account.label} hint={hintParts.join(' · ')} wide>
      <div className="ml-account-row" data-account={account.id}>
        <Chip tone={STATE_TONE[state]}>{t(`settingsMail.state.${state}`)}</Chip>
        {missing.length > 0 && <Chip tone="warn">{t('settingsMail.account.foldersNotSet')}</Chip>}
        <Btn tone="quiet" disabled={busy} onClick={() => setOpen(open === 'password' ? null : 'password')}>
          {t('settingsMail.account.changePassword')}
        </Btn>
        <Btn tone="quiet" disabled={busy} onClick={() => setOpen(open === 'folders' ? null : 'folders')}>
          {t('settingsMail.account.folders')}
        </Btn>
        <Btn
          tone="quiet"
          disabled={busy}
          onClick={() => {
            // Text typed before, whether its save was refused or saved in another spelling, would otherwise reopen as if it were what is saved.
            setOtherAddresses(account.otherAddresses.join('\n'))
            setOpen(open === 'otherAddresses' ? null : 'otherAddresses')
          }}
        >
          {t('settingsMail.account.otherAddresses')}
        </Btn>
        <Btn tone="danger" disabled={busy} onClick={onRemove}>
          {t('common.delete')}
        </Btn>
      </div>
      {open === 'password' && (
        <form className="ml-account-form" onSubmit={savePassword}>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            className="st-input is-mono"
            aria-label={t('settingsMail.account.password', { label: account.label })}
            placeholder={t('settingsMail.account.appPassword')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Btn tone="primary" type="submit" disabled={busy || !password}>
            {busy ? t('settingsMail.account.checking') : t('settingsMail.account.connectAndSave')}
          </Btn>
        </form>
      )}
      {open === 'folders' && (
        <form className="ml-account-form is-folders" onSubmit={saveFolders}>
          {FOLDER_KEYS.map((key) => (
            <label key={key}>
              <span>{t(`settingsMail.account.folderName.${key}`)}</span>
              <input
                className="st-input is-mono"
                aria-label={t('settingsMail.account.folderLabel', { label: account.label, folder: t(`settingsMail.account.folderName.${key}`) })}
                placeholder={t('settingsMail.account.folderPlaceholder')}
                value={folders[key]}
                onChange={(event) => setFolders({ ...folders, [key]: event.target.value })}
              />
            </label>
          ))}
          <Btn tone="primary" type="submit" disabled={busy}>
            {t('common.save')}
          </Btn>
        </form>
      )}
      {open === 'otherAddresses' && (
        <form className="ml-account-form is-other-addresses" onSubmit={saveOtherAddresses}>
          <label>
            <span>{t('settingsMail.account.otherAddressesHint')}</span>
            <textarea
              className="st-input is-mono"
              autoFocus
              aria-label={t('settingsMail.account.otherAddressesLabel', { label: account.label })}
              placeholder={t('settingsMail.account.otherAddressesPlaceholder')}
              value={otherAddresses}
              onChange={(event) => setOtherAddresses(event.target.value)}
            />
          </label>
          <Btn tone="primary" type="submit" disabled={busy}>
            {t('common.save')}
          </Btn>
        </form>
      )}
    </Row>
  )
}

interface Draft {
  provider: MailProvider
  label: string
  email: string
  name: string
  password: string
  imap: MailEndpoint
  smtp: MailEndpoint
}

const emptyDraft = (): Draft => ({
  provider: 'gmail',
  label: '',
  email: '',
  name: '',
  password: '',
  ...presetFor('gmail')!
})

function inputOf(draft: Draft): MailAccountInput {
  return {
    provider: draft.provider,
    label: draft.label.trim(),
    email: draft.email.trim(),
    name: draft.name.trim(),
    password: draft.password,
    imap: { ...draft.imap, host: draft.imap.host.trim() },
    smtp: { ...draft.smtp, host: draft.smtp.host.trim() }
  }
}

function probeText(t: Translate, probe: MailProbeResult): string {
  const none = t('settingsMail.form.probeNoFolder')
  return t(probe.gmail ? 'settingsMail.form.probeResultGmail' : 'settingsMail.form.probeResult', {
    sent: probe.folders.sent ?? none,
    archive: probe.folders.archive ?? none,
    trash: probe.folders.trash ?? none
  })
}

function AddAccountForm({ onDone }: { onDone: (account: MailAccount) => Promise<void> }): React.JSX.Element {
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [probe, setProbe] = useState<MailProbeResult | null>(null)
  const [busy, setBusy] = useState<'probe' | 'add' | null>(null)
  const [error, setError] = useState('')
  const update = (patch: Partial<Draft>): void => {
    setProbe(null)
    setDraft((current) => ({ ...current, ...patch }))
  }
  const setProvider = (provider: MailProvider): void => {
    const preset = presetFor(provider)
    update(preset ? { provider, ...preset } : { provider })
  }
  const ready = draft.label.trim() && draft.email.trim() && draft.password && draft.imap.host.trim() && draft.smtp.host.trim()
  const check = async (): Promise<void> => {
    setBusy('probe')
    setError('')
    try {
      setProbe(await window.api.mailProbe(inputOf(draft)))
    } catch (err) {
      setError(displayError(err))
    } finally {
      setBusy(null)
    }
  }
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy('add')
    setError('')
    try {
      const account = await window.api.mailAccountAdd(inputOf(draft))
      await onDone(account)
    } catch (err) {
      setError(displayError(err))
      toast({ kind: 'error', title: t('settingsMail.addFailed'), body: displayError(err) })
    } finally {
      setBusy(null)
    }
  }
  const endpoint = (kind: 'imap' | 'smtp'): React.JSX.Element => (
    <div className="ml-endpoint">
      <span>{kind.toUpperCase()}</span>
      <input
        className="st-input is-mono"
        aria-label={t('settingsMail.form.host', { protocol: kind.toUpperCase() })}
        placeholder={t('settingsMail.form.hostPlaceholder')}
        value={draft[kind].host}
        onChange={(event) => update({ [kind]: { ...draft[kind], host: event.target.value } } as Partial<Draft>)}
      />
      <input
        type="number"
        className="st-input is-mono"
        aria-label={t('settingsMail.form.port', { protocol: kind.toUpperCase() })}
        min={1}
        max={65535}
        value={draft[kind].port}
        onChange={(event) => update({ [kind]: { ...draft[kind], port: Number(event.target.value) } } as Partial<Draft>)}
      />
      <label className="st-check">
        <input type="checkbox" checked={draft[kind].secure} onChange={(event) => update({ [kind]: { ...draft[kind], secure: event.target.checked } } as Partial<Draft>)} />
        <span>{t('settingsMail.form.tls')}</span>
      </label>
    </div>
  )
  return (
    <form className="ml-account-form is-add" aria-label={t('settingsMail.form.title')} onSubmit={(event) => void add(event)}>
      <label>
        <span>{t('settingsMail.form.provider')}</span>
        <select className="st-select" aria-label={t('settingsMail.form.provider')} value={draft.provider} onChange={(event) => setProvider(event.target.value as MailProvider)}>
          {MAIL_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {providerLabel(t, provider)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('settingsMail.form.label')}</span>
        <input
          className="st-input"
          aria-label={t('settingsMail.form.label')}
          placeholder={t('settingsMail.form.labelPlaceholder')}
          value={draft.label}
          onChange={(event) => update({ label: event.target.value })}
        />
      </label>
      <label>
        <span>{t('settingsMail.form.email')}</span>
        <input
          className="st-input is-mono"
          type="email"
          aria-label={t('settingsMail.form.email')}
          autoComplete="off"
          value={draft.email}
          onChange={(event) => update({ email: event.target.value })}
        />
      </label>
      <label>
        <span>{t('settingsMail.form.senderName')}</span>
        <input
          className="st-input"
          aria-label={t('settingsMail.form.senderName')}
          placeholder={t('settingsMail.form.senderNamePlaceholder')}
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      <label>
        <span>{t('settingsMail.form.password')}</span>
        <input
          className="st-input is-mono"
          type="password"
          aria-label={t('settingsMail.form.password')}
          autoComplete="off"
          placeholder={draft.provider === 'custom' ? t('settingsMail.form.password') : t('settingsMail.account.appPassword')}
          value={draft.password}
          onChange={(event) => update({ password: event.target.value })}
        />
      </label>
      {draft.provider === 'custom' && (
        <>
          {endpoint('imap')}
          {endpoint('smtp')}
        </>
      )}
      <div className="ml-account-actions">
        <Btn tone="quiet" type="button" disabled={!ready || busy !== null} onClick={() => void check()}>
          {busy === 'probe' ? t('settingsMail.form.probing') : t('settingsMail.form.probe')}
        </Btn>
        <Btn tone="primary" type="submit" disabled={!ready || busy !== null}>
          {busy === 'add' ? t('settingsMail.form.adding') : t('settingsMail.add')}
        </Btn>
        {probe && (
          <span className="ml-probe" role="status">
            {probeText(t, probe)}
          </span>
        )}
        {error && (
          <span className="ml-probe is-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}
