import { app, BrowserWindow, Notification, powerMonitor, safeStorage, shell } from 'electron'
import mitt from 'mitt'
import { displayName, type MailEvent } from '@shared/mail'
import { requestConfirm } from './confirm'
import { t } from './i18n'
import { MailCache } from './mail-cache'
import { MailDraftStore } from './mail-drafts'
import { createImapClient } from './mail-imap'
import { createMailSecretStore } from './mail-secrets'
import { MailService } from './mail-service'
import { smtpSender } from './mail-smtp'
import { docsUrl } from '@shared/docs-links'
import { getSettings, saveSettings } from './settings'
import { dataPath } from './store'

/**
 * Wires the mail integration into Electron: where the cache, the passwords and the drafts are stored,
 * the in-app confirmation dialog, the OS notification for new mail, and the re-sync when the machine
 * wakes from sleep. ipc relays the events to the renderer.
 */

export const events = mitt<{ event: MailEvent }>()

let service: MailService | null = null

/** The shared instance, created on first use so that the userData path is resolved only after app ready. */
export function getMailService(): MailService {
  return (service ??= new MailService({
    settings: () => getSettings().mail,
    saveSettings: (mail) => {
      saveSettings({ mail })
    },
    secrets: createMailSecretStore({
      filePath: dataPath('mail-secrets.json'),
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (encrypted) => safeStorage.decryptString(encrypted)
    }),
    cache: new MailCache(dataPath('mail-cache.sqlite')),
    drafts: new MailDraftStore({ filePath: dataPath('mail-drafts.json'), onChanged: (drafts) => events.emit('event', { type: 'drafts', drafts }) }),
    createClient: createImapClient,
    smtp: smtpSender,
    confirm: (detail, signal, action, destructive) =>
      requestConfirm(
        { title: t('mail.confirm.title'), message: t('mail.confirm.message'), detail, confirmLabel: action, destructive },
        signal
      ),
    emit: (event) => events.emit('event', event)
  }))
}

export function initMail(): void {
  const mail = getMailService()
  events.on('event', (event) => {
    if (event.type !== 'arrived' || !getSettings().mail.notifyNewMail) return
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) return
    if (!Notification.isSupported()) return
    const first = event.messages[0]
    const rest = event.messages.length - 1
    const subject = first.subject || t('mail.noSubject')
    new Notification({
      title: rest > 0 ? t('mail.notify.count', { count: event.messages.length }) : t('mail.notify.from', { name: displayName(first.from) }),
      body: (rest > 0 ? t('mail.notify.more', { subject, count: rest }) : subject).slice(0, 180),
      silent: false
    }).show()
  })
  powerMonitor.on('resume', () => void mail.wake().catch(() => undefined))
  app.once('will-quit', () => void mail.stop())
  // The check of the cache file runs in a worker thread, and the window and the cached listing need not wait for it.
  void mail
    .checkCache()
    .catch((error: unknown) => console.error('mail cache check:', error))
    .then(() => mail.start())
}

export function openMailGuide(): Promise<void> {
  return shell.openExternal(docsUrl('mail', getSettings().uiLocale))
}
