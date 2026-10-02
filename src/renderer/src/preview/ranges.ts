import { errorKey } from '@shared/i18n/error-key'

/**
 * Reading a file of the user's by HTTP ranges, as the viewers that read only what they show do: the zip reader of
 * the Office files and pdf.js. It runs in the preview iframe and throws its errors as keys.
 */

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
 * unread, and null stands for it.
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

/**
 * The bytes from start up to end of a file that was `size` bytes long when it was first read. An answer from a
 * file of another length, or with other bytes than those asked for, means the file was written again meanwhile,
 * and the bytes read before no longer belong with these.
 */
export async function readRange(url: string, start: number, end: number, size: number, signal?: AbortSignal): Promise<Bytes> {
  if (start === end) return new Uint8Array(0)
  const answer = await fetchRange(url, `bytes=${start}-${end - 1}`, signal)
  if (!answer || answer.size !== size || answer.start !== start || answer.bytes.length !== end - start) {
    throw new Error(errorKey('files.errors.changedWhileReading'))
  }
  return answer.bytes
}
