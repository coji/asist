import type { VapState } from './ipc'

/**
 * The stdout protocol of the turn-taking worker, resources/vap_worker.py. One line is one message, and
 * only the JSON that follows `ASIST_JSON:` is interpreted; every other log line is ignored.
 */

export const VAP_PROTOCOL_PREFIX = 'ASIST_JSON:'

export type VapWorkerMessage =
  | { type: 'ready'; device: string; frameHz: number }
  | { type: 'state'; state: VapState }
  | { type: 'fatal'; error: string }

const number = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Returns null for a line without the prefix, with invalid JSON, or with an unknown type. */
export function parseVapWorkerLine(line: string): VapWorkerMessage | null {
  const marker = line.indexOf(VAP_PROTOCOL_PREFIX)
  if (marker < 0) return null
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line.slice(marker + VAP_PROTOCOL_PREFIX.length))
  } catch {
    return null
  }
  if (typeof message !== 'object' || message === null) return null
  switch (message.type) {
    case 'ready':
      return {
        type: 'ready',
        device: String(message.device ?? 'unknown'),
        frameHz: number(message.frameHz)
      }
    case 'fatal':
      return { type: 'fatal', error: String(message.error ?? 'unknown') }
    case 'state':
      return {
        type: 'state',
        state: {
          t: number(message.t),
          pNowUser: number(message.pNowUser),
          pNowAssistant: number(message.pNowAssistant),
          pFutureUser: number(message.pFutureUser),
          pFutureAssistant: number(message.pFutureAssistant),
          eotUser: number(message.eotUser),
          bcDetUser: number(message.bcDetUser),
          bcReact: number(message.bcReact),
          bcEmo: number(message.bcEmo),
          nodShort: number(message.nodShort),
          nodLong: number(message.nodLong),
          inferMs: number(message.inferMs),
          turnLagMs: number(message.turnLagMs),
          backchannelLagMs: number(message.backchannelLagMs)
        }
      }
    default:
      return null
  }
}
