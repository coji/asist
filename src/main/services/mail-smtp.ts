import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import type { MailAccount, MailAddress } from '@shared/mail'

/**
 * Sending over SMTP. The message is composed once and the raw bytes are both sent and returned, because
 * many servers do not put a sent message in the Sent folder, so the caller has to append exactly those
 * bytes itself.
 */

export interface OutgoingMail {
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

export interface SmtpSender {
  send(account: MailAccount, password: string, message: OutgoingMail): Promise<{ messageId: string; raw: Buffer }>
}

const CONNECTION_TIMEOUT_MS = 20_000

/**
 * Builds the message. The addresses go to nodemailer as objects: written out as "name <addr>" strings,
 * they are parsed again, and an address inside a display name such as `"Sato <x@evil.example>, Suzuki"`
 * would come back as a header recipient of its own.
 */
export async function composeMail(account: MailAccount, message: OutgoingMail): Promise<{ messageId: string; raw: Buffer }> {
  const domain = account.email.split('@')[1] || 'asist.local'
  const messageId = `<${randomUUID()}@${domain}>`
  const composer = new MailComposer({
    from: { ...message.from },
    to: message.to.map((address) => ({ ...address })),
    cc: message.cc.length ? message.cc.map((address) => ({ ...address })) : undefined,
    subject: message.subject,
    text: message.text,
    messageId,
    inReplyTo: message.inReplyTo,
    references: message.references?.length ? message.references : undefined,
    date: new Date()
  })
  return { messageId, raw: await composer.compile().build() }
}

/** Marks a failure that came before nodemailer had read any of the message. */
const NOT_HANDED_OVER = Symbol('smtp.notHandedOver')

/**
 * Hands the raw message to the server. nodemailer reads the message only once the connection is open and
 * the login has passed, so a failure before the first read provably left nothing on the server; such an
 * error is marked for failedBeforeSending.
 */
export async function deliver(options: SMTPTransport.Options, envelope: { from: string; to: string[] }, raw: Buffer): Promise<void> {
  let handedOver = false
  const content = new Readable({
    read() {
      handedOver = true
      this.push(raw)
      this.push(null)
    }
  })
  const transport = nodemailer.createTransport(options)
  try {
    await transport.sendMail({ envelope, raw: content })
  } catch (error) {
    if (!handedOver && typeof error === 'object' && error !== null) Object.defineProperty(error, NOT_HANDED_OVER, { value: true })
    throw error
  } finally {
    transport.close()
  }
}

export const smtpSender: SmtpSender = {
  async send(account, password, message) {
    const { messageId, raw } = await composeMail(account, message)
    await deliver(
      {
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        requireTLS: !account.smtp.secure,
        auth: { user: account.email, pass: password },
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: CONNECTION_TIMEOUT_MS
      },
      { from: account.email, to: [...message.to, ...message.cc].map((address) => address.address) },
      raw
    )
    return { messageId, raw }
  }
}

/**
 * Whether the SMTP failure provably happened before the message went out. A dropped connection or a
 * timeout (ECONNECTION, ESOCKET, ETIMEDOUT) also happens while the client waits for the reply to the
 * whole message, after which the server may already have queued it, so those count only when deliver
 * marked them as coming before the message was read. For any other failure it is unknown whether the
 * message was delivered.
 */
export function failedBeforeSending(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { [NOT_HANDED_OVER]?: unknown })[NOT_HANDED_OVER] === true) return true
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && ['EAUTH', 'EDNS', 'ETLS', 'EENVELOPE'].includes(code)
}
