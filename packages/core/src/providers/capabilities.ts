/**
 * What a model can actually do, learned from the provider itself instead of guessed from one error.
 *
 * Two facts, both kept as data so no list of model ids is ever written into the app:
 *  - the provider's own catalogue (GET <baseUrl>/models), for which models take images at all. Cached for a day,
 *    because asking on every turn wastes the person's money and the provider's patience.
 *  - a refusal this model really gave when an image was sent (a learned "no"), so a second attempt is not wasted
 *    on the same answer.
 *
 * A single refusal is never a verdict on the model: a gateway may refuse to route one request (OpenCode Go routes
 * each request by its session header and some engines have no image input). That is what `isImageRoutingRefusal`
 * is for: it tells the two apart, so the caller retries or switches instead of telling the person their model
 * cannot see.
 */
import { check } from '../http-policy'

import { USER_AGENT } from './http'

export type VisionState = 'yes' | 'no' | 'unknown'

export interface ModelInfo {
  id: string
  image: VisionState
  contextLimit?: number
}

export interface Catalogue {
  fetchedAt: number
  models: ModelInfo[]
}

/** Where the catalogue is kept (one JSON file in the app's data folder, or memory in a test). */
export interface CatalogueStore {
  read(key: string): Catalogue | null
  write(key: string, value: Catalogue): void
}

/** One model's last image refusal, with what the provider said, so it reads back in plain words. */
export interface RefusalRecord {
  at: number
  detail: string
}

export interface RefusalStore {
  read(key: string): RefusalRecord | null
  write(key: string, value: RefusalRecord): void
  clear(key: string): void
}

export interface CapabilityOptions {
  provider: string
  baseUrl: string
  apiKey: string
  allowHttp?: boolean
  fetchImpl?: typeof fetch
  catalogueStore: CatalogueStore
  refusalStore: RefusalStore
  now?: () => number
  /** How long a fetched catalogue is trusted. Default one day. */
  ttlMs?: number
}

export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000

/** One key per provider and server: two accounts on the same provider share what the provider told us. */
export function catalogueKey(options: Pick<CapabilityOptions, 'provider' | 'baseUrl'>): string {
  return `${options.provider}|${trimSlash(options.baseUrl.trim()).toLowerCase()}`
}

export function refusalKey(model: string): string {
  return model.trim().toLowerCase()
}

/**
 * The provider's own list of models, as capability facts. Answers the cached copy while it is fresh, fetches when
 * it is not, and hands back the stale copy (never nothing) when the provider cannot be reached.
 */
export async function modelCatalogue(options: CapabilityOptions): Promise<Catalogue | null> {
  const key = catalogueKey(options)
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? CATALOGUE_TTL_MS
  let cached: Catalogue | null = null
  try {
    cached = options.catalogueStore.read(key)
  } catch {
    cached = null
  }
  if (cached !== null && now() - cached.fetchedAt < ttl && cached.models.length > 0) return cached

  const base = trimSlash(options.baseUrl.trim())
  if (base === '') return cached
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    check(base, options.allowHttp ?? false)
    const res = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'User-Agent': USER_AGENT },
    })
    if (!res.ok) return cached
    const body: unknown = JSON.parse(await res.text())
    const models = modelsFrom(body)
    if (models.length === 0) return cached
    const fresh: Catalogue = { fetchedAt: now(), models }
    try {
      options.catalogueStore.write(key, fresh)
    } catch {
      // A catalogue we cannot keep is still worth this turn.
    }
    return fresh
  } catch {
    return cached
  }
}

/** The models array out of whatever shape the provider answered with ({data:[...]}, {models:[...]} or a bare list). */
function modelsFrom(body: unknown): ModelInfo[] {
  const list = Array.isArray(body)
    ? body
    : isObject(body)
      ? [body['data'], body['models'], body['items']].find((each) => Array.isArray(each)) ?? []
      : []
  const out: ModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of list as unknown[]) {
    if (!isObject(raw)) continue
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    if (id === '' || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    const info: ModelInfo = { id, image: imageStateOf(raw) }
    const limit = contextLimitOf(raw)
    if (limit !== undefined) info.contextLimit = limit
    out.push(info)
  }
  return out
}

/** Whether a catalogue row says it takes images. Providers differ in how they say it; absent means unknown. */
function imageStateOf(raw: Record<string, unknown>): VisionState {
  const yes = true
  const no = false
  const candidates: unknown[] = [
    raw['supports_vision'],
    raw['supportsVision'],
    raw['vision'],
    raw['input_modalities'],
    raw['modalities'],
    isObject(raw['architecture']) ? (raw['architecture'] as Record<string, unknown>)['input_modalities'] : undefined,
    isObject(raw['capabilities']) ? (raw['capabilities'] as Record<string, unknown>)['vision'] : undefined,
    isObject(raw['capabilities']) ? (raw['capabilities'] as Record<string, unknown>)['image_input'] : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate === yes) return 'yes'
    if (candidate === no) return 'no'
    if (Array.isArray(candidate)) {
      const words = candidate.filter((each): each is string => typeof each === 'string').map((each) => each.toLowerCase())
      if (words.includes('image') || words.includes('images')) return 'yes'
      // A list of input kinds that leaves images out is a real "no"; an empty list says nothing.
      if (words.length > 0 && (words.includes('text') || words.includes('file'))) return 'no'
    }
  }
  return 'unknown'
}

function contextLimitOf(raw: Record<string, unknown>): number | undefined {
  const numbers: unknown[] = [
    raw['context_length'],
    raw['contextLimit'],
    raw['context_window'],
    isObject(raw['top_provider']) ? (raw['top_provider'] as Record<string, unknown>)['context_length'] : undefined,
    isObject(raw['limit']) ? (raw['limit'] as Record<string, unknown>)['context'] : undefined,
  ]
  for (const candidate of numbers) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return Math.round(candidate)
  }
  return undefined
}

/**
 * What we know about one model's pictures, best fact first: the person's own choice, then a refusal this model
 * really gave, then the provider's catalogue, then nothing.
 */
export function visionSupport(
  options: CapabilityOptions,
  model: string,
  override?: 'auto' | 'on' | 'off',
): { state: VisionState; source: 'override' | 'learned' | 'catalogue' | 'none' } {
  if (override === 'on') return { state: 'yes', source: 'override' }
  if (override === 'off') return { state: 'no', source: 'override' }
  const key = refusalKey(model)
  let refused: RefusalRecord | null = null
  try {
    refused = key === '' ? null : options.refusalStore.read(key)
  } catch {
    refused = null
  }
  if (refused !== null) return { state: 'no', source: 'learned' }
  let catalogue: Catalogue | null = null
  try {
    catalogue = options.catalogueStore.read(catalogueKey(options))
  } catch {
    catalogue = null
  }
  const found = catalogue?.models.find((each) => each.id.toLowerCase() === key) ?? null
  if (found !== null) return { state: found.image, source: 'catalogue' }
  return { state: 'unknown', source: 'none' }
}

/** A model answered "no" to a picture: keep it, with what the provider said, so it is not asked again blindly. */
export function learnImageRefusal(options: CapabilityOptions, model: string, detail: string): void {
  const key = refusalKey(model)
  if (key === '') return
  const now = options.now ?? Date.now
  try {
    options.refusalStore.write(key, { at: now(), detail: detail.slice(0, 500) })
  } catch {
    // Learning is an optimisation: a person waiting on a turn never hears about it.
  }
}

/** A model took a picture after all (a fresh session, a fixed gateway): forget the refusal. */
export function clearImageRefusal(options: CapabilityOptions, model: string): void {
  const key = refusalKey(model)
  if (key === '') return
  try {
    options.refusalStore.clear(key)
  } catch {
    // Same as above.
  }
}

/**
 * The best model in the catalogue that takes images, for one turn, or null when there is none. "Best" is the one
 * with the most context first (a real measure from the provider), then the catalogue's own order.
 */
export function pickImageModel(catalogue: Catalogue | null, currentModel: string): string | null {
  if (catalogue === null) return null
  const current = currentModel.trim().toLowerCase()
  const able = catalogue.models.filter((each) => each.image === 'yes' && each.id.toLowerCase() !== current)
  if (able.length === 0) return null
  let best = able[0] as ModelInfo
  for (const each of able.slice(1)) {
    if ((each.contextLimit ?? 0) > (best.contextLimit ?? 0)) best = each
  }
  return best.id
}

/**
 * True when a provider's gateway refused to ROUTE a picture somewhere that takes it, which says nothing about the
 * model: the same model on a fresh routing session usually reads the same picture. Deliberately narrow, so a real
 * "this model does not do images", a 401, a 429 or bad image data never reads as one.
 */
export function isImageRoutingRefusal(error: unknown): boolean {
  const message = messageOf(error)
  if (message === '') return false
  if (/invalid image data|unsupported image format|image too large|could not decode/i.test(message)) return false
  return /image input is not available on [a-z ]{0,24}engine/i.test(message)
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (isObject(error)) {
    const message = error['message']
    if (typeof message === 'string') return message
  }
  return ''
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
