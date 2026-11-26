/** Labels from the app's own stored user message. Never supplied by a tool argument. */
export interface RequestSource { id: string; at: number; text: string }
export function requestLabel(source: RequestSource): string {
  const at = `${new Date(source.at).toISOString().slice(11, 16)} UTC`
  return `You asked for this at ${at}: "${source.text.replace(/\s+/g, ' ').slice(0, 500)}"`
}

export function parseRequestSource(value: unknown): RequestSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Partial<RequestSource>
  return typeof source.id === 'string' && source.id !== '' && typeof source.at === 'number' && Number.isFinite(source.at) && source.at > 0 && source.at <= 8.64e15 && typeof source.text === 'string'
    ? { id: source.id, at: source.at, text: source.text } : null
}

