import { APIError } from 'openai'
import { statusError } from './adapter'

/** The failures of a stream read through the openai package, which the OpenAI and the Cerebras adapters both use. */

/**
 * The ChatGPT plan's two failures that can arrive after a stream has begun take the status the same
 * failure gets before it: the usage limit 429 and the plan being unavailable 503.
 */
const STREAM_FAILURE_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  server_error: 500,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503
}

/**
 * A failure the server reports inside a stream carries a code, or only a type, but no HTTP status, so it
 * is given the status a request failing the same way would get, which is what tells a transient failure
 * apart.
 */
export function streamFailure(provider: string, reason: string | null | undefined, message: string | undefined): Error {
  const status = STREAM_FAILURE_STATUS[reason ?? ''] ?? 400
  return statusError(status, `${provider}: ${reason ?? 'failed'}: ${message ?? 'the response failed'}`)
}

/**
 * The events of a stream. The openai package raises an error the server sends inside the stream, as an
 * `error` event or as a chunk carrying `error`, itself as an APIError without a status before the reader
 * sees it (openai/core/streaming.js), so it becomes a failure with a status here.
 */
export async function* streamEvents<Event>(provider: string, stream: AsyncIterable<Event>): AsyncGenerator<Event> {
  try {
    yield* stream
  } catch (error) {
    if (error instanceof APIError && error.status === undefined && error.error !== undefined) {
      throw streamFailure(provider, error.code ?? error.type, error.message)
    }
    throw error
  }
}
