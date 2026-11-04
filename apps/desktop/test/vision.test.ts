/**
 * Pictures in a chat (Ayanda, 5 Nov 2026). What these tests hold down:
 *
 *  - a gateway that refuses to ROUTE a picture (OpenCode Go picks an engine from the session id, and one engine has
 *    no image input) is retried on a fresh session, and the third answer is the turn's answer. The chat's model
 *    never changes.
 *  - only after every session refused does the turn go to a model the provider's catalogue says takes images, once,
 *    and the person is told.
 *  - a 401, a 429 and bad image data are not routing refusals: they are rethrown untouched, with no retry.
 *  - pictures turned off never put an image block on the wire, and still run the turn.
 *  - a call that carried a picture and worked forgets a learned refusal.
 *  - friendlyError never says "This model can't look at images" for a 400 that merely has the word image in it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ProviderException,
  catalogueKey,
  isImageRoutingRefusal,
  pickImageModel,
  visionSupport,
  type AiAccount,
  type CapabilityOptions,
  type Completion,
  type LlmProvider,
  type Msg,
} from '@agent/core'

import { friendlyError } from '../src/main/runtime/runner'
import {
  FileVisionStores,
  MAX_IMAGE_ATTEMPTS,
  MemoryVisionStores,
  PICTURES_OFF_LINE,
  VisionRouter,
  capabilityOptions,
  picturesSetting,
  withImageHandling,
  type VisionStores,
} from '../src/main/runtime/vision'

/** Exactly what the gateway answered on 5 Nov 2026, in the app's own error shape. */
const ROUTED_AWAY = 'HTTP 400: Upstream request failed: [invalid_request_error] image input is not available on this engine'

const chatModel = 'deepseek-v4.1-flash'
const imageModel = 'glm-5.2'

const dirs: string[] = []
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), 'vision-'))
  dirs.push(made)
  return made
}
afterEach(() => {
  for (const each of dirs.splice(0)) rmSync(each, { recursive: true, force: true })
})

function answer(model: string, text = 'read the picture'): Completion {
  return { message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: `${text} (${model})` }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }
}

/** A picture in the conversation, the way the chat sends one. */
function withPicture(text = 'what is this?'): Msg[] {
  return [{ role: 'USER', blocks: [{ t: 'image', path: '/tmp/shot.png', mime: 'image/png' }, { t: 'text', text }] }]
}

interface Call {
  model: string
  messages: Msg[]
}

/**
 * A provider whose answers are a script: each call takes the next step, which is either a completion or an error.
 * Every provider made by `sessions()` shares the script and the recorded calls, so a refreshed session is told apart
 * by the order of the calls alone.
 */
function scripted(steps: Array<Completion | Error>, label = 'one'): { provider: LlmProvider; calls: Call[] } {
  const calls: Call[] = []
  const provider: LlmProvider = {
    name: label,
    async complete(_system, messages, _tools, model) {
      calls.push({ model, messages })
      const step = steps[Math.min(calls.length - 1, steps.length - 1)] as Completion | Error
      if (step instanceof Error) throw step
      return step
    },
  }
  return { provider, calls }
}

function account(patch: Partial<AiAccount> = {}): AiAccount {
  return {
    id: 'a1',
    label: 'OpenCode Go',
    kind: 'api',
    provider: 'opencode_go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: chatModel,
    hasKey: true,
    ...patch,
  }
}

function optionsFor(stores: VisionStores): CapabilityOptions {
  return capabilityOptions(account(), () => 'sk-test', 'https://opencode.ai/zen/go/v1', stores)
}

/** The provider's catalogue as it really reads: the chat's model, and one that takes pictures. */
function seedCatalogue(stores: VisionStores): void {
  stores.catalogueStore.write(catalogueKey(optionsFor(stores)), {
    fetchedAt: Date.now(),
    models: [
      { id: chatModel, image: 'no' },
      { id: imageModel, image: 'yes', contextLimit: 200_000 },
    ],
  })
}

describe('a picture the gateway refused to route', () => {
  it('tries again on a fresh session and answers the turn on the third attempt', async () => {
    const first = scripted([new ProviderException(ROUTED_AWAY, 400)])
    const second = scripted([new ProviderException(ROUTED_AWAY, 400)])
    const third = scripted([answer(chatModel)])
    const sessions = [first, second, third]
    let made = 0
    const retries: number[] = []
    const switched: string[] = []

    const provider = withImageHandling(sessions[0]!.provider, {
      refresh: () => (sessions[++made] as { provider: LlmProvider }).provider,
      alternatives: () => [],
      onRetry: (attempt) => retries.push(attempt),
      onSwitch: (model) => switched.push(model),
    })

    const completed = await provider.complete('system', withPicture(), [], chatModel)

    expect(completed.message.blocks).toEqual([{ t: 'text', text: `read the picture (${chatModel})` }])
    expect(retries).toEqual([1, 2])
    expect(switched).toEqual([])
    expect(made).toBe(2)
    // Every attempt asked for the chat's own model: nothing about the chat changed.
    for (const session of sessions) for (const call of session.calls) expect(call.model).toBe(chatModel)
    expect(sessions[2]!.calls).toHaveLength(1)
    expect(MAX_IMAGE_ATTEMPTS).toBe(3)
  })

  it('switches one turn to a model the catalogue says takes pictures, once, and says so', async () => {
    const stores = new MemoryVisionStores()
    seedCatalogue(stores)
    const inner = scripted([new ProviderException(ROUTED_AWAY, 400), new ProviderException(ROUTED_AWAY, 400), new ProviderException(ROUTED_AWAY, 400), answer(imageModel)])
    const refreshed: LlmProvider[] = []
    const switched: string[] = []
    let made = 0
    const router = new VisionRouter({ stores, keyFor: () => 'sk-test', baseUrlFor: (each) => each.baseUrl ?? '' })

    const provider = router.wrap(inner.provider, {
      account: account(),
      model: chatModel,
      refresh: () => {
        made += 1
        refreshed.push(inner.provider)
        return inner.provider
      },
      onSwitch: (model) => switched.push(model),
    })

    const completed = await provider.complete('system', withPicture(), [], chatModel)

    expect(switched).toEqual([imageModel])
    expect(completed.message.blocks).toEqual([{ t: 'text', text: `read the picture (${imageModel})` }])
    expect(made).toBe(2)
    // The last call of the turn is the one that carried the other model; the three before it were the chat's own.
    expect(inner.calls.map((call) => call.model)).toEqual([chatModel, chatModel, chatModel, imageModel])
    // The refusal is remembered for the model that really refused it.
    expect(visionSupport(optionsFor(stores), chatModel)).toEqual({ state: 'no', source: 'learned' })
  })

  it('says plainly what happened when there is no other model to try', async () => {
    const inner = scripted([new ProviderException(ROUTED_AWAY, 400)])
    const provider = withImageHandling(inner.provider, { alternatives: () => [] })
    await expect(provider.complete('system', withPicture(), [], chatModel)).rejects.toThrow(ROUTED_AWAY)
    expect(inner.calls).toHaveLength(1)
  })
})

describe('what is not a routing refusal', () => {
  it('rethrows a 401, a 429 and bad image data untouched, with no retry', async () => {
    const cases: Array<ProviderException> = [
      new ProviderException('HTTP 401: invalid api key', 401),
      new ProviderException('HTTP 429: rate limited', 429),
      new ProviderException('HTTP 400: invalid image data for block 0', 400),
    ]
    for (const error of cases) {
      const inner = scripted([error])
      let refreshed = 0
      const provider = withImageHandling(inner.provider, {
        refresh: () => {
          refreshed += 1
          return inner.provider
        },
        alternatives: () => [imageModel],
      })
      await expect(provider.complete('system', withPicture(), [], chatModel)).rejects.toBe(error)
      expect(refreshed).toBe(0)
      expect(inner.calls).toHaveLength(1)
    }
  })

  it('tells the two kinds of refusal apart by the words the gateway used', () => {
    expect(isImageRoutingRefusal(new ProviderException(ROUTED_AWAY, 400))).toBe(true)
    expect(isImageRoutingRefusal(new ProviderException('HTTP 400: Upstream request failed: image input is not available on this engine', 400))).toBe(true)
    expect(isImageRoutingRefusal(new ProviderException('HTTP 400: image input is not supported by this model', 400))).toBe(false)
    expect(isImageRoutingRefusal(new ProviderException('HTTP 400: invalid image data', 400))).toBe(false)
    expect(isImageRoutingRefusal(new ProviderException('HTTP 429: rate limited', 429))).toBe(false)
    expect(isImageRoutingRefusal(new Error('socket hang up'))).toBe(false)
  })
})

describe('pictures turned off', () => {
  it('never sends an image block, and still runs the turn', async () => {
    const inner = scripted([answer(chatModel)])
    const provider = withImageHandling(inner.provider, { override: 'off', alternatives: () => [imageModel] })
    const completed = await provider.complete('system', withPicture(), [], chatModel)

    expect(completed.message.blocks).toEqual([{ t: 'text', text: `read the picture (${chatModel})` }])
    expect(inner.calls).toHaveLength(1)
    const sent = inner.calls[0]!.messages
    expect(sent.some((message) => message.blocks.some((block) => block.t === 'image'))).toBe(false)
    expect(JSON.stringify(sent)).not.toContain('/tmp/shot.png')
    expect(JSON.stringify(sent)).toContain(PICTURES_OFF_LINE)
  })

  it('reads the person\'s choice off the account, and nothing means auto', () => {
    expect(picturesSetting({ pictures: 'off' })).toBe('off')
    expect(picturesSetting({ pictures: 'on' })).toBe('on')
    expect(picturesSetting({})).toBe('auto')
  })
})

describe('learning from what a model really does', () => {
  it('forgets a learned refusal once a call with a picture works', async () => {
    const stores = new MemoryVisionStores()
    const options = optionsFor(stores)
    stores.refusalStore.write(chatModel, { at: Date.now(), detail: ROUTED_AWAY })
    expect(visionSupport(options, chatModel)).toEqual({ state: 'no', source: 'learned' })

    const inner = scripted([answer(chatModel)])
    const provider = withImageHandling(inner.provider, { capability: options, alternatives: () => [] })
    await provider.complete('system', withPicture(), [], chatModel)

    expect(stores.refusalStore.read(chatModel)).toBeNull()
    expect(visionSupport(options, chatModel).source).toBe('none')
  })

  it('keeps the catalogue and the refusals in the app\'s own data folder', () => {
    const base = dir()
    const first = new FileVisionStores(base)
    const options = capabilityOptions(account(), () => 'sk-test', 'https://opencode.ai/zen/go/v1', first)
    first.catalogueStore.write(catalogueKey(options), { fetchedAt: 1234, models: [{ id: imageModel, image: 'yes', contextLimit: 200_000 }] })
    first.refusalStore.write(chatModel, { at: 99, detail: ROUTED_AWAY })

    // A fresh process reads what the last one wrote.
    const second = new FileVisionStores(base)
    expect(second.catalogueStore.read(catalogueKey(options))).toEqual({ fetchedAt: 1234, models: [{ id: imageModel, image: 'yes', contextLimit: 200_000 }] })
    expect(second.refusalStore.read(chatModel)).toEqual({ at: 99, detail: ROUTED_AWAY })
    second.refusalStore.clear(chatModel)
    expect(new FileVisionStores(base).refusalStore.read(chatModel)).toBeNull()
  })

  it('picks the image model from the catalogue, never the chat\'s own', () => {
    const catalogue = { fetchedAt: 1, models: [{ id: chatModel, image: 'no' } as const, { id: 'small-vision', image: 'yes' as const, contextLimit: 32_000 }, { id: imageModel, image: 'yes' as const, contextLimit: 200_000 }] }
    expect(pickImageModel(catalogue, chatModel)).toBe(imageModel)
    expect(pickImageModel(catalogue, 'small-vision')).toBe(imageModel)
    expect(pickImageModel({ fetchedAt: 1, models: [{ id: chatModel, image: 'no' }] }, chatModel)).toBeNull()
    expect(pickImageModel(null, chatModel)).toBeNull()
  })

  it('lets the person\'s own choice outrank everything learned', () => {
    const stores = new MemoryVisionStores()
    const options = optionsFor(stores)
    stores.refusalStore.write(chatModel, { at: 1, detail: ROUTED_AWAY })
    expect(visionSupport(options, chatModel, 'on')).toEqual({ state: 'yes', source: 'override' })
    expect(visionSupport(options, 'a-model-nobody-heard-of', 'off')).toEqual({ state: 'no', source: 'override' })
    expect(visionSupport(options, 'a-model-nobody-heard-of')).toEqual({ state: 'unknown', source: 'none' })
  })
})

describe('what the chat says', () => {
  it('never claims a model cannot look at images because of one 400', () => {
    const said = friendlyError(new ProviderException('HTTP 400: invalid image data for block 0', 400))
    expect(said).not.toMatch(/can't look at images/i)
    expect(said).toContain('invalid image data')

    const plain = friendlyError(new ProviderException('HTTP 400: something about an image', 400))
    expect(plain).not.toMatch(/can't look at images/i)
  })

  it('says the gateway refused to route the picture, and that nothing was lost', () => {
    const said = friendlyError(new ProviderException(ROUTED_AWAY, 400))
    expect(said).toContain('refused to route that picture')
    expect(said).toContain('Nothing was lost')
  })

  it('names a model that really takes no pictures only when the catalogue says so', () => {
    const error = new ProviderException('HTTP 400: image input is not supported by this model', 400)
    expect(friendlyError(error, { modelTakesNoImages: true })).toBe('This model takes no pictures. I can switch this chat to one that does, or you can send the text.')
    expect(friendlyError(error)).toContain('Something went wrong')
  })

  it('keeps the generic wording for every other 400', () => {
    expect(friendlyError(new ProviderException('HTTP 400: messages: field required', 400))).toContain('Something went wrong')
    expect(friendlyError(new ProviderException('HTTP 401: no', 401))).toContain('API key was rejected')
    expect(friendlyError(new ProviderException('HTTP 429: slow down', 429))).toContain('too much right now')
  })
})
