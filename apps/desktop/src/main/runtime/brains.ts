/**
 * Which AI thinks for a chat. Every chat has two picks: one for the agent that talks in it, one for the helpers it
 * starts. The main thread's picks are in Settings; a project may set its own (or leave one as "same as the main
 * thread"). One place decides, for every turn, helper, routine and memory pass:
 *
 *  - `pickFor(chat, slot)`: the account and model a chat is set to for that slot.
 *  - `brainFor(pick)`: that pick as something that can run: a plan (Claude or Codex) or a provider with a key.
 *  - `pickBrain(chat)`: the chat's own agent, with the switch rule: a change within the same family (another API
 *    provider, another model on the same plan) applies on the next message; a change of family (plan to key, Claude
 *    to Codex) waits for the chat's next new chat, because the engine's own session cannot carry over.
 *  - `helperBrain(chat)`: the helpers' pick, which applies at once (every helper is a fresh session).
 */
import {
  MAIN_CHAT,
  PROVIDERS,
  accountById,
  accountFamily,
  mainPickOf,
  mainRosterOf,
  pickModel,
  resolvePick,
  resolveRoster,
  type AiAccount,
  type AiPick,
  type AiRosterEntry,
  type AiSlot,
  type BrainFamily,
  type ChatBrain,
  type ChatBrainSlot,
  type LlmProvider,
  type Settings,
} from '@agent/core'

import { latestDividerAt } from '../memory/chats'
import { keyFor } from '../accounts'
import type { CliId } from './cli-agent'
import { listWhere, type DataStore } from './data'

/**
 * The same shape runtime/runner.ts has: a provider for these settings and this key, or null. A session id is how a
 * provider that routes each request by it (OpenCode Go) is put on a fresh route: the same call, another engine.
 */
export type ProviderFactory = (settings: Settings, apiKey: string, sessionId?: string) => LlmProvider | null

export type Brain =
  | { kind: 'plan'; cli: CliId; model: string; account: AiAccount }
  | { kind: 'api'; provider: LlmProvider; model: string; account: AiAccount }

export type BrainOutcome = Brain | { kind: 'none'; message: string }

export interface BrainDeps {
  settings: { get(): Settings }
  secrets: { get(name: string): string | null }
  providerFactory: ProviderFactory
  /** Whether this build can run on a plan at all. */
  hasCli: boolean
  store?: DataStore
  locks?: BrainLocks
}

/** What a chat's own agent last ran on, kept until its next new chat (the divider it was on). */
export interface BrainLock {
  account: string
  model: string
  family: BrainFamily
  divider: number
}

/** The locks, kept where the app likes (a JSON file; memory in tests). */
export interface BrainLocks {
  get(chat: string): BrainLock | null
  set(chat: string, lock: BrainLock): void
}

export class MemoryBrainLocks implements BrainLocks {
  private readonly map = new Map<string, BrainLock>()
  get(chat: string): BrainLock | null {
    return this.map.get(chat) ?? null
  }
  set(chat: string, lock: BrainLock): void {
    this.map.set(chat, lock)
  }
}

export function isBrain(outcome: BrainOutcome): outcome is Brain {
  return outcome.kind !== 'none'
}

/** The pick a chat is set to for a slot: its project's, else the main thread's. */
export async function pickFor(deps: Pick<BrainDeps, 'settings' | 'store'>, chat: string, slot: AiSlot): Promise<AiPick> {
  const settings = deps.settings.get()
  if (chat !== MAIN_CHAT && deps.store !== undefined) {
    try {
      const project = (await deps.store.list('project')).find((each) => each.chats.includes(chat))
      return resolvePick(settings, project?.ai, slot)
    } catch {
      // A store that cannot answer: the main thread's pick.
    }
  }
  return mainPickOf(settings, slot)
}

/** The helper models a chat may use (its project's list, else the main thread's), first = the default. */
export async function rosterFor(deps: Pick<BrainDeps, 'settings' | 'store'>, chat: string): Promise<AiRosterEntry[]> {
  const settings = deps.settings.get()
  if (chat !== MAIN_CHAT && deps.store !== undefined) {
    try {
      const project = (await deps.store.list('project')).find((each) => each.chats.includes(chat))
      if (project !== undefined) return resolveRoster(settings, project.ai)
    } catch {
      // A store that cannot answer: the main thread's list.
    }
  }
  return mainRosterOf(settings)
}

/** A pick as something that can run now, or why it cannot. */
export function brainFor(deps: Pick<BrainDeps, 'settings' | 'secrets' | 'providerFactory' | 'hasCli'>, pick: AiPick): BrainOutcome {
  const settings = deps.settings.get()
  const account = accountById(settings, pick.account)
  if (account === null) return { kind: 'none', message: 'Add an AI key in Settings to start' }
  const model = pickModel(settings, pick)
  if (account.kind !== 'api') {
    if (!deps.hasCli) return { kind: 'none', message: 'This build cannot run on a plan. Add an API key account in Settings.' }
    return { kind: 'plan', cli: account.kind, model, account }
  }
  const key = keyFor(deps.secrets, account.id)
  if (!account.hasKey || key === '') return { kind: 'none', message: `${account.label} has no API key yet. Add an AI key in Settings.` }
  const provider = account.provider ?? 'anthropic'
  const chosen = model || PROVIDERS.find((each) => each.id === provider)?.defaultModel || ''
  if (chosen === '') return { kind: 'none', message: `Choose a model for ${account.label} in Settings.` }
  if (provider === 'custom' && (account.baseUrl ?? '').trim() === '') return { kind: 'none', message: `Add the server address for ${account.label} in Settings.` }
  const made = providerForAccount(deps, account, chosen)
  if (made === null) return { kind: 'none', message: `${account.label} could not be set up. Check it in Settings.` }
  return { kind: 'api', provider: made, model: chosen, account }
}

/**
 * A key account's provider for one model, on a fresh routing session when one is named. This is also how a turn
 * retries a picture the gateway refused to route: same provider, same model, a new session id (runtime/vision.ts).
 */
export function providerForAccount(
  deps: Pick<BrainDeps, 'settings' | 'secrets' | 'providerFactory'>,
  account: AiAccount,
  model: string,
  sessionId?: string,
): LlmProvider | null {
  if (account.kind !== 'api') return null
  const settings = deps.settings.get()
  const key = keyFor(deps.secrets, account.id)
  const provider = account.provider ?? 'anthropic'
  const chosen = model.trim() || PROVIDERS.find((each) => each.id === provider)?.defaultModel || ''
  if (key === '') return null
  if (chosen === '') return null
  try {
    return deps.providerFactory(
      { ...settings, provider, baseUrl: account.baseUrl ?? '', allowHttp: account.allowHttp === true, model: chosen, hasKey: true, mode: 'api_key' },
      key,
      ...(sessionId === undefined ? [] : [sessionId]),
    )
  } catch {
    return null
  }
}

/** The brain for the main thread's agent, routines and the memory pass. */
export function mainBrain(deps: BrainDeps): BrainOutcome {
  return brainFor(deps, mainPickOf(deps.settings.get(), 'main'))
}

/** What a chat's own agent runs on now: its pick, unless a change of family waits for its next new chat. */
export async function pickBrain(deps: BrainDeps, chat: string): Promise<BrainOutcome> {
  const slot = await slotNow(deps, chat)
  const brain = brainFor(deps, slot.using)
  if (isBrain(brain)) deps.locks?.set(chat, { account: slot.using.account, model: slot.using.model, family: accountFamily(brain.account), divider: slot.divider })
  return brain
}

/** What the helpers a chat starts run on: the chat's helpers pick, at once. */
export async function helperBrain(deps: BrainDeps, chat: string): Promise<BrainOutcome> {
  return brainFor(deps, await pickFor(deps, chat, 'helpers'))
}

/** For the picker in a chat's header. */
export async function chatBrainOf(deps: BrainDeps, chat: string): Promise<ChatBrain> {
  const main = await slotNow(deps, chat)
  const helpers = await pickFor(deps, chat, 'helpers')
  const settings = deps.settings.get()
  const full = (pick: AiPick): AiPick => ({ account: pick.account, model: pickModel(settings, pick) })
  return {
    main: { wanted: full(main.wanted), using: full(main.using), deferred: main.deferred },
    helpers: { wanted: full(helpers), using: full(helpers), deferred: false },
  }
}

async function slotNow(deps: BrainDeps, chat: string): Promise<ChatBrainSlot & { divider: number }> {
  const settings = deps.settings.get()
  const wanted = await pickFor(deps, chat, 'main')
  const divider = await dividerOf(deps, chat)
  const lock = deps.locks?.get(chat) ?? null
  const lockedAccount = lock !== null && lock.divider === divider ? accountById(settings, lock.account) : null
  const wantedAccount = accountById(settings, wanted.account)
  const deferred = lockedAccount !== null && wantedAccount !== null && accountFamily(lockedAccount) !== accountFamily(wantedAccount)
  const using = deferred && lock !== null ? { account: lock.account, model: lock.model } : wanted
  return { wanted, using, deferred, divider }
}

async function dividerOf(deps: Pick<BrainDeps, 'store'>, chat: string): Promise<number> {
  if (deps.store === undefined) return 0
  try {
    // Dividers are notices: never every chat row (hundreds of MB) on each turn.
    const rows = (await listWhere(deps.store, 'chat_item', { kind: 'notice', chat })).filter((row) => chatOfRow(row) === chat)
    return latestDividerAt(rows)
  } catch {
    return 0
  }
}

function chatOfRow(row: { meta: string }): string {
  try {
    const meta = JSON.parse(row.meta) as Record<string, unknown>
    return typeof meta['chat'] === 'string' && meta['chat'] !== '' ? meta['chat'] : MAIN_CHAT
  } catch {
    return MAIN_CHAT
  }
}
