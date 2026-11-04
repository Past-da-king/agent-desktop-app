/**
 * Pictures in a chat, wired to the app.
 *
 * The rule this file exists for (Ayanda, 5 Nov 2026): one provider error is never a verdict on a model. OpenCode
 * Go routes every request by its x-opencode-session header, and some routes land on an engine with no image input;
 * the same model on a fresh session reads the same screenshot. So a refusal that says it could not ROUTE a picture
 * is retried on a fresh session, and only then does the turn fall back to a model the provider's own catalogue
 * says takes images. Whether a model sees pictures at all comes from that catalogue and from the person's own
 * choice in Settings, never from a list of model ids in the code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  catalogueKey,
  clearImageRefusal,
  isImageRoutingRefusal,
  learnImageRefusal,
  modelCatalogue,
  pickImageModel,
  visionSupport,
  type AiAccount,
  type Block,
  type CapabilityOptions,
  type Catalogue,
  CATALOGUE_TTL_MS,
  type CatalogueStore,
  type LlmProvider,
  type Msg,
  type RefusalRecord,
  type RefusalStore,
  type VisionState,
} from '@agent/core'

/** How many routing sessions one turn may try before it takes that as a real refusal. */
export const MAX_IMAGE_ATTEMPTS = 3

/** What a message says in place of a picture the person turned off (it is never silent about it). */
export const PICTURES_OFF_LINE = '(A picture was attached but pictures are off for this model in Settings.)'

/** One JSON file each, in the app's data folder: what the provider said about its models, and refusals. */
export interface VisionStores {
  catalogueStore: CatalogueStore
  refusalStore: RefusalStore
}

/** The two files, in the app's own data folder. Reads are synchronous so a turn never waits on a disk. */
export class FileVisionStores implements VisionStores {
  readonly catalogueStore: CatalogueStore
  readonly refusalStore: RefusalStore

  constructor(private readonly dir: string) {
    this.catalogueStore = new JsonFileCatalogue(join(dir, 'pictures-catalogue.json'))
    this.refusalStore = new JsonFileRefusals(join(dir, 'pictures-refused.json'))
  }
}

/** Everything in memory: tests, and a build with no data folder yet. */
export class MemoryVisionStores implements VisionStores {
  private readonly catalogues = new Map<string, Catalogue>()
  private readonly refusals = new Map<string, RefusalRecord>()

  readonly catalogueStore: CatalogueStore = {
    read: (key) => this.catalogues.get(key) ?? null,
    write: (key, value) => {
      this.catalogues.set(key, value)
    },
  }

  readonly refusalStore: RefusalStore = {
    read: (key) => this.refusals.get(key) ?? null,
    write: (key, value) => {
      this.refusals.set(key, value)
    },
    clear: (key) => {
      this.refusals.delete(key)
    },
  }
}

/** A small JSON file kept best-effort: a read that fails is "nothing yet", a write that fails changes nothing. */
class JsonFile {
  constructor(private readonly file: string) {}

  readInto<T>(check: (value: unknown) => T | null): T | null {
    try {
      if (!existsSync(this.file)) return null
      return check(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  write(value: unknown): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 })
    } catch {
      // Losing this only means the next turn asks the provider again.
    }
  }
}

class JsonFileCatalogue implements CatalogueStore {
  private readonly file: JsonFile
  /** One read per process: a turn's steps never re-parse the file. */
  private cached: { key: string; value: Catalogue } | null = null

  constructor(file: string) {
    this.file = new JsonFile(file)
  }

  read(key: string): Catalogue | null {
    if (this.cached !== null && this.cached.key === key) return this.cached.value
    const found = this.file.readInto((value) => {
      const catalogue = asCatalogue(value)
      if (catalogue === null) return null
      const stored = typeof (value as Record<string, unknown>)['key'] === 'string' ? String((value as Record<string, unknown>)['key']) : ''
      return stored === key ? catalogue : null
    })
    this.cached = found === null ? null : { key, value: found }
    return found
  }

  write(key: string, value: Catalogue): void {
    this.cached = { key, value }
    this.file.write({ key, fetchedAt: value.fetchedAt, models: value.models })
  }
}

class JsonFileRefusals implements RefusalStore {
  private readonly file: JsonFile
  private loaded: Record<string, RefusalRecord> | null = null

  constructor(file: string) {
    this.file = new JsonFile(file)
  }

  read(key: string): RefusalRecord | null {
    return this.all()[key] ?? null
  }

  write(key: string, value: RefusalRecord): void {
    this.all()[key] = value
    this.file.write(this.all())
  }

  clear(key: string): void {
    const all = this.all()
    if (!(key in all)) return
    delete all[key]
    this.file.write(all)
  }

  private all(): Record<string, RefusalRecord> {
    if (this.loaded === null) this.loaded = this.file.readInto((value) => asRefusals(value)) ?? {}
    return this.loaded
  }
}

function asCatalogue(value: unknown): Catalogue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const fetchedAt = typeof o['fetchedAt'] === 'number' && Number.isFinite(o['fetchedAt']) ? o['fetchedAt'] : 0
  const rows = Array.isArray(o['models']) ? o['models'] : []
  const models: Catalogue['models'] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    const id = typeof r['id'] === 'string' ? r['id'] : ''
    if (id === '') continue
    const image: VisionState = r['image'] === 'yes' || r['image'] === 'no' ? r['image'] : 'unknown'
    models.push({ id, image, ...(typeof r['contextLimit'] === 'number' ? { contextLimit: r['contextLimit'] } : {}) })
  }
  return { fetchedAt, models }
}

function asRefusals(value: unknown): Record<string, RefusalRecord> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: Record<string, RefusalRecord> = {}
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    out[key] = { at: typeof r['at'] === 'number' ? r['at'] : 0, detail: typeof r['detail'] === 'string' ? r['detail'] : '' }
  }
  return out
}

/** A brand-new routing session id (OpenCode Go picks the engine from it). */
export function freshImageSession(): string {
  return `desktop-${randomUUID()}`
}

/** The capability options for one account: its provider, its server and its own key. */
export function capabilityOptions(
  account: AiAccount,
  keyFor: (accountId: string) => string,
  baseUrl: string,
  stores: VisionStores,
  now: () => number = Date.now,
): CapabilityOptions {
  const options: CapabilityOptions = {
    provider: account.provider ?? 'anthropic',
    baseUrl,
    apiKey: keyFor(account.id),
    catalogueStore: stores.catalogueStore,
    refusalStore: stores.refusalStore,
    now,
  }
  if (account.allowHttp === true) options.allowHttp = true
  return options
}

/** The person's choice for one account; absent means 'auto'. */
export function picturesSetting(account: Pick<AiAccount, 'pictures'>): 'auto' | 'on' | 'off' {
  const value = account.pictures
  return value === 'on' || value === 'off' ? value : 'auto'
}

export interface ImageHandlingOptions {
  /** The person's choice for this account (Settings > Pictures). */
  override?: 'auto' | 'on' | 'off'
  /** Where a refusal is learned and a success forgotten; absent = learn nothing (a build with no store). */
  capability?: CapabilityOptions | null
  /**
   * The same provider on a fresh routing session. Left out: the turn gets one attempt, since nothing can change
   * between them.
   */
  refresh?: () => LlmProvider
  /** Models that take images, best first (from the provider's cached catalogue). */
  alternatives?: () => string[]
  /** A retry on a fresh session is about to happen (invisible in the chat). */
  onRetry?: (attempt: number) => void
  /** This turn is answered by another model: said to the person once. */
  onSwitch?: (model: string) => void
  /** A fake clock, for tests and for stores that keep time. */
  now?: () => number
}

/** The provider's answer when the person turned pictures off: no image block leaves this computer. */
function withoutPictures(messages: Msg[]): Msg[] {
  return messages.map((message) => {
    if (!message.blocks.some((block) => block.t === 'image')) return message
    const blocks: Block[] = message.blocks.filter((block) => block.t !== 'image')
    blocks.push({ t: 'text', text: PICTURES_OFF_LINE })
    return { role: message.role, blocks }
  })
}

export function hasPicture(messages: Msg[]): boolean {
  return messages.some((message) => message.blocks.some((block) => block.t === 'image'))
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * A provider that can look at pictures, or say plainly why it cannot.
 *
 *  - pictures off: the image blocks are stripped and one line tells the model a picture was there. It is never sent.
 *  - a gateway refusal to route a picture: up to three attempts, each on a fresh routing session.
 *  - still refused: the refusal is learned, and one turn goes to a model that takes images (the chat keeps its own).
 *  - a call that carried a picture and worked: any learned refusal for that model is forgotten.
 *  - everything else (a 401, a 429, bad image data): rethrown untouched, so the chat says what really happened.
 */
export function withImageHandling(inner: LlmProvider, options: ImageHandlingOptions): LlmProvider {
  const override = options.override ?? 'auto'
  return {
    name: inner.name,
    async complete(system, messages, tools, model, maxTokens, signal) {
      if (override === 'off') {
        return inner.complete(system, withoutPictures(messages), tools, model, maxTokens, signal)
      }
      if (!hasPicture(messages)) return inner.complete(system, messages, tools, model, maxTokens, signal)

      let provider = inner
      let lastError: unknown = null
      for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
        try {
          const done = await provider.complete(system, messages, tools, model, maxTokens, signal)
          if (options.capability != null) clearImageRefusal(options.capability, model)
          return done
        } catch (error) {
          if (!isImageRoutingRefusal(error)) throw error
          lastError = error
          const next = attempt < MAX_IMAGE_ATTEMPTS ? options.refresh?.() : undefined
          if (next === undefined) break
          provider = next
          options.onRetry?.(attempt)
        }
      }

      // Every session said it could not route the picture: that is this model's answer here, so keep it.
      if (options.capability != null) learnImageRefusal(options.capability, model, messageOf(lastError))
      const other = options.alternatives?.().find((each) => each.trim() !== '' && each.trim() !== model.trim())
      if (other === undefined) throw lastError
      const answer = await inner.complete(system, messages, tools, other, maxTokens, signal)
      options.onSwitch?.(other)
      if (options.capability != null) clearImageRefusal(options.capability, other)
      return answer
    },
  }
}

export interface WrapOptions {
  account: AiAccount
  /** The model this chat runs on: never changed here, only for the one turn that needs another. */
  model: string
  /** The same provider on a fresh routing session (a new x-opencode-session id). */
  refresh?: () => LlmProvider
  onRetry?: (attempt: number) => void
  onSwitch?: (model: string) => void
}

/**
 * The app's own wiring of all that: the two files under the data folder, the catalogue fetched once per provider
 * and server (cached for a day, asked off the turn's path), and one wrapper per turn.
 */
export class VisionRouter {
  private readonly stores: VisionStores
  private readonly keyFor: (accountId: string) => string
  private readonly baseUrlFor: (account: AiAccount) => string
  private readonly now: () => number
  /** One fetch per provider+server at a time: ten helpers starting together ask the provider once. */
  private readonly fetching = new Map<string, Promise<void>>()

  constructor(deps: {
    stores: VisionStores
    keyFor: (accountId: string) => string
    /** The server that account talks to (its own address, else the provider's). */
    baseUrlFor?: (account: AiAccount) => string
    now?: () => number
  }) {
    this.stores = deps.stores
    this.keyFor = deps.keyFor
    this.baseUrlFor = deps.baseUrlFor ?? (() => '')
    this.now = deps.now ?? Date.now
  }

  optionsFor(account: AiAccount): CapabilityOptions {
    return capabilityOptions(account, this.keyFor, this.baseUrlFor(account), this.stores, this.now)
  }

  /**
   * Ask the provider what its models can do, at most once a day, off the turn's path: a turn never waits on it,
   * and a provider that is down simply leaves the catalogue as it was.
   */
  prepare(account: AiAccount): void {
    const options = this.optionsFor(account)
    const key = catalogueKey(options)
    if (this.fetching.has(key)) return
    const known = this.stores.catalogueStore.read(key)
    const ttl = CATALOGUE_TTL_MS
    if (known !== null && this.now() - known.fetchedAt < ttl && known.models.length > 0) return
    const run = modelCatalogue(options)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => this.fetching.delete(key))
    this.fetching.set(key, run)
  }

  /** The image-capable models the provider's catalogue knows, best first. */
  alternativesFor(account: AiAccount, model: string): string[] {
    const catalogue = this.stores.catalogueStore.read(catalogueKey(this.optionsFor(account)))
    const best = pickImageModel(catalogue, model)
    return best === null ? [] : [best]
  }

  /** What is really known about this model and pictures: the person's choice, a learned refusal, the catalogue. */
  supportFor(account: AiAccount, model: string): { state: VisionState; source: string } {
    return visionSupport(this.optionsFor(account), model, picturesSetting(account))
  }

  /** A provider that handles pictures for this account's turn. */
  wrap(inner: LlmProvider, wrap: WrapOptions): LlmProvider {
    const options = this.optionsFor(wrap.account)
    return withImageHandling(inner, {
      override: picturesSetting(wrap.account),
      capability: options,
      ...(wrap.refresh === undefined ? {} : { refresh: wrap.refresh }),
      alternatives: () => this.alternativesFor(wrap.account, wrap.model),
      ...(wrap.onRetry === undefined ? {} : { onRetry: wrap.onRetry }),
      ...(wrap.onSwitch === undefined ? {} : { onSwitch: wrap.onSwitch }),
      now: this.now,
    })
  }
}
