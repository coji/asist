import Anthropic from '@anthropic-ai/sdk'
import { ApiError as GoogleApiError } from '@google/genai'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { apiErrorKey, isTransientApiError } from '@shared/api-errors'

/** An in-band SSE error as it was actually observed: it arrives as an APIError whose status is undefined. */
const IN_BAND_529 = new Error(
  '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cd6FbJx"}'
)

const apiError = (status: number, message: string, errType = 'invalid_request_error'): Anthropic.APIError =>
  new Anthropic.APIError(status, { type: 'error', error: { type: errType, message } }, message, undefined)

describe('isTransientApiError', () => {
  it('treats an in-band SSE 529, whose message is raw JSON, as transient', () => {
    expect(isTransientApiError(IN_BAND_529)).toBe(true)
  })
  it('treats the HTTP statuses 429, 5xx and 529 as transient', () => {
    expect(isTransientApiError(apiError(529, 'Overloaded'))).toBe(true)
    expect(isTransientApiError(apiError(500, 'Internal'))).toBe(true)
    expect(isTransientApiError(apiError(429, 'rate limited'))).toBe(true)
  })
  it('treats a lost connection such as fetch failed, ECONNREFUSED or ETIMEDOUT as transient', () => {
    expect(isTransientApiError(new Error('fetch failed'))).toBe(true)
    expect(isTransientApiError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true)
    expect(isTransientApiError(new Error('connect ETIMEDOUT'))).toBe(true)
  })
  it('treats a socket cut during the response as transient, which the SDK wraps as terminated with the original error in cause', () => {
    const socketError = new Error('other side closed')
    const terminated = new Anthropic.AnthropicError('terminated')
    ;(terminated as Error & { cause?: unknown }).cause = socketError
    expect(isTransientApiError(terminated)).toBe(true)
    expect(isTransientApiError(new Error('socket hang up'))).toBe(true)
    expect(isTransientApiError(new Error('read ECONNRESET'))).toBe(true)
    expect(apiErrorKey(terminated)).toBe('conversation.reply.network')
  })
  it('treats an SDK connection error, whose text is only "Connection error.", and a 5xx from the OpenAI and Google SDKs as transient', () => {
    for (const error of [
      new Anthropic.APIConnectionError({ message: 'Connection error.' }),
      new OpenAI.APIConnectionError({ message: 'Connection error.' }),
      new OpenAI.APIConnectionTimeoutError()
    ]) {
      expect(isTransientApiError(error)).toBe(true)
      expect(apiErrorKey(error)).toBe('conversation.reply.network')
    }
    expect(isTransientApiError(new OpenAI.APIError(503, undefined, 'unavailable', undefined))).toBe(true)
    expect(isTransientApiError(new GoogleApiError({ status: 503, message: 'The model is overloaded.' }))).toBe(true)
    expect(isTransientApiError(new GoogleApiError({ status: 400, message: 'invalid argument' }))).toBe(false)
  })
  it('does not treat authentication and validation errors as transient', () => {
    expect(isTransientApiError(apiError(401, 'invalid x-api-key', 'authentication_error'))).toBe(false)
    expect(isTransientApiError(apiError(400, 'max_tokens required'))).toBe(false)
    expect(isTransientApiError(new Error('something else'))).toBe(false)
  })
})

describe('apiErrorKey', () => {
  it('names the sentence about a busy service when the API is overloaded', () => {
    expect(apiErrorKey(IN_BAND_529)).toBe('conversation.reply.overloaded')
    expect(apiErrorKey(apiError(529, 'Overloaded'))).toBe('conversation.reply.overloaded')
  })
  it('names the usage limit for 429, the API key for 401 and the network for a lost connection', () => {
    expect(apiErrorKey(apiError(429, 'x', 'rate_limit_error'))).toBe('conversation.reply.rateLimit')
    expect(apiErrorKey(apiError(401, 'invalid x-api-key', 'authentication_error'))).toBe('conversation.reply.authentication')
    expect(apiErrorKey(new Error('fetch failed'))).toBe('conversation.reply.network')
  })
  it('names one sentence for an unknown error, so that its raw text never reaches the user', () => {
    expect(apiErrorKey(new Error('boom'))).toBe('conversation.reply.failed')
    expect(createTranslator('ja-JP')(apiErrorKey(new Error('boom')))).not.toContain('boom')
  })
})

describe('a ChatGPT sign-in that cannot be used', () => {
  it('is said as a sign-in to make again, not as an API key to check', async () => {
    const { errorText } = await import('../src/shared/i18n/error-text')
    const rejected = Object.assign(new Error(errorText('settingsIntegrations.chatgpt.errors.rejected')), { status: 401 })
    expect(apiErrorKey(rejected)).toBe('conversation.reply.chatgptSignIn')
    expect(apiErrorKey(new Error(errorText('settingsIntegrations.chatgpt.errors.signedOut')))).toBe('conversation.reply.chatgptSignIn')
  })
})

describe('the usage limit of a ChatGPT plan', () => {
  const beforeStream = Object.assign(new Error('429 You have reached your usage limit'), { status: 429, code: 'subscription_sharing_usage_limit_exceeded' })
  const insideStream = Object.assign(new Error('OpenAI: subscription_sharing_usage_limit_exceeded: limit'), { status: 429 })

  it('is not retried, since it lasts hours rather than seconds', () => {
    expect(isTransientApiError(beforeStream)).toBe(false)
    expect(isTransientApiError(insideStream)).toBe(false)
  })

  it('is said as the plan limit rather than as a rate limit of the API', () => {
    expect(apiErrorKey(beforeStream)).toBe('conversation.reply.planLimit')
    expect(apiErrorKey(insideStream)).toBe('conversation.reply.planLimit')
  })
})
