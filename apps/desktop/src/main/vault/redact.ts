/**
 * The one place every vault value is scrubbed out of text. The vault registers itself here when the app starts;
 * the logger's redactSecrets, the row store (every synced row: chat items, turns, memory, tasks) and the vault
 * guard all call redactVault, so a value cannot be written down anywhere the app writes.
 */
let current: ((text: string) => string) | null = null

export function setVaultRedactor(redactor: ((text: string) => string) | null): void {
  current = redactor
}

export function redactVault(text: string): string {
  if (current === null || text === '') return text
  try {
    return current(text)
  } catch {
    return text
  }
}

/** Every string inside a JSON-like value, scrubbed. Returns the same object when nothing changed. */
export function redactDeep<T>(value: T): T {
  if (current === null) return value
  if (typeof value === 'string') return redactVault(value) as T
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = redactDeep(item)
      if (next !== item) changed = true
      return next
    })
    return (changed ? out : value) as T
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = redactDeep(item)
      if (next !== item) changed = true
      out[key] = next
    }
    return (changed ? out : value) as T
  }
  return value
}
