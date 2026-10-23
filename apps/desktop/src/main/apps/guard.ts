/**
 * The one gate every connected-app action goes through, enforced in code rather than asked of the
 * model (reference phone tools/AppGuard.kt): which account it runs in, and what that account allows.
 * Reading and changing things are each Allowed, Ask first or Never, per account.
 *
 * A helper works inside one profile: it may only use that profile's accounts, and with one account of
 * the app in the profile, that one is picked for it. The main agent has no profile: with no account
 * named, the action is held to the strictest of that app's accounts, because Composio picks its default.
 */
import type { AccountRules, AgentProfileInfo, AppRule, ToolContext } from '@agent/core'

import { needsYes } from '../ask-rule'
import { appName } from './catalog'
import type { AppAccount } from './composio'

export interface GuardDeps {
  rulesFor(accountId: string | null): AccountRules
  /** The person's accounts for these candidate app slugs (for example microsoft, microsoft_teams). */
  accountsFor(apps: string[]): Promise<AppAccount[]>
  /** The profile the agent behind this call works in, or null (the main agent). */
  profileOf?(ctx: ToolContext): AgentProfileInfo | null
}

function listOf(accounts: AppAccount[]): string {
  return accounts.map((acc) => `${acc.label} (account ${acc.id})`).join(', ')
}

export interface Verdict {
  /** Why it may not run, said to the agent. */
  refuse?: string
  /** The account picked for it, to pass on the call. */
  account: string | null
}

const WRITE_WORDS =
  /(SEND|REPLY|FORWARD|CREATE|DELETE|REMOVE|TRASH|UPDATE|PATCH|POST|PUBLISH|PAY|PURCHASE|ARCHIVE|MOVE|INVITE|SHARE|INSERT|UPLOAD|ACCEPT|DECLINE|CANCEL)/
const WRITE_TOKENS = new Set([
  'ADD', 'SET', 'EDIT', 'MODIFY', 'WRITE', 'MARK', 'APPEND', 'REPLACE', 'RENAME', 'COPY', 'STAR',
  'UNSTAR', 'LABEL', 'APPROVE', 'REJECT', 'SUBMIT', 'BOOK', 'ORDER', 'SCHEDULE',
])

/** GMAIL_SEND_EMAIL is a change. Whatever follows the app's own prefix decides. */
export function isWrite(action: string, app: string): boolean {
  const upper = action.toUpperCase()
  const prefix = `${app.toUpperCase()}_`
  let rest = upper.startsWith(prefix) ? upper.slice(prefix.length) : ''
  if (rest === '') rest = upper.includes('_') ? upper.slice(upper.indexOf('_') + 1) : upper
  return WRITE_WORDS.test(rest) || rest.split('_').some((token) => WRITE_TOKENS.has(token))
}

/** MICROSOFT_TEAMS_SEND_MESSAGE could belong to microsoft or microsoft_teams. */
export function candidates(action: string): string[] {
  const parts = action.toLowerCase().split('_').filter((part) => part !== '')
  const out: string[] = []
  if (parts[0] !== undefined) out.push(parts[0])
  if (parts.length >= 2) out.push(`${parts[0]}_${parts[1]}`)
  return [...new Set(out)]
}

const ORDER: Record<AppRule, number> = { allow: 0, ask: 1, never: 2 }

export class AppGuard {
  constructor(private readonly deps: GuardDeps) {}

  async check(ctx: ToolContext, actions: string[], account: string | null, detail: string): Promise<Verdict> {
    if (actions.length === 0) return { account }
    const profile = this.deps.profileOf?.(ctx) ?? null
    const asks: string[] = []
    /** The accounts the profile picked, one per action. */
    const resolved = new Set<string>()
    for (const action of actions.map((a) => a.toUpperCase())) {
      const cands = candidates(action)
      let all: AppAccount[] = []
      try {
        all = await this.deps.accountsFor(cands)
      } catch (cause) {
        if (profile !== null) {
          return { refuse: `Could not check which accounts this profile may use (${cause instanceof Error ? cause.message : String(cause)}). Try again in a moment.`, account }
        }
        all = []
      }
      // The app is the longest slug the person actually has accounts for (microsoft_teams over microsoft).
      const app =
        [...cands].sort((a, b) => b.length - a.length).find((c) => all.some((acc) => acc.app.toLowerCase() === c)) ??
        cands[0] ??
        ''
      const mine = all.filter((acc) => acc.app.toLowerCase() === app)
      const named = account
      const picked =
        named === null
          ? undefined
          : (mine.find((acc) => acc.id === named) ?? mine.find((acc) => acc.label.toLowerCase() === named.toLowerCase()))
      let use: AppAccount[]
      if (profile !== null) {
        const inProfile = (acc: AppAccount): boolean => profile.accounts.some((p) => p.id === acc.id)
        const allowed = mine.filter(inProfile)
        const name = appName(app)
        if (picked !== undefined && !inProfile(picked)) {
          return {
            refuse:
              `${picked.label} is not in your profile (${profile.name}). ` +
              (allowed.length === 0 ? `This profile has no ${name} account. Tell the main agent; do not use another account.` : `Use ${allowed.map((acc) => `${acc.label} (account ${acc.id})`).join(' or ')}.`),
            account,
          }
        }
        if (picked !== undefined) use = [picked]
        else if (named !== null && mine.length > 0) {
          return { refuse: `Unknown ${name} account "${named}". In your profile (${profile.name}): ${allowed.length === 0 ? 'none' : listOf(allowed)}.`, account }
        } else if (allowed.length === 0) {
          return { refuse: `Your profile (${profile.name}) has no ${name} account, so you cannot use ${name}. Tell the main agent what you needed it for.`, account }
        } else if (allowed.length > 1) {
          return { refuse: `Your profile (${profile.name}) has ${allowed.length} ${name} accounts: ${listOf(allowed)}. Pass \`account\` to pick one.`, account }
        } else {
          use = allowed
          const only = allowed[0]
          if (only !== undefined) resolved.add(only.id)
        }
      } else {
        if (named !== null && picked === undefined && mine.length > 0) {
          return { refuse: `Unknown ${appName(app)} account "${named}". The connected ones: ${listOf(mine)}.`, account }
        }
        use = picked !== undefined ? [picked] : mine
        // One account of the app: run in it by id, so an account connected elsewhere (the phone, the
        // dashboard) is found even though it hangs off another Composio user.
        const only = mine.length === 1 ? mine[0] : undefined
        if (picked === undefined && only !== undefined) resolved.add(only.id)
      }
      const write = isWrite(action, app)
      const rules = use.length === 0 ? [this.deps.rulesFor(null)] : use.map((acc) => this.deps.rulesFor(acc.id))
      const rule = rules
        .map((r) => (write ? r.change : r.read))
        .reduce<AppRule>((worst, next) => (ORDER[next] > ORDER[worst] ? next : worst), 'allow')
      const one = use.length === 1 ? use[0] : undefined
      const where = one !== undefined && one.label !== '' && one.label.toLowerCase() !== app ? one.label : ''
      const what = action.toLowerCase().replace(/_/g, ' ')
      if (rule === 'never') {
        return {
          refuse: `Not allowed: the person set ${where !== '' ? where : appName(app)} so the agent never ${write ? 'changes or sends anything' : 'reads anything'} there. Do not try another way; tell them, and they can change it in Connections.`,
          account,
        }
      }
      // Allowed changes still ask when they delete, cannot be undone, cost money, deploy, touch DNS or secrets.
      if (rule === 'ask' || (write && rule === 'allow' && needsYes(action))) asks.push(where !== '' ? `${what} (${where})` : what)
      if (picked !== undefined) account = picked.id
    }
    if (account === null && resolved.size > 1) {
      return { refuse: 'These actions belong to different accounts in your profile. Run them one app at a time.', account }
    }
    if (account === null && resolved.size === 1) account = [...resolved][0] ?? null
    if (asks.length > 0) {
      const yes = await ctx.approve(`Let your agent ${asks.join(', ')}?`, detail)
      if (!yes) return { refuse: 'The person declined, or nobody was around to approve. Not done.', account }
    }
    return { account }
  }
}
