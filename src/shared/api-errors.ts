import type { MessageKey } from './i18n'

/**
 * Classifies LLM API errors for the brain (retry decisions) and the UI (user-facing messages). It
 * depends on no SDK type: the Anthropic, OpenAI and Google SDKs all expose the HTTP status as `status`,
 * and connection errors are recognized by class name.
 */

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Joins the messages along the `cause` chain. The SDKs wrap a mid-stream disconnect in a 'terminated'
 * error whose cause is the original SocketError ('other side closed').
 */
function errMessageChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    parts.push(errMessage(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' <- ')
}

/** Message fragments of undici and Node socket errors that mean a failed or dropped connection. */
const CONNECTION_FAILURE =
  /fetch failed|ECONN|ETIMEDOUT|EPIPE|ENETDOWN|ENETUNREACH|EAI_AGAIN|timeout|timed out|aborted|terminated|other side closed|socket hang up|premature close|network error/i

const httpStatus = (err: unknown): number | undefined =>
  err && typeof err === 'object' && 'status' in err && typeof err.status === 'number' ? err.status : undefined
/** Connection errors of the Anthropic and OpenAI SDKs. Their `name` stays 'Error', so the class name is the only marker; the timeout error is a subclass. */
const isConnectionError = (err: unknown): boolean =>
  err instanceof Error && /^APIConnection(Timeout)?Error$/.test(err.constructor.name)

const PLAN_USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded'

/**
 * A ChatGPT sign-in that is missing or that OpenAI refused, which a new sign-in mends rather than a check of
 * an API key. Its message carries the key of the sign-in's error text.
 */
export const isChatGptSignInFailure = (err: unknown): boolean => /settingsIntegrations\.chatgpt\.errors\.(signedOut|rejected|unreadable)\b/.test(errMessageChain(err))

/**
 * The usage limit of a ChatGPT plan, which OpenAI sends as a 429 like a rate limit but which lasts hours, so
 * waiting a few seconds never clears it.
 */
export function isPlanUsageLimit(err: unknown): boolean {
  // Before the stream opens the OpenAI package keeps the code on the error, not in its message; inside the
  // stream the adapter writes it into the message.
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
  return code === PLAN_USAGE_LIMIT || errMessageChain(err).includes(PLAN_USAGE_LIMIT)
}

/**
 * Whether the error is transient and worth a retry: overload, rate limit, 5xx, or a failed or dropped
 * connection. An error event that arrives over SSE after the stream is established has no status, so
 * the message text is checked as well.
 */
export function isTransientApiError(err: unknown): boolean {
  if (isPlanUsageLimit(err)) return false
  if (isConnectionError(err)) return true
  const status = httpStatus(err) ?? 0
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true
  const message = errMessageChain(err)
  return (
    /overloaded|rate.?limit|"type"\s*:\s*"(overloaded_error|api_error)"/i.test(message) ||
    CONNECTION_FAILURE.test(message)
  )
}

/**
 * The key of the sentence the assistant says when a call fails. This module holds no interface text,
 * so the caller, which knows the interface language, turns the key into the sentence. Raw error JSON
 * never reaches the user.
 */
export type ApiErrorKey = Extract<MessageKey, `conversation.reply.${string}`>

export function apiErrorKey(err: unknown): ApiErrorKey {
  const msg = errMessage(err)
  const status = httpStatus(err)
  if (isPlanUsageLimit(err)) return 'conversation.reply.planLimit'
  if (isChatGptSignInFailure(err)) return 'conversation.reply.chatgptSignIn'
  if (status === 529 || /overloaded/i.test(msg)) return 'conversation.reply.overloaded'
  if (status === 429 || /rate.?limit/i.test(msg)) return 'conversation.reply.rateLimit'
  if (status === 401 || status === 403 || /authentication|invalid.*api.?key/i.test(msg)) return 'conversation.reply.authentication'
  if (
    isConnectionError(err) ||
    /network/i.test(msg) ||
    CONNECTION_FAILURE.test(errMessageChain(err)) ||
    (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'))
  )
    return 'conversation.reply.network'
  return 'conversation.reply.failed'
}
