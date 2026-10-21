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
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  log: 'text/plain',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  sh: 'text/x-shellscript',
  ps1: 'text/plain',
  bat: 'text/plain',
  sql: 'text/plain',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
}

/** Best guess from the file name. Unknown kinds are treated as opaque files, not text. */
export function mimeForFile(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  const extension = name.slice(dot + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------------------------------------------
// How an attachment reaches the model (added for paste and drop of any file)
// ---------------------------------------------------------------------------------------------------------------

/**
 * image: sent as a picture the model looks at. text: read and put in the message. document: a format the app can
 * pull the text out of (Word, Excel, PowerPoint, PDF). file: anything else; the agent gets the saved path and opens
 * it with its own file tools.
 */
export type AttachmentKind = 'image' | 'text' | 'document' | 'file'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const DOCUMENT_EXT = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'odt', 'ods', 'odp'])
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs',
  'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'env', 'log', 'svg', 'vue', 'svelte', 'lua', 'r', 'dart', 'gradle', 'properties', 'tex', 'rtf', 'srt',
  'vtt', 'graphql', 'gql', 'proto', 'dockerfile', 'makefile', 'gitignore',
])

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot < 0) return base.toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/** Which way a file goes to the model, from its name first and its type second. */
export function attachmentKind(name: string, mime = ''): AttachmentKind {
  const extension = extensionOf(name)
  const type = mime.toLowerCase()
  if (IMAGE_EXT.has(extension)) return 'image'
  if (DOCUMENT_EXT.has(extension)) return 'document'
  if (TEXT_EXT.has(extension)) return 'text'
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image'
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') return 'text'
  if (type === 'application/pdf') return 'document'
  return 'file'
}

/** Human size for a chip, e.g. "820 KB", "2.4 MB", "312 bytes". */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return megabytes(bytes)
}
