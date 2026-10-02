import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { errorText } from '@shared/i18n/error-text'
import { SecretUnreadableError, type EncryptedSecretStore } from './encrypted-secrets'
import { fetchFailure } from './fetch-failure'

/**
 * Signing in to Google as an installed app (RFC 8252): the system browser shows Google's consent page and
 * comes back to a server on 127.0.0.1 that listens only for the sign-in, with PKCE (RFC 7636) and a state
 * check, so no server of ASIST's own is involved. The refresh token is kept encrypted on this computer and
 * the access token only in memory.
 */

/** Reading the list of calendars, and reading and writing events. Nothing broader. */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events'
] as const

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/** How long the sign-in waits for the browser to come back, which covers choosing an account and a second factor. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** An access token this close to its expiry is renewed before a request rather than risk a 401 in the middle of one. */
const EXPIRY_MARGIN_MS = 60_000

/** The OAuth client of the desktop app. Google treats the secret of an installed app as public. */
export interface GoogleOAuthClient {
  id: string
  secret: string
}

export type GoogleTokenId = 'refreshToken'

export interface GoogleAuthDependencies {
  client: GoogleOAuthClient
  tokens: EncryptedSecretStore<GoogleTokenId>
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<void>
  /** The HTML the browser shows once it comes back, which tells whether the sign-in went through. */
  page: (signedIn: boolean) => string
  now?: () => number
  signInTimeoutMs?: number
}

/** No usable sign-in: none was made, or Google no longer accepts the one that was saved. */
export class GoogleSignedOut extends Error {
  constructor() {
    super(errorText('calendar.errors.googleSignedOut'))
  }
}

/** The reason a sign-in stops when a newer one or a sign-out takes its place. */
export class SignInReplaced extends Error {}

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

/** A code verifier of 43 characters and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional()
})

interface Arrival {
  code: string
  answer: (signedIn: boolean) => void
}

interface Loopback {
  uri: string
  arrival: Promise<Arrival>
  close: () => void
}

/**
 * The server the browser comes back to. It takes one answer on its root: a code that carries the state
 * this sign-in sent, or Google's error. A request with another state is refused and ends the sign-in, since
 * only a page other than Google's could have sent it.
 */
async function openLoopback(state: string, page: (signedIn: boolean) => string, signal: AbortSignal, timeoutMs: number): Promise<Loopback> {
  let settled = false
  let settle!: { resolve: (arrival: Arrival) => void; reject: (error: unknown) => void }
  const arrival = new Promise<Arrival>((resolve, reject) => {
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
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/' || settled) {
      response.writeHead(404, { connection: 'close' }).end()
      return
    }
    const answer = (signedIn: boolean): void => {
      response.writeHead(signedIn ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page(signedIn))
    }
    const params = url.searchParams
    const code = params.get('code')
    const failure =
      params.get('state') !== state
        ? 'calendar.errors.googleSignInFailed'
        : params.get('error') === 'access_denied'
          ? 'calendar.errors.googleSignInDenied'
          : params.get('error') || !code
            ? 'calendar.errors.googleSignInFailed'
            : null
    if (failure || !code) {
      answer(false)
      settle.reject(new Error(errorText(failure ?? 'calendar.errors.googleSignInFailed')))
      return
    }
    settle.resolve({ code, answer })
  })
  // A sign-in that fails before anyone waits for the browser, as when the browser does not open, would
  // otherwise leave this rejection unhandled; whoever awaits the arrival still sees it.
  arrival.catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const timer = setTimeout(() => settle.reject(new Error(errorText('calendar.errors.googleSignInTimedOut', { minutes: Math.round(timeoutMs / 60_000) }))), timeoutMs)
  const abort = (): void => settle.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  // A sign-out or a newer sign-in may have come while the server was starting to listen.
  if (signal.aborted) abort()
  return {
    uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    arrival,
    close: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeIdleConnections()
    }
  }
}

/**
 * The error code of a failed token request, which is also logged: redirect_uri_mismatch, invalid_client
 * and the like tell what to fix in the Google Cloud project. The body never carries a token.
 */
async function googleError(response: Response, request: string): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : null
  console.warn(`Google token ${request} failed: HTTP ${response.status} ${code ?? '(no error code)'}`)
  return code
}

async function tokenOf(response: Response): Promise<z.infer<typeof tokenSchema>> {
  const token = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!token.success) throw new Error(errorText('calendar.errors.googleBadResponse'), { cause: token.error })
  return token.data
}

export class GoogleAuth {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null
  private signingIn: AbortController | null = null
  constructor(private readonly deps: GoogleAuthDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Whether a sign-in is saved. `unreadable` is one that another build encrypted, as when a run from the
   * repository and the installed app share userData but not the key of safeStorage; it can only be
   * replaced by a new sign-in or dropped by a sign-out.
   */
  signInState(): 'signedIn' | 'signedOut' | 'unreadable' {
    try {
      return this.deps.tokens.get('refreshToken') === null ? 'signedOut' : 'signedIn'
    } catch (error) {
      if (error instanceof SecretUnreadableError) return 'unreadable'
      throw error
    }
  }

  /** A valid access token, renewed with the saved refresh token when the one in memory is about to expire. */
  accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return Promise.resolve(this.access.token)
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** Drops an access token Google refused, so that the next request renews it. */
  forgetAccessToken(token: string): void {
    if (this.access?.token === token) this.access = null
  }

  /** Forgets a saved sign-in whose fresh access token Google still refuses, which only a new sign-in mends. */
  signedOutByGoogle(): GoogleSignedOut {
    this.forget()
    return new GoogleSignedOut()
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.deps.tokens.get('refreshToken')
    if (refreshToken === null) throw new GoogleSignedOut()
    const response = await this.post(GOOGLE_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.deps.client.id,
      client_secret: this.deps.client.secret
    })
    if (!response.ok) {
      const body = await googleError(response, 'refresh')
      // Google answers invalid_grant when the user took the access back, when the password changed, and when
      // a sign-in made while the app is in testing passes its seven days. Only a new sign-in helps then.
      if (response.status === 400 && body === 'invalid_grant') {
        this.forget()
        throw new GoogleSignedOut()
      }
      throw new Error(errorText('calendar.errors.googleRequestFailed', { status: response.status }))
    }
    const token = await tokenOf(response)
    this.access = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1000 }
    return token.access_token
  }

  /**
   * Signs in through the browser and saves the refresh token. A sign-in started while another waits takes
   * its place, since the browser tab of the first may have been closed; the first then fails with
   * SignInReplaced.
   */
  async signIn(): Promise<void> {
    this.signingIn?.abort(new SignInReplaced())
    const controller = new AbortController()
    this.signingIn = controller
    const { verifier, challenge } = pkcePair()
    const state = base64url(randomBytes(16))
    const loopback = await openLoopback(state, this.deps.page, controller.signal, this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
    try {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: this.deps.client.id,
        redirect_uri: loopback.uri,
        response_type: 'code',
        scope: GOOGLE_CALENDAR_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        // Google returns a refresh token only on a consent it shows, so a second sign-in would otherwise get none.
        prompt: 'consent'
      }).toString()
      controller.signal.throwIfAborted()
      await this.deps.openBrowser(url.href)
      const { code, answer } = await loopback.arrival
      try {
        await this.exchange(code, verifier, loopback.uri, controller)
      } catch (error) {
        answer(false)
        throw error
      }
      answer(true)
    } finally {
      loopback.close()
      if (this.signingIn === controller) this.signingIn = null
    }
  }

  /**
   * Trades the code for tokens. The request is not aborted halfway, since Google may already have granted
   * the tokens. A sign-in stopped meanwhile saves nothing. When a sign-out was the last thing to stop it,
   * the grant is revoked; when a newer sign-in started after it, the grant is only dropped, because Google's
   * revocation takes back every grant the account gave the app, the one the newer sign-in asks for included.
   */
  private async exchange(code: string, verifier: string, redirectUri: string, controller: AbortController): Promise<void> {
    const { signal } = controller
    const response = await this.post(GOOGLE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: this.deps.client.id,
      client_secret: this.deps.client.secret
    })
    if (!response.ok) {
      await googleError(response, 'code exchange')
      throw new Error(errorText('calendar.errors.googleSignInFailed'))
    }
    const token = await tokenOf(response)
    if (!token.refresh_token) throw new Error(errorText('calendar.errors.googleSignInFailed'))
    if (signal.aborted) {
      if (this.signingIn === controller) await this.revoke(token.refresh_token)
      throw signal.reason
    }
    // The consent page lets the user leave out any of the scopes, and the calendar needs both.
    const granted = new Set((token.scope ?? '').split(' '))
    if (!GOOGLE_CALENDAR_SCOPES.every((scope) => granted.has(scope))) {
      await this.revoke(token.refresh_token)
      throw new Error(errorText('calendar.errors.googleScopesMissing'))
    }
    this.deps.tokens.set('refreshToken', token.refresh_token)
    this.access = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1000 }
  }

  /** Takes ASIST's access back at Google and forgets it here. A sign-in in progress stops. */
  async signOut(): Promise<void> {
    this.signingIn?.abort(new SignInReplaced())
    let refreshToken: string | null
    try {
      refreshToken = this.deps.tokens.get('refreshToken')
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error
      // Another build encrypted it, so it cannot be revoked from here; it stays in the Google account's list
      // of connected apps until the user removes it there.
      this.forget()
      return
    }
    if (refreshToken !== null) await this.revoke(refreshToken)
    this.forget()
  }

  private async revoke(token: string): Promise<void> {
    const response = await this.post(GOOGLE_REVOKE_URL, { token })
    // Google answers 400 for a token it no longer knows, which is revoked already.
    if (!response.ok && response.status !== 400) throw new Error(errorText('calendar.errors.googleRequestFailed', { status: response.status }))
  }

  private forget(): void {
    this.deps.tokens.remove('refreshToken')
    this.access = null
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form)
      })
    } catch (error) {
      throw fetchFailure(url, error)
    }
  }
}
