import { createCipheriv } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'
import { random, sentence } from './text.mjs'

/**
 * Writes a zip one entry at a time, which is what docx, pptx and xlsx are, with Node's own deflate: JSZip would
 * hold a whole 146 MB deck in memory twice and deflate it in JavaScript. Every entry is deflated as Office does,
 * unless it asks to be stored. Names are UTF-8, and no file here reaches the 4 GB that would need ZIP64.
 */
export function zipWriter(file) {
  const fd = openSync(file, 'w')
  const central = []
  let offset = 0
  const write = (buffer) => {
    writeSync(fd, buffer)
    offset += buffer.length
  }
  // 2026-01-01 00:00 in MS-DOS form, so that every run writes the same bytes.
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
  return {
    add(name, content, { store = false } = {}) {
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
      const packed = store ? data : deflateRawSync(data)
      const nameBytes = Buffer.from(name, 'utf8')
      const fields = { method: store ? 0 : 8, crc: crc32(data), packed: packed.length, size: data.length, offset }
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(fields.method, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(DOS_DATE, 12)
      local.writeUInt32LE(fields.crc, 14)
      local.writeUInt32LE(fields.packed, 18)
      local.writeUInt32LE(fields.size, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28)
      write(local)
      write(nameBytes)
      write(packed)
      central.push({ nameBytes, ...fields })
    },
    close() {
      const start = offset
      for (const entry of central) {
        const header = Buffer.alloc(46)
        header.writeUInt32LE(0x02014b50, 0)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(20, 6)
        header.writeUInt16LE(0x0800, 8)
        header.writeUInt16LE(entry.method, 10)
        header.writeUInt16LE(0, 12)
        header.writeUInt16LE(DOS_DATE, 14)
        header.writeUInt32LE(entry.crc, 16)
        header.writeUInt32LE(entry.packed, 20)
        header.writeUInt32LE(entry.size, 24)
        header.writeUInt16LE(entry.nameBytes.length, 28)
        header.writeUInt32LE(entry.offset, 42)
        write(header)
        write(entry.nameBytes)
      }
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(central.length, 8)
      end.writeUInt16LE(central.length, 10)
      end.writeUInt32LE(offset - start, 12)
      end.writeUInt32LE(start, 16)
      write(end)
      closeSync(fd)
    }
  }
}

/**
 * A zip of a project's exported files, `megabytes` in all: a text file that is deflated, and parts that are
 * stored because their contents do not compress, as photos and recordings in a real archive do not.
 */
export function writeArchive(file, { megabytes }) {
  const next = random(megabytes)
  const zip = zipWriter(file)
  zip.add('export/README.txt', Array.from({ length: 200 }, () => sentence(next)).join('\n'))
  // The parts are the keystream of AES-CTR under a fixed key: bytes that do not compress, the same on every run,
  // at the speed of the cipher.
  const keystream = createCipheriv('aes-256-ctr', Buffer.alloc(32, megabytes), Buffer.alloc(16))
  const part = 8 * 1024 * 1024
  for (let i = 1; i * 8 <= megabytes; i++) zip.add(`export/data/part-${String(i).padStart(4, '0')}.bin`, keystream.update(Buffer.alloc(part)), { store: true })
  zip.close()
}
