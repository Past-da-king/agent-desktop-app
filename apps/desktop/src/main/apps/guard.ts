/**
 * The one gate every connected-app action goes through, enforced in code rather than asked of the
 * model (reference phone tools/AppGuard.kt): which account it runs in, and what that account allows.
 * Reading and changing things are each Allowed, Ask first or Never, per account.
 *
 * The desktop has no profiles yet, so the phone's profile branch is left out: with no account named,
 * the action is held to the strictest of that app's accounts, because Composio picks its default one.
 */
import type { AccountRules, AppRule, ToolContext } from '@agent/core'

import { appName } from './catalog'
import type { AppAccount } from './composio'

export interface GuardDeps {
  rulesFor(accountId: string | null): AccountRules
  /** The person's accounts for these candidate app slugs (for example microsoft, microsoft_teams). */
  accountsFor(apps: string[]): Promise<AppAccount[]>
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
    const asks: string[] = []
    for (const action of actions.map((a) => a.toUpperCase())) {
      const cands = candidates(action)
      let all: AppAccount[] = []
      try {
        all = await this.deps.accountsFor(cands)
      } catch {
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
      if (named !== null && picked === undefined && mine.length > 0) {
        return {
          refuse: `Unknown ${appName(app)} account "${named}". The connected ones: ${mine.map((acc) => `${acc.label} (account ${acc.id})`).join(', ')}.`,
          account,
        }
      }
      const use = picked !== undefined ? [picked] : mine
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
      if (rule === 'ask') asks.push(where !== '' ? `${what} (${where})` : what)
      if (picked !== undefined) account = picked.id
    }
    if (asks.length > 0) {
      const yes = await ctx.approve(`Let your agent ${asks.join(', ')}?`, detail)
      if (!yes) return { refuse: 'The person declined, or nobody was around to approve. Not done.', account }
    }
    return { account }
  }
}
