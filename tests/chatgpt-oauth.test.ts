import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { errorText } from '../src/shared/i18n/error-text'
import {
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_REVOKE_URL,
  CHATGPT_TOKEN_URL,
  ChatGptAuth,
  ChatGptSignedOut,
  PLAN_USAGE_SCOPE,
  type ChatGptSecretId
} from '../src/main/services/chatgpt-oauth'
import { SecretUnreadableError, type EncryptedSecretStore } from '../src/main/services/encrypted-secrets'
import { SignInReplaced } from '../src/main/services/oauth-loopback'

/** Signing in with ChatGPT and keeping its tokens. OpenAI's endpoints are faked; the browser's return to 127.0.0.1 is real. */

const CLIENT_ID = 'oaiapp_issued'
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWKS = { keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }

function idToken(claims: Record<string, unknown>, key = signingKey.privateKey): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const head = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${part({ iss: CHATGPT_ISSUER, aud: [CLIENT_ID], sub: 'user-1', email: 'someone@example.com', exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000, ...claims })}`
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`
}

function memorySecrets(initial: Partial<Record<ChatGptSecretId, string>> = {}): EncryptedSecretStore<ChatGptSecretId> & { values: Map<ChatGptSecretId, string> } {
  const values = new Map(Object.entries(initial) as Array<[ChatGptSecretId, string]>)
  return {
    values,
    get: (id) => values.get(id) ?? null,
    set: (id, secret) => void values.set(id, secret),
    remove: (id) => void values.delete(id),
    clear: () => values.clear()
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  form: URLSearchParams
}

/**
 * OpenAI's sign-in endpoints. `tokens` answers each token request in turn, `nonce` being the one the
 * authorization asked for; every POST is kept with its form.
 */
function fakeOpenAI(tokens: Array<(form: URLSearchParams, nonce: string) => Response | Promise<Response>>) {
  const calls: Call[] = []
  let nonce = ''
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (url === CHATGPT_JWKS_URL) return json(JWKS)
    const form = new URLSearchParams(String(init.body ?? ''))
    calls.push({ url, form })
    if (url === CHATGPT_REVOKE_URL) return new Response(null, { status: 200 })
    if (url === CHATGPT_TOKEN_URL) {
      const answer = tokens.shift()
      if (!answer) throw new Error('no token answer left')
      return answer(form, nonce)
    }
    throw new Error(`unexpected request to ${url}`)
  })
  return { fetch: fetchMock as unknown as typeof fetch, calls, setNonce: (value: string) => (nonce = value), tokenCalls: () => calls.filter((call) => call.url === CHATGPT_TOKEN_URL) }
}

const granted = (over: Record<string, unknown> = {}) => (_form: URLSearchParams, nonce: string): Response =>
  json({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
    id_token: idToken({ nonce }),
    scope: SCOPE,
    ...over
  })

/** A browser that comes back to the redirect URI with the code, as ChatGPT does once the user consents. */
function browser(openai: ReturnType<typeof fakeOpenAI>, back: (authorize: URL) => Record<string, string> = (authorize) => ({ code: 'code-1', state: authorize.searchParams.get('state')!, client_id: CLIENT_ID, scope: SCOPE })) {
  const opened: URL[] = []
  const answers: number[] = []
  const openBrowser = vi.fn(async (url: string) => {
    const authorize = new URL(url)
    opened.push(authorize)
    openai.setNonce(authorize.searchParams.get('nonce')!)
    const callback = new URL(authorize.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams(back(authorize)).toString()
    void globalThis.fetch(callback).then((response) => answers.push(response.status))
  })
  return { openBrowser, opened, answers }
}

function authWith(openai: ReturnType<typeof fakeOpenAI>, secrets = memorySecrets(), openBrowser: (url: string) => Promise<void> = async () => undefined, now = () => Date.now()) {
  return new ChatGptAuth({ secrets, fetch: openai.fetch, openBrowser, page: (signedIn) => `<p>${signedIn}</p>`, now })
}

const session = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, subject: 'user-1', email: 'someone@example.com', idToken: 'id', accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: Date.now() + 30_000, ...over })

describe('signing in with ChatGPT', () => {
  it('registers ASIST on the first sign-in with PKCE, a state and a nonce, and keeps the verified session', async () => {
    const openai = fakeOpenAI([granted()])
    const secrets = memorySecrets()
    const { openBrowser, opened, answers } = browser(openai)
    const auth = authWith(openai, secrets, openBrowser)
    await auth.signIn()

    const params = opened[0].searchParams
    expect(`${opened[0].origin}${opened[0].pathname}`).toBe(`${CHATGPT_ISSUER}/api/accounts/authorize`)
    expect(params.get('client_id')).toBe('dynamic_agent_client')
    expect(params.get('agent_name_hint')).toBe('ASIST')
    expect(params.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(params.get('scope')!.split(' ')).toContain(PLAN_USAGE_SCOPE)
    expect(params.get('resource')).toBe('https://api.openai.com/v1')
    expect(params.get('code_challenge_method')).toBe('S256')
    const redirect = new URL(params.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/auth/callback')

    // The code goes to the registration the callback named, with the verifier whose hash the browser carried.
    const [exchange] = openai.tokenCalls()
    expect(exchange.form.get('grant_type')).toBe('authorization_code')
    expect(exchange.form.get('client_id')).toBe(CLIENT_ID)
    expect(exchange.form.get('redirect_uri')).toBe(params.get('redirect_uri'))
    expect(createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url')).toBe(params.get('code_challenge'))

    expect(auth.signInState()).toBe('signedIn')
    expect(auth.account()).toEqual({ email: 'someone@example.com', clientId: CLIENT_ID })
    await expect(auth.accessToken()).resolves.toBe('access-1')
    expect(secrets.values.get('hostId')).toBe(params.get('ext_agent_host_id'))
    await vi.waitFor(() => expect(answers).toEqual([200]))
  })

  it('signs in again with the saved registration and host id, without registering a second app', async () => {
    const openai = fakeOpenAI([granted()])
    const secrets = memorySecrets({ hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', clientId: CLIENT_ID })
    const { openBrowser, opened } = browser(openai, (authorize) => ({ code: 'code-1', state: authorize.searchParams.get('state')! }))
    await authWith(openai, secrets, openBrowser).signIn()
    expect(opened[0].searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(opened[0].searchParams.has('agent_name_hint')).toBe(false)
    expect(opened[0].searchParams.get('ext_agent_host_id')).toBe('urn:uuid:00000000-0000-4000-8000-000000000000')
  })

  it('refuses a request with another state without ending the sign-in, since any page can reach 127.0.0.1', async () => {
    const openai = fakeOpenAI([granted()])
    const strays: number[] = []
    const openBrowser = vi.fn(async (url: string) => {
      const authorize = new URL(url)
      openai.setNonce(authorize.searchParams.get('nonce')!)
      const callback = new URL(authorize.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ code: 'forged', state: 'not-this-one', client_id: CLIENT_ID }).toString()
      strays.push((await globalThis.fetch(callback)).status)
      callback.search = new URLSearchParams({ code: 'code-1', state: authorize.searchParams.get('state')!, client_id: CLIENT_ID }).toString()
      void globalThis.fetch(callback)
    })
    const auth = authWith(openai, memorySecrets(), openBrowser)
    await auth.signIn()
    expect(strays).toEqual([400])
    expect(openai.tokenCalls().map((call) => call.form.get('code'))).toEqual(['code-1'])
  })

  it('forgets the registration of a sign-in that failed, which may be bound to an account the user did not mean, so the next one registers again', async () => {
    const openai = fakeOpenAI([() => json({ error: 'invalid_grant' }, 400), granted()])
    const secrets = memorySecrets()
    const { openBrowser, opened } = browser(openai)
    const auth = authWith(openai, secrets, openBrowser)
    await expect(auth.signIn()).rejects.toThrow(errorText('settingsIntegrations.chatgpt.errors.signInFailed'))
    expect(secrets.values.has('clientId')).toBe(false)
    await auth.signIn()
    expect(opened.map((url) => url.searchParams.get('client_id'))).toEqual(['dynamic_agent_client', 'dynamic_agent_client'])
  })

  it('refuses a sign-in that did not share the plan, and revokes the grant it got', async () => {
    const openai = fakeOpenAI([granted({ scope: 'openid profile email offline_access' })])
    const secrets = memorySecrets()
    const { openBrowser } = browser(openai)
    await expect(authWith(openai, secrets, openBrowser).signIn()).rejects.toThrow(errorText('settingsIntegrations.chatgpt.errors.planUsageNotGranted'))
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL).map((call) => call.form.get('token'))).toEqual(['refresh-1'])
    expect(secrets.values.has('session')).toBe(false)
  })

  it.each([
    ['signed by a key OpenAI did not publish', (nonce: string) => idToken({ nonce }, strangerKey.privateKey)],
    ['issued for another sign-in', () => idToken({ nonce: 'another-nonce' })],
    ['issued to another client', (nonce: string) => idToken({ nonce, aud: ['oaiapp_other'] })],
    ['from another issuer', (nonce: string) => idToken({ nonce, iss: 'https://example.com' })],
    ['expired', (nonce: string) => idToken({ nonce, exp: Date.now() / 1000 - 600 })]
  ])('refuses an ID token %s', async (_case, token) => {
    const openai = fakeOpenAI([(form, nonce) => granted({ id_token: token(nonce) })(form, nonce)])
    const secrets = memorySecrets()
    const { openBrowser } = browser(openai)
    await expect(authWith(openai, secrets, openBrowser).signIn()).rejects.toThrow(errorText('settingsIntegrations.chatgpt.errors.badIdToken'))
    expect(secrets.values.has('session')).toBe(false)
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL).map((call) => call.form.get('token'))).toEqual(['refresh-1'])
  })

  it('saves nothing and gives the grant back when a sign-out comes while the ID token is checked', async () => {
    const openai = fakeOpenAI([granted()])
    const secrets = memorySecrets()
    const { openBrowser } = browser(openai)
    const auth = authWith(openai, secrets, openBrowser)
    const fetchJwks = openai.fetch
    let signedOut!: Promise<void>
    const deps = auth as unknown as { deps: { fetch: typeof fetch } }
    deps.deps.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input) === CHATGPT_JWKS_URL) signedOut = auth.signOut()
      return fetchJwks(input, init)
    }) as typeof fetch
    await expect(auth.signIn()).rejects.toBeInstanceOf(SignInReplaced)
    await signedOut
    expect(auth.signInState()).toBe('signedOut')
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL).map((call) => call.form.get('token'))).toEqual(['refresh-1'])
  })

  it('takes a response without scope as granting what was asked for', async () => {
    const openai = fakeOpenAI([(form, nonce) => { const response = granted()(form, nonce); return response.json().then((body: Record<string, unknown>) => { delete body.scope; return json(body) }) }])
    const { openBrowser } = browser(openai)
    const auth = authWith(openai, memorySecrets(), openBrowser)
    await auth.signIn()
    expect(auth.signInState()).toBe('signedIn')
  })

  it('replaces a sign-in this build cannot read instead of failing on it', async () => {
    const openai = fakeOpenAI([granted()])
    // Everything saved was encrypted by another build, so reading any of it throws until it is removed.
    const secrets = memorySecrets({ hostId: 'urn:uuid:other-build', clientId: 'oaiapp_other', session: session() })
    const foreign = new Set<ChatGptSecretId>(['hostId', 'clientId', 'session'])
    const { get, set } = secrets
    secrets.get = (id) => {
      if (foreign.has(id)) throw new SecretUnreadableError('foreign')
      return get(id)
    }
    secrets.remove = (id) => {
      foreign.delete(id)
      secrets.values.delete(id)
    }
    secrets.set = (id, secret) => {
      foreign.delete(id)
      set(id, secret)
    }
    secrets.clear = () => {
      foreign.clear()
      secrets.values.clear()
    }
    const { openBrowser, opened } = browser(openai)
    const auth = authWith(openai, secrets, openBrowser)
    expect(auth.signInState()).toBe('unreadable')
    await auth.signIn()
    expect(opened[0].searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(opened[0].searchParams.get('ext_agent_host_id')).not.toBe('urn:uuid:other-build')
    expect(auth.signInState()).toBe('signedIn')
  })

  it('replaces a saved sign-in without revoking it, since under the same registration that could end the new grant too', async () => {
    const openai = fakeOpenAI([granted({ refresh_token: 'refresh-new' })])
    const secrets = memorySecrets({ hostId: 'urn:uuid:x', clientId: CLIENT_ID, session: session() })
    const { openBrowser } = browser(openai, (authorize) => ({ code: 'code-1', state: authorize.searchParams.get('state')! }))
    await authWith(openai, secrets, openBrowser).signIn()
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL)).toEqual([])
    expect(JSON.parse(secrets.values.get('session')!).refreshToken).toBe('refresh-new')
  })

  it('keeps the registration of a session whose refresh failed while a sign-in waited for the browser', async () => {
    let browserBack!: () => void
    const back = new Promise<void>((resolve) => (browserBack = resolve))
    const openai = fakeOpenAI([() => json({ error: 'refresh_token_reused' }, 400), granted()])
    const secrets = memorySecrets({ hostId: 'urn:uuid:x', clientId: CLIENT_ID, session: session() })
    const openBrowser = vi.fn(async (url: string) => {
      const authorize = new URL(url)
      openai.setNonce(authorize.searchParams.get('nonce')!)
      void back.then(() => globalThis.fetch(`${authorize.searchParams.get('redirect_uri')}?code=code-1&state=${authorize.searchParams.get('state')}`))
    })
    const auth = authWith(openai, secrets, openBrowser)
    const signingIn = auth.signIn()
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalled())
    await expect(auth.accessToken()).rejects.toBeInstanceOf(ChatGptSignedOut)
    browserBack()
    await signingIn
    expect(auth.account()).toEqual({ email: 'someone@example.com', clientId: CLIENT_ID })
  })

  it('treats a revocation OpenAI answers with 400 as already done', async () => {
    const openai = fakeOpenAI([])
    const fetchOpenAI = openai.fetch
    const auth = new ChatGptAuth({
      secrets: memorySecrets({ clientId: CLIENT_ID, session: session() }),
      fetch: (async (input: string | URL, init?: RequestInit) =>
        String(input) === CHATGPT_REVOKE_URL ? json({ error: 'invalid_token' }, 400) : fetchOpenAI(input, init)) as typeof fetch,
      openBrowser: async () => undefined,
      page: () => ''
    })
    await expect(auth.signOut()).resolves.toBeUndefined()
    expect(auth.signInState()).toBe('signedOut')
  })

  it('makes the next request renew an access token OpenAI refused before its expiry', async () => {
    const openai = fakeOpenAI([granted({ access_token: 'access-2', refresh_token: 'refresh-2', id_token: idToken({}) })])
    const auth = authWith(openai, memorySecrets({ clientId: CLIENT_ID, session: session({ accessToken: 'access-old', expiresAt: Date.now() + 3_600_000 }) }))
    await expect(auth.accessToken()).resolves.toBe('access-old')
    auth.forgetAccessToken('access-old')
    await expect(auth.accessToken()).resolves.toBe('access-2')
  })

  it('signs out of a file it cannot open by emptying it', async () => {
    const secrets = memorySecrets({ clientId: CLIENT_ID })
    secrets.get = () => {
      throw new Error('chatgpt.json is broken')
    }
    let cleared = false
    secrets.clear = () => void (cleared = true)
    await authWith(fakeOpenAI([]), secrets).signOut()
    expect(cleared).toBe(true)
  })

  it('stops a sign-in that waits for the browser when it is cancelled', async () => {
    const openai = fakeOpenAI([])
    const auth = authWith(openai, memorySecrets())
    const signingIn = auth.signIn()
    await vi.waitFor(() => expect(openai.fetch).not.toHaveBeenCalled())
    auth.cancelSignIn()
    await expect(signingIn).rejects.toBeInstanceOf(SignInReplaced)
    expect(auth.signInState()).toBe('signedOut')
  })
})

describe('the ChatGPT access token', () => {
  it('is renewed once for callers that ask at the same time, and the rotated refresh token is saved before it is handed out', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const openai = fakeOpenAI([
      async () => {
        await held
        return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', id_token: idToken({}), scope: SCOPE })
      }
    ])
    const secrets = memorySecrets({ clientId: CLIENT_ID, session: session() })
    const auth = authWith(openai, secrets)
    const tokens = Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])
    release()
    await expect(tokens).resolves.toEqual(['access-2', 'access-2', 'access-2'])
    const [refresh] = openai.tokenCalls()
    expect(openai.tokenCalls()).toHaveLength(1)
    expect(refresh.form.get('grant_type')).toBe('refresh_token')
    expect(refresh.form.get('refresh_token')).toBe('refresh-old')
    expect(refresh.form.get('client_id')).toBe(CLIENT_ID)
    expect(JSON.parse(secrets.values.get('session')!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', subject: 'user-1' })
    await expect(auth.accessToken()).resolves.toBe('access-2')
    expect(openai.tokenCalls()).toHaveLength(1)
  })

  it('lets a caller stop waiting for a refresh, which still runs to its end and saves the rotated token', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const openai = fakeOpenAI([
      async () => {
        await held
        return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', id_token: idToken({}), scope: SCOPE })
      }
    ])
    const secrets = memorySecrets({ clientId: CLIENT_ID, session: session() })
    const auth = authWith(openai, secrets)
    const caller = new AbortController()
    const waiting = auth.accessToken(caller.signal)
    caller.abort(new Error('barge-in'))
    await expect(waiting).rejects.toThrow('barge-in')
    release()
    await vi.waitFor(() => expect(JSON.parse(secrets.values.get('session')!).refreshToken).toBe('refresh-2'))
  })

  it('keeps the rotated refresh token even when checking the new ID token fails afterwards', async () => {
    const openai = fakeOpenAI([() => json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', id_token: idToken({}, strangerKey.privateKey), scope: SCOPE })])
    const secrets = memorySecrets({ clientId: CLIENT_ID, session: session() })
    await expect(authWith(openai, secrets).accessToken()).rejects.toThrow(errorText('settingsIntegrations.chatgpt.errors.badIdToken'))
    expect(JSON.parse(secrets.values.get('session')!).refreshToken).toBe('refresh-2')
  })

  it('signs out when the refresh token is reused or revoked, without trying any other credential, and forgets the registration with it', async () => {
    const openai = fakeOpenAI([() => json({ error: 'refresh_token_reused' }, 400)])
    const secrets = memorySecrets({ clientId: CLIENT_ID, session: session() })
    const auth = authWith(openai, secrets)
    await expect(auth.accessToken()).rejects.toBeInstanceOf(ChatGptSignedOut)
    expect(auth.signInState()).toBe('signedOut')
    expect(secrets.values.has('clientId')).toBe(false)
    await expect(auth.accessToken()).rejects.toBeInstanceOf(ChatGptSignedOut)
    expect(openai.tokenCalls()).toHaveLength(1)
  })

  it('keeps the session through a refresh that fails on the server, so the next request can try again', async () => {
    const openai = fakeOpenAI([() => json({ error: 'server_error' }, 503), granted({ access_token: 'access-2', refresh_token: 'refresh-2', id_token: idToken({}) })])
    const auth = authWith(openai, memorySecrets({ clientId: CLIENT_ID, session: session() }))
    await expect(auth.accessToken()).rejects.toThrow(errorText('settingsIntegrations.chatgpt.errors.requestFailed', { status: 503 }))
    expect(auth.signInState()).toBe('signedIn')
    await expect(auth.accessToken()).resolves.toBe('access-2')
  })

  it('is not brought back by a refresh that was on its way when the user signed out, whose new grant is given back', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const openai = fakeOpenAI([
      async () => {
        await held
        return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', id_token: idToken({}), scope: SCOPE })
      }
    ])
    const secrets = memorySecrets({ clientId: CLIENT_ID, session: session() })
    const auth = authWith(openai, secrets)
    const token = auth.accessToken()
    await vi.waitFor(() => expect(openai.tokenCalls()).toHaveLength(1))
    await auth.signOut()
    release()
    await expect(token).rejects.toBeInstanceOf(ChatGptSignedOut)
    expect(auth.signInState()).toBe('signedOut')
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL).map((call) => call.form.get('token'))).toEqual(['refresh-old', 'refresh-2'])
  })

  it('reads a file that cannot be opened as unreadable rather than failing every status read', () => {
    const secrets = memorySecrets()
    secrets.get = () => {
      throw new Error('chatgpt.json is broken')
    }
    expect(authWith(fakeOpenAI([]), secrets).signInState()).toBe('unreadable')
  })

  it('reads a session it cannot parse as unreadable, which a sign-out clears, rather than as a sign-in that fails on every request', async () => {
    const auth = authWith(fakeOpenAI([]), memorySecrets({ clientId: CLIENT_ID, session: '{"subject":"user-1"}' }))
    expect(auth.signInState()).toBe('unreadable')
    await auth.signOut()
    expect(auth.signInState()).toBe('signedOut')
  })

  it('is no longer handed out after a sign-out, which revokes the refresh token and forgets the registration, since the next sign-in may be another account', async () => {
    const openai = fakeOpenAI([])
    const secrets = memorySecrets({ clientId: CLIENT_ID, hostId: 'urn:uuid:x', session: session({ expiresAt: Date.now() + 3_600_000 }) })
    const auth = authWith(openai, secrets)
    await auth.signOut()
    const [revoke] = openai.calls
    expect(revoke.url).toBe(CHATGPT_REVOKE_URL)
    expect(Object.fromEntries(revoke.form)).toEqual({ token: 'refresh-old', token_type_hint: 'refresh_token', client_id: CLIENT_ID })
    await expect(auth.accessToken()).rejects.toBeInstanceOf(ChatGptSignedOut)
    expect([...secrets.values.keys()]).toEqual(['hostId'])
  })
})
