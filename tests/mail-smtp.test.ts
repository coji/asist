import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import addressparser from 'nodemailer/lib/addressparser'
import type { MailAccount } from '@shared/mail'
import { composeMail, deliver, failedBeforeSending } from '../src/main/services/mail-smtp'

/**
 * Whether a failed send may be reported as "not sent", which lets the user press send again, and whether
 * the headers name only the addresses the message is delivered to. A loopback SMTP server stands in for
 * the real one.
 */

const account: MailAccount = {
  id: 'a1',
  label: '仕事',
  email: 'me@example.com',
  otherAddresses: [],
  name: '私',
  provider: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  folders: { sent: 'Sent', archive: 'Archive', trash: 'Trash' }
}

interface Stub {
  port: number
  received: () => string
  close: () => Promise<void>
}

/**
 * A server that answers EHLO, MAIL, RCPT and DATA. `on` decides what it does at each step instead of
 * answering: at the EHLO, at the AUTH, or once it holds the whole message, where a real server would
 * answer 250 after queueing it.
 */
function stubServer(on: { ehlo?: (socket: net.Socket) => void; auth?: boolean; data?: (socket: net.Socket) => void }): Promise<Stub> {
  let data = ''
  const server = net.createServer((socket) => {
    let inData = false
    let buffer = ''
    socket.on('error', () => undefined)
    socket.write('220 stub ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end < 0) return
        data = buffer.slice(0, end)
        buffer = ''
        inData = false
        if (on.data) on.data(socket)
        else socket.write('250 queued\r\n')
        return
      }
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') {
          if (on.ehlo) return on.ehlo(socket)
          socket.write(on.auth ? '250-stub\r\n250 AUTH PLAIN\r\n' : '250-stub\r\n250 8BITMIME\r\n')
        } else if (verb === 'AUTH') socket.write('535 5.7.8 Authentication failed\r\n')
        else if (verb === 'DATA') {
          socket.write('354 go ahead\r\n')
          inData = true
          return
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received: () => data,
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

let stub: Stub | null = null
afterEach(async () => {
  await stub?.close()
  stub = null
})

async function failureOf(port: number, auth = false): Promise<unknown> {
  const { raw } = await composeMail(account, { from: { name: '私', address: 'me@example.com' }, to: [{ name: '田中', address: 't@example.com' }], cc: [], subject: 'x', text: 'body' })
  try {
    await deliver(
      { host: '127.0.0.1', port, secure: false, ignoreTLS: true, connectionTimeout: 2_000, greetingTimeout: 2_000, ...(auth ? { auth: { user: 'me@example.com', pass: 'wrong' } } : {}) },
      { from: 'me@example.com', to: ['t@example.com'] },
      raw
    )
  } catch (error) {
    return error
  }
  throw new Error('the send did not fail')
}

describe('classifying a failed send', () => {
  it('does not call a connection closed after the whole message was handed over a failure before sending', async () => {
    stub = await stubServer({ data: (socket) => socket.end() })
    const error = await failureOf(stub.port)
    expect(stub.received()).toContain('body')
    expect(failedBeforeSending(error)).toBe(false)
  })

  it('does not call a connection reset after the whole message was handed over a failure before sending', async () => {
    stub = await stubServer({ data: (socket) => socket.resetAndDestroy() })
    const error = await failureOf(stub.port)
    expect(stub.received()).toContain('body')
    expect(failedBeforeSending(error)).toBe(false)
  })

  it('calls a refused connection, a connection dropped at the greeting and a rejected login failures before sending', async () => {
    stub = await stubServer({ ehlo: (socket) => socket.destroy() })
    expect(failedBeforeSending(await failureOf(stub.port))).toBe(true)
    await stub.close()
    stub = await stubServer({ auth: true })
    expect(failedBeforeSending(await failureOf(stub.port, true))).toBe(true)
    const port = stub.port
    await stub.close()
    stub = null
    expect(failedBeforeSending(await failureOf(port))).toBe(true)
  })

  it('delivers when the server accepts the message', async () => {
    stub = await stubServer({})
    const { raw } = await composeMail(account, { from: { name: '私', address: 'me@example.com' }, to: [{ name: '', address: 't@example.com' }], cc: [], subject: 'x', text: 'body' })
    await expect(deliver({ host: '127.0.0.1', port: stub.port, secure: false, ignoreTLS: true }, { from: 'me@example.com', to: ['t@example.com'] }, raw)).resolves.toBeUndefined()
    expect(stub.received()).toContain('body')
  })
})

describe('composing the headers', () => {
  it('names in To and Cc only the addresses the message goes to, even when a display name holds an address or a comma', async () => {
    const to = [{ name: '田中 <x@evil.example>', address: 't@example.com' }]
    const cc = [
      { name: 'Sato <attacker@evil.example>, Suzuki', address: 'suzuki@example.com' },
      { name: 'Tanaka, Taro', address: 'taro@example.com' }
    ]
    const { raw } = await composeMail(account, { from: { name: '私', address: 'me@example.com' }, to, cc, subject: 'Re: x', text: 'body' })
    const head = raw.toString('utf8').split('\r\n\r\n')[0]
    // Folded lines are joined back, and the header is read with the address parser a mail program would use.
    const field = (name: string): string[] =>
      addressparser(
        head
          .split(/\r\n(?![ \t])/)
          .find((line) => line.startsWith(`${name}:`))!
          .slice(name.length + 1)
          .replace(/\r\n/g, '')
      ).map((entry) => entry.address ?? '')
    expect(field('To')).toEqual(['t@example.com'])
    expect(field('Cc')).toEqual(['suzuki@example.com', 'taro@example.com'])
  })
})
