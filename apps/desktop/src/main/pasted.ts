/**
 * Pasted things that have no file of their own (a screenshot, an image copied from a web page, a long text
 * pasted as a file) are written to the app's attachments folder, one folder per day, so the message can carry
 * a real path like any dropped file and the agent can open it with its file tools.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'

import { MAX_ATTACHMENT_BYTES, mimeForFile, type Attachment } from '@agent/core'

const EXTENSION_FOR: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/pdf': '.pdf',
}

/** A file name that is safe on every system and keeps its extension. */
export function safeFileName(name: string, mime: string): string {
  let clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (clean === '' || clean === '-') clean = mime.startsWith('image/') ? 'Pasted image' : 'Pasted file'
  if (clean.length > 120) {
    const ext = extname(clean).slice(0, 12)
    clean = clean.slice(0, 120 - ext.length) + ext
  }
  if (extname(clean) === '') clean += EXTENSION_FOR[mime.toLowerCase()] ?? ''
  return clean
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Writes the bytes under `root/<day>/` without overwriting anything, and returns the attachment. */
export function savePastedFile(root: string, name: string, mime: string, bytes: Uint8Array, now = new Date()): Attachment {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('That is too big to attach.')
  const folder = join(root, stamp(now))
  mkdirSync(folder, { recursive: true })
  const file = safeFileName(name, mime)
  const ext = extname(file)
  const base = file.slice(0, file.length - ext.length)
  let path = join(folder, file)
  for (let n = 2; existsSync(path); n++) path = join(folder, `${base} (${n})${ext}`)
  writeFileSync(path, bytes)
  const type = mime.trim() !== '' && mime !== 'application/octet-stream' ? mime : mimeForFile(path)
  return { path, name: path.slice(folder.length + 1), mime: type, size: bytes.byteLength }
}
