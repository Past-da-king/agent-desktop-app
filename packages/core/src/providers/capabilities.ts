/**
 * What a provider can do, asked of the provider itself.
 *
 * The app used to judge a model from one error string: an HTTP 400 whose body happened to say
 * "image" was read as "this model cannot look at pictures". That is a guess, and it was wrong:
 * OpenCode Go routes each request by session, and some routes land on an engine with no image
 * input ("image input is not available on this engine") while the very same model, on a fresh
 * session, reads the same picture fine. So the app keeps three things apart:
 *
 * - what the provider's own model list says (`modelCatalogue`),
 * - what this app actually saw refused (`learnImageRefusal`, fresh for 12 hours),
 * - what the person chose (`override` in `visionSupport`).
 *
 * Nothing here names a model, and nothing here touches the disk or the network on its own: the
 * cache and the refusal records arrive as stores, so a test passes fakes and the app passes files.
 */
import { check } from '../http-policy'
import { ProviderException, asNumber, asObject, asString, isObject, type JsonObject } from '../model'
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

/** Where a catalogue is cached between runs (the app passes a file-backed one; tests pass a fake). */
export interface CatalogueStore {
  read(key: string): Catalogue | null
  write(key: string, value: Catalogue): void
}

/** One refusal this app saw for one provider and model. */
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
  ttlMs?: number
}

export type VisionSource = 'override' | 'learned' | 'catalogue' | 'none'

export interface VisionAnswer {
  state: VisionState
  source: VisionSource
}

/** A model list is slow-moving: a day is enough, and a stale one is better than a failed turn. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long one refusal counts. A route that refused a picture is good evidence for a while; after
 * half a day it is not, because the model itself may well take the next one.
 */
export const REFUSAL_TTL_MS = 12 * 60 * 60 * 1000

/** A model list that hangs must not hold up a turn. */
const FETCH_TIMEOUT_MS = 15_000

/** The cache key: one provider at one address. An address change means a different list. */
export function catalogueKey(options: Pick<CapabilityOptions, 'provider' | 'baseUrl'>): string {
  return `${options.provider}|${options.baseUrl}`
}

/** Refusals remember which model, because one route refusing does not condemn the family. */
export function refusalKey(
  options: Pick<CapabilityOptions, 'provider' | 'baseUrl'>,
  model: string,
): string {
  return `${options.provider}|${options.baseUrl}|${model}`
}

function clockOf(options: CapabilityOptions): number {
  return options.now?.() ?? Date.now()
}

/** A store that fails (a bad file, a full disk) must never take a turn down with it. */
function readCatalogue(store: CatalogueStore, key: string): Catalogue | null {
  try {
    return store.read(key)
  } catch {
    return null
  }
}

function writeCatalogue(store: CatalogueStore, key: string, value: Catalogue): void {
  try {
    store.write(key, value)
  } catch {
    // Losing the cache costs one request next time, nothing more.
  }
}

function readRefusal(store: RefusalStore, key: string): RefusalRecord | null {
  try {
    return store.read(key)
  } catch {
    return null
  }
}

function writeRefusal(store: RefusalStore, key: string, value: RefusalRecord): void {
  try {
    store.write(key, value)
  } catch {
    // Losing the record means one more try by hand.
  }
}

/**
 * Fetches (and caches) the provider's own model list. Never throws: a network or auth failure
 * answers the last cached catalogue, else null.
 */
export async function modelCatalogue(options: CapabilityOptions): Promise<Catalogue | null> {
  const key = catalogueKey(options)
  const now = clockOf(options)
  const ttl = options.ttlMs ?? CATALOGUE_TTL_MS
  const cached = readCatalogue(options.catalogueStore, key)
  // A fresh cache is the answer: asking again would be a wasted request on every turn.
  if (cached !== null && now - cached.fetchedAt < ttl) return cached
  try {
    const models = await fetchCatalogue(options)
    const fresh: Catalogue = { fetchedAt: now, models }
    writeCatalogue(options.catalogueStore, key, fresh)
    return fresh
  } catch {
    // Whatever went wrong, the last list is still the best thing we know.
    return cached
  }
}

async function fetchCatalogue(options: CapabilityOptions): Promise<ModelInfo[]> {
  const url = `${trimSlash(options.baseUrl)}/models`
  check(url, options.allowHttp ?? false)
  const fetchImpl = options.fetchImpl ?? fetch
  const clock = new AbortController()
  const timer = setTimeout(() => clock.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: clock.signal,
    })
    const text = await res.text()
    if (res.ok === false) {
      throw new ProviderException(`HTTP ${res.status}: the model list was refused`, res.status)
    }
    const entries = entriesOf(JSON.parse(text) as unknown)
    const models: ModelInfo[] = []
    for (const entry of entries) {
      const info = parseEntry(entry)
      if (info !== null) models.push(info)
    }
    return models
  } finally {
    clearTimeout(timer)
  }
}

/** `{data: [...]}` (OpenAI, OpenRouter, OpenCode) or a bare array; `{models: [...]}` as a courtesy. */
function entriesOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  const object = asObject(parsed)
  if (Array.isArray(object.data)) return object.data
  if (Array.isArray(object.models)) return object.models
  return []
}

function parseEntry(raw: unknown): ModelInfo | null {
  const entry = asObject(raw)
  const id = asString(entry.id) || asString(entry.name)
  if (id === '') return null
  const info: ModelInfo = { id, image: imageState(entry) }
  const limit = contextLimit(entry)
  if (limit !== undefined) info.contextLimit = limit
  return info
}

/**
 * What the entry says about pictures. Four providers' spellings, all of them evidence:
 * OpenCode `modalities.input`, OpenRouter `architecture.input_modalities` (and the same list
 * loose on the entry), and a plain `capabilities.vision` flag.
 */
function imageState(entry: JsonObject): VisionState {
  const modalities = isObject(entry.modalities) ? entry.modalities : undefined
  const architecture = isObject(entry.architecture) ? entry.architecture : undefined
  const signals = [
    fromModalityList(modalities?.['input']),
    fromModalityList(modalities?.['input_modalities']),
    fromModalityList(architecture?.['input_modalities']),
    fromModalityList(architecture?.['input']),
    fromModalityList(entry.input_modalities),
  ]
  const vision = isObject(entry.capabilities) ? entry.capabilities.vision : undefined
  if (vision === true) signals.push('yes')
  else if (vision === false) signals.push('no')
  if (signals.includes('yes')) return 'yes'
  if (signals.includes('no')) return 'no'
  // No modality information at all is not a "no": it is a provider that does not say.
  return 'unknown'
}

function fromModalityList(value: unknown): VisionState | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const image = value.some(
    (item) => typeof item === 'string' && item.trim().toLowerCase().startsWith('image'),
  )
  return image ? 'yes' : 'no'
}

function contextLimit(entry: JsonObject): number | undefined {
  const direct =
    asNumber(entry.context_length) || asNumber(entry.context_window) || asNumber(entry.max_context_tokens)
  if (direct > 0) return direct
  const provider = asNumber(asObject(entry.top_provider).context_length)
  if (provider > 0) return provider
  const limits = asNumber(asObject(entry.limits).context)
  return limits > 0 ? limits : undefined
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * Image support for one model: the user's override wins, then a refusal this app actually observed
 * for this provider+model (fresh within 12 hours), then the provider catalogue, then 'unknown'.
 */
export function visionSupport(
  options: CapabilityOptions,
  model: string,
  override?: 'auto' | 'on' | 'off',
): VisionAnswer {
  if (override === 'on') return { state: 'yes', source: 'override' }
  if (override === 'off') return { state: 'no', source: 'override' }

  const now = clockOf(options)
  const refusal = readRefusal(options.refusalStore, refusalKey(options, model))
  if (refusal !== null && now - refusal.at < REFUSAL_TTL_MS) return { state: 'no', source: 'learned' }

  const catalogue = readCatalogue(options.catalogueStore, catalogueKey(options))
  const entry = catalogue?.models.find((candidate) => candidate.id === model)
  if (entry !== undefined) return { state: entry.image, source: 'catalogue' }

  return { state: 'unknown', source: 'none' }
}

/** Notes that this provider refused a picture for this model, and when. */
export function learnImageRefusal(options: CapabilityOptions, model: string, detail: string): void {
  writeRefusal(options.refusalStore, refusalKey(options, model), {
    at: clockOf(options),
    detail: detail.slice(0, 500),
  })
}

/** Forgets a refusal: the person asked for it, or a fresh session took the picture. */
export function clearImageRefusal(options: CapabilityOptions, model: string): void {
  try {
    options.refusalStore.clear(refusalKey(options, model))
  } catch {
    // Nothing to clear is not an error.
  }
}

/**
 * The model to use for ONE turn when the chosen one will not take pictures: an image-capable model
 * from the same catalogue, preferring the same family (the id up to its first dash, so 'deepseek-'),
 * else the first image-capable one in the list. Null when the catalogue holds none.
 */
export function pickImageModel(catalogue: Catalogue | null, currentModel: string): string | null {
  if (catalogue === null) return null
  const capable = catalogue.models.filter((model) => model.image === 'yes')
  if (capable.length === 0) return null
  const family = familyPrefix(currentModel)
  if (family !== '') {
    const sibling = capable.find((model) => model.id.startsWith(family))
    if (sibling !== undefined) return sibling.id
  }
  return capable[0]!.id
}

/** 'deepseek-v4.1-flash' -> 'deepseek-'; a model with no dash has no family of its own. */
function familyPrefix(model: string): string {
  const dash = model.indexOf('-')
  return dash > 0 ? model.slice(0, dash + 1) : ''
}

/**
 * What a provider says when it will not take a picture on the route this request landed on (worth
 * trying again on a fresh session), as opposed to a bad picture or an error that merely mentions one.
 */
const ROUTING_REFUSALS: RegExp[] = [
  /image input is not available/i,
  /does not support image/i,
  /image (input )?is not supported/i,
  /no endpoints?( found that)? supports? imag/i,
]

/** The picture itself is the problem: another route would refuse it just the same. */
const BAD_IMAGE: RegExp[] = [
  /invalid image data/i,
  /(invalid|corrupt) image/i,
  /image too large/i,
  /could not decode image/i,
  /could not (read|load) image/i,
  /image format is not supported/i,
  /unsupported image format/i,
]

/**
 * Is this an image-routing refusal (a route with no image input, worth a fresh session) rather than
 * bad image data or an unrelated answer? Deliberately narrow: other errors are retried by their own
 * rules, and a 401 or a 429 says nothing about pictures.
 */
export function isImageRoutingRefusal(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const status = statusOf(error)
  // Only a 400 (or a message with no status at all) can be about image routing.
  if (status !== 0 && status !== 400) return false
  const message = messageOf(error)
  if (BAD_IMAGE.some((pattern) => pattern.test(message))) return false
  if (ROUTING_REFUSALS.some((pattern) => pattern.test(message))) return true
  // Some gateways answer with a machine-readable code or a field name instead of a sentence.
  return namesImageModality(error)
}

function statusOf(error: unknown): number {
  if (error instanceof ProviderException) return error.status
  if (isObject(error)) {
    const status = asNumber(error.status)
    if (status > 0) return status
  }
  if (error instanceof Error) {
    const match = /^HTTP (\d{3})\b/.exec(error.message)
    if (match?.[1] !== undefined) return Number(match[1])
  }
  return 0
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return ''
  const object = asObject(error)
  const body = isObject(object.error) ? object.error : object
  return asString(body.message) || asString(body.detail)
}

/** A structured error whose code, param or type is about image modality, e.g. 'unsupported_image_input'. */
function namesImageModality(error: unknown): boolean {
  if (!isObject(error)) return false
  const body = isObject(error.error) ? error.error : error
  const words = [asString(body.code), asString(body.param), asString(body.type)]
    .join(' ')
    .toLowerCase()
    .trim()
  if (words === '') return false
  if (!/image|vision|modalit/.test(words)) return false
  // A code about the picture's bytes is not about the route.
  return !/invalid_image|image_too|too_large|decode|format|corrupt|size/.test(words)
}
