/**
 * The AI accounts the person set up, and how the old single choice (mode, provider, model, plan) reads as one of
 * them. Shared by the main process and the window so both see the same list and the same labels.
 */
import { LEGACY_ACCOUNT, NO_PICK, type AiAccount, type AiAccountKind, type AiPick, type AiPicks, type AiRosterEntry, type Settings } from './ipc'
import { providerInfo } from './providers/catalog'

/** 'plan:claude', 'plan:codex' or 'api': a chat can switch within a family mid-way, across families only afresh. */
export type BrainFamily = 'plan:claude' | 'plan:codex' | 'api'

export function accountFamily(account: AiAccount): BrainFamily {
  return account.kind === 'api' ? 'api' : `plan:${account.kind}`
}

/** The old single choice as an account, or null when none was ever set up. */
export function legacyAccount(settings: Settings): AiAccount | null {
  if (settings.mode === 'subscription') {
    const kind: AiAccountKind = settings.cli === 'codex' ? 'codex' : 'claude'
    return { id: LEGACY_ACCOUNT, label: kind === 'codex' ? 'ChatGPT plan' : 'Claude plan', kind, model: settings.cliModel.trim(), hasKey: false }
  }
  if (settings.mode === 'api_key') {
    return {
      id: LEGACY_ACCOUNT,
      label: providerInfo(settings.provider)?.label ?? settings.provider,
      kind: 'api',
      provider: settings.provider,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      hasKey: settings.hasKey,
      allowHttp: settings.allowHttp,
    }
  }
  return null
}

/** Every account: the list, or the old single choice when the list is empty. */
export function accountsOf(settings: Settings): AiAccount[] {
  if (settings.accounts.length > 0) return settings.accounts
  const legacy = legacyAccount(settings)
  return legacy === null ? [] : [legacy]
}

export function accountById(settings: Settings, id: string | undefined | null): AiAccount | null {
  const all = accountsOf(settings)
  const wanted = (id ?? '').trim()
  return (wanted === '' ? null : (all.find((account) => account.id === wanted) ?? null))
}

export type AiSlot = 'main' | 'helpers'

/** The main thread's pick for a slot, resolved: helpers fall back to main; a missing account to the first there is. */
export function mainPickOf(settings: Settings, slot: AiSlot = 'main'): AiPick {
  // Helpers with a list of models: the first is the default.
  if (slot === 'helpers') {
    const first = knownRoster(settings, settings.ai?.roster)[0]
    if (first !== undefined) return { account: first.account, model: first.model }
  }
  const own = settings.ai?.[slot] ?? NO_PICK
  if (slot === 'helpers' && own.account.trim() === '') return mainPickOf(settings, 'main')
  if (accountById(settings, own.account) !== null) return own
  const first = accountsOf(settings)[0]
  return first === undefined ? NO_PICK : { account: first.id, model: own.model }
}

/** A project's pick for a slot over the main thread's: '' account means the main thread's choice for that slot. */
export function resolvePick(settings: Settings, project: AiPicks | undefined, slot: AiSlot): AiPick {
  if (slot === 'helpers') {
    const first = knownRoster(settings, project?.roster)[0]
    if (first !== undefined) return { account: first.account, model: first.model }
  }
  const own = project?.[slot] ?? NO_PICK
  if (own.account.trim() !== '' && accountById(settings, own.account) !== null) return own
  if (slot === 'helpers' && (project?.main.account ?? '').trim() !== '' && accountById(settings, project?.main.account) !== null) return project?.main ?? NO_PICK
  return mainPickOf(settings, slot)
}

/** The model a pick runs: its own, else the account's default. */
export function pickModel(settings: Settings, pick: AiPick): string {
  const own = pick.model.trim()
  if (own !== '') return own
  return accountById(settings, pick.account)?.model.trim() ?? ''
}

/** The main agent's account: the chosen one, else the first there is. */
export function mainAccountOf(settings: Settings): AiAccount | null {
  return accountById(settings, mainPickOf(settings, 'main').account)
}

/** "Claude plan · opus", "OpenCode Go · deepseek-v4.1-flash". */
export function accountLine(account: AiAccount): string {
  const model = account.model.trim()
  return model === '' ? (account.kind === 'api' ? account.label : `${account.label} · Default`) : `${account.label} · ${model}`
}

/** The old fields as the main pick has them, so older code keeps reading the right thing. */
export function legacyFieldsOf(main: AiAccount | null, model = ''): Pick<Settings, 'mode' | 'cli' | 'cliModel' | 'provider' | 'model' | 'baseUrl' | 'allowHttp' | 'hasKey'> {
  if (main === null) return { mode: 'none', cli: '', cliModel: '', provider: 'anthropic', model: '', baseUrl: '', allowHttp: false, hasKey: false }
  const chosen = model.trim() || main.model
  if (main.kind === 'api') {
    return { mode: 'api_key', cli: '', cliModel: '', provider: main.provider ?? 'anthropic', model: chosen, baseUrl: main.baseUrl ?? '', allowHttp: main.allowHttp === true, hasKey: main.hasKey }
  }
  return { mode: 'subscription', cli: main.kind, cliModel: chosen, provider: 'anthropic', model: '', baseUrl: '', allowHttp: false, hasKey: false }
}

/** The secret name an account's key is kept under. */
export function keyNameFor(id: string): string {
  return `apiKey-${id.replace(/[^A-Za-z0-9_-]/g, '')}`
}

/** A fresh account id: short, file-safe. */
export function newAccountId(random: () => number = Math.random): string {
  return `a${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`
}

// ---- helpers: a list of models, chosen per job ------------------------------------------------------------------

export const MAX_ROSTER = 8
export const GOOD_FOR_MAX = 120

/** A roster as stored, cleaned: well formed, trimmed, no repeats, at most MAX_ROSTER. Accounts are not checked. */
export function cleanRoster(raw: unknown): AiRosterEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AiRosterEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const account = typeof o['account'] === 'string' ? o['account'].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : ''
    if (account === '') continue
    const model = typeof o['model'] === 'string' ? o['model'].trim().slice(0, 200) : ''
    const goodFor = typeof o['goodFor'] === 'string' ? o['goodFor'].replace(/\s+/g, ' ').trim().slice(0, GOOD_FOR_MAX) : ''
    const key = `${account}\u0000${model.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ account, model, goodFor })
    if (out.length >= MAX_ROSTER) break
  }
  return out
}

/** The roster entries whose account still exists. */
export function knownRoster(settings: Settings, roster: AiRosterEntry[] | undefined): AiRosterEntry[] {
  return cleanRoster(roster ?? []).filter((entry) => accountById(settings, entry.account) !== null)
}

/** The main thread's helper models: its list, else its one helpers pick. */
export function mainRosterOf(settings: Settings): AiRosterEntry[] {
  const own = knownRoster(settings, settings.ai?.roster)
  if (own.length > 0) return own
  const pick = mainPickOf(settings, 'helpers')
  return pick.account === '' ? [] : [{ account: pick.account, model: pick.model, goodFor: '' }]
}

/**
 * The helper models a chat may use: its project's list; else the project's one helpers pick (or its agent's, which
 * helpers follow when they have none of their own); else the main thread's list.
 */
export function resolveRoster(settings: Settings, project: AiPicks | undefined): AiRosterEntry[] {
  const own = knownRoster(settings, project?.roster)
  if (own.length > 0) return own
  if (project !== undefined) {
    for (const pick of [project.helpers, project.main]) {
      if (pick.account.trim() !== '' && accountById(settings, pick.account) !== null) return [{ account: pick.account, model: pick.model, goodFor: '' }]
    }
  }
  return mainRosterOf(settings)
}

/** "Claude plan · opus": how a roster entry reads, to the person and to the agent. */
export function rosterName(settings: Settings, entry: Pick<AiRosterEntry, 'account' | 'model'>): string {
  const account = accountById(settings, entry.account)
  const model = pickModel(settings, entry)
  if (account === null) return model || 'Not set up'
  return model === '' ? (account.kind === 'api' ? account.label : `${account.label} · Default`) : `${account.label} · ${model}`
}

/** What a model is likely good for when the person wrote nothing: read from its name. */
export function defaultGoodFor(model: string): string {
  const m = model.toLowerCase()
  if (/opus|o3|o1|gpt-5(?!.*mini)|pro\b|-pro|r1|reason/.test(m)) return 'strongest reasoning, code and long writing; slower and dearer'
  if (/haiku|flash|mini|nano|lite|small|8b|turbo/.test(m)) return 'fast and cheap: lookups, scraping, simple browser steps'
  if (/sonnet|fable|gpt-4|gemini|deepseek|qwen|llama|mistral|kimi|glm/.test(m)) return 'balanced: most jobs'
  return 'general work'
}

/**
 * The roster entry a delegated job names: "Claude plan · opus", the model id, the account's name when only one entry
 * is on it, or a unique partial match. '' = the first (the default).
 */
export function findRosterEntry(
  settings: Settings,
  roster: AiRosterEntry[],
  wanted: string | undefined,
): { entry: AiRosterEntry } | { error: string } {
  const first = roster[0]
  if (first === undefined) return { error: 'No helper models are set up. Add an AI account in Settings.' }
  const q = (wanted ?? '').trim().toLowerCase()
  if (q === '') return { entry: first }
  const names = roster.map((entry) => rosterName(settings, entry))
  const exact = roster.findIndex((_, i) => names[i]!.toLowerCase() === q)
  if (exact >= 0) return { entry: roster[exact]! }
  const byModel = roster.filter((entry) => pickModel(settings, entry).toLowerCase() === q)
  if (byModel.length === 1) return { entry: byModel[0]! }
  const byAccount = roster.filter((entry) => (accountById(settings, entry.account)?.label ?? '').toLowerCase() === q)
  if (byAccount.length === 1) return { entry: byAccount[0]! }
  const partial = roster.filter((_, i) => names[i]!.toLowerCase().includes(q))
  if (partial.length === 1) return { entry: partial[0]! }
  const choices = names.map((name) => `"${name}"`).join(', ')
  return { error: partial.length > 1 ? `"${wanted}" matches more than one helper model. Use one of: ${choices}. Nothing was started.` : `No helper model called "${wanted}". Use one of: ${choices}, or leave model out for the first. Nothing was started.` }
}
