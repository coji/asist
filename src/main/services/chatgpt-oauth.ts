import { createPublicKey, randomBytes, randomUUID, verify, type JsonWebKeyInput } from 'node:crypto'
import { z } from 'zod'
import { waitWithAbort } from '@shared/abort'
import { errorText } from '@shared/i18n/error-text'
import { SecretUnreadableError, type EncryptedSecretStore } from './encrypted-secrets'
import { SignInReplaced, base64url, getWithTimeout, oauthErrorCode, openLoopback, pkcePair, postForm, sameText, type LoopbackRead } from './oauth-loopback'

/**
 * Signing in with ChatGPT so that OpenAI requests are paid from the user's ChatGPT plan instead of an API
 * key, through the flow OpenAI documents for open-source local apps ("ChatGPT plan usage", a preview). The
 * app registers itself on the first sign-in through `dynamic_agent_client` and gets a client id of its own
 * bound to that ChatGPT account, which later sign-ins reuse. The browser comes back to a server on
 * 127.0.0.1 with PKCE and a state and nonce check. The tokens and the registration are kept encrypted on
 * this computer; the access token lives an hour and every refresh replaces the refresh token too.
 */

export const CHATGPT_ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`
export const CHATGPT_REVOKE_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`
export const CHATGPT_JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`
/** The audience the access token is issued for; the token endpoint wants it on every grant. */
const RESOURCE = 'https://api.openai.com/v1'
/** The scope without which a token signs the user in but cannot be spent on the Responses API. */
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_USAGE_SCOPE]
const CALLBACK_PATH = '/auth/callback'
/** The name OpenAI shows the user for this app on the consent page and in ChatGPT's settings. */
const AGENT_NAME = 'ASIST'
/** The client id that starts a first registration. It is never the id tokens are issued to. */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client'

const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** An access token this close to its expiry is renewed before a request rather than risk a 401 in the middle of one. */
const EXPIRY_MARGIN_MS = 60_000
/** The clock difference tolerated when checking the expiry of an ID token. */
const CLOCK_SKEW_S = 5

/**
 * The refresh errors after which the saved grant is gone for good, so only a new sign-in helps. A reused
 * refresh token is among them: two refreshes raced and the server revoked the whole session.
 */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
])

/**
 * `hostId` names this installation to OpenAI and stays the same across sign-ins (`ext_agent_host_id`).
 * `clientId` is the registration issued for the signed-in account, reused while that account signs in again
 * and forgotten at a sign-out, because a registration is bound to one account and the next sign-in may be
 * another's. `session` is the signed-in account and its tokens, as JSON that carries the version of its form.
 */
export type ChatGptSecretId = 'hostId' | 'clientId' | 'session'

const sessionSchema = z.object({
  version: z.literal(1),
  subject: z.string().min(1),
  email: z.string().optional(),
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number()
})
type Session = z.infer<typeof sessionSchema>

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((type) => type.toLowerCase() === 'bearer'),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  scope: z.string().optional()
})

const jwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })) })

export interface ChatGptAuthDependencies {
  secrets: EncryptedSecretStore<ChatGptSecretId>
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<void>
  /** The HTML the browser shows once it comes back, which tells whether the sign-in went through. */
  page: (signedIn: boolean) => string
  now?: () => number
  signInTimeoutMs?: number
}

/**
 * No usable sign-in: none was made, it was signed out, or OpenAI no longer accepts the one that was saved.
 * It carries 401, so a check of the configuration reports it as a credential that does not authenticate.
 */
export class ChatGptSignedOut extends Error {
  readonly status = 401
  constructor() {
    super(errorText('settingsIntegrations.chatgpt.errors.signedOut'))
  }
}

export interface ChatGptAccount {
  /** The account's email from its verified ID token, shown so the user can tell which account is connected. */
  email: string | null
  /** The registration the tokens were issued to, which stays the same across refreshes. */
  clientId: string
}

/**
 * OpenAI's answer on the callback path. A request with another state is not its answer and leaves the
 * sign-in waiting, since any page in the browser can reach 127.0.0.1 and must not be able to cancel it.
 */
function readChatGptReturn(state: string): (params: URLSearchParams) => LoopbackRead<{ code: string; clientId: string | null }> {
  return (params) => {
    if (params.getAll('state').length !== 1 || !sameText(params.get('state') ?? '', state)) return null
    const code = params.get('code')
    if (params.get('error') || !code || params.getAll('code').length !== 1 || params.getAll('client_id').length > 1) {
      const denied = params.get('error') === 'access_denied'
      return { error: new Error(errorText(denied ? 'settingsIntegrations.chatgpt.errors.signInDenied' : 'settingsIntegrations.chatgpt.errors.signInFailed')) }
    }
    return { value: { code, clientId: params.get('client_id') } }
  }
}

async function tokenOf(response: Response): Promise<z.infer<typeof tokenSchema>> {
  const token = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!token.success) throw new Error(errorText('settingsIntegrations.chatgpt.errors.badResponse'), { cause: token.error })
  return token.data
}

const decodePart = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

export class ChatGptAuth {
  private refreshing: Promise<string> | null = null
  private signingIn: AbortController | null = null
  /**
   * Counts every change of who is signed in: sign-outs, completed sign-ins and sessions forgotten after a
   * refresh failed. A refresh or sign-in that finds it changed once its request returns saves nothing over
   * the change.
   */
  private generation = 0
  /** OpenAI's signing keys, fetched again only when an ID token names a key they lack. */
  private signingKeys: z.infer<typeof jwksSchema>['keys'] | null = null
  constructor(private readonly deps: ChatGptAuthDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** A session that cannot be read counts as unreadable, like one another build encrypted, so only a new sign-in or a sign-out replaces it. */
  private session(): Session | null {
    const raw = this.deps.secrets.get('session')
    if (raw === null) return null
    let content: unknown
    try {
      content = JSON.parse(raw)
    } catch (error) {
      throw new SecretUnreadableError(errorText('settingsIntegrations.chatgpt.errors.unreadable'), { cause: error })
    }
    const parsed = sessionSchema.safeParse(content)
    if (!parsed.success) throw new SecretUnreadableError(errorText('settingsIntegrations.chatgpt.errors.unreadable'), { cause: parsed.error })
    return parsed.data
  }

  private saveSession(session: Session): void {
    this.deps.secrets.set('session', JSON.stringify(session))
  }

  /**
   * Whether a sign-in is saved. `unreadable` is one that another build encrypted, or a file that is broken
   * or that encryption cannot open; a new sign-in replaces it and a sign-out drops it.
   */
  signInState(): 'signedIn' | 'signedOut' | 'unreadable' {
    try {
      return this.session() === null ? 'signedOut' : 'signedIn'
    } catch (error) {
      // Such a file stops only the sign-in, not every status read.
      if (!(error instanceof SecretUnreadableError)) console.warn('ChatGPT sign-in cannot be read:', error)
      return 'unreadable'
    }
  }

  /**
   * Makes the next request renew an access token OpenAI refused before its expiry, as when the user
   * disconnected ASIST in ChatGPT's settings; the renewal then finds out whether the grant is gone.
   */
  forgetAccessToken(token: string): void {
    const session = this.session()
    if (session?.accessToken === token) this.saveSession({ ...session, expiresAt: 0 })
  }

  /** The signed-in account, or null when there is none. */
  account(): ChatGptAccount | null {
    const session = this.session()
    const clientId = this.deps.secrets.get('clientId')
    return session && clientId ? { email: session.email ?? null, clientId } : null
  }

  /**
   * A valid access token, renewed when the saved one is about to expire. Concurrent callers share one
   * refresh, because the refresh token rotates and a second refresh with the old one would revoke the
   * session. The refresh runs to its end even if every caller stops waiting for it, so the replacement
   * refresh token is never lost; `signal` ends only this caller's wait.
   */
  accessToken(signal?: AbortSignal): Promise<string> {
    const session = this.session()
    if (!session) return Promise.reject(new ChatGptSignedOut())
    if (session.expiresAt - EXPIRY_MARGIN_MS > this.now()) return Promise.resolve(session.accessToken)
    this.refreshing ??= this.refresh(session).finally(() => {
      this.refreshing = null
    })
    return signal ? waitWithAbort(this.refreshing, signal) : this.refreshing
  }

  private async refresh(session: Session): Promise<string> {
    const clientId = this.deps.secrets.get('clientId')
    if (clientId === null) throw new ChatGptSignedOut()
    const generation = this.generation
    const current = (): boolean => this.generation === generation
    const response = await postForm(this.deps.fetch, CHATGPT_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: session.refreshToken,
      resource: RESOURCE
    })
    if (!response.ok) {
      const code = await oauthErrorCode(response, 'ChatGPT token refresh')
      if (code !== null && TERMINAL_REFRESH_ERRORS.has(code)) {
        if (current()) this.forget()
        throw new ChatGptSignedOut()
      }
      throw new Error(errorText('settingsIntegrations.chatgpt.errors.requestFailed', { status: response.status }))
    }
    const token = await tokenOf(response)
    if (!current()) {
      // After a sign-out nothing here holds this grant, so it is given back. A newer sign-in under the same
      // registration may share the grant at OpenAI, and revoking would end that one too, so it is only dropped.
      if (this.signInState() === 'signedOut') await this.revoke(token.refresh_token, clientId).catch(() => undefined)
      throw new ChatGptSignedOut()
    }
    // The old refresh token is spent now, so the replacement is saved before anything else can fail, such
    // as fetching the keys that check the new ID token.
    const refreshed: Session = { ...session, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: this.now() + token.expires_in * 1000 }
    this.saveSession(refreshed)
    if (token.id_token) {
      const identity = await this.verifyIdToken(token.id_token, clientId, null)
      if (!current()) throw new ChatGptSignedOut()
      // A refresh that came back for another account would mix two accounts' tokens under one registration.
      if (identity.subject !== session.subject) {
        this.forget()
        await this.revoke(token.refresh_token, clientId).catch((error: unknown) => console.warn('ChatGPT: revoking a refresh for another account failed:', error))
        throw new ChatGptSignedOut()
      }
      this.saveSession({ ...refreshed, idToken: token.id_token, ...(identity.email ? { email: identity.email } : {}) })
    }
    return token.access_token
  }

  /**
   * Signs in through the browser and saves the session. A sign-in started while another waits takes its
   * place, since the browser tab of the first may have been closed; the first then fails with
   * SignInReplaced.
   */
  async signIn(): Promise<void> {
    this.signingIn?.abort(new SignInReplaced())
    const controller = new AbortController()
    this.signingIn = controller
    // A sign-in replaces one this build cannot read, so what cannot be read is dropped first.
    if (this.signInState() === 'unreadable') this.deps.secrets.clear()
    const hostId = this.hostId()
    const savedClientId = this.deps.secrets.get('clientId')
    const { verifier, challenge } = pkcePair()
    const state = base64url(randomBytes(32))
    const nonce = base64url(randomBytes(32))
    const timeoutMs = this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS
    const loopback = await openLoopback({
      path: CALLBACK_PATH,
      read: readChatGptReturn(state),
      page: this.deps.page,
      signal: controller.signal,
      timeoutMs,
      timedOut: () => new Error(errorText('settingsIntegrations.chatgpt.errors.signInTimedOut', { minutes: Math.round(timeoutMs / 60_000) }))
    })
    try {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: savedClientId ?? REGISTRATION_CLIENT_ID,
        response_type: 'code',
        redirect_uri: loopback.uri,
        scope: SCOPES.join(' '),
        resource: RESOURCE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ext_agent_host_id: hostId,
        ...(savedClientId === null ? { agent_name_hint: AGENT_NAME } : {})
      }).toString()
      controller.signal.throwIfAborted()
      await this.deps.openBrowser(url.href)
      const {
        value: { code, clientId: returnedClientId },
        answer
      } = await loopback.arrival
      try {
        const clientId = returnedClientId ?? savedClientId
        if (!clientId || clientId === REGISTRATION_CLIENT_ID || (savedClientId !== null && returnedClientId !== null && returnedClientId !== savedClientId)) {
          throw new Error(errorText('settingsIntegrations.chatgpt.errors.signInFailed'))
        }
        await this.exchange(code, verifier, nonce, loopback.uri, clientId, controller)
      } catch (error) {
        answer(false)
        // Without a session the registration belongs to nobody yet, and it may be bound to an account the
        // user did not mean, so the next attempt registers again rather than reuse it.
        if (this.signInState() === 'signedOut') this.deps.secrets.remove('clientId')
        throw error
      }
      answer(true)
    } finally {
      loopback.close()
      if (this.signingIn === controller) this.signingIn = null
    }
  }

  /** Stops a sign-in that waits for the browser. */
  cancelSignIn(): void {
    this.signingIn?.abort(new SignInReplaced())
  }

  private hostId(): string {
    const saved = this.deps.secrets.get('hostId')
    if (saved !== null) return saved
    const created = `urn:uuid:${randomUUID()}`
    this.deps.secrets.set('hostId', created)
    return created
  }

  /**
   * Trades the code for tokens. The request is not aborted halfway, since OpenAI may already have granted
   * the tokens; a sign-in stopped meanwhile revokes them and saves nothing.
   */
  private async exchange(code: string, verifier: string, nonce: string, redirectUri: string, clientId: string, controller: AbortController): Promise<void> {
    const response = await postForm(this.deps.fetch, CHATGPT_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE
    })
    if (!response.ok) {
      await oauthErrorCode(response, 'ChatGPT token code exchange')
      throw new Error(errorText('settingsIntegrations.chatgpt.errors.signInFailed'))
    }
    const token = await tokenOf(response)
    // Every way this sign-in can still end without a session gives back the grant it just got.
    let identity: { subject: string; email: string | null }
    try {
      controller.signal.throwIfAborted()
      // The consent page lets the user sign in without sharing the plan, and such a token cannot pay for a
      // request. A response without `scope` granted what was asked for (RFC 6749, 5.1).
      const granted = new Set(token.scope === undefined ? SCOPES : token.scope.split(/\s+/))
      if (!granted.has(PLAN_USAGE_SCOPE)) throw new Error(errorText('settingsIntegrations.chatgpt.errors.planUsageNotGranted'))
      if (!token.id_token) throw new Error(errorText('settingsIntegrations.chatgpt.errors.badResponse'))
      identity = await this.verifyIdToken(token.id_token, clientId, nonce)
      // A sign-out or a newer sign-in may have come while the keys were fetched.
      controller.signal.throwIfAborted()
    } catch (error) {
      await this.revoke(token.refresh_token, clientId).catch(() => undefined)
      throw error
    }
    // A sign-in made while another session is saved replaces it without revoking it: under the same
    // registration both may be one grant at OpenAI, and revoking the old one could end the new one.
    this.generation++
    this.deps.secrets.set('clientId', clientId)
    this.saveSession({
      version: 1,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      idToken: token.id_token!,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: this.now() + token.expires_in * 1000
    })
  }

  /**
   * Checks the ID token's RS256 signature against OpenAI's published keys and its issuer, audience, expiry
   * and, at sign-in, the nonce this attempt sent. Its subject is the account the session belongs to.
   */
  private async verifyIdToken(idToken: string, clientId: string, nonce: string | null): Promise<{ subject: string; email: string | null }> {
    const invalid = (): Error => new Error(errorText('settingsIntegrations.chatgpt.errors.badIdToken'))
    const parts = idToken.split('.')
    if (parts.length !== 3) throw invalid()
    let header: Record<string, unknown>
    let claims: Record<string, unknown>
    try {
      header = decodePart(parts[0])
      claims = decodePart(parts[1])
    } catch {
      throw invalid()
    }
    if (header.alg !== 'RS256') throw invalid()
    const keyOf = (keys: z.infer<typeof jwksSchema>['keys']) => keys.find((key) => key.kty === 'RSA' && (header.kid === undefined || key.kid === header.kid))
    // OpenAI rotates its keys, so a key the cached set lacks sends for the set again.
    let jwk = this.signingKeys ? keyOf(this.signingKeys) : undefined
    if (!jwk) {
      this.signingKeys = await this.fetchSigningKeys(invalid)
      jwk = keyOf(this.signingKeys)
    }
    if (!jwk) throw invalid()
    const signed = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' } as JsonWebKeyInput), Buffer.from(parts[2], 'base64url'))
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const nowS = this.now() / 1000
    if (
      !signed ||
      claims.iss !== CHATGPT_ISSUER ||
      !audience.includes(clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' ||
      claims.exp + CLOCK_SKEW_S < nowS ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      (nonce !== null && claims.nonce !== nonce)
    ) {
      throw invalid()
    }
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null }
  }

  private async fetchSigningKeys(invalid: () => Error): Promise<z.infer<typeof jwksSchema>['keys']> {
    const response = await getWithTimeout(this.deps.fetch, CHATGPT_JWKS_URL)
    if (!response.ok) throw new Error(errorText('settingsIntegrations.chatgpt.errors.requestFailed', { status: response.status }))
    const keys = jwksSchema.safeParse(await response.json().catch(() => null))
    if (!keys.success) throw invalid()
    return keys.data.keys
  }

  /**
   * Takes the grant back at OpenAI and forgets the session and its registration here; the host id stays.
   * Both are forgotten even when OpenAI cannot be reached, and the failure is then raised, since the grant
   * still shows in ChatGPT's settings until the user removes it there.
   */
  async signOut(): Promise<void> {
    this.signingIn?.abort(new SignInReplaced())
    if (this.signInState() === 'unreadable') {
      // What cannot be read cannot be revoked from here either; the whole file is dropped, host id included.
      this.generation++
      this.deps.secrets.clear()
      return
    }
    const session = this.session()
    const clientId = this.deps.secrets.get('clientId')
    this.forget()
    if (session && clientId) await this.revoke(session.refreshToken, clientId)
  }

  /** Forgets the session and its registration, which belongs to that account alone; the host id stays. */
  private forget(): void {
    this.generation++
    this.deps.secrets.remove('session')
    this.deps.secrets.remove('clientId')
  }

  /** OpenAI answers 400 for a token it no longer knows, which is revoked already. */
  private async revoke(token: string, clientId: string): Promise<void> {
    const response = await postForm(this.deps.fetch, CHATGPT_REVOKE_URL, { token, token_type_hint: 'refresh_token', client_id: clientId })
    if (!response.ok && response.status !== 400) throw new Error(errorText('settingsIntegrations.chatgpt.errors.revokeFailed', { status: response.status }))
  }
}
