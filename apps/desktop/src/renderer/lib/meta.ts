export type Meta = Record<string, unknown>

/** Card metadata is JSON text in `ChatItem.meta`. Unreadable meta is treated as empty. */
export function parseMeta(raw: string): Meta {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Meta
    }
  } catch {
    // Fall through to an empty object; the row still renders as plain text.
  }
  return {}
}

export function metaText(meta: Meta, key: string): string {
  const value = meta[key]
  return typeof value === 'string' ? value : ''
}

export function metaStrings(meta: Meta, key: string): string[] {
  const value = meta[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
