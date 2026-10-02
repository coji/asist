import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { openLoopback } from '../src/main/services/oauth-loopback'

/** The server on 127.0.0.1 that a sign-in waits on, which any page in the browser can also reach. */

/** Sends a raw request, so that a target no browser API would let through can be tried, and returns the status. */
function rawRequest(uri: string, target: string): Promise<number> {
  const { hostname, port } = new URL(uri)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`))
    let data = ''
    socket.on('data', (chunk) => (data += chunk))
    socket.on('end', () => resolve(Number(data.split(' ')[1])))
    socket.on('error', reject)
  })
}

describe('the loopback server of a sign-in', () => {
  it('refuses a target that is not a URL without throwing, and still takes the answer that follows', async () => {
    const loopback = await openLoopback({
      path: '/auth/callback',
      read: (params) => (params.get('state') === 'ok' ? { value: params.get('code') } : null),
      page: () => 'done',
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      timedOut: () => new Error('timed out')
    })
    try {
      expect(await rawRequest(loopback.uri, '//[')).toBe(400)
      expect(await rawRequest(loopback.uri, '/auth/callback?state=forged&code=x')).toBe(400)
      void fetch(`${loopback.uri}?state=ok&code=the-code`)
      const { value, answer } = await loopback.arrival
      answer(true)
      expect(value).toBe('the-code')
    } finally {
      loopback.close()
    }
  })
})
