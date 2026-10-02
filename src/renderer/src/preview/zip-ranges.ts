import { errorKey } from '@shared/i18n/error-key'
import { fetchRange, loadFailed } from './fetch-range'

/**
 * A zip container (docx, xlsx, pptx) read by HTTP ranges, so that a viewer reads the directory and the entries
 * it shows and never the rest of the file. It runs in the preview iframe, with nothing but what a browser page
 * has, and throws its errors as keys, since the iframe does not load the dictionary. The layout follows
 * PKWARE's APPNOTE: the end of central directory record at the end of the file, the ZIP64 records in front of it
 * when a count, a size or an offset does not fit in its field, the central directory, and each entry's local
 * header in front of its data.
 */

type Bytes = Uint8Array<ArrayBuffer>

/** One file inside the zip, as the central directory describes it before any of its bytes are read. */
export interface ZipEntry {
  readonly name: string
  /** The size of the content, which a viewer compares with its limit before it reads the entry. */
  readonly size: number
  readonly compressedSize: number
}

interface CentralRecord extends ZipEntry {
  readonly rawName: Bytes
  readonly versionMadeBy: number
  readonly flags: number
  readonly method: number
  readonly time: number
  readonly date: number
  readonly crc32: number
  readonly internalAttributes: number
  readonly externalAttributes: number
  /** Where the entry's local header starts in the file. */
  readonly offset: number
  /** Where the next entry, or the central directory, starts. The entry's local record never runs past it. */
  readonly end: number
}

export interface RangedZip {
  readonly entries: ReadonlyMap<string, ZipEntry>
  /** The content of one entry, inflated. */
  read(name: string): Promise<Bytes>
  /**
   * The same container with each entry `stub` chooses replaced by a stored entry whose content is its own path,
   * so that a library reading the container meets the entry without its bytes being read, and the path tells
   * the caller which entry to read later.
   */
  slimmed(stub: (name: string) => boolean): Promise<Bytes>
}

const LOCAL_SIGNATURE = 0x04034b50
const LOCAL_LENGTH = 30
const CENTRAL_SIGNATURE = 0x02014b50
const CENTRAL_LENGTH = 46
const END_SIGNATURE = 0x06054b50
const END_LENGTH = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_END_LENGTH = 56
const ZIP64_EXTRA_ID = 0x0001
/** The value a field of 16 or 32 bits holds when the real one is in the ZIP64 records. */
const U16_FULL = 0xffff
const U32_FULL = 0xffffffff
const STORED = 0
const DEFLATED = 8
const FLAG_ENCRYPTED = 0x1
const FLAG_DATA_DESCRIPTOR = 0x8
const FLAG_UTF8 = 0x800
/** The version of the format a reader needs for a stored or deflated entry without ZIP64. */
const VERSION_NEEDED = 20
/** The end of central directory record with the longest comment, and the ZIP64 locator in front of it. */
const TAIL_LENGTH = END_LENGTH + U16_FULL + ZIP64_LOCATOR_LENGTH

const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))
const changed = (): Error => new Error(errorKey('files.errors.changedWhileReading'))

const viewOf = (bytes: Bytes): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A 64-bit field. It holds a size or an offset, so a value past Number's exact integers is no real one. */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged()
  return Number(value)
}

/**
 * Where the end of central directory record starts in the tail: the last signature whose comment fits before
 * the end of the file. Bytes may follow the comment, as a newline does after some exports, which JSZip and
 * SheetJS read past as well.
 */
function findEnd(tail: Bytes): number {
  const view = viewOf(tail)
  for (let at = tail.length - END_LENGTH; at >= 0; at--) {
    if (view.getUint32(at, true) === END_SIGNATURE && at + END_LENGTH + view.getUint16(at + 20, true) <= tail.length) return at
  }
  throw damaged()
}

/** The values of the ZIP64 extended information field, which stand in for the fields that hold U32_FULL. */
function zip64Values(extra: Bytes, wanted: number): number[] {
  const view = viewOf(extra)
  for (let at = 0; at + 4 <= extra.length; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) !== ZIP64_EXTRA_ID) continue
    if (view.getUint16(at + 2, true) < wanted * 8 || at + 4 + wanted * 8 > extra.length) throw damaged()
    return Array.from({ length: wanted }, (_, i) => u64(view, at + 4 + i * 8))
  }
  throw damaged()
}

/** The central directory's records. `shift` is how far into the file the zip starts, which every offset is counted from. */
function parseCentral(directory: Bytes, count: number, directoryStart: number, shift: number): CentralRecord[] {
  const view = viewOf(directory)
  const decoder = new TextDecoder()
  const parsed: Array<Omit<CentralRecord, 'end'>> = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_LENGTH > directory.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw damaged()
    const nameEnd = at + CENTRAL_LENGTH + view.getUint16(at + 28, true)
    const extraEnd = nameEnd + view.getUint16(at + 30, true)
    const next = extraEnd + view.getUint16(at + 32, true)
    if (next > directory.length) throw damaged()
    // The ZIP64 field carries, in this order, only the values whose own field is full.
    let size = view.getUint32(at + 24, true)
    let compressedSize = view.getUint32(at + 20, true)
    let offset = view.getUint32(at + 42, true)
    const full = [size, compressedSize, offset].filter((value) => value === U32_FULL).length
    if (full > 0) {
      const values = zip64Values(directory.subarray(nameEnd, extraEnd), full)
      if (size === U32_FULL) size = values.shift()!
      if (compressedSize === U32_FULL) compressedSize = values.shift()!
      if (offset === U32_FULL) offset = values.shift()!
    }
    const rawName = directory.slice(at + CENTRAL_LENGTH, nameEnd)
    parsed.push({
      name: decoder.decode(rawName),
      rawName,
      size,
      compressedSize,
      versionMadeBy: view.getUint16(at + 4, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc32: view.getUint32(at + 16, true),
      internalAttributes: view.getUint16(at + 36, true),
      externalAttributes: view.getUint32(at + 38, true),
      offset: offset + shift
    })
    at = next
  }
  const starts = [...new Set(parsed.map((record) => record.offset)), directoryStart].sort((a, b) => a - b)
  return parsed.map((record) => {
    const end = starts.find((start) => start > record.offset)
    if (end === undefined || end > directoryStart || end - record.offset < LOCAL_LENGTH + record.compressedSize) throw damaged()
    return { ...record, end }
  })
}

/** The compressed data inside the bytes of an entry's local record. */
function dataOf(record: CentralRecord, local: Bytes): Bytes {
  const view = viewOf(local)
  if (local.length < LOCAL_LENGTH || view.getUint32(0, true) !== LOCAL_SIGNATURE) throw damaged()
  // The local extra field can differ from the central one: Excel writes a ZIP64 field in the local header alone.
  const start = LOCAL_LENGTH + view.getUint16(26, true) + view.getUint16(28, true)
  if (start + record.compressedSize > local.length) throw damaged()
  return local.subarray(start, start + record.compressedSize)
}

/**
 * Inflates into the size the central directory declares, which the caller has compared with its limit, and stops
 * at the first byte past it, so that data inflating beyond its declared size takes no more memory than that.
 */
async function inflate(data: Bytes, size: number): Promise<Bytes> {
  const out = new Uint8Array(size)
  // A writer can store an empty file as deflated with no bytes at all, which is no deflate stream and which
  // DecompressionStream refuses; JSZip reads it as empty, and so does this.
  if (data.length === 0 && size === 0) return out
  let filled = 0
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  for (;;) {
    // The stream fails on data that is not deflate, or that ends before its last block.
    const chunk = await reader.read().catch(() => null)
    if (chunk === null) throw damaged()
    if (chunk.done) break
    if (filled + chunk.value.length > size) {
      await reader.cancel()
      throw damaged()
    }
    out.set(chunk.value, filled)
    filled += chunk.value.length
  }
  if (filled !== size) throw damaged()
  return out
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Bytes): number {
  let crc = U32_FULL
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ U32_FULL) >>> 0
}

/** An entry of the slimmed zip: what its headers say, and the data that follows its local header. */
interface Written {
  record: CentralRecord
  flags: number
  method: number
  crc32: number
  size: number
  data: Bytes
}

/**
 * Writes the entries as a plain zip, with no extra fields, data descriptors or ZIP64 records, which a container
 * without its pictures does not need. One that would need them, for a count, an offset or the size of an entry,
 * is refused rather than written with fields that overflow.
 */
function writeZip(written: Written[]): Bytes {
  const localLength = written.reduce((sum, { record, data }) => sum + LOCAL_LENGTH + record.rawName.length + data.length, 0)
  const centralLength = written.reduce((sum, { record }) => sum + CENTRAL_LENGTH + record.rawName.length, 0)
  const total = localLength + centralLength + END_LENGTH
  if (written.length >= U16_FULL || total >= U32_FULL || written.some(({ size }) => size >= U32_FULL)) {
    throw new Error(errorKey('files.viewer.tooLarge'))
  }
  const out = new Uint8Array(total)
  const view = viewOf(out)
  const offsets: number[] = []
  let at = 0
  for (const { record, flags, method, crc32, size, data } of written) {
    offsets.push(at)
    view.setUint32(at, LOCAL_SIGNATURE, true)
    view.setUint16(at + 4, VERSION_NEEDED, true)
    view.setUint16(at + 6, flags, true)
    view.setUint16(at + 8, method, true)
    view.setUint16(at + 10, record.time, true)
    view.setUint16(at + 12, record.date, true)
    view.setUint32(at + 14, crc32, true)
    view.setUint32(at + 18, data.length, true)
    view.setUint32(at + 22, size, true)
    view.setUint16(at + 26, record.rawName.length, true)
    out.set(record.rawName, at + LOCAL_LENGTH)
    out.set(data, at + LOCAL_LENGTH + record.rawName.length)
    at += LOCAL_LENGTH + record.rawName.length + data.length
  }
  written.forEach(({ record, flags, method, crc32, size, data }, i) => {
    view.setUint32(at, CENTRAL_SIGNATURE, true)
    view.setUint16(at + 4, record.versionMadeBy, true)
    view.setUint16(at + 6, VERSION_NEEDED, true)
    view.setUint16(at + 8, flags, true)
    view.setUint16(at + 10, method, true)
    view.setUint16(at + 12, record.time, true)
    view.setUint16(at + 14, record.date, true)
    view.setUint32(at + 16, crc32, true)
    view.setUint32(at + 20, data.length, true)
    view.setUint32(at + 24, size, true)
    view.setUint16(at + 28, record.rawName.length, true)
    view.setUint16(at + 36, record.internalAttributes, true)
    view.setUint32(at + 38, record.externalAttributes, true)
    view.setUint32(at + 42, offsets[i], true)
    out.set(record.rawName, at + CENTRAL_LENGTH)
    at += CENTRAL_LENGTH + record.rawName.length
  })
  view.setUint32(at, END_SIGNATURE, true)
  view.setUint16(at + 8, written.length, true)
  view.setUint16(at + 10, written.length, true)
  view.setUint32(at + 12, centralLength, true)
  view.setUint32(at + 16, localLength, true)
  return out
}

/**
 * Opens the zip at url. It reads the last 64 KB by a suffix range, whose answer gives the file's length as it is
 * now, so a file saved again since it was listed is read as it is. Those bytes hold the end of central directory
 * record whatever its comment, and they are kept, so the part of the central directory or an entry inside them is
 * not read again. Every later answer has to come from a file of the same length.
 */
export async function openZip(url: string): Promise<RangedZip> {
  const tail = await fetchRange(url, `bytes=-${TAIL_LENGTH}`)
  // A suffix range holds no byte of an empty file alone.
  if (!tail) throw damaged()
  const { size, start: tailStart } = tail
  // A server that does not take a suffix range, such as Vite's for a file over 64 KB, sends other bytes.
  if (tailStart !== Math.max(0, size - TAIL_LENGTH) || tail.bytes.length !== size - tailStart) throw loadFailed(206)
  const fetchBytes = async (start: number, end: number): Promise<Bytes> => {
    if (start === end) return new Uint8Array(0)
    const answer = await fetchRange(url, `bytes=${start}-${end - 1}`)
    if (!answer || answer.size !== size || answer.start !== start || answer.bytes.length !== end - start) throw changed()
    return answer.bytes
  }
  const bytes = async (start: number, end: number): Promise<Bytes> => {
    if (start >= tailStart) return tail.bytes.subarray(start - tailStart, end - tailStart)
    if (end <= tailStart) return fetchBytes(start, end)
    const joined = new Uint8Array(end - start)
    joined.set(await fetchBytes(start, tailStart))
    joined.set(tail.bytes.subarray(0, end - tailStart), tailStart - start)
    return joined
  }

  const endAt = findEnd(tail.bytes)
  const endRecord = viewOf(tail.bytes.subarray(endAt))
  let count = endRecord.getUint16(10, true)
  let directoryLength = endRecord.getUint32(12, true)
  let directoryOffset = endRecord.getUint32(16, true)
  // The central directory ends where the records after it start: the ZIP64 end record or the end record.
  let directoryEnd = tailStart + endAt
  const locatorAt = endAt - ZIP64_LOCATOR_LENGTH
  if (locatorAt >= 0 && viewOf(tail.bytes.subarray(locatorAt)).getUint32(0, true) === ZIP64_LOCATOR_SIGNATURE) {
    // The ZIP64 end record ends where its locator starts, and is 56 bytes long without the extensible data that
    // only PKWARE's strong encryption writes, which this does not read. Its place is taken from there rather
    // than from the locator's offset, which bytes in front of the zip would move.
    const zip64At = tailStart + locatorAt - ZIP64_END_LENGTH
    if (zip64At < 0) throw damaged()
    const zip64 = viewOf(await bytes(zip64At, zip64At + ZIP64_END_LENGTH))
    if (zip64.getUint32(0, true) !== ZIP64_END_SIGNATURE) throw damaged()
    count = u64(zip64, 32)
    directoryLength = u64(zip64, 40)
    directoryOffset = u64(zip64, 48)
    directoryEnd = zip64At
  } else if (count === U16_FULL || directoryLength === U32_FULL || directoryOffset === U32_FULL) {
    throw damaged()
  }
  // Offsets count from the start of the zip, and bytes in front of it, such as a newline an export wrote first,
  // move every one by the same distance: the one between where the central directory is and where it is said to be.
  const directoryStart = directoryEnd - directoryLength
  const shift = directoryStart - directoryOffset
  if (shift < 0) throw damaged()
  const records = parseCentral(await bytes(directoryStart, directoryEnd), count, directoryStart, shift)
  const byName = new Map(records.map((record) => [record.name, record]))

  return {
    entries: byName,

    async read(name) {
      const record = byName.get(name)
      if (!record) throw new Error(errorKey('files.errors.zipEntryMissing', { path: name }))
      if (record.flags & FLAG_ENCRYPTED || (record.method !== STORED && record.method !== DEFLATED)) {
        throw new Error(errorKey('files.errors.zipEntryUnsupported', { path: name }))
      }
      const data = dataOf(record, await bytes(record.offset, record.end))
      if (record.method === DEFLATED) return inflate(data, record.size)
      if (data.length !== record.size) throw damaged()
      // A copy, because the data can be a view of the kept tail, which a caller could transfer away.
      return data.slice()
    },

    async slimmed(stub) {
      const ordered = [...records].sort((a, b) => a.offset - b.offset)
      // The kept entries that lie next to each other in the file are read in one range.
      const runs: CentralRecord[][] = []
      let previousKept = false
      for (const record of ordered) {
        const keep = !stub(record.name)
        if (keep && previousKept) runs.at(-1)!.push(record)
        else if (keep) runs.push([record])
        previousKept = keep
      }
      const kept = new Map<CentralRecord, Bytes>()
      await Promise.all(
        runs.map(async (run) => {
          const first = run[0].offset
          const read = await bytes(first, run.at(-1)!.end)
          for (const record of run) kept.set(record, dataOf(record, read.subarray(record.offset - first, record.end - first)))
        })
      )
      const encoder = new TextEncoder()
      return writeZip(
        ordered.map((record): Written => {
          const data = kept.get(record)
          if (data) return { record, flags: record.flags & ~FLAG_DATA_DESCRIPTOR, method: record.method, crc32: record.crc32, size: record.size, data }
          const path = encoder.encode(record.name)
          return { record, flags: record.flags & FLAG_UTF8, method: STORED, crc32: crc32(path), size: path.length, data: path }
        })
      )
    }
  }
}
