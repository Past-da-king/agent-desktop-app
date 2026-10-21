/**
 * The AI accounts the person set up, and how the old single choice (mode, provider, model, plan) reads as one of
 * them. Shared by the main process and the window so both see the same list and the same labels.
 */
import { LEGACY_ACCOUNT, NO_PICK, type AiAccount, type AiAccountKind, type AiPick, type AiPicks, type Settings } from './ipc'
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
  const own = settings.ai?.[slot] ?? NO_PICK
  if (slot === 'helpers' && own.account.trim() === '') return mainPickOf(settings, 'main')
  if (accountById(settings, own.account) !== null) return own
  const first = accountsOf(settings)[0]
  return first === undefined ? NO_PICK : { account: first.id, model: own.model }
}

/** A project's pick for a slot over the main thread's: '' account means the main thread's choice for that slot. */
export function resolvePick(settings: Settings, project: AiPicks | undefined, slot: AiSlot): AiPick {
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
