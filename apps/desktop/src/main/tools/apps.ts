/**
 * Connected apps through Composio, with the person's own key. Names and wording follow reference
 * phone tools/Composio.kt (AppsListTool, AppsConnectTool, AppsFindToolsTool, AppsRunTool) and the
 * guarded run in AgentRuntime.kt. Every action goes through the per-account rules in AppGuard.
 */
import { clipResult, int, resultLimitOf, schema, str, type JsonObject, type Tool } from '@agent/core'

import { appName } from '../apps/catalog'
import { NO_KEY, type AppsService } from '../apps/service'

/** The most of one action's result a model reads; a script reads all of it (ToolContext.resultLimit). */
export const APP_RESULT_CHARS = 20_000
/** The most of a tool search a model reads. */
const FIND_RESULT_CHARS = 16_000
const CONNECT = 'Connect'
const DECLINE = 'Decline'

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function failure(cause: unknown): string {
  return `Error: ${cause instanceof Error ? cause.message : String(cause)}`
}

export function appTools(apps: AppsService | undefined): Tool[] {
  if (apps === undefined) return []
  return [connectedTool(apps), findToolsTool(apps), runTool(apps), connectTool(apps)]
}

function connectedTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_connected',
      description: "List the person's connected apps (Gmail, Calendar, Drive, Slack... via Composio), with each account and what it allows.",
      schema: schema([], {}),
    },
    run: async (_input, ctx) => {
      if (apps.backend() === null) return NO_KEY
      try {
        // A helper sees only its profile's accounts: they are the only ones it may use.
        const profile = apps.profileOf(ctx.profile)
        const all = await apps.accounts()
        const list = profile === null ? all : all.filter((a) => profile.accounts.some((p) => p.id === a.id))
        if (profile !== null && list.length === 0) {
          return `Your profile (${profile.name}) has none of the person's connected accounts${all.length > 0 ? ', so you cannot use their apps' : ''}. If the job needs one, say so in your result.`
        }
        if (list.length === 0) return 'No apps connected yet. Use apps_connect to offer one.'
        const head = profile === null ? '' : `Your profile (${profile.name}) has these accounts:\n`
        // A Connect key answers only for the apps it is asked about (service.ts appsToAsk): say so, never "not connected".
        const foot =
          profile === null && apps.backend()?.listsEveryApp !== true
            ? '\n(Composio Connect lists only the apps it is asked about: the common ones and every app used here. An app not listed may still be connected: apps_find_tools with its name shows it, and it is listed from then on.)'
            : ''
        return head + list
          .map((a) => {
            const r = apps.rulesFor(a.id)
            return `${a.app}: ${a.status} · ${a.label} · account ${a.id} · reading ${r.read}, changing ${r.change}`
          })
          .join('\n') + foot
      } catch (cause) {
        return failure(cause)
      }
    },
  }
}

function findToolsTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_find_tools',
      description:
        "Find the actions available in a connected app (for example toolkit gmail, query 'search unread'). Returns tool slugs with their parameters, for apps_run.",
      schema: schema(['query'], {
        query: str('What you want to do'),
        toolkit: str('Toolkit slug to search within'),
        limit: int('Max results, default 6'),
      }),
    },
    run: async (input, ctx) => {
      const backend = apps.backend()
      if (backend === null) return NO_KEY
      const refused = outsideProfile(apps, ctx.profile, text(input['toolkit']).trim().toLowerCase())
      if (refused !== null) return refused
      const raw = input['limit']
      const limit = typeof raw === 'number' && raw > 0 ? Math.min(Math.floor(raw), 20) : 6
      try {
        const found = await backend.findTools(text(input['query']), text(input['toolkit']).trim().toLowerCase(), limit)
        // A search also says which apps the person has a working account in: listed by apps_connected from then on.
        apps.noteConnectedApps(found)
        return clipResult(found, resultLimitOf(ctx, FIND_RESULT_CHARS))
      } catch (cause) {
        return failure(cause)
      }
    },
  }
}

function runTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_run',
      description:
        "Run one action in a connected app by its tool slug (from apps_find_tools), for example GMAIL_FETCH_EMAILS. Each account's rules decide: reading and changing are each allowed, ask the person first, or never.",
      schema: schema(['slug', 'arguments'], {
        slug: str('Tool slug'),
        arguments: { type: 'object', description: "Arguments per the tool's parameters" },
        account: str('Which account, when the app has several connected: the account id from apps_connected'),
      }),
    },
    run: async (input, ctx) => {
      const backend = apps.backend()
      if (backend === null) return NO_KEY
      const slug = text(input['slug']).trim().toUpperCase()
      if (!/^[A-Z0-9_]{3,120}$/.test(slug)) return 'Pass the tool slug from apps_find_tools, for example GMAIL_FETCH_EMAILS.'
      const rawArgs = input['arguments']
      const args: JsonObject =
        rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as JsonObject) : {}
      const named = text(input['account']).trim()
      const detail = JSON.stringify(args, null, 2).slice(0, 1500)
      const verdict = await apps.guard.check(ctx, [slug], named === '' ? null : named, detail)
      if (verdict.refuse !== undefined) return verdict.refuse
      const what = slug.toLowerCase().replace(/_/g, ' ')
      const id = await ctx.activity(`Using ${what}`, { tool: 'apps' })
      try {
        const res = await backend.execute(slug, args, verdict.account)
        await ctx.updateActivity(id, `${res.ok ? 'Used' : 'Failed:'} ${what}`, { tool: 'apps' })
        return clipResult(res.text, resultLimitOf(ctx, APP_RESULT_CHARS))
      } catch (cause) {
        await ctx.updateActivity(id, `Failed: ${what}`, { tool: 'apps' })
        return failure(cause)
      }
    },
  }
}

/**
 * The agent connects an app itself when it needs one: it asks, the person says Connect, the sign-in
 * opens in their own browser, and the tool waits until Composio reports it connected.
 */
function connectTool(apps: AppsService): Tool {
  return {
    spec: {
      name: 'apps_connect',
      description:
        "Connect an app the task needs (for example gmail, googlecalendar, googledrive, googledocs, slack, notion). Asks the person, opens the sign-in in their browser, and waits until it is connected (up to 5 minutes). Never paste sign-in links yourself.",
      schema: schema(['toolkit', 'reason'], {
        toolkit: str('Composio toolkit slug, lower case'),
        reason: str("What you need it for, finishing 'so I can...'"),
      }),
    },
    run: async (input, ctx) => {
      if (apps.backend() === null) return NO_KEY
      const slug = text(input['toolkit']).trim().toLowerCase()
      if (!/^[a-z0-9_]{2,60}$/.test(slug)) return 'Pass the toolkit slug, for example gmail.'
      const name = appName(slug)
      if (apps.profileOf(ctx.profile)?.general === true) {
        return `Your profile (General) holds none of the person's accounts, so you cannot connect or use ${name}. Say in your result that the job needs ${name}; the main agent will send it to the right profile.`
      }
      let before: string[]
      try {
        before = (await apps.activeAccounts([slug])).map((a) => a.id)
      } catch (cause) {
        return failure(cause)
      }
      const existing = before.length
      const reason = text(input['reason']).trim().replace(/^so I can /i, '').replace(/[.?]+$/, '')
      const question =
        (existing > 0 ? `Connect another ${name} account` : `Connect ${name}`) + (reason === '' ? '?' : ` so I can ${reason}?`)
      const answer = await ctx.ask(question, [CONNECT, DECLINE])
      if (answer === null) return `Nobody is around to connect ${name}. Tell the person they can connect it in Connections.`
      if (answer !== CONNECT) {
        return `The person declined connecting ${name}${answer !== DECLINE ? ` and said: ${answer}` : ''}. Carry on without it.`
      }
      let started: Awaited<ReturnType<AppsService['begin']>>
      try {
        started = await apps.begin(slug)
      } catch (cause) {
        return `Could not start connecting ${name}: ${cause instanceof Error ? cause.message : String(cause)}`
      }
      const id = await ctx.activity(`Waiting for you to sign in to ${name}`, { tool: 'apps' })
      const result = await started.wait(ctx.signal)
      await ctx.updateActivity(id, result === 'connected' ? `${name} connected` : `${name} sign-in not finished`, { tool: 'apps' })
      if (result === 'connected') return `${name} (${slug}) is connected now. ${await fileInProfile(apps, ctx.profile, slug, before)}Carry on with the task.`
      if (result === 'stopped') return 'Stopped.'
      return `The person has not finished signing in to ${name} yet. Do not paste a link; say you will continue once it is connected (they can also connect it in Connections).`
    },
  }
}

/**
 * A new account connected by a helper goes into that helper's own profile, so it can use it straight
 * away (reference phone AgentRuntime.onAccountConnected). General never holds accounts.
 */
async function fileInProfile(apps: AppsService, profileId: string | undefined, slug: string, before: string[]): Promise<string> {
  const profile = apps.profileOf(profileId)
  if (profile === null) return ''
  if (profile.general) {
    return `Your profile (${profile.name}) holds none of the person's accounts, so you cannot use it here: tell the main agent, which can put it in a profile. `
  }
  try {
    const fresh = (await apps.activeAccounts([slug])).filter((a) => !before.includes(a.id))
    for (const account of fresh) apps.profiles.setMember(profile.id, { id: account.id, app: account.app, label: account.label }, true)
    return fresh.length > 0 ? `It is in your profile (${profile.name}) now. ` : ''
  } catch {
    return ''
  }
}

/**
 * A helper may only look up actions for apps its profile has an account of (General has none). The
 * main agent may look up anything. Null when it may go ahead.
 */
export function outsideProfile(apps: AppsService, profileId: string | undefined, toolkit: string): string | null {
  const profile = apps.profileOf(profileId)
  if (profile === null) return null
  if (profile.accounts.length === 0) {
    return `Your profile (${profile.name}) has none of the person's connected accounts, so you cannot use their apps. If the job needs one, say so in your result.`
  }
  if (toolkit !== '' && !profile.accounts.some((a) => a.app.toLowerCase() === toolkit)) {
    return `Your profile (${profile.name}) has no ${appName(toolkit)} account. It has: ${[...new Set(profile.accounts.map((a) => appName(a.app)))].join(', ')}.`
  }
  return null
}
