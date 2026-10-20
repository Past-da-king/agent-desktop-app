/**
 * The one rule for attaching a file to a chat message, shared by the renderer's drop target and
 * anything in the main process that reads attachments. Kept here so the rule cannot drift.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** A friendly line when the file is too big, otherwise null. Plain words, shown as-is. */
export function attachmentProblem(name: string, size: number): string | null {
  if (!Number.isFinite(size) || size < 0) return `${name} could not be read.`
  if (size <= MAX_ATTACHMENT_BYTES) return null
  const limit = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
  return `${name} is ${megabytes(size)}. Files up to ${limit} MB can be attached.`
}

/** Human size for a message, e.g. "24.3 MB". */
export function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024)
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} MB`
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/** Best guess from the file name. Unknown kinds are treated as opaque files, not text. */
export function mimeForFile(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  const extension = name.slice(dot + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}
