import type { Attachment } from '@agent/core'

/** The last part of a path, for a folder row. Handles both separators. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path.slice(0, 1)
  const parts = trimmed.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? trimmed
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function isImageFile(file: Pick<Attachment, 'mime' | 'name'>): boolean {
  return file.mime.toLowerCase().startsWith('image/') || IMAGE_EXTENSION.test(file.name)
}

/** User chat rows carry `attachments: Attachment[]` in meta; older rows carried a count. */
export function attachmentsFromMeta(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  const result: Attachment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row['path'] !== 'string' || row['path'] === '') continue
    const name = typeof row['name'] === 'string' && row['name'] !== '' ? row['name'] : folderName(row['path'])
    const mime = typeof row['mime'] === 'string' && row['mime'] !== '' ? row['mime'] : 'application/octet-stream'
    const size = typeof row['size'] === 'number' && Number.isFinite(row['size']) ? row['size'] : undefined
    result.push({ path: row['path'], name, mime, ...(size !== undefined ? { size } : {}) })
  }
  return result
}
