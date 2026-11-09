/**
 * The AI accounts the person set up: adding, changing and removing them, their keys in the secrets module, and the
 * one-time move from the old single choice (mode, provider, model, plan) to a list with one account in it.
 */
import {
  LEGACY_ACCOUNT,
  accountById,
  accountsOf,
  keyNameFor,
  legacyAccount,
  newAccountId,
  type AiAccount,
  type AiAccountDraft,
  type Settings,
} from '@agent/core'

export interface SettingsLike {
  get(): Settings
  save(patch: Partial<Settings>): Settings
}

export interface SecretsLike {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}

/**
 * On start: an install that only ever had the single choice gets it as account "default", with its key moved to
 * that account's own secret. Runs once; a list that already exists is left alone.
 */
export function migrateLegacyAccount(settings: SettingsLike, secrets: SecretsLike): AiAccount | null {
  const current = settings.get()
  if (current.accounts.length > 0) return null
  const legacy = legacyAccount(current)
  if (legacy === null) return null
  const oldKey = secrets.get('apiKey')
  if (legacy.kind === 'api' && oldKey !== null && oldKey.trim() !== '') {
    secrets.set(keyNameFor(LEGACY_ACCOUNT), oldKey)
    legacy.hasKey = true
  }
  // A plan that was signed in beside an API key (the old AI step kept both) becomes a second account, so it is
  // there to pick for a project without setting it up again.
  const plan: AiAccount[] =
    legacy.kind === 'api' && (current.cli === 'claude' || current.cli === 'codex')
      ? [{ id: `plan-${current.cli}`, label: current.cli === 'codex' ? 'ChatGPT plan' : 'Claude plan', kind: current.cli, model: current.cliModel.trim(), hasKey: false }]
      : []
  settings.save({ accounts: [legacy, ...plan], ai: { main: { account: LEGACY_ACCOUNT, model: '' }, helpers: { account: '', model: '' } } })
  return legacy
}

/** The key for an account: its own secret, or the old single key for the migrated account. */
export function keyFor(secrets: Pick<SecretsLike, 'get'>, id: string): string {
  const own = secrets.get(keyNameFor(id))
  if (own !== null && own.trim() !== '') return own.trim()
  if (id === LEGACY_ACCOUNT) return (secrets.get('apiKey') ?? '').trim()
  return ''
}

export class AccountStore {
  constructor(
    private readonly settings: SettingsLike,
    private readonly secrets: SecretsLike,
    private readonly random: () => number = Math.random,
  ) {}

  all(): AiAccount[] {
    return accountsOf(this.settings.get())
  }

  find(id: string): AiAccount | null {
    return accountById(this.settings.get(), id)
  }

  /** The list as stored (the old single choice becomes a real row the first time the list changes). */
  private list(): AiAccount[] {
    const current = this.settings.get()
    return current.accounts.length > 0 ? [...current.accounts] : accountsOf(current)
  }

  add(draft: AiAccountDraft): AiAccount {
    const kind = draft.kind ?? 'api'
    const list = this.list()
    let id = newAccountId(this.random)
    for (let n = 2; list.some((account) => account.id === id); n += 1) id = `${newAccountId(this.random)}${n}`
    const account: AiAccount = {
      id,
      label: (draft.label ?? '').trim().slice(0, 60) || (kind === 'api' ? 'API key' : kind === 'codex' ? 'ChatGPT plan' : 'Claude plan'),
      kind,
      model: (draft.model ?? '').trim(),
      hasKey: false,
    }
    if (kind === 'api') {
      account.provider = draft.provider ?? 'anthropic'
      if ((draft.baseUrl ?? '').trim() !== '') account.baseUrl = (draft.baseUrl ?? '').trim()
      if (draft.allowHttp === true) account.allowHttp = true
    }
    if (draft.pictures === 'on' || draft.pictures === 'off') account.pictures = draft.pictures
    const next = [...list, account]
    this.settings.save({ accounts: next })
    return account
  }

  update(id: string, patch: AiAccountDraft): AiAccount {
    const list = this.list()
    const current = list.find((account) => account.id === id)
    if (current === undefined) throw new Error('No such account')
    const kind = patch.kind ?? current.kind
    const next: AiAccount = {
      ...current,
      kind,
      label: patch.label === undefined ? current.label : patch.label.trim().slice(0, 60) || current.label,
      model: patch.model === undefined ? current.model : patch.model.trim(),
    }
    if (kind === 'api') {
      next.provider = patch.provider ?? current.provider ?? 'anthropic'
      const baseUrl = patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl.trim()
      if (baseUrl !== undefined && baseUrl !== '') next.baseUrl = baseUrl
      else delete next.baseUrl
      if (patch.allowHttp === undefined ? current.allowHttp === true : patch.allowHttp) next.allowHttp = true
      else delete next.allowHttp
    } else {
      delete next.provider
      delete next.baseUrl
      delete next.allowHttp
      next.hasKey = false
    }
    // Pictures are the person's choice, whatever kind of account it is; 'auto' is stored as absent.
    const pictures = patch.pictures === undefined ? current.pictures : patch.pictures
    if (pictures === 'on' || pictures === 'off') next.pictures = pictures
    else delete next.pictures
    this.settings.save({ accounts: list.map((account) => (account.id === id ? next : account)) })
    return next
  }

  remove(id: string): void {
    const list = this.list()
    if (!list.some((account) => account.id === id)) return
    this.secrets.delete(keyNameFor(id))
    if (id === LEGACY_ACCOUNT) this.secrets.delete('apiKey')
    const next = list.filter((account) => account.id !== id)
    const current = this.settings.get()
    const clear = (pick: { account: string; model: string }): { account: string; model: string } => (pick.account === id ? { account: '', model: '' } : pick)
    this.settings.save({ accounts: next, ai: { main: clear(current.ai.main), helpers: clear(current.ai.helpers) } })
  }

  setKey(id: string, key: string): void {
    const list = this.list()
    const current = list.find((account) => account.id === id)
    if (current === undefined) throw new Error('No such account')
    const value = key.trim()
    if (value === '') this.secrets.delete(keyNameFor(id))
    else this.secrets.set(keyNameFor(id), value)
    this.settings.save({ accounts: list.map((account) => (account.id === id ? { ...account, hasKey: value !== '' } : account)) })
  }

  key(id: string): string {
    return keyFor(this.secrets, id)
  }
}
