import { describe, expect, it } from 'vitest'

import { ProviderException } from '../src/model'
import {
  clearImageRefusal,
  isImageRoutingRefusal,
  learnImageRefusal,
  modelCatalogue,
  pickImageModel,
  visionSupport,
  type Catalogue,
  type CatalogueStore,
  type CapabilityOptions,
  type RefusalRecord,
  type RefusalStore,
} from '../src/providers/capabilities'

const HOUR = 3_600_000
const BASE = 'https://opencode.ai/zen/go/v1'
const KEY = `opencode_go|${BASE}`

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

/** Answers one request the way a provider would. */
type Reply = (call: Call) => { status?: number; body: unknown } | Error

function fakeFetch(reply: Reply): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    const answer = reply(call)
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { impl, calls }
}

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

interface Setup {
  options: CapabilityOptions
  calls: Call[]
  catalogues: Map<string, Catalogue>
  refusals: Map<string, RefusalRecord>
  clock: { now: () => number; advance: (ms: number) => void }
}

function setup(
  reply: Reply,
  existing: { catalogue?: Catalogue; refusals?: Record<string, RefusalRecord> } = {},
): Setup {
  const catalogues = new Map<string, Catalogue>()
  if (existing.catalogue) catalogues.set(KEY, existing.catalogue)
  const refusals = new Map<string, RefusalRecord>(Object.entries(existing.refusals ?? {}))
  const catalogueStore: CatalogueStore = {
    read: (key) => catalogues.get(key) ?? null,
    write: (key, value) => {
      catalogues.set(key, value)
    },
  }
  const refusalStore: RefusalStore = {
    read: (key) => refusals.get(key) ?? null,
    write: (key, value) => {
      refusals.set(key, value)
    },
    clear: (key) => {
      refusals.delete(key)
    },
  }
  const time = clock()
  const fetch_ = fakeFetch(reply)
  return {
    options: {
      provider: 'opencode_go',
      baseUrl: BASE,
      apiKey: 'test-key',
      fetchImpl: fetch_.impl,
      catalogueStore,
      refusalStore,
      now: () => time.now(),
    },
    calls: fetch_.calls,
    catalogues,
    refusals,
    clock: time,
  }
}

const OPENCODE_LISTING = {
  object: 'list',
  data: [
    { id: 'deepseek-v4-pro', object: 'model', modalities: { input: ['text'], output: ['text'] } },
    { id: 'deepseek-v4.1-flash', object: 'model', modalities: { input: ['text', 'image'], output: ['text'] } },
    {
      id: 'qwen-vl-max',
      object: 'model',
      modalities: { input: ['text', 'image'], output: ['text'] },
      context_length: 131072,
    },
  ],
}

const OPENROUTER_LISTING = {
  data: [
    {
      id: 'openrouter/auto',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    { id: 'anthropic/claude-x', architecture: { input_modalities: ['text'] } },
    { id: 'google/gemini-y', input_modalities: ['text', 'image'] },
    { id: 'flagged-vision', capabilities: { vision: true } },
    { id: 'no-modalities-at-all' },
  ],
}
const CATALOGUE: Catalogue = {
  fetchedAt: 1_700_000_000_000,
  models: [
    { id: 'deepseek-v4.1-flash', image: 'yes' },
    { id: 'deepseek-v4-pro', image: 'no' },
    { id: 'glm-4.6', image: 'yes' },
    { id: 'mystery-1', image: 'unknown' },
  ],
}

describe('modelCatalogue', () => {
  it('reads an OpenCode-shaped listing and caches it under provider|baseUrl', async () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }))
    const catalogue = await modelCatalogue(s.options)

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.url).toBe(`${BASE}/models`)
    expect(s.calls[0]!.method).toBe('GET')
    expect(s.calls[0]!.headers.Authorization).toBe('Bearer test-key')
    expect(catalogue).toEqual({
      fetchedAt: s.clock.now(),
      models: [
        { id: 'deepseek-v4-pro', image: 'no' },
        { id: 'deepseek-v4.1-flash', image: 'yes' },
        { id: 'qwen-vl-max', image: 'yes', contextLimit: 131072 },
      ],
    })
    expect(catalogue?.models.find((m) => m.id === 'deepseek-v4.1-flash')?.image).toBe('yes')
    expect(catalogue?.models.find((m) => m.id === 'deepseek-v4-pro')?.image).toBe('no')
    expect(s.catalogues.get(KEY)).toEqual(catalogue)
  })

  it('reads an OpenRouter-shaped listing, including vision flags', async () => {
    const s = setup(() => ({ body: OPENROUTER_LISTING }))
    const catalogue = await modelCatalogue(s.options)
    const byId = new Map(catalogue?.models.map((m) => [m.id, m.image]))
    expect(byId.get('openrouter/auto')).toBe('yes')
    expect(byId.get('anthropic/claude-x')).toBe('no')
    expect(byId.get('google/gemini-y')).toBe('yes')
    expect(byId.get('flagged-vision')).toBe('yes')
    expect(byId.get('no-modalities-at-all')).toBe('unknown')
  })

  it('says unknown, never no, when an entry carries no modality information', async () => {
    const s = setup(() => ({ body: { data: [{ id: 'bare-model' }] } }))
    const catalogue = await modelCatalogue(s.options)
    expect(catalogue?.models).toEqual([{ id: 'bare-model', image: 'unknown' }])
  })

  it('does not fetch while the 24 hour cache is fresh, and refetches when it is stale', async () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }))
    await modelCatalogue(s.options)
    expect(s.calls).toHaveLength(1)

    s.clock.advance(23 * HOUR)
    await modelCatalogue(s.options)
    expect(s.calls).toHaveLength(1)

    s.clock.advance(2 * HOUR)
    const again = await modelCatalogue(s.options)
    expect(s.calls).toHaveLength(2)
    expect(again?.fetchedAt).toBe(s.clock.now())
    expect(again?.models).toHaveLength(3)
  })

  it('honours a caller-supplied ttlMs', async () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }))
    const options = { ...s.options, ttlMs: 60_000 }
    await modelCatalogue(options)
    s.clock.advance(61_000)
    await modelCatalogue(options)
    expect(s.calls).toHaveLength(2)
  })

  it('keeps the old catalogue when the refetch fails, and never throws', async () => {
    let broken = false
    const s = setup(() => (broken ? new Error('network down') : { body: OPENCODE_LISTING }))
    const first = await modelCatalogue(s.options)
    s.clock.advance(25 * HOUR)
    broken = true
    const second = await modelCatalogue(s.options)
    expect(s.calls).toHaveLength(2)
    expect(second).toEqual(first)
  })

  it('answers the stale cache when the provider rejects the key', async () => {
    let status = 200
    const s = setup(() => (status === 200 ? { body: OPENCODE_LISTING } : { status, body: { error: { message: 'bad key' } } }))
    const first = await modelCatalogue(s.options)
    s.clock.advance(25 * HOUR)
    status = 401
    await expect(modelCatalogue(s.options)).resolves.toEqual(first)
  })

  it('answers null when there is nothing cached and the first fetch fails', async () => {
    const s = setup(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    await expect(modelCatalogue(s.options)).resolves.toBeNull()
  })

  it('refuses a plain http server without the opt-in, without sending a request', async () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }))
    const insecure = { ...s.options, baseUrl: 'http://192.168.1.9:8000/v1' }
    await expect(modelCatalogue(insecure)).resolves.toBeNull()
    expect(s.calls).toHaveLength(0)
  })
})

describe('visionSupport', () => {
  it('answers from the catalogue when the person left it on auto', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'yes', source: 'catalogue' })
    expect(visionSupport(s.options, 'deepseek-v4.1-flash', 'auto')).toEqual({ state: 'yes', source: 'catalogue' })
    expect(visionSupport(s.options, 'deepseek-v4-pro')).toEqual({ state: 'no', source: 'catalogue' })
    expect(visionSupport(s.options, 'mystery-1')).toEqual({ state: 'unknown', source: 'catalogue' })
    expect(s.calls).toHaveLength(0)
  })

  it('answers unknown from nowhere when the model or catalogue is missing', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    expect(visionSupport(s.options, 'not-listed')).toEqual({ state: 'unknown', source: 'none' })

    const empty = setup(() => ({ body: OPENCODE_LISTING }))
    expect(visionSupport(empty.options, 'deepseek-v4.1-flash')).toEqual({ state: 'unknown', source: 'none' })
  })

  it('lets an override beat the catalogue both ways', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    expect(visionSupport(s.options, 'deepseek-v4.1-flash', 'off')).toEqual({ state: 'no', source: 'override' })
    expect(visionSupport(s.options, 'deepseek-v4-pro', 'on')).toEqual({ state: 'yes', source: 'override' })
  })

  it('lets a learned refusal beat a catalogue yes, but only for 12 hours', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    learnImageRefusal(s.options, 'deepseek-v4.1-flash', 'image input is not available on this engine')

    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'no', source: 'learned' })
    // It is about the route this app hit, not about the other model in the same family.
    expect(visionSupport(s.options, 'glm-4.6')).toEqual({ state: 'yes', source: 'catalogue' })

    s.clock.advance(11 * HOUR)
    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'no', source: 'learned' })

    s.clock.advance(2 * HOUR)
    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'yes', source: 'catalogue' })
  })

  it('still honours an explicit override while a refusal is fresh', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    learnImageRefusal(s.options, 'deepseek-v4.1-flash', 'image input is not available on this engine')
    expect(visionSupport(s.options, 'deepseek-v4.1-flash', 'on')).toEqual({ state: 'yes', source: 'override' })
  })

  it('learns only the model and provider it saw, and clears again', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    learnImageRefusal(s.options, 'deepseek-v4.1-flash', 'image input is not available on this engine')
    expect([...s.refusals.values()]).toEqual([
      { at: s.clock.now(), detail: 'image input is not available on this engine' },
    ])

    clearImageRefusal(s.options, 'deepseek-v4.1-flash')
    expect(s.refusals.size).toBe(0)
    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'yes', source: 'catalogue' })
  })

  it('keeps another provider out of this provider refusal', () => {
    const s = setup(() => ({ body: OPENCODE_LISTING }), { catalogue: CATALOGUE })
    learnImageRefusal({ ...s.options, provider: 'openrouter' }, 'deepseek-v4.1-flash', 'does not support image')
    expect(visionSupport(s.options, 'deepseek-v4.1-flash')).toEqual({ state: 'yes', source: 'catalogue' })
  })
})

describe('pickImageModel', () => {
  it('prefers a model from the same family before the first dash', () => {
    expect(pickImageModel(CATALOGUE, 'deepseek-v4-pro')).toBe('deepseek-v4.1-flash')
  })

  it('falls back to the first image-capable model when the family has none', () => {
    expect(pickImageModel(CATALOGUE, 'kimi-k2')).toBe('deepseek-v4.1-flash')
  })

  it('never picks a model that says no or unknown', () => {
    expect(pickImageModel(CATALOGUE, 'mystery-1')).toBe('deepseek-v4.1-flash')
    const onlyNo: Catalogue = { fetchedAt: 0, models: [{ id: 'deepseek-v4-pro', image: 'no' }] }
    expect(pickImageModel(onlyNo, 'deepseek-v4-pro')).toBeNull()
    expect(pickImageModel(null, 'deepseek-v4-pro')).toBeNull()
  })

  it('skips a no in the family for a yes outside it', () => {
    const mixed: Catalogue = {
      fetchedAt: 0,
      models: [
        { id: 'deepseek-v4-pro', image: 'no' },
        { id: 'glm-4.6', image: 'yes' },
      ],
    }
    expect(pickImageModel(mixed, 'deepseek-v4-pro')).toBe('glm-4.6')
  })
})

describe('isImageRoutingRefusal', () => {
  const refusing = [
    new ProviderException(
      'HTTP 400: Upstream request failed: [invalid_request_error] image input is not available on this engine',
      400,
    ),
    new ProviderException('HTTP 400: this model does not support image input', 400),
    new ProviderException('HTTP 400: image input is not supported', 400),
    new ProviderException('HTTP 400: image is not supported by the selected endpoint', 400),
    new ProviderException('HTTP 400: No endpoints found that support image input', 400),
    new ProviderException('HTTP 400: no endpoint supports images', 400),
  ]

  const notRefusing = [
    new ProviderException('HTTP 400: invalid image data', 400),
    new ProviderException('HTTP 400: image too large', 400),
    new ProviderException('HTTP 400: could not decode image', 400),
    new ProviderException('HTTP 400: the image field must be a url string', 400),
    new ProviderException('HTTP 401: Unauthorized (image endpoint needs a key)', 401),
    new ProviderException('HTTP 429: rate limit while uploading image', 429),
    new ProviderException('HTTP 500: upstream exploded', 500),
    new ProviderException('The AI service did not answer within 120 seconds.', 0, true),
    new Error('network down'),
  ]

  it('is true for a per-route image refusal', () => {
    for (const error of refusing) expect(isImageRoutingRefusal(error), error.message).toBe(true)
  })

  it('is false for bad image data, unrelated errors and anything that merely says image', () => {
    for (const error of notRefusing) expect(isImageRoutingRefusal(error), error.message).toBe(false)
  })

  it('reads a structured error whose code or param is about image modality', () => {
    expect(isImageRoutingRefusal({ status: 400, error: { code: 'unsupported_image_input', param: 'modalities' } })).toBe(true)
    expect(isImageRoutingRefusal({ status: 400, error: { code: 'invalid_image_data', param: 'messages[0]' } })).toBe(false)
    expect(isImageRoutingRefusal({ status: 401, error: { code: 'image_not_allowed' } })).toBe(false)
  })

  it('is false for nothing at all', () => {
    expect(isImageRoutingRefusal(null)).toBe(false)
    expect(isImageRoutingRefusal(undefined)).toBe(false)
    expect(isImageRoutingRefusal(new Error(''))).toBe(false)
  })
})
