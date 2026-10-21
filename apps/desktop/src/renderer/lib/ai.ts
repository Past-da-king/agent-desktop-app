import { PROVIDERS, accountById, accountsOf, pickModel, resolvePick, type AiAccount, type AiPick, type AiPicks, type AiSlot, type ProjectRow, type ProviderId, type Settings } from '@agent/core'

/** "Claude plan", "OpenCode Go": the account's own name. */
export function accountName(settings: Settings | null, id: string): string {
  if (settings === null) return ''
  return accountById(settings, id)?.label ?? ''
}

/** What a pick reads as in a menu: "Claude plan · opus" or "OpenCode Go · deepseek-v4.1-flash". */
export function pickLine(settings: Settings | null, pick: AiPick): string {
  if (settings === null) return ''
  const account = accountById(settings, pick.account)
  if (account === null) return 'Not set up'
  const model = pickModel(settings, pick)
  return model === '' ? (account.kind === 'api' ? account.label : `${account.label} · Default`) : `${account.label} · ${model}`
}

/** A short word for what kind of account it is. */
export function kindLine(account: AiAccount): string {
  if (account.kind === 'claude') return 'On your Claude plan, no key'
  if (account.kind === 'codex') return 'On your ChatGPT plan, through Codex'
  const provider = PROVIDERS.find((each) => each.id === account.provider)
  return `${provider?.label ?? account.provider ?? 'API'} key`
}

/** What a chat's slot is set to: the project's pick over the main thread's. */
export function pickOfChat(settings: Settings | null, project: ProjectRow | null, slot: AiSlot): AiPick {
  if (settings === null) return { account: '', model: '' }
  return resolvePick(settings, project?.ai, slot)
}

export function hasAccounts(settings: Settings | null): boolean {
  return settings !== null && accountsOf(settings).length > 0
}

/** Where a provider hands out keys, for the "Open ..." link. */
export const CONSOLE_URLS: Partial<Record<ProviderId, string>> = {
  anthropic: 'https://console.anthropic.com',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  opencode_go: 'https://opencode.ai/auth',
  opencode_zen: 'https://opencode.ai/auth',
  openrouter: 'https://openrouter.ai/keys',
}

/** Two picks with one slot changed. */
export function withPick(picks: AiPicks | undefined, slot: AiSlot, pick: AiPick): AiPicks {
  const base: AiPicks = picks ?? { main: { account: '', model: '' }, helpers: { account: '', model: '' } }
  return { ...base, [slot]: pick }
}
