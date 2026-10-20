/**
 * The models the person's own key can use, asked of the provider itself (its /models list). Nothing here is
 * a hardcoded choice: the list is whatever the provider says today. Main process only, the key stays here.
 */
import { providerInfo, type ModelListResult, type ProviderId } from '@agent/core'

export type ModelList = ModelListResult

export interface ListModelsInput {
  provider: ProviderId
  key: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

const MAX_MODELS = 2000

/** Drop what cannot chat: embeddings, speech, images, moderation. */
function chats(id: string): boolean {
  return !/(embed|tts|whisper|transcri|audio|speech|image|imagen|dall-e|moderation|veo|aqa|rerank)/i.test(id)
}

export async function listModels(input: ListModelsInput): Promise<ModelList> {
  const fetcher = input.fetchImpl ?? fetch
  const base = (input.baseUrl?.trim() || providerInfo(input.provider)?.baseUrl || '').replace(/\/+$/, '')
  if (base === '') return { ok: false, models: [], message: 'Add the server address for this provider first.' }
  const anthropic = input.provider === 'anthropic'
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': input.key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${input.key}` }
  let response: Response
  try {
    response = await fetcher(`${base}/models${anthropic ? '?limit=1000' : ''}`, { headers, signal: AbortSignal.timeout(20_000) })
  } catch {
    return { ok: false, models: [], message: 'Could not reach the provider.' }
  }
  if (response.status === 401 || response.status === 403) return { ok: false, models: [], message: 'That key was not accepted.' }
  if (!response.ok) return { ok: false, models: [], message: `The provider did not list its models (${response.status}). Type the model name instead.` }
  const body = (await response.json().catch(() => ({}))) as { data?: unknown; models?: unknown }
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  const seen = new Set<string>()
  const unique = rows
    .flatMap((row) => {
      const o: Record<string, unknown> = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : { id: row }
      const raw = o['id'] ?? o['name']
      if (typeof raw !== 'string' || raw.trim() === '') return []
      const id = raw.replace(/^models\//, '')
      const named = o['display_name'] ?? o['displayName'] ?? (o['id'] !== undefined ? o['name'] : undefined)
      return [{ id, label: typeof named === 'string' && named.trim() !== '' ? named : id, line: typeof o['description'] === 'string' ? (o['description'].split('\n')[0] ?? '').slice(0, 140) : '' }]
    })
    .filter((m) => chats(m.id) && !seen.has(m.id) && seen.add(m.id) !== undefined)
    .slice(0, MAX_MODELS)
  if (unique.length === 0) return { ok: true, models: [], message: 'Your key works, but the provider listed no models. Type the model name.' }
  return { ok: true, models: unique, message: `Your key works. ${unique.length} ${unique.length === 1 ? 'model' : 'models'} to choose from.` }
}
