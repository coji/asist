import { ImapFlow } from 'imapflow'
import type { MailAccount } from '@shared/mail'

/**
 * mail-sync and mail-service use only the ImapFlow members listed here, so a test can pass a fake of the
 * same shape instead of a real connection.
 */
export type ImapClient = Pick<
  ImapFlow,
  | 'connect'
  | 'logout'
  | 'close'
  | 'noop'
  | 'stats'
  | 'list'
  | 'getMailboxLock'
  | 'search'
  | 'fetchAll'
  | 'fetchOne'
  | 'download'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageMove'
  | 'append'
  | 'on'
  | 'off'
  | 'usable'
  | 'capabilities'
  | 'mailbox'
>

export type ImapClientFactory = (account: Pick<MailAccount, 'email' | 'imap'>, password: string) => ImapClient

/** IDLE is renewed every 5 minutes, well inside the 30 minutes after which most servers drop it. */
const CONNECTION_TIMEOUT_MS = 20_000
const IDLE_MS = 5 * 60_000

export const createImapClient: ImapClientFactory = (account, password) =>
  new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    // Without doSTARTTLS, imapflow logs in over plain text when the server's greeting does not offer
    // STARTTLS, which is what someone on the network gets by stripping the offer.
    doSTARTTLS: !account.imap.secure,
    auth: { user: account.email, pass: password },
    clientInfo: { name: 'ASIST', vendor: 'nyosegawa' },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    maxIdleTime: IDLE_MS
  })

/** Ends a connection with LOGOUT, and closes the socket when the server does not answer it. */
export async function disconnect(client: Pick<ImapClient, 'logout' | 'close'>): Promise<void> {
  try {
    await client.logout()
  } catch {
    client.close()
  }
}

/** Whether the server offers the Gmail extensions: thread ids, labels and the Gmail search syntax. */
export const supportsGmail = (client: Pick<ImapClient, 'capabilities'>): boolean => client.capabilities.has('X-GM-EXT-1')

/** Reads a download to its end. imapflow resolves a download of a part it cannot find with no content. */
export async function readBytes(content: NodeJS.ReadableStream | undefined): Promise<Buffer> {
  if (!content) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of content) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks)
}
