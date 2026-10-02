import { errorKey } from '@shared/i18n/error-key'

export type Bytes = Uint8Array<ArrayBuffer>

export const loadFailed = (status: number): Error => new Error(errorKey('files.errors.loadFailed', { status }))

/** The bytes of an answer to a Range request, where they start in the file, and how long the file is now. */
export interface RangeAnswer {
  bytes: Bytes
  start: number
  size: number
}

/**
 * Asks for a range of the file, and reads from the answer's Content-Range which bytes it holds and the file's
 * length. asist-file answers a range that holds no byte of the file with a 200 and the whole file, which is left
 * unread, and null stands for it. A signal that aborts stops the request.
 */
export async function fetchRange(url: string, range: string, signal?: AbortSignal): Promise<RangeAnswer | null> {
  const response = await fetch(url, { headers: { Range: range }, signal })
  if (!response.ok) throw loadFailed(response.status)
  const answered = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  if (response.status !== 206 || !answered) {
    await response.body?.cancel()
    // A 206 always names its range, so one whose Content-Range cannot be read is not an answer this can use.
    if (response.status === 206) throw loadFailed(response.status)
    return null
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), start: Number(answered[1]), size: Number(answered[2]) }
}
