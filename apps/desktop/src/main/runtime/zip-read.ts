/**
 * Just enough of the ZIP format to read the XML inside Office files (docx, xlsx, pptx) and OpenDocument
 * files. Pure Node (zlib), no dependency: the central directory names every entry, and each entry is
 * stored or deflated. Anything odd (encryption, ZIP64, a broken archive) reads as "no entries".
 */
import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** One entry may not inflate past this, so a zip bomb cannot eat the main process. */
const MAX_ENTRY_BYTES = 40 * 1024 * 1024

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

export function zipEntries(buf: Buffer): ZipEntry[] {
  const start = Math.max(0, buf.length - 65_557)
  let eocd = -1
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) break
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const compressedSize = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const offset = buf.readUInt32LE(at + 42)
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength)
    // Encrypted entries cannot be read; skip them rather than return garbage.
    if ((flags & 1) === 0) entries.push({ name, method, compressedSize, size, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function zipRead(buf: Buffer, entry: ZipEntry): Buffer | null {
  const at = entry.offset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) return null
  const nameLength = buf.readUInt16LE(at + 26)
  const extraLength = buf.readUInt16LE(at + 28)
  const begin = at + 30 + nameLength + extraLength
  const end = begin + entry.compressedSize
  if (end > buf.length || entry.size > MAX_ENTRY_BYTES) return null
  const data = buf.subarray(begin, end)
  try {
    if (entry.method === 0) return Buffer.from(data)
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
  } catch {
    return null
  }
  return null
}

/** Every entry whose name passes `wanted`, read as UTF-8 text, in archive order. */
export function zipTexts(buf: Buffer, wanted: (name: string) => boolean): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  for (const entry of zipEntries(buf)) {
    if (!wanted(entry.name)) continue
    const data = zipRead(buf, entry)
    if (data !== null) out.push({ name: entry.name, text: data.toString('utf8') })
  }
  return out
}
