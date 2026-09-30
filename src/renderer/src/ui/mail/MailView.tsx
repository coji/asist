import { useEffect, useMemo, useState } from 'react'
import { MailOpen, RefreshCw, Search, X } from 'lucide-react'
import { MAX_BULK_CHANGE, type MailChangeInput, type MailListQuery, type MailListResult, type MailMessage } from '@shared/mail'
import type { MessageKey } from '@shared/i18n'
import { useMailStore, useSettingsStore, useToastStore } from '@/state/stores'
import { useMiniApp, useViewStore, type MiniAppState } from '@/state/view'
import { Composer } from './Composer'
import { DraftList } from './DraftList'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { Sidebar, mailBoxLabel } from './Sidebar'
import { displayError } from '@/display-error'
import { useT, useFormatLocale } from '@/i18n'

/**
 * The mail workspace, with the boxes and accounts on the left, the message list in the middle and
 * either the reader or the composer on the right. The list is read from main's cache and read again
 * whenever a fetch or a change bumps the generation in useMailStore. The "下書き" box shows every
 * draft main has stored, and pressing one continues it in the composer. Every change goes to main.
 * For sending and replying, pressing "送信" is the approval; only moving a message to the trash goes
 * through the confirm sheet.
 */

const PAGE = 50
type Pane = MiniAppState<'mail'>['pane']

/** The toast after a change that went through. Starring and marking as read show in the list itself, so they say nothing. */
const DONE_KEY = {
  send: 'mail.done.send',
  reply: 'mail.done.reply',
  archive: 'mail.done.archive',
  trash: 'mail.done.trash'
} as const satisfies Record<string, MessageKey>
const FAILED_KEY = {
  send: 'mail.changeFailed.send',
  reply: 'mail.changeFailed.reply',
  archive: 'mail.changeFailed.archive',
  trash: 'mail.changeFailed.trash',
  markRead: 'mail.changeFailed.markRead',
  star: 'mail.changeFailed.star'
} as const satisfies Record<MailChangeInput['operation'], MessageKey>

/**
 * The first `rows` messages of the list. One query returns at most MAX_BULK_CHANGE of them, so a longer
 * list is read in parts, each continuing after the last message of the part before.
 */
export async function readRows(filter: Pick<MailListQuery, 'view' | 'accountId' | 'query'>, rows: number): Promise<MailListResult> {
  const first = await window.api.mailList({ ...filter, limit: Math.min(rows, MAX_BULK_CHANGE) })
  const messages = [...first.messages]
  while (messages.length < Math.min(rows, first.total)) {
    const last = messages.at(-1)!
    const next = await window.api.mailList({ ...filter, limit: Math.min(rows - messages.length, MAX_BULK_CHANGE), before: { date: last.date, uid: last.uid, id: last.id } })
    if (next.messages.length === 0) break
    messages.push(...next.messages)
  }
  return { ...first, messages }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function MailView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const openApp = useViewStore((s) => s.openApp)
  const update = useViewStore((s) => s.update)
  const { box: view, accountId, query, pane } = useMiniApp('mail')
  const setPane = (next: Pane): void => update('mail', { pane: next })
  const mail = useSettingsStore((s) => s.settings?.mail)
  const status = useMailStore((s) => s.status)
  const revision = useMailStore((s) => s.revision)
  const drafts = useMailStore((s) => s.drafts)
  const draftsLoaded = useMailStore((s) => s.draftsLoaded)
  const loadDrafts = useMailStore((s) => s.loadDrafts)
  const refreshStatus = useMailStore((s) => s.refresh)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const locale = useFormatLocale()
  const now = useNow(open)
  const [input, setInput] = useState(query)
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [total, setTotal] = useState(0)
  const [unreadCount, setUnreadCount] = useState(0)
  const [marking, setMarking] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // How many rows the list holds: one page for a new box, account or search term, and one more for each
  // "load more". Every read, the one after a change in the cache included, reads that many from the top.
  const scope = JSON.stringify([view, accountId, query])
  const [extent, setExtent] = useState({ scope, rows: PAGE })
  const rows = extent.scope === scope ? extent.rows : PAGE

  const accounts = useMemo(() => mail?.accounts ?? [], [mail])
  const ready = Boolean(mail?.enabled) && accounts.length > 0
  const accountLabels = useMemo(() => new Map(accounts.map((account) => [account.id, account.label])), [accounts])
  const statuses = useMemo(() => new Map((status?.accounts ?? []).map((item) => [item.id, item])), [status])

  // The search term takes effect once the typing has stopped.
  useEffect(() => {
    const timer = setTimeout(() => update('mail', { query: input.trim() }), 250)
    return () => clearTimeout(timer)
  }, [input, update])
  useEffect(() => {
    if (!open || !ready || view === 'drafts') return
    let active = true
    readRows({ view, accountId, query }, rows)
      .then((result) => {
        if (!active) return
        setMessages(result.messages)
        setTotal(result.total)
        setUnreadCount(result.unread)
        setLoaded(true)
        setError('')
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [open, ready, view, accountId, query, rows, revision, attempt])
  useEffect(() => {
    if (!open) return
    void refreshStatus()
    if (!draftsLoaded) void loadDrafts()
  }, [open, refreshStatus, draftsLoaded, loadDrafts])
  // The composer closes when the draft it holds has been sent or discarded, or was never there.
  useEffect(() => {
    if (pane?.kind === 'draft' && draftsLoaded && !drafts.some((draft) => draft.id === pane.id)) update('mail', { pane: null })
  }, [pane, drafts, draftsLoaded, update])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (pane) update('mail', { pane: null })
      else closeApp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pane, update, closeApp])

  if (!open) return <></>

  const patch = (ids: readonly string[], flags: Partial<Pick<MailMessage, 'unread' | 'starred'>>): void =>
    setMessages((current) => current.map((item) => (ids.includes(item.id) ? { ...item, ...flags } : item)))
  /**
   * Sends a change to main. A cancelled change is reported quietly and a failed one as a toast, and
   * both answer false. A flag change, starring or marking as read, is shown in the list first and
   * taken back when it does not go through: the round trip to the server waits in the connection's
   * queue and can take seconds, and a row that does not change at once looks like a missed press.
   */
  const submit = async (change: MailChangeInput): Promise<boolean> => {
    let undo: (() => void) | null = null
    if (change.operation === 'star') {
      const before = messages.find((item) => item.id === change.id)
      if (before) {
        patch([before.id], { starred: change.starred })
        undo = () => patch([before.id], { starred: before.starred })
      }
    }
    if (change.operation === 'markRead') {
      const before = messages.filter((item) => change.ids.includes(item.id) && item.unread === change.read)
      const count = unreadCount
      patch(change.ids, { unread: !change.read })
      setUnreadCount(Math.max(0, count + (change.read ? -change.ids.length : change.ids.length)))
      undo = () => {
        patch(
          before.map((item) => item.id),
          { unread: change.read }
        )
        setUnreadCount(count)
      }
    }
    try {
      const result = await window.api.mailChange(change)
      if (!result.saved) {
        undo?.()
        toast({ kind: 'info', title: t('mail.change.cancelled'), body: t('mail.change.cancelledBody') })
        return false
      }
      const done = DONE_KEY[change.operation as keyof typeof DONE_KEY]
      if (done) toast({ kind: 'ok', title: t(done), body: result.summary })
      return true
    } catch (err) {
      undo?.()
      const failed = change.operation === 'markRead' && !change.read ? 'mail.changeFailed.markUnread' : FAILED_KEY[change.operation]
      toast({ kind: 'error', title: t(failed), body: displayError(err) })
      return false
    }
  }
  /** Marks every unread message that matches the current box, account and search term as read, in a single STORE. */
  const markAllRead = async (): Promise<void> => {
    if (view === 'drafts') return
    setMarking(true)
    try {
      const { messages: unread } = await window.api.mailList({ view, accountId, query, unreadOnly: true, limit: MAX_BULK_CHANGE })
      if (unread.length === 0) return
      const ok = await submit({ operation: 'markRead', ids: unread.map((item) => item.id), read: true })
      if (ok) {
        toast({
          kind: 'ok',
          title: t('mail.list.markedRead', { count: unread.length }),
          body: unread.length >= MAX_BULK_CHANGE ? t('mail.list.bulkLimit', { count: MAX_BULK_CHANGE }) : undefined
        })
      }
    } catch (err) {
      toast({ kind: 'error', title: t('mail.list.markAllFailed'), body: displayError(err) })
    } finally {
      setMarking(false)
    }
  }
  const sync = (): void => {
    setSyncing(true)
    window.api
      .mailSyncNow()
      .then(() => refreshStatus())
      .catch((err: unknown) => toast({ kind: 'error', title: t('mail.sync.failed'), body: displayError(err) }))
      .finally(() => setSyncing(false))
  }
  const selectedId = pane?.kind === 'message' || pane?.kind === 'draft' ? pane.id : null
  const shownDrafts = accountId ? drafts.filter((draft) => draft.accountId === accountId) : drafts
  const troubled = (status?.accounts ?? []).filter((item) => item.state === 'error')
  const lastSync = Math.max(0, ...(status?.accounts ?? []).map((item) => item.lastSyncAt ?? 0))

  return (
    <section className="builtin-focus glass ml-focus" aria-label="MAIL">
      <header>
        <h2>MAIL</h2>
        <button onClick={closeApp}>
          {t('common.backToConversation')} <X size={16} />
        </button>
      </header>
      <div className="ml-root">
        <div className="ml-toolbar">
          <label className="ml-search">
            <Search size={15} />
            <input
              aria-label={t('mail.search.label')}
              placeholder={t('mail.search.placeholder', { box: mailBoxLabel(t, view) })}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            {input && (
              <button type="button" aria-label={t('mail.search.clear')} onClick={() => setInput('')}>
                <X size={14} />
              </button>
            )}
          </label>
          <span className="ml-count">
            {view === 'drafts' ? t('mail.draftCount', { count: shownDrafts.length }) : loaded && ready ? t('mail.messageCount', { count: total }) : ''}
          </span>
          {view !== 'drafts' && loaded && ready && unreadCount > 0 && (
            <button type="button" className="cal-btn ml-read-all" disabled={marking} onClick={() => void markAllRead()}>
              <MailOpen size={14} />
              {marking ? t('mail.list.markingRead') : t('mail.list.markAllRead', { count: unreadCount })}
            </button>
          )}
          {troubled.length > 0 && (
            <span className="ml-trouble" role="status" title={troubled.map((item) => `${item.label}: ${item.error}`).join('\n')}>
              {t('mail.accountsDisconnected', { accounts: new Intl.ListFormat(locale).format(troubled.map((item) => item.label)) })}
            </span>
          )}
          <button type="button" className="cal-btn ml-sync" disabled={syncing || !ready} onClick={sync} aria-label={t('mail.sync.now')}>
            <RefreshCw size={14} className={syncing ? 'is-spinning' : undefined} />
            {lastSync
              ? t('mail.sync.lastAt', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(lastSync) })
              : t('mail.sync.idle')}
          </button>
        </div>
        <div className="ml-body">
          <Sidebar
            view={view}
            unread={status?.unread ?? 0}
            drafts={drafts.length}
            accounts={accounts}
            statuses={statuses}
            accountId={accountId}
            onView={(next) => update('mail', { box: next, pane: null })}
            onAccount={(next) => update('mail', { accountId: next })}
            onCompose={() => setPane({ kind: 'compose' })}
          />
          <div className="ml-main">
            {!ready ? (
              <div className="ml-notice">
                <p>{accounts.length === 0 ? t('mail.empty.noAccounts') : t('mail.empty.disabled')}</p>
                <button type="button" className="cal-btn" onClick={() => openApp({ app: 'settings', page: 'connections' })}>
                  {t('mail.openSettings')}
                </button>
              </div>
            ) : view === 'drafts' ? (
              <DraftList drafts={shownDrafts} query={query} selectedId={selectedId} now={now} onSelect={(draft) => setPane({ kind: 'draft', id: draft.id })} />
            ) : (
              <MessageList
                messages={messages}
                total={total}
                loaded={loaded}
                error={error}
                query={query}
                selectedId={selectedId}
                accountLabels={accountLabels}
                showAccount={accounts.length > 1 && accountId === null}
                now={now}
                onSelect={(message) => setPane({ kind: 'message', id: message.id })}
                onStar={(message) => void submit({ operation: 'star', id: message.id, starred: !message.starred })}
                onLoadMore={() => setExtent({ scope, rows: rows + PAGE })}
                onRetry={() => setAttempt((value) => value + 1)}
              />
            )}
          </div>
          {pane?.kind === 'message' && <Reader key={pane.id} id={pane.id} accounts={accounts} onChange={submit} onClose={() => setPane(null)} />}
          {pane?.kind === 'compose' && (
            <Composer accounts={accounts} defaultAccountId={mail?.defaultAccountId ?? null} onSend={submit} onNotice={toast} onClose={() => setPane(null)} />
          )}
          {pane?.kind === 'draft' && (
            <Composer
              key={pane.id}
              accounts={accounts}
              defaultAccountId={mail?.defaultAccountId ?? null}
              draft={drafts.find((draft) => draft.id === pane.id) ?? null}
              onSend={submit}
              onNotice={toast}
              onClose={() => setPane(null)}
            />
          )}
        </div>
      </div>
    </section>
  )
}
