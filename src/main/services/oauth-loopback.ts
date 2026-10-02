import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchFailure } from './fetch-failure'

/**
 * The pieces an installed app's sign-in (RFC 8252) shares between Google and ChatGPT: the PKCE pair, and
 * the server on 127.0.0.1 the system browser comes back to. Any page open in the browser can send requests
 * to that server while it waits, so nothing such a page sends can throw in main, and only what the
 * provider reads as an answer ends the wait.
 */

export const base64url = (bytes: Buffer): string => bytes.toString('base64url')

/** Compares a returned state with the one sent, in time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** The reason a sign-in stops when a newer one, a cancel or a sign-out takes its place. */
export class SignInReplaced extends Error {}

/**
 * How long one request to a sign-in server may take. A refresh holds up every call that needs its token and
 * a sign-out holds up saving the settings, so neither waits for undici's own limit of minutes.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

/** A form POST to a token or revocation endpoint. */
export async function postForm(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw fetchFailure(url, error)
  }
}

/** A GET with the same time limit as the token requests, for a provider's signing keys. */
export async function getWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw fetchFailure(url, error)
  }
}

/**
 * The OAuth error code of a failed token request, which is also logged: the code tells what to fix, and the
 * body of an error never carries a token.
 */
export async function oauthErrorCode(response: Response, what: string): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : typeof body?.code === 'string' ? body.code : null
  console.warn(`${what} failed: HTTP ${response.status} ${code ?? '(no error code)'}`)
  return code
}

/** A code verifier of 43 characters and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/**
 * What the provider makes of the query of a request on the callback path: the value the sign-in goes on
 * with, the error it ends with, or null for a request that is not its answer, which is refused and leaves
 * the sign-in waiting.
 */
export type LoopbackRead<T> = { value: T } | { error: Error } | null

export interface LoopbackArrival<T> {
  value: T
  /** Answers the browser with the page that tells whether the sign-in went through. */
  answer: (signedIn: boolean) => void
}

export interface Loopback<T> {
  /** The redirect URI: the server's origin followed by the callback path, which is left out when it is `/`. */
  uri: string
  arrival: Promise<LoopbackArrival<T>>
  close: () => void
}

export interface LoopbackOptions<T> {
  path: string
  read: (params: URLSearchParams) => LoopbackRead<T>
  page: (signedIn: boolean) => string
  signal: AbortSignal
  timeoutMs: number
  timedOut: () => Error
}

export async function openLoopback<T>(options: LoopbackOptions<T>): Promise<Loopback<T>> {
  const { path, read, page, signal, timeoutMs, timedOut } = options
  let settled = false
  let settle!: { resolve: (arrival: LoopbackArrival<T>) => void; reject: (error: unknown) => void }
  const arrival = new Promise<LoopbackArrival<T>>((resolve, reject) => {
    settle = {
      resolve: (value) => {
        settled = true
        resolve(value)
      },
      reject: (error) => {
        settled = true
        reject(error)
      }
    }
  })
  let host = ''
  const server = http.createServer((request, response) => {
    const refuse = (status: number): void => void response.writeHead(status, { connection: 'close' }).end()
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${host}`)
    } catch {
      // A target such as `//[` is not a URL, and the URL constructor throws on it.
      refuse(400)
      return
    }
    if (request.method !== 'GET' || request.headers.host !== host || url.pathname !== path || settled) {
      refuse(404)
      return
    }
    const result = read(url.searchParams)
    if (result === null) {
      refuse(400)
      return
    }
    const answer = (signedIn: boolean): void => {
      response
        .writeHead(signedIn ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close' })
        .end(page(signedIn))
    }
    if ('error' in result) {
      answer(false)
      settle.reject(result.error)
      return
    }
    settle.resolve({ value: result.value, answer })
  })
  // A sign-in that fails before anyone waits for the browser would otherwise leave this rejection unhandled;
  // whoever awaits the arrival still sees it.
  arrival.catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  const timer = setTimeout(() => settle.reject(timedOut()), timeoutMs)
  const abort = (): void => settle.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  // A sign-out or a newer sign-in may have come while the server was starting to listen.
  if (signal.aborted) abort()
  return {
    uri: `http://${host}${path === '/' ? '' : path}`,
    arrival,
    close: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeIdleConnections()
    }
  }
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The page the browser shows once it comes back, with one line of text. */
export const signInPage = (text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ASIST</title></head><body><p>${escapeHtml(text)}</p></body></html>`
