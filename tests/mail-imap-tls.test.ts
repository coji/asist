import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailCache } from '../src/main/services/mail-cache'
import { createImapClient } from '../src/main/services/mail-imap'
import { MailAccountSync } from '../src/main/services/mail-sync'

// The sync writes its own status text in the interface language, which it reads from the settings.
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'ja-JP' }) }))

/**
 * A server on a plain port that does not offer STARTTLS, which is what a client sees when someone on the
 * network strips the offer from the greeting. It answers every command and records what it was sent.
 */
function plainServer(): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = []
  const server = net.createServer((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        received.push(line)
        socket.write(`${line.split(' ')[0]} OK done\r\n`)
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      resolve({ port, received, close: () => server.close() })
    })
  })
}

describe('createImapClient on a plain port', () => {
  let close = (): void => undefined
  afterEach(() => close())

  it('refuses to log in when the server does not offer STARTTLS, so the password never travels in clear text', async () => {
    const server = await plainServer()
    close = server.close
    const endpoint = { host: '127.0.0.1', port: server.port, secure: false }
    const client = createImapClient({ email: 'me@example.com', imap: endpoint }, 'secret-password')
    await expect(client.connect()).rejects.toThrow()
    expect(server.received.join('\n')).not.toContain('secret-password')
    expect(server.received.some((line) => /\b(LOGIN|AUTHENTICATE)\b/i.test(line))).toBe(false)
  })
})

describe('a connection given up during its TLS handshake', () => {
  let close = (): void => undefined
  afterEach(() => close())

  it('settles the sync waiting on it, and the account can still be stopped', async () => {
    // A port that accepts the first connection and never answers its TLS handshake, as a server forgotten during
    // sleep can, and turns every later one away at once.
    const sockets: net.Socket[] = []
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined)
      if (sockets.push(socket) > 1) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    close = () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    }
    const { port } = server.address() as net.AddressInfo
    const sync = new MailAccountSync({
      account: {
        id: 'a1',
        label: '仕事',
        email: 'me@example.com',
        name: '私',
        provider: 'custom',
        imap: { host: '127.0.0.1', port, secure: true },
        smtp: { host: '127.0.0.1', port, secure: true },
        folders: { sent: null, archive: null, trash: null }
      },
      password: () => 'secret-password',
      cache: new MailCache(':memory:'),
      createClient: createImapClient,
      syncDays: () => 30,
      intervals: { periodicMs: 600_000, reconnectMs: [600_000] },
      onStatus: () => undefined,
      onChanged: () => undefined,
      onArrived: () => undefined
    })
    const settled: string[] = []
    const record = (name: string, promise: Promise<unknown>): void =>
      void promise.then(
        () => settled.push(`${name} resolved`),
        () => settled.push(`${name} rejected`)
      )
    record('first sync', sync.syncNow())
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    record('wake', sync.wake())
    await vi.waitFor(() => expect(settled).toEqual(['first sync rejected', 'wake rejected']), { timeout: 3_000 })
    await sync.stop()
  })
})
