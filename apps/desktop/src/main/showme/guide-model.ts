/**
 * The model that walks the steps ("show me how", 10 Nov 2026): a SMALL, FAST one, never the big model, because it
 * answers between his clicks. Nothing is hardcoded: the choice is the setting `guideModel` (an account and a model
 * from the AI accounts the person has), and left on Automatic it is worked out from what the accounts offer today:
 *
 *   - the account: the one the main chat uses, when it is a key account (a direct call answers in well under a
 *     second); when the main chat runs on a plan, the first key account there is, because starting a plan's engine
 *     for a one-line answer takes seconds; with no key account at all, the plan itself.
 *   - the model: the smallest fast one that account lists right now (asked of the provider or the plan, kept for a
 *     few minutes), judged by the class its name says it is. The same reading of names the helper picker already
 *     uses (core accounts.ts defaultGoodFor); no model id appears in this file.
 *
 * What is on screen goes only to that account: the person's own.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { accountById, accountsOf, knownRoster, mainPickOf, msgText, type AiAccount, type AiPick, type LlmProvider, type Msg, type Settings } from '@agent/core'

import { keyFor } from '../accounts'
import { providerForAccount, type ProviderFactory } from '../runtime/brains'

export interface GuideModel {
  /** "OpenCode Go · some-fast-model", for the log and Settings. */
  name: string
  /** Can it be shown a picture (the last-resort fallback)? */
  vision: boolean
  complete(system: string, prompt: string, options?: { image?: Buffer; maxTokens?: number; signal?: AbortSignal }): Promise<string>
}

/** 0 = small and fast, 1 = balanced, 2 = the big ones. Read from the class a model's name says it is. */
export function modelSpeed(id: string): 0 | 1 | 2 {
  const m = id.toLowerCase()
  if (/haiku|flash|mini|nano|lite|small|instant|\b8b\b|tiny/.test(m)) return 0
  if (/opus|\bo[134]\b|gpt-5|ultra|\bpro\b|-pro|\br1\b|reason|think|fable|max\b/.test(m)) return 2
  return 1
}

/** The smallest fast model of a list (the first of the fastest class, in the order the provider gave), '' for none. */
export function smallestModel(ids: string[]): string {
  let best = ''
  let bestSpeed = 3
  for (const id of ids) {
    const clean = id.trim()
    if (clean === '') continue
    const speed = modelSpeed(clean)
    if (speed < bestSpeed) {
      best = clean
      bestSpeed = speed
    }
  }
  return best
}

function usable(account: AiAccount, secrets: { get(name: string): string | null }): boolean {
  return account.kind !== 'api' || (account.hasKey && keyFor(secrets, account.id) !== '')
}

/** The account a walk thinks with: the setting's, else the automatic choice described at the top. Null with none. */
export function guideAccount(settings: Settings, secrets: { get(name: string): string | null }, hasCli: boolean): AiAccount | null {
  const chosen = accountById(settings, settings.guideModel?.account)
  if (chosen !== null && usable(chosen, secrets) && (chosen.kind === 'api' || hasCli)) return chosen
  const main = accountById(settings, mainPickOf(settings, 'main').account)
  if (main !== null && main.kind === 'api' && usable(main, secrets)) return main
  const keyed = accountsOf(settings).find((account) => account.kind === 'api' && usable(account, secrets))
  if (keyed !== undefined) return keyed
  if (!hasCli) return null
  // No key account at all: the plan (the main chat's, else any).
  if (main !== null && main.kind !== 'api') return main
  return accountsOf(settings).find((account) => account.kind !== 'api') ?? null
}

/** The models already named for an account in Settings (its own, and the picks that use it), for when it lists none. */
function namedModels(settings: Settings, account: AiAccount): string[] {
  const picks: AiPick[] = [settings.ai?.main ?? { account: '', model: '' }, settings.ai?.helpers ?? { account: '', model: '' }, ...knownRoster(settings, settings.ai?.roster)]
  return [...picks.filter((pick) => pick.account === account.id).map((pick) => pick.model), account.model].filter((model) => model.trim() !== '')
}

export interface GuideModelDeps {
  settings: { get(): Settings }
  secrets: { get(name: string): string | null }
  providerFactory: ProviderFactory
  /** Whether this build can run on a plan at all. */
  hasCli: boolean
  /** The model ids an account offers right now (the provider's list, or the plan's). */
  listModels(account: AiAccount): Promise<string[]>
  /** One tool-free answer from a plan's engine. Absent: a plan account cannot guide. */
  planTurn?: (account: AiAccount, model: string, system: string, prompt: string, signal: AbortSignal) => Promise<string>
  /** Where a picture for the model is written for the moment it is sent. */
  tmpDir: string
  now?: () => number
}

const LIST_FOR_MS = 10 * 60_000
const LIST_WAIT_MS = 4_000

export class GuideModels {
  private readonly lists = new Map<string, { at: number; ids: string[] }>()
  private readonly noVision = new Set<string>()
  private seq = 0

  constructor(private readonly deps: GuideModelDeps) {}

  /** What a walk would think with now, in words, for Settings and the log: { account, model } or why there is none. */
  async describe(): Promise<{ ok: true; account: string; model: string } | { ok: false; message: string }> {
    const picked = await this.pick()
    return 'message' in picked ? { ok: false, message: picked.message } : { ok: true, account: picked.account.label, model: picked.model }
  }

  private async pick(): Promise<{ account: AiAccount; model: string } | { message: string }> {
    const settings = this.deps.settings.get()
    const account = guideAccount(settings, this.deps.secrets, this.deps.hasCli)
    if (account === null) return { message: 'Add an AI account in Settings to be shown how.' }
    const own = settings.guideModel?.account === account.id ? (settings.guideModel?.model ?? '').trim() : ''
    if (own !== '') return { account, model: own }
    const listed = await this.listed(account)
    const model = smallestModel(listed.length > 0 ? listed : namedModels(settings, account))
    return { account, model }
  }

  private async listed(account: AiAccount): Promise<string[]> {
    const now = (this.deps.now ?? Date.now)()
    const known = this.lists.get(account.id)
    if (known !== undefined && now - known.at < LIST_FOR_MS) return known.ids
    let ids: string[] = []
    try {
      ids = await Promise.race([this.deps.listModels(account), new Promise<string[]>((resolve) => setTimeout(() => resolve([]), LIST_WAIT_MS).unref?.())])
    } catch {
      ids = []
    }
    // An empty answer is not kept: the provider may only have been slow this once.
    if (ids.length > 0) this.lists.set(account.id, { at: now, ids })
    return ids
  }

  /** The model for a walk, ready to call, or why there is none. */
  async resolve(): Promise<GuideModel | { message: string }> {
    const picked = await this.pick()
    if ('message' in picked) return picked
    const { account, model } = picked
    const name = `${account.label}${model === '' ? '' : ` · ${model}`}`
    if (account.kind !== 'api') {
      const planTurn = this.deps.planTurn
      if (planTurn === undefined) return { message: 'Being shown how needs an API key account on this build.' }
      return {
        name,
        vision: false,
        complete: (system, prompt, options) => planTurn(account, model, system, prompt, options?.signal ?? new AbortController().signal),
      }
    }
    const provider: LlmProvider | null = providerForAccount(this.deps, account, model)
    if (provider === null) return { message: `${account.label} could not be set up. Check it in Settings.` }
    const key = `${account.id}|${model}`
    const self = this
    const guide: GuideModel = {
      name,
      get vision(): boolean {
        return !self.noVision.has(key)
      },
      complete: async (system, prompt, options) => {
        const image = options?.image
        if (image === undefined || image.length === 0) {
          const done = await provider.complete(system, [{ role: 'USER', blocks: [{ t: 'text', text: prompt }] }], [], model, options?.maxTokens ?? 900, options?.signal)
          return msgText(done.message)
        }
        mkdirSync(this.deps.tmpDir, { recursive: true })
        const path = join(this.deps.tmpDir, `showme-${process.pid}-${++this.seq}.png`)
        writeFileSync(path, image, { mode: 0o600 })
        try {
          const message: Msg = { role: 'USER', blocks: [{ t: 'image', path, mime: 'image/png' }, { t: 'text', text: prompt }] }
          const done = await provider.complete(system, [message], [], model, options?.maxTokens ?? 300, options?.signal)
          return msgText(done.message)
        } catch (error) {
          // A model that takes no pictures is not shown one again this session.
          if (options?.signal?.aborted !== true) this.noVision.add(key)
          throw error
        } finally {
          // The picture of his screen is never kept.
          rmSync(path, { force: true })
        }
      },
    }
    return guide
  }
}
